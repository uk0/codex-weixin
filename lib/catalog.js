import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

// Metadata only. Never resumes threads, reads histories, or walks arbitrary home directories.
export async function collectCatalog(controller, { includeArchived = false } = {}) {
  const owners = new Map(); const threads = new Map(); const warnings = []; let truncated = false;
  const call = async (backend, method, params) => {
    let timer;
    try { return await Promise.race([controller.call(backend, method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Catalog timeout')), controller.catalogRequestTimeoutMs || 3000); })]); }
    finally { clearTimeout(timer); }
  };
  for (const [backend, b] of controller.backends) {
    if (b.client.closed) { warnings.push(`${backend}: disconnected`); continue; }
    try {
      let cursor; const loaded = [];
      for (let page = 0; page < 5; page++) {
        const r = await call(backend, 'thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const id of r.data || []) { loaded.push(id); const ids = owners.get(id) || new Set(); ids.add(backend); owners.set(id, ids); }
        cursor = r.nextCursor; if (!cursor) break;
      }
      if (cursor) truncated = true;
      if (b.catalog !== false) {
        for (const archived of includeArchived ? [false, true] : [false]) {
        cursor = null;
        for (let page = 0; page < 5; page++) {
          const r = await call(backend, 'thread/list', { limit: 100, sourceKinds: SOURCES, modelProviders: [], useStateDbOnly: true, archived, ...(cursor ? { cursor } : {}) });
          for (const t of r.data || []) if (!threads.has(t.id)) threads.set(t.id, { ...t, backend, archived });
          if (!r.nextCursor) { cursor = null; break; }
          if (r.nextCursor === cursor) { warnings.push(`${backend}: repeated cursor`); truncated = true; break; }
          cursor = r.nextCursor;
        }
        if (cursor) truncated = true;
        }
      }
      // Live metadata wins over persisted listings. Limit fan-out, explicitly mark incomplete status.
      for (const id of loaded.slice(0, 100)) {
        try { const r = await call(backend, 'thread/read', { threadId: id }); threads.set(id, { ...r.thread, backend }); }
        catch { warnings.push(`${backend}: live metadata unavailable`); break; }
      }
      if (loaded.length > 100) { truncated = true; warnings.push(`${backend}: live metadata limit reached`); }
    } catch { warnings.push(`${backend}: inventory unavailable`); }
  }
  const rows = [...threads.values()].map(t => {
    const ids = [...(owners.get(t.id) || [])]; const backend = ids.length === 1 ? ids[0] : t.backend;
    return { ref: `${backend}:${t.id}`, backend, threadId: t.id, cwd: t.cwd || '', name: (t.name || '(未命名)').slice(0, 160),
      archived: !!t.archived, live: ids.length === 1, conflict: ids.length > 1, status: ids.length === 1 ? t.status?.type || 'loaded' : 'history_or_private', channelTools: !!controller.state.channelThreads[`${backend}:${t.id}`] };
  }).sort((a, b) => Number(b.live) - Number(a.live) || a.cwd.localeCompare(b.cwd) || a.threadId.localeCompare(b.threadId));
  return { rows, truncated, warnings: [...new Set(warnings)], includeArchived, scope: `Connected backends: visible ${includeArchived ? 'active and archived' : 'non-archived'} sessions. Private/unconnected backends are NOT included.` };
}

export async function catalogPage(controller, route, args = {}) {
  const peer = controller.peer(route); let snapshot = peer.catalogSnapshot;
  let offset = 0;
  if (args.cursor) {
    const [id, n] = args.cursor.split(':');
    snapshot = peer.catalogSnapshots?.[id] || snapshot;
    if (!snapshot || snapshot.id !== id || !/^\d+$/.test(n || '') || snapshot.expires < controller.now()) throw new Error('目录页已过期，请重新查询。');
    offset = Number(n); if (offset >= snapshot.rows.length || offset % 30) throw new Error('无效目录页。');
  } else {
    controller.catalogPending ||= new Map();
    const key = `${route.peer}:${!!args.includeArchived}`;
    let pending = controller.catalogPending.get(key);
    if (!pending) {
      pending = collectCatalog(controller, args).then(data => ({ ...data, id: randomBytes(6).toString('hex'), capturedAt: controller.now(), expires: controller.now() + 300000 }));
      controller.catalogPending.set(key, pending);
    }
    try { snapshot = await pending; } finally { if (controller.catalogPending.get(key) === pending) controller.catalogPending.delete(key); }
    peer.catalogSnapshots ||= {}; peer.catalogSnapshots[snapshot.id] = snapshot;
    for (const id of Object.keys(peer.catalogSnapshots)) if (peer.catalogSnapshots[id].expires < controller.now()) delete peer.catalogSnapshots[id];
    while (Object.keys(peer.catalogSnapshots).length > 3) delete peer.catalogSnapshots[Object.keys(peer.catalogSnapshots)[0]];
  }
  peer.catalogSnapshot = snapshot; peer.rows = snapshot.rows; controller.save();
  return { scope: snapshot.scope, capturedAt: snapshot.capturedAt, totalVisible: snapshot.rows.length, complete: !snapshot.truncated && !snapshot.warnings.length,
    warnings: snapshot.warnings, truncated: snapshot.truncated, sessions: snapshot.rows.slice(offset, offset + 30).map((r, i) => ({ ...r, number: offset + i + 1 })),
    nextCursor: offset + 30 < snapshot.rows.length ? `${snapshot.id}:${offset + 30}` : null };
}

export async function projectCatalog(controller, route) {
  const peer = controller.peer(route);
  if (controller.catalogPending?.has(`${route.peer}:true`)) await catalogPage(controller, route, { includeArchived: true });
  else if (controller.catalogPending?.has(`${route.peer}:false`)) await catalogPage(controller, route);
  if (!peer.catalogSnapshot || peer.catalogSnapshot.expires < controller.now()) await catalogPage(controller, route);
  const snapshot = peer.catalogSnapshot; const projects = new Map(); let diskTruncated = false; const warnings = [...snapshot.warnings];
  const add = (backend, cwd, data) => { const key = `${backend}:${cwd}`; projects.set(key, { ...(projects.get(key) || { backend, cwd, sessions: 0 }), ...data }); };
  for (const row of snapshot.rows) { if (!row.cwd) continue; const old = projects.get(`${row.backend}:${row.cwd}`); add(row.backend, row.cwd, { sessions: (old?.sessions || 0) + 1, origin: 'session-workspace' }); }
  for (const p of controller.projects()) add(p.backend, p.workspace, { configuredName: p.name, sandbox: p.sandbox, canCreate: true });
  const root = controller.config.newSessionWorkspace || controller.config.workspace;
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name));
    diskTruncated = dirs.length > 200;
    for (const dir of dirs.slice(0, 200)) add('local', path.join(root, dir.name), { directoryName: dir.name, candidate: true });
  } catch { warnings.push('Configured project root could not be listed.'); }
  return { scope: 'Configured projects + visible session workspaces + immediate non-hidden directory candidates under the configured local project root. No recursive/home scan; candidates do not grant permissions.', projectRoot: root,
    projects: [...projects.values()], truncated: snapshot.truncated || diskTruncated, complete: !snapshot.truncated && !diskTruncated && !warnings.length, warnings };
}
