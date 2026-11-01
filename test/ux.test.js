import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { splitMarkdown, normalizeAnswer } from '../lib/presentation.js';
import { catalogPage, projectCatalog, collectCatalog } from '../lib/catalog.js';
import { catalogArguments } from '../lib/channel-tools.js';
import { SessionController } from '../lib/sessions.js';
import { Store } from '../lib/store.js';
const route = { peer: 'owner', sender: 'owner', context: 'context' };
function setup(t, count = 65) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-ux-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new EventEmitter(); const calls = [];
  const threads = Array.from({ length: count }, (_, i) => ({ id: `thread-${i}`, name: `项目会话 ${i}`, cwd: root, status: { type: 'idle' } }));
  backend.request = async (method, p) => {
    calls.push({ method, p });
    if (method === 'thread/loaded/list') return { data: ['thread-0'] };
    if (method === 'thread/list') { const offset = Number(p.cursor || 0); return { data: threads.slice(offset, offset + 20), nextCursor: offset + 20 < count ? String(offset + 20) : null }; }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: threads.find(x => x.id === p.threadId) };
    throw new Error(method);
  };
  const output = []; const c = new SessionController({ store: new Store(path.join(root, '.state')), config: { workspace: root, sandbox: 'read-only' }, backends: new Map([['local', { client: backend }]]), publish: async (_, text) => output.push(text) });
  t.after(() => c.close()); c.peer(route).selected = { backend: 'local', threadId: 'thread-0', cwd: root, live: true };
  return { c, root, backend, calls, output };
}
test('Markdown keeps headings, source links, lists and code without converting to plain text', () => {
  const s = '# 结果\n**重点**\n- [官方文档](https://example.com/a_(b))\n```js\nx ** y\n```';
  assert.equal(splitMarkdown(s).join(''), s);
});
test('long code blocks are closed/reopened and every Unicode message respects byte limit', () => {
  const chunks = splitMarkdown('```txt\n' + '你好😀'.repeat(900) + '\n```');
  assert(chunks.length > 3);
  for (const s of chunks) { assert(Buffer.byteLength(s) <= 1800); assert.match(s, /^```txt\n/); assert.match(s, /\n```$/); assert(!s.includes('\uFFFD')); }
  assert.equal(chunks.map(s => s.slice(7, -4)).join(''), '你好😀'.repeat(900));
});
test('ordinary clickable citations are never split between label and URL', () => {
  const link = '[官方文档](https://example.com/a_(b))';
  const chunks = splitMarkdown(('段落 '.repeat(100) + link + '\n').repeat(8), 400);
  assert.equal(chunks.join('').match(/\[官方文档\]/g).length, 8);
  assert(chunks.every(s => !s.includes('[官方文档]') || s.includes(link)));
  assert(splitMarkdown('相邻中文'.repeat(100) + link, 400).every(s => !s.includes('[官方文档]') || s.includes(link)));
});
test('long Markdown tables repeat headers on continuation messages', () => {
  const s = '| 项目 | 状态 |\n| --- | --- |\n' + Array.from({ length: 90 }, (_, i) => `| project-${i} | idle |`).join('\n');
  const chunks = splitMarkdown(s, 350); assert(chunks.length > 3);
  assert(chunks.every(s => s.startsWith('| 项目 | 状态 |\n| --- | --- |')));
  for (let i = 0; i < 90; i++) assert.equal(chunks.join('\n').match(new RegExp(`project-${i} \\|`, 'g')).length, 1);
});
test('opaque citation tokens are disclosed, never fabricated into sources', () => {
  assert.equal(normalizeAnswer('[文档](https://example.com)'), '[文档](https://example.com)');
  const s = normalizeAnswer('结论 citeturn123search0'); assert(!s.includes('turn123')); assert(s.includes('未包含网址')); assert(!s.includes('http'));
});
test('catalog follows backend pagination, returns peer-bound pages and never resumes', async t => {
  const x = setup(t); const a = await catalogPage(x.c, route); assert.equal(a.totalVisible, 65); assert.equal(a.sessions.length, 30);
  const b = await catalogPage(x.c, route, { cursor: a.nextCursor }); const c = await catalogPage(x.c, route, { cursor: b.nextCursor });
  assert.equal(c.sessions.length, 5); assert.equal(c.nextCursor, null);
  assert.equal(new Set([...a.sessions, ...b.sessions, ...c.sessions].map(r => r.ref)).size, 65);
  assert(!x.calls.some(r => r.method.includes('resume') || r.method.includes('turns')));
  await assert.rejects(catalogPage(x.c, { peer: 'stranger' }, { cursor: a.nextCursor }), /过期/);
  x.c.now = () => Date.now() + 400000; await assert.rejects(catalogPage(x.c, route, { cursor: a.nextCursor }), /过期/);
});
test('catalog limits, disconnected backends and duplicate loaded owners are explicit', async t => {
  const x = setup(t, 200); x.c.backends.set('offline', { client: { closed: true } });
  x.c.backends.set('duplicate', { client: x.backend });
  const s = await collectCatalog(x.c); assert(s.truncated); assert(s.warnings.some(x => x.includes('offline'))); assert(s.rows.find(x => x.threadId === 'thread-0').conflict);
});
test('project candidates are scoped to direct directories; hidden and symlink roots are not traversed', async t => {
  const x = setup(t); fs.mkdirSync(path.join(x.root, 'project')); fs.mkdirSync(path.join(x.root, '.secret'));
  fs.symlinkSync(os.homedir(), path.join(x.root, 'outside-link'));
  const data = await projectCatalog(x.c, route);
  assert(data.projects.some(p => p.directoryName === 'project' && !p.canCreate));
  assert(!data.projects.some(p => ['.secret', 'outside-link'].includes(p.directoryName)));
  assert(data.projects.some(p => p.configuredName === 'default' && p.canCreate));
});
test('parallel project and session tools share one in-flight catalog snapshot', async t => {
  const x = setup(t); await Promise.all([catalogPage(x.c, route), projectCatalog(x.c, route)]);
  assert.equal(x.calls.filter(r => r.method === 'thread/list').length, 4);
});
test('short commands preserve ordinary messages and explicit approval codes', async t => {
  const x = setup(t); assert.match(await x.c.dispatch('/h', route), /\/s/); assert.match(await x.c.dispatch('/st', route), /thread-0/);
  let arg; x.c.decision = async (r, code, ok) => { arg = { r, code, ok }; return 'OK'; };
  await x.c.dispatch('/ok ab12', route); assert.equal(arg.code, 'ab12'); assert.equal(arg.ok, true);
  x.c.submit = async (r, text) => text; const text = '看一下当前所有项目和所有session，然后用markdown给我'; assert.equal(await x.c.dispatch(text, route), text);
});
test('long answers page without rerunning Codex and can continue after switching sessions', async t => {
  const x = setup(t); const input = Array.from({ length: 100 }, (_, i) => `条目${i} ${'内容'.repeat(100)}`).join('\n');
  await x.c.notifyAnswer(route, input, x.c.selected(route)); assert.equal(x.output.length, 4);
  const code = Object.keys(x.c.peer(route).outputPages)[0]; x.c.peer(route).selected = { backend: 'local', threadId: 'thread-1' };
  while (x.c.peer(route).outputPages[code]) await x.c.dispatch(`/more ${code}`, route);
  for (let i = 0; i < 100; i++) assert(x.output.join('\n').includes(`条目${i} `));
  assert(!x.calls.some(r => r.method === 'turn/start'));
});
test('inventory arguments reject arbitrary recipient, path, RPC and invalid ref data', () => {
  for (const args of [{ path: '/etc' }, { recipient: 'other' }, [], null, { cursor: 12 }]) assert.throws(() => catalogArguments('weixin_list_sessions', args));
  assert.throws(() => catalogArguments('weixin_select_session', {}));
});
test('unresponsive catalog backend produces a partial result instead of stalling other backends', async t => {
  const x = setup(t, 1); x.c.catalogRequestTimeoutMs = 10;
  x.c.backends.set('hung', { client: { request: () => new Promise(() => {}) } });
  const result = await catalogPage(x.c, route); assert.equal(result.complete, false); assert.equal(result.sessions.length, 1); assert(result.warnings.some(s => s.includes('hung')));
});
test('archived sessions are included only when requested and retain their distinction', async t => {
  const x = setup(t, 1); const original = x.backend.request;
  x.backend.request = async (method, p) => method === 'thread/list' && p.archived ? { data: [{ id: 'archived', name: 'old', cwd: x.root }], nextCursor: null } : original(method, p);
  assert.equal((await collectCatalog(x.c)).rows.length, 1);
  const all = await collectCatalog(x.c, { includeArchived: true }); assert.equal(all.rows.length, 2); assert(all.rows.find(r => r.threadId === 'archived').archived);
});
test('parallel archived/default queries keep independent valid pagination snapshots', async t => {
  const x = setup(t, 65); const original = x.backend.request;
  x.backend.request = async (method, p) => method === 'thread/list' && p.archived ? { data: [{ id: 'archived', name: 'old', cwd: x.root }], nextCursor: null } : original(method, p);
  const [a, b] = await Promise.all([catalogPage(x.c, route), catalogPage(x.c, route, { includeArchived: true })]);
  assert.equal(a.totalVisible, 65); assert.equal(b.totalVisible, 66);
  assert.equal((await catalogPage(x.c, route, { cursor: a.nextCursor })).totalVisible, 65);
  assert.equal((await catalogPage(x.c, route, { cursor: b.nextCursor })).totalVisible, 66);
});
test('failed attachment never leaves the user silently switched to another session', async t => {
  const x = setup(t); const original = x.backend.request;
  x.backend.request = async (method, p) => method === 'thread/loaded/list' ? { data: ['thread-0', 'thread-1'] } : method === 'thread/resume' ? Promise.reject(new Error('disconnected')) : original(method, p);
  await assert.rejects(x.c.choose(route, 'local:thread-1'));
  assert.equal(x.c.selected(route).threadId, 'thread-0');
});
test('natural tool selection rejects unknown refs and never starts a model turn on the target', async t => {
  const x = setup(t); const replies = []; x.backend.send = m => replies.push(m);
  await catalogPage(x.c, route);
  const job = { started: Promise.resolve(), turnId: 'turn', origin: route, cwd: x.root };
  const msg = ref => ({ id: 'call', params: { tool: 'weixin_select_session', threadId: 'thread-0', turnId: 'turn', callId: 'select', arguments: { ref } } });
  await x.c.handleChannelCall('local', msg('local:unknown'), job); assert.equal(replies.at(-1).result.success, false);
  await x.c.handleChannelCall('local', msg('local:thread-1'), job); assert.equal(replies.at(-1).result.success, true);
  assert.equal(x.c.selected(route).threadId, 'thread-1'); assert(!x.calls.some(r => r.method === 'turn/start' || r.method === 'thread/resume'));
});
