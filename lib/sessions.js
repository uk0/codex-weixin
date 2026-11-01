import { randomBytes } from 'node:crypto';
import { isNewRequest } from './natural.js';
import { ArtifactError } from './files.js';
import { CHANNEL_TOOLS, toolPayload, catalogArguments } from './channel-tools.js';
import { catalogPage, projectCatalog } from './catalog.js';
import { CHANNEL_INSTRUCTIONS, COMMAND_ALIASES, normalizeAnswer, splitMarkdown } from './presentation.js';
import { actionHint, message, codeBlock, inlineCode, controlMarkdown, confirmationMessage, approvalMessage, moreMessage, helpMessage } from './messages.js';

const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const binding = s => `${s.backend}:${s.threadId}`;
const brief = s => `[${s.backend}/${s.threadId.slice(0, 8)}]`;
export class UserError extends Error {}
export const CONTROL_HELP = helpMessage();

export class SessionController {
  constructor({ store, config, backends, publish = () => {}, sendAction, now = Date.now }) {
    Object.assign(this, { store, config, backends, publish, sendAction, now });
    this.state = store.read('control', { version: 1, peers: {} });
    if (this.state.version !== 1) throw new Error('Unsupported controller state.');
    this.state.jobs ||= {};
    this.state.channelThreads ||= {};
    for (const job of Object.values(this.state.jobs)) if (['starting', 'active'].includes(job.status)) job.status = 'detached';
    this.attached = new Set(); this.catalog = new Map(); this.routes = new Map(); this.jobs = new Map(); this.approvals = new Map(); this.confirmations = new Map();
    this.observedItems = new Map(); this.handlers = []; this.background = new Set(); this.closed = false;
    for (const [id, backend] of backends) {
      const event = msg => this.onNotification(id, msg);
      const request = msg => this.onRequest(id, msg);
      backend.client.on('notification', event); backend.client.on('serverRequest', request);
      this.handlers.push(() => { backend.client.off('notification', event); backend.client.off('serverRequest', request); });
    }
  }
  save() { this.store.write('control', this.state); }
  peer(route) {
    return this.state.peers[route.peer] ||= { selected: null, rows: [], cursors: {}, historyCursor: null };
  }
  backend(id) {
    const backend = this.backends.get(id);
    if (!backend || backend.client.closed) throw new UserError(`后端 ${id} 不可用；请在本机检查连接。`);
    return backend;
  }
  async call(id, method, params) {
    try { return await this.backend(id).client.request(method, params); }
    catch (error) { error.backend = id; error.rpcMethod ||= method; throw error; }
  }
  selected(route) {
    const selected = this.peer(route).selected;
    if (!selected) throw new UserError(message('尚未选择会话', actionHint('查看会话', '/s'), actionHint('切换（替换编号）', '/u <编号>'), actionHint('或新建会话', '/n')));
    return selected;
  }
  async notify(route, text) {
    if (!this.closed) await this.publish(route, text);
  }
  async notifyAnswer(route, value, selected) {
    const chunks = splitMarkdown(normalizeAnswer(value), 1700);
    for (const chunk of chunks.slice(0, 3)) await this.notify(route, chunk);
    if (chunks.length > 3) {
      const peer = this.peer(route); peer.outputPages ||= {};
      const code = randomBytes(3).toString('hex');
      peer.outputPages[code] = { chunks: chunks.slice(3), selected, expires: this.now() + 86400000 };
      const keys = Object.keys(peer.outputPages); if (keys.length > 5) delete peer.outputPages[keys[0]];
      this.save(); await this.notify(route, moreMessage(chunks.length - 3, code));
    }
  }
  async more(route, code) {
    const peer = this.peer(route); peer.outputPages ||= {};
    for (const [key, page] of Object.entries(peer.outputPages)) if (page.expires < this.now()) delete peer.outputPages[key];
    const keys = Object.keys(peer.outputPages);
    if (!code && keys.length === 1) code = keys[0];
    if (!code && keys.length > 1) return message('选择待续结果', ...keys.map(k => actionHint(`结果 ${k}`, `/more ${k}`)));
    const page = peer.outputPages[code]; if (!page) return '没有待续结果，或结果已过期。';
    if (binding(page.selected) !== binding(peer.selected || {})) await this.notify(route, message('结果续页', `来自会话 ${inlineCode(brief(page.selected))}，未切换当前会话。`));
    // Queue before removing persisted pages. No model rerun or hidden task retry.
    for (const chunk of page.chunks.slice(0, 3)) await this.notify(route, chunk);
    page.chunks.splice(0, 3); const remaining = page.chunks.length;
    if (!remaining) delete peer.outputPages[code]; this.save();
    return remaining ? moreMessage(remaining, code) : '';
  }
  track(promise) {
    this.background.add(promise); promise.finally(() => this.background.delete(promise)).catch(() => {}); return promise;
  }
  addRoute(selected, route, watch = false) {
    const key = binding(selected);
    const peers = this.routes.get(key) || new Map();
    const old = peers.get(route.peer);
    peers.set(route.peer, { ...route, watch: watch || old?.watch || false, lastProgress: old?.lastProgress || 0 }); this.routes.set(key, peers);
  }
  async inventory(route, argument = '') {
    const peer = this.peer(route); const next = argument === 'next';
    if (!next) { peer.cursors = {}; peer.query = argument === 'archived' ? { archived: true } : { searchTerm: argument || null }; }
    const owners = new Map(); const metadata = new Map();
    const errors = [];
    for (const [id, b] of this.backends) {
      if (b.client.closed) { errors.push(`${id}:断开`); continue; }
      try {
        const loaded = await this.call(id, 'thread/loaded/list', {});
        for (const threadId of loaded.data || []) {
          const ids = owners.get(threadId) || []; ids.push(id); owners.set(threadId, ids);
          const read = await this.call(id, 'thread/read', { threadId });
          metadata.set(threadId, { ...read.thread, backend: id });
        }
        if (b.catalog === false || (next && peer.cursors[id] === null)) continue;
        const page = await this.call(id, 'thread/list', { limit: 12, modelProviders: [], sourceKinds: SOURCES,
          useStateDbOnly: true, ...(peer.query || {}), ...(next && peer.cursors[id] ? { cursor: peer.cursors[id] } : {}) });
        peer.cursors[id] = page.nextCursor || null;
        for (const thread of page.data || []) if (!metadata.has(thread.id)) metadata.set(thread.id, { ...thread, backend: id });
      } catch { errors.push(`${id}:清单查询失败`); }
    }
    const rows = [...metadata.values()].map(t => {
      const known = owners.get(t.id) || [];
      return { backend: known.length === 1 ? known[0] : t.backend, threadId: t.id, cwd: t.cwd,
        name: t.name || t.preview?.slice(0, 70) || '(未命名)', source: t.source,
        live: known.length === 1, conflict: known.length > 1, status: t.status?.type || 'notLoaded' };
    }).sort((a, b) => Number(b.live) - Number(a.live));
    peer.rows = rows; this.save();
    for (const row of rows) this.catalog.set(binding(row), row);
    const lines = rows.map((r, i) => `${i + 1}. **${r.name.replace(/[\[\]*_`]/g, '')}** · ${r.live ? '实时' : r.conflict ? '冲突/只读' : '历史/其他后端'} ${r.status}\n   ${brief(r)} · ${r.cwd || ''}`);
    return message('会话目录', lines.join('\n\n') || '没有查到会话。', actionHint('切换（替换编号）', '/u <编号>'),
      Object.values(peer.cursors).some(Boolean) && actionHint('下一页', '/s next'), '仅列已接入后端可见记录，历史不等于当前未运行。', errors.join('；'));
  }
  async choose(route, argument) {
    const peer = this.peer(route); let selected;
    if (/^\d+$/.test(argument)) selected = peer.rows[Number(argument) - 1];
    else {
      const colon = argument.indexOf(':');
      if (colon > 0) {
        const backend = argument.slice(0, colon); const threadId = argument.slice(colon + 1);
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(threadId)) throw new UserError('无效会话ID。');
        const read = await this.call(backend, 'thread/read', { threadId });
        const loaded = await this.call(backend, 'thread/loaded/list', {});
        selected = { backend, threadId, cwd: read.thread.cwd, name: read.thread.name || '', live: loaded.data.includes(threadId), status: read.thread.status?.type };
      }
    }
    if (!selected || selected.conflict) throw new UserError(message('无法选择会话', '编号无效或同一会话在多个后端运行；请先在本机解决冲突。', actionHint('刷新会话目录', '/s')));
    const previous = peer.selected;
    peer.selected = { ...selected };
    try { if (selected.live) await this.attach(route); }
    catch (error) { peer.selected = previous; this.save(); throw error; }
    peer.historyCursor = null; this.save();
    return message('已选择会话', `**会话**：${inlineCode(brief(selected))}`, `**目录**\n\n${codeBlock(selected.cwd || '')}`,
      selected.live ? '已附加现有后端，保留其权限配置。' : '当前仅历史可见，不能据此判断桌面端是否仍在运行。',
      !selected.live && actionHint('查看历史', '/hist'), !selected.live && actionHint('请求恢复（仍需确认）', '/resume'));
  }
  async owners(threadId) {
    const owners = [];
    for (const [id, b] of this.backends) {
      if (b.client.closed) continue;
      const result = await this.call(id, 'thread/loaded/list', {});
      if (result.data.includes(threadId)) owners.push(id);
    }
    return owners;
  }
  async attach(route) {
    const s = this.selected(route);
    const owners = await this.owners(s.threadId);
    if (owners.length > 1) throw new UserError('同一会话在多个已接入后端运行，拒绝双重控制；先在本机解决冲突。');
    if (!owners.includes(s.backend)) { s.live = false; this.save(); throw new UserError(message('目标会话未加载', '目标不在已接入后端运行；需要申请恢复并确认，不会自动复制执行。', actionHint('申请恢复', '/resume'))); }
    // No cwd/model/sandbox/approval overrides for existing threads.
    let result;
    if (this.attached.has(binding(s))) {
      result = await this.call(s.backend, 'thread/read', { threadId: s.threadId });
    } else {
      try { result = await this.call(s.backend, 'thread/resume', { threadId: s.threadId, excludeTurns: true }); }
      catch (error) {
        if (error.rpcCategory !== 'noRollout') throw error;
        const read = await this.call(s.backend, 'thread/read', { threadId: s.threadId });
        if (read.thread.status?.type !== 'idle' || read.thread.name || read.thread.preview || read.thread.ephemeral === true) throw new UserError(message('该空会话尚无可恢复的历史记录', '没有自动重复执行任务。', actionHint('新建会话', '/n')));
        // This explicitly selected, loaded, idle, unnamed empty thread has no rollout yet.
        // Persist only its default name; never retry turn/start or create a copy.
        await this.call(s.backend, 'thread/name/set', { threadId: s.threadId, name: this.newThreadName() });
        result = await this.call(s.backend, 'thread/resume', { threadId: s.threadId, excludeTurns: true });
      }
      this.attached.add(binding(s));
    }
    s.live = true; s.cwd = result.cwd || result.thread.cwd; s.status = result.thread.status?.type;
    this.addRoute(s, route); this.save(); return result;
  }
  confirm(route, action, selected) {
    const code = randomBytes(4).toString('hex');
    this.confirmations.set(code, { peer: route.peer, action, selected: { ...selected }, expires: this.now() + 120000 });
    return confirmationMessage(action, brief(selected), code);
  }
  async confirmed(route, code) {
    const item = this.confirmations.get(code); const selected = this.selected(route);
    if (!item || item.peer !== route.peer || item.expires < this.now() || binding(item.selected) !== binding(selected)) throw new UserError('确认码无效、过期或会话不匹配。');
    this.confirmations.delete(code);
    const s = item.selected; const params = { threadId: s.threadId };
    if (item.action === 'resume') {
      const owners = await this.owners(s.threadId);
      if (owners.some(id => id !== s.backend)) throw new UserError('会话已在另一个已接入后端运行，拒绝再次恢复。');
      const result = await this.call(s.backend, 'thread/resume', { ...params, excludeTurns: true });
      this.peer(route).selected = { ...s, live: true, status: result.thread.status?.type, cwd: result.cwd || result.thread.cwd };
      this.attached.add(binding(s)); this.addRoute(s, route); this.save(); return `已在 ${s.backend} 恢复 ${s.threadId}；没有自动发送任务。`;
    }
    const read = await this.call(s.backend, 'thread/read', params);
    if (read.thread.status?.type === 'active') throw new UserError(message('目标仍在执行', '中断后请确认任务已结束。', actionHint('请求中断', '/q')));
    await this.call(s.backend, `thread/${item.action}`, params);
    if (item.action === 'delete' || item.action === 'archive') this.peer(route).selected = null;
    this.save(); return `${item.action} 已完成：${brief(s)}`;
  }
  async activeTurn(selected) {
    const job = this.jobs.get(binding(selected));
    if (job?.started) await job.started;
    if (job?.turnId) return job.turnId;
    const result = await this.call(selected.backend, 'thread/turns/list', { threadId: selected.threadId, limit: 5, itemsView: 'notLoaded' });
    const active = (result.data || []).find(t => t.status === 'inProgress');
    if (!active) throw new UserError('没有找到运行中的 turn；不会猜测任务ID。');
    return active.id;
  }
  async submit(route, text) {
    const s = { ...this.selected(route) }; const key = binding(s);
    if (this.jobs.has(key)) throw new UserError(message('该会话已有任务', actionHint('追加指令（替换内容）', '/+ <追加指令>'), actionHint('中断任务', '/q')));
    await this.attach(route);
    const read = await this.call(s.backend, 'thread/read', { threadId: s.threadId });
    s.cwd = read.thread.cwd || this.selected(route).cwd;
    if (read.thread.status?.type === 'active') throw new UserError(message('会话正在其他客户端执行', actionHint('查看进度', '/watch'), actionHint('追加指令（替换内容）', '/+ <追加指令>'), actionHint('中断任务', '/q')));
    this.addRoute(s, route);
    const settings = { ...this.peer(route) };
    let started; const ready = new Promise(resolve => { started = resolve; });
    const job = { turnId: null, started: ready, origin: { ...route }, cwd: s.cwd }; this.jobs.set(key, job);
    this.state.jobs[key] = { backend: s.backend, threadId: s.threadId, peer: route.peer, status: 'starting', startedAt: this.now() }; this.save();
    // Release the inbound long-poll immediately so approvals, stop, and other sessions remain usable.
    this.track(new Promise(resolve => setImmediate(resolve)).then(async () => {
      try {
        const result = await this.backend(s.backend).client.run(s.threadId, text, { model: settings.model, effort: settings.effort,
          onStarted: id => { job.turnId = id; this.state.jobs[key] = { ...this.state.jobs[key], turnId: id, status: 'active' }; this.save(); started(); } });
        if (result?.trim()) await this.notifyAnswer(route, result, s);
      } catch {
        await this.notify(route, message('任务未正常完成', '任务中断或连接断开，结果未知；未自动重跑。', actionHint('查看状态', '/st')));
      } finally { started(); this.jobs.delete(key); delete this.state.jobs[key]; this.save(); }
    }));
    return ''; // Final output and necessary approvals are enough in a chat channel.
  }
  async onNotification(backend, msg) {
    const p = msg.params || {};
    if (['thread/closed', 'thread/archived', 'thread/deleted'].includes(msg.method)) this.attached.delete(`${backend}:${p.threadId}`);
    if (msg.method === 'serverRequest/resolved') {
      for (const [code, item] of this.approvals) if (item.backend === backend && item.id === p.requestId) { clearTimeout(item.timer); this.approvals.delete(code); }
    }
    if (msg.method === 'turn/completed') {
      for (const [code, item] of this.approvals) if (item.backend === backend && item.threadId === p.threadId && item.turnId === p.turn?.id) { clearTimeout(item.timer); this.approvals.delete(code); }
    }
    const key = `${backend}:${p.threadId}`; const routes = this.routes.get(key);
    if (!routes) return;
    if (msg.method === 'item/started' && p.item?.id) {
      this.observedItems.set(`${key}:${p.item.id}`, p.item);
      if (this.observedItems.size > 100) this.observedItems.delete(this.observedItems.keys().next().value);
    }
    let text;
    if (msg.method === 'item/started') text = `执行：${p.item?.type || 'item'}`;
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'final_answer') text = String(p.item.text || '').slice(0, 700);
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'final_answer' && !this.jobs.has(key)) text = String(p.item.text || '');
    if (msg.method === 'turn/completed' && !this.jobs.has(key)) text = `任务状态：${p.turn?.status}`;
    if (!text) return;
    for (const route of routes.values()) if (route.watch && (msg.method === 'turn/completed' || p.item?.phase === 'final_answer' || this.now() - route.lastProgress > 3000)) {
      route.lastProgress = this.now(); this.track(this.notify(route, message('会话动态', inlineCode(`${backend}/${p.threadId.slice(0, 8)}`), text)).catch(() => {}));
    }
  }
  onRequest(backend, msg) {
    const p = msg.params || {}; const routes = this.routes.get(`${backend}:${p.threadId}`);
    if (!routes?.size) return; // Never decline or approve requests for unrelated sessions.
    if (msg.method === 'item/tool/call') {
      const job = this.jobs.get(`${backend}:${p.threadId}`);
      // Watches, other clients and restarted/detached turns never gain a sending capability.
      if (!job || !this.state.channelThreads[`${backend}:${p.threadId}`]) return;
      this.track(this.handleChannelCall(backend, msg, job)); return;
    }
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(msg.method)) {
      const job = this.jobs.get(`${backend}:${p.threadId}`);
      // A subscription must not consume an original client's private tool call.
      if (this.backend(backend).client.endpoint && (!job || job.turnId !== p.turnId)) return;
      this.backend(backend).client.send({ id: msg.id, error: { code: -32601, message: 'This interactive request is not supported by the Weixin bridge.' } }); return;
    }
    const code = randomBytes(4).toString('hex');
    const item = { backend, id: msg.id, threadId: p.threadId, turnId: p.turnId, method: msg.method, params: p,
      expires: this.now() + 120000, peers: new Set(routes.keys()) };
    this.approvals.set(code, item);
    const timer = setTimeout(() => { if (this.approvals.has(code)) { this.approvals.delete(code); try { this.answerRequest(item, false); } catch {} } }, 120000); timer.unref(); item.timer = timer;
    const observed = this.observedItems.get(`${backend}:${p.threadId}:${p.itemId}`) || {};
    const details = JSON.stringify({ command: p.command || observed.command, cwd: p.cwd || observed.cwd, grantRoot: p.grantRoot, changes: observed.changes, reason: p.reason, permissions: p.permissions,
      questions: p.questions, message: p.message, requestedSchema: p.requestedSchema, url: p.url }, null, 2).slice(0, 6000);
    for (const route of routes.values()) this.track(this.notify(route,
      approvalMessage(`${backend}/${p.threadId.slice(0, 8)}`, code, msg.method, details, { urlMode: p.mode === 'url' })).catch(() => {}));
  }
  async handleChannelCall(backend, msg, job) {
    const p = msg.params;
    await job.started; // Requests can precede the turn/start response.
    if (job.turnId !== p.turnId) return;
    let result;
    try {
      if (typeof p.callId !== 'string' || !p.callId) throw new Error('Missing call identity.');
      if (p.namespace) throw new Error('Unsupported channel namespace.');
      if (['weixin_list_sessions', 'weixin_list_projects', 'weixin_select_session'].includes(p.tool)) {
        const args = catalogArguments(p.tool, p.arguments); let data;
        if (p.tool === 'weixin_list_sessions') data = await catalogPage(this, job.origin, args);
        else if (p.tool === 'weixin_list_projects') data = await projectCatalog(this, job.origin);
        else {
          const snapshot = this.peer(job.origin).catalogSnapshot;
          if (!snapshot || snapshot.expires < this.now() || !snapshot.rows.some(r => r.ref === args.ref && !r.conflict)) throw new UserError('会话未出现在有效目录中，请先重新查询。');
          data = { message: await this.choose(job.origin, args.ref), selected: this.selected(job.origin) };
        }
        result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
      } else {
      const payload = toolPayload(p.tool, p.arguments);
      if (!this.sendAction) throw new Error('Channel transport not connected.');
      if (payload.type === 'file') {
        const b = this.backend(backend);
        if (b.localFiles !== true && b.client.endpoint && !b.client.endpoint.startsWith('unix://')) throw new Error('Remote file transfer is unavailable.');
        payload.cwd = job.cwd;
      }
      payload.deliveryKey = [backend, p.threadId, p.turnId, p.callId];
      const receipt = await this.sendAction(job.origin, payload);
      result = { success: receipt.accepted === true, contentItems: [{ type: 'inputText', text: JSON.stringify(receipt) }] };
      }
    } catch (error) {
      result = { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'rejected', accepted: false, reason: error instanceof ArtifactError || error instanceof UserError ? error.message : 'Tool failed. Refresh inventory if a cursor/ref expired; no delivery confirmed.' }) }] };
    }
    try { this.backend(backend).client.send({ id: msg.id, result }); } catch { /* Never repeat a send after disconnection. */ }
  }
  answerRequest(item, approved, answer) {
    let result;
    if (item.method.includes('commandExecution') || item.method.includes('fileChange')) result = { decision: approved ? 'accept' : 'decline' };
    else if (item.method === 'item/permissions/requestApproval') result = { permissions: approved ? item.params.permissions : {}, scope: 'turn' };
    else if (item.method === 'item/tool/requestUserInput') {
      if (approved && !answer) throw new UserError(message('需要填写回答', actionHint('替换确认码、问题ID和回答后发送', '/answer <确认码> {"问题ID":["回答"]}')));
      const questions = item.params.questions || []; const entries = Object.entries(answer || {});
      if (entries.some(([id, values]) => !questions.some(q => q.id === id) || !Array.isArray(values) || !values.every(v => typeof v === 'string'))) throw new UserError('回答必须使用本请求的问题ID和字符串数组。');
      result = { answers: Object.fromEntries(entries.map(([id, answers]) => [id, { answers }])) };
    } else if (item.method === 'mcpServer/elicitation/request') {
      if (approved && item.params.mode === 'url') throw new UserError(message('请在本机或浏览器授权', '微信不代填凭据。', actionHint('或拒绝（替换确认码）', '/no <确认码>')));
      if (approved && !answer) throw new UserError(message('需要填写表单', actionHint('替换确认码和 JSON 后发送', '/answer <确认码> {}')));
      if (approved) {
        const schema = item.params.requestedSchema || {}; const properties = schema.properties || {};
        if (Object.keys(answer).some(key => !Object.hasOwn(properties, key)) || (schema.required || []).some(key => !Object.hasOwn(answer, key))) throw new UserError('表单字段与本请求schema不匹配。');
        for (const [key, value] of Object.entries(answer)) {
          const type = properties[key]?.type;
          if ((type === 'string' && typeof value !== 'string') || (type === 'boolean' && typeof value !== 'boolean') || (type === 'number' && typeof value !== 'number') || (type === 'integer' && !Number.isInteger(value)) || (properties[key]?.enum && !properties[key].enum.includes(value))) throw new UserError('表单值类型或枚举不匹配。');
        }
      }
      result = { action: approved ? 'accept' : 'decline', content: approved ? answer : null };
    }
    this.backend(item.backend).client.send({ id: item.id, result });
  }
  async decision(route, code, approved, answer) {
    const item = this.approvals.get(code);
    if (!item || !item.peers.has(route.peer) || item.expires < this.now()) throw new UserError('请求不存在、已解决、过期或不属于当前微信用户。');
    this.answerRequest(item, approved, answer);
    this.approvals.delete(code); clearTimeout(item.timer);
    return `${code} 已${approved ? '单次同意/回答' : '拒绝'}；不扩大整个会话权限。`;
  }
  async publishFile(route, selected, requested) {
    const backend = this.backend(selected.backend);
    if (backend.localFiles !== true && backend.client.endpoint && !backend.client.endpoint.startsWith('unix://')) throw new UserError('远端文件不能按本机路径读取；该后端尚未接入文件传输。');
    try { return await this.publish(route, { type: 'file', path: requested, cwd: selected.cwd }); }
    catch (error) { if (error instanceof ArtifactError) throw new UserError(error.message); throw error; }
  }
  newThreadName() { return `微信新会话 ${new Date(this.now()).toLocaleString('zh-CN', { hour12: false })}`; }
  async dispatch(text, route) {
    const result = await this.dispatchRaw(text, route);
    return text.startsWith('/') || isNewRequest(text) ? controlMarkdown(result) : result;
  }
  async dispatchRaw(text, route) {
    if (isNewRequest(text)) text = '/new';
    this.peer(route); const [original] = text.split(/\s+/); const command = COMMAND_ALIASES[original] || original; const arg = text.slice(original.length).trim();
    if (!command.startsWith('/')) {
      return this.submit(route, text);
    }
    if (command === '/help') return helpMessage(arg === 'all');
    if (command === '/more') return this.more(route, arg);
    if (command === '/backends') return message('后端连接', [...this.backends].map(([id, b]) => `- ${inlineCode(id)}：${b.client.closed ? '断开' : '已连接'} ${b.label || ''}`).join('\n'), '私有stdio桌面/IDE后端必须另外提供可附加入口；不会自动迁移。');
    if (command === '/sessions') return this.inventory(route, arg);
    if (command === '/use') return this.choose(route, arg);
    if (command === '/approvals') return [...this.approvals].filter(([, a]) => a.peers.has(route.peer) && a.expires > this.now()).map(([code, a]) => approvalMessage(`${a.backend}/${a.threadId.slice(0, 8)}`, code, a.method, '', { compact: true, urlMode: a.params.mode === 'url', remainingSeconds: Math.max(0, Math.ceil((a.expires - this.now()) / 1000)) })).join('\n\n') || message('待处理请求', '没有待处理请求。');
    if (command === '/approve' || command === '/decline') return this.decision(route, arg, command === '/approve');
    if (command === '/answer') {
      const [code] = arg.split(/\s+/); let answer;
      try { answer = JSON.parse(arg.slice(code.length).trim()); } catch { throw new UserError('回答必须是JSON对象。'); }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new UserError('回答必须是JSON对象。');
      return this.decision(route, code, true, answer);
    }
    if (command === '/confirm') return this.confirmed(route, arg);
    if (command === '/projects') {
      const data = await projectCatalog(this, route);
      return '## 项目目录\n' + data.projects.map(p => `- **${p.configuredName || p.directoryName || p.cwd.split('/').pop()}** · ${p.sessions} 个会话${p.candidate ? ' · 目录候选' : ''}\n  ${p.cwd}`).join('\n') + `\n\n范围：已配置项目、可见会话工作区与项目根目录的直接子目录。${data.complete ? '' : '目录不完整，请勿视为全量。'}`;
    }
    if (command === '/new') {
      const project = this.projects().find(p => p.name === (arg || 'default'));
      if (!project) throw new UserError(message('项目未在本机授权配置', actionHint('查看项目目录', '/p')));
      const backend = project.backend || 'bridge';
      const result = await this.call(backend, 'thread/start', { cwd: project.workspace, sandbox: project.sandbox, approvalPolicy: 'on-request', dynamicTools: CHANNEL_TOOLS,
        developerInstructions: CHANNEL_INSTRUCTIONS,
        ...(this.peer(route).model ? { model: this.peer(route).model } : {}) });
      const s = { backend, threadId: result.thread.id, cwd: result.cwd || result.thread.cwd || project.workspace, live: true };
      this.peer(route).selected = s; this.state.channelThreads[binding(s)] = { version: 2, peer: route.peer };
      this.attached.add(binding(s)); this.addRoute(s, route); this.save();
      // Codex 0.166 can list/read an empty thread yet reject resume until a name
      // (or first turn) persists its rollout. Naming does not create a model turn.
      try { await this.call(backend, 'thread/name/set', { threadId: s.threadId, name: result.thread.name || this.newThreadName() }); }
      catch { /* Still subscribed to the newly created thread; first turn can start directly. */ }
      return message('新会话已就绪', `**目录**\n\n${codeBlock(s.cwd)}`, `**权限**：${inlineCode(project.sandbox)}`, '已启用微信工具，直接发送任务即可。');
    }
    if (command === '/models') {
      const result = await this.call(this.peer(route).selected?.backend || 'bridge', 'model/list', { limit: 100 });
      return message('可用模型', result.data.map(m => `- ${inlineCode(m.id || m.model)} ${m.displayName || ''}`).join('\n'), actionHint('选择模型（替换ID）', '/model <模型ID>'));
    }
    if (command === '/model') {
      const result = await this.call(this.peer(route).selected?.backend || 'bridge', 'model/list', { limit: 100 });
      if (!result.data.some(m => [m.id, m.model].includes(arg))) throw new UserError(message('模型不在当前后端的可用列表中', actionHint('查看模型目录', '/models')));
      this.peer(route).model = arg; this.save(); return `后续从微信新发起的任务使用 ${arg}，不改变其他客户端正在执行的任务。`;
    }
    if (command === '/effort') {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(arg)) throw new UserError('无效推理档位；模型是否支持仍由后端校验。');
      this.peer(route).effort = arg; this.save(); return `后续微信任务推理档位：${arg}；不支持的组合由后端拒绝。`;
    }
    const s = this.selected(route);
    if (command === '/files') {
      const files = (this.peer(route).exports?.[binding(s)] || (this.peer(route).files || []).filter(file => binding(file) === binding(s)));
      return message('交付文件', files.map((file, i) => `${i + 1}. ${inlineCode(file.path)}`).join('\n') || '该会话暂无标记的交付文件。', actionHint('发送已有文件（替换路径或编号）', '/f <相对路径或编号>'));
    }
    if (command === '/send' || command === '/file') {
      if (!arg) throw new UserError(message('请指定文件', '填写文件编号或当前会话工作目录内的路径。', actionHint('发送文件（替换路径或编号）', '/f <相对路径或编号>'), actionHint('查看交付文件', '/files')));
      const files = (this.peer(route).exports?.[binding(s)] || (this.peer(route).files || []).filter(file => binding(file) === binding(s)));
      const requested = /^\d+$/.test(arg) ? files[Number(arg) - 1]?.path : arg;
      if (!requested) throw new UserError(message('文件编号不存在', actionHint('查看交付文件', '/files')));
      const file = await this.publishFile(route, s, requested);
      return message('附件已加入发送队列', codeBlock(file?.fileName || requested), '收到后请检查内容；入队不代表已经送达。');
    }
    if (command === '/resume') return this.confirm(route, 'resume', s);
    if (['/archive', '/unarchive', '/delete'].includes(command)) return this.confirm(route, command.slice(1), s);
    if (command === '/status') {
      const result = await this.call(s.backend, 'thread/read', { threadId: s.threadId });
      return message('当前会话', `**会话**：${inlineCode(brief(s))}`, `**状态**：${inlineCode(result.thread.status?.type)}`, `**目录**\n\n${codeBlock(result.thread.cwd)}`,
        this.state.channelThreads[binding(s)] ? '**微信工具**：已启用' : '**微信工具**：旧会话未注册', !this.state.channelThreads[binding(s)] && actionHint('新建工具会话', '/n'), !s.live && '当前仅历史可见。');
    }
    if (command === '/history') {
      const peer = this.peer(route);
      const result = await this.call(s.backend, 'thread/turns/list', { threadId: s.threadId, limit: 5, itemsView: 'full', ...(arg === 'next' && peer.historyCursor ? { cursor: peer.historyCursor } : {}) });
      peer.historyCursor = result.nextCursor || null; this.save();
      return message('会话历史', (result.data || []).map(t => `### ${t.id.slice(0, 8)} · ${t.status}\n\n${(t.items || []).map(i => i.type === 'agentMessage' ? `**助手**\n\n${i.text || ''}` : i.type === 'userMessage' ? `**用户**\n\n${(i.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')}` : '').filter(Boolean).join('\n\n')}`).join('\n\n') || '暂无历史。', peer.historyCursor && actionHint('下一页', '/hist next'));
    }
    if (command === '/watch') { await this.attach(route); this.addRoute(s, route, true); return `已订阅 ${brief(s)}；进度限频，完成结果单独回传。`; }
    if (command === '/unwatch') { const r = this.routes.get(binding(s))?.get(route.peer); if (r) r.watch = false; return '已停止该会话的进度推送。'; }
    if (command === '/stop' || command === '/steer') {
      await this.attach(route); const turnId = await this.activeTurn(s);
      if (command === '/stop') { await this.call(s.backend, 'turn/interrupt', { threadId: s.threadId, turnId }); return '已请求中断；以最终 interrupted 状态为准。'; }
      if (!arg) throw new UserError(message('请填写追加指令', actionHint('替换内容后发送', '/+ <追加指令>')));
      await this.call(s.backend, 'turn/steer', { threadId: s.threadId, expectedTurnId: turnId, input: [{ type: 'text', text: arg }] }); return '已向指定运行任务追加指令。';
    }
    if (command === '/rename') { if (!arg || arg.length > 200) throw new UserError('名称需为1至200字符。'); await this.call(s.backend, 'thread/name/set', { threadId: s.threadId, name: arg }); return '会话已重命名。'; }
    if (command === '/fork') {
      await this.attach(route); const result = await this.call(s.backend, 'thread/fork', { threadId: s.threadId, excludeTurns: true });
      const fork = { backend: s.backend, threadId: result.thread.id, cwd: result.thread.cwd || s.cwd, live: true };
      this.peer(route).selected = fork; this.attached.add(binding(fork)); this.addRoute(fork, route); this.save(); return `已创建并切换分支 ${brief(fork)}`;
    }
    if (command === '/skills') { const r = await this.call(s.backend, 'skills/list', { cwds: [s.cwd] }); return message('可用技能', (r.data || []).flatMap(x => x.skills || []).map(x => `- ${inlineCode(x.name)}：${x.description || ''}`).join('\n') || '没有技能。'); }
    if (command === '/mcp') { const r = await this.call(s.backend, 'mcpServerStatus/list', { limit: 100 }); return message('MCP 状态', (r.data || []).map(x => `- ${inlineCode(x.name)}：${x.authStatus || 'unknown'}`).join('\n') || '没有MCP状态。'); }
    throw new UserError(message('未知命令', actionHint('查看帮助', '/h')));
  }
  projects() { return [{ name: 'default', workspace: this.config.newSessionWorkspace || this.config.workspace, sandbox: this.config.newSessionSandbox || this.config.sandbox, backend: this.config.newSessionBackend || (this.backends.has('local') ? 'local' : 'bridge') }, ...(this.config.projects || [])]; }
  close() {
    this.closed = true; for (const off of this.handlers) off();
    for (const item of this.approvals.values()) { clearTimeout(item.timer); try { this.answerRequest(item, false); } catch {} }
    this.approvals.clear(); this.confirmations.clear();
    // Shared tasks are not killed on controller disconnect.
  }
}
