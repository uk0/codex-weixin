import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Store } from '../lib/store.js';
import { SessionController, UserError } from '../lib/sessions.js';
import { CodexClient, websocketTarget } from '../lib/codex.js';
import { Bridge } from '../lib/bridge.js';

class Backend extends EventEmitter {
  constructor(threads = []) { super(); this.threads = new Map(threads.map(t => [t.id, t])); this.calls = []; this.answers = []; this.closed = false; }
  async request(method, params) {
    this.calls.push({ method, params });
    const t = this.threads.get(params.threadId);
    if (method === 'thread/loaded/list') return { data: [...this.threads.values()].filter(t => t.loaded).map(t => t.id) };
    if (method === 'thread/list') return { data: [...this.threads.values()], nextCursor: null };
    if (method === 'thread/read') { if (!t) throw new Error('missing'); return { thread: { ...t, status: { type: t.active ? 'active' : t.loaded ? 'idle' : 'notLoaded' } } }; }
    if (method === 'thread/resume') { t.loaded = true; return { thread: { ...t, status: { type: t.active ? 'active' : 'idle' } }, cwd: t.cwd }; }
    if (method === 'thread/start' || method === 'thread/fork') {
      const thread = { id: `new-${this.threads.size}`, cwd: params.cwd || t?.cwd, source: 'appServer', loaded: true };
      this.threads.set(thread.id, thread); return { thread };
    }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-live', status: t.active ? 'inProgress' : 'completed', items: [{ type: 'agentMessage', text: '历史回答' }, { type: 'commandExecution', aggregatedOutput: 'secret not to forward' }] }], nextCursor: null };
    if (method === 'turn/interrupt') { t.active = false; this.resolveRun?.('中断后的终态'); return {}; }
    if (method === 'model/list') return { data: [{ id: 'test-model', model: 'test-model' }] };
    if (['turn/steer', 'thread/name/set', 'thread/delete', 'thread/archive', 'thread/unarchive'].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  }
  send(message) { this.answers.push(message); }
  async run(id, text, options) {
    this.threads.get(id).active = true; options.onStarted('turn-live');
    return new Promise(resolve => { this.resolveRun = resolve; });
  }
}
const thread = (id, loaded = true) => ({ id, loaded, name: id, cwd: '/project', source: 'cli' });
const route = { peer: 'owner-hash', sender: 'owner', context: 'ctx' };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = new Backend([thread('live-a'), thread('history-a', false)]);
  const bridge = new Backend([thread('own-a')]);
  const store = new Store(root); const config = { workspace: root, sandbox: 'read-only', allowUsers: ['owner'] };
  const pushed = [];
  const controller = new SessionController({ store, config, backends: new Map([['bridge', { client: bridge, catalog: false }], ['local', { client: local }]]), publish: async (r, text) => pushed.push({ r, text }) });
  t.after(() => controller.close());
  return { root, local, bridge, store, config, pushed, controller };
}

test('catalog aggregates loaded ownership and historical sources without resuming', async t => {
  const x = setup(t); const result = await x.controller.dispatch('/sessions', route);
  assert.match(result, /live-a/); assert.match(result, /历史\/其他后端/); assert.match(result, /own-a/);
  assert(![...x.local.calls, ...x.bridge.calls].some(c => c.method === 'thread/resume'));
  assert(x.local.calls.find(c => c.method === 'thread/list').params.sourceKinds.includes('subAgent'));
});
test('attach loaded thread preserves cwd, sandbox, model and approval configuration', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  assert.deepEqual(x.local.calls.find(c => c.method === 'thread/resume').params, { threadId: 'live-a', excludeTurns: true });
});
test('history-only selection is read-only; resume requires bound one-time confirmation', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:history-a', route);
  assert(!x.local.calls.some(c => c.method === 'thread/resume'));
  await assert.rejects(x.controller.dispatch('execute', route), /申请恢复/);
  const history = await x.controller.dispatch('/history', route); assert.match(history, /历史回答/); assert(!history.includes('secret'));
  const prompt = await x.controller.dispatch('/resume', route); const code = prompt.match(/\/confirm ([a-f0-9]+)/)[1];
  await assert.rejects(x.controller.dispatch(`/confirm ${code}`, { ...route, peer: 'other' }), /尚未选择会话|确认码/);
  await x.controller.dispatch(`/confirm ${code}`, route);
  await assert.rejects(x.controller.dispatch(`/confirm ${code}`, route), /无效/);
});
test('confirmation expires and cannot apply to another selected thread', async t => {
  const x = setup(t); let now = 1000; x.controller.now = () => now;
  await x.controller.dispatch('/use local:history-a', route);
  const code = (await x.controller.dispatch('/delete', route)).match(/\/confirm ([a-f0-9]+)/)[1];
  now += 120001; await assert.rejects(x.controller.dispatch(`/confirm ${code}`, route), /过期/);
  const newCode = (await x.controller.dispatch('/delete', route)).match(/\/confirm ([a-f0-9]+)/)[1];
  await x.controller.dispatch('/use local:live-a', route);
  await assert.rejects(x.controller.dispatch(`/confirm ${newCode}`, route), /不匹配/);
  assert(!x.local.calls.some(c => c.method === 'thread/delete'));
});
test('active execution does not block other commands, steer uses expectedTurnId and stop the exact turn', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  assert.equal(await x.controller.dispatch('long task', route), '');
  await x.controller.jobs.get('local:live-a').started;
  assert.match(await x.controller.dispatch('/status', route), /active/);
  await x.controller.dispatch('/steer additional', route);
  assert.deepEqual(x.local.calls.find(c => c.method === 'turn/steer').params, { threadId: 'live-a', expectedTurnId: 'turn-live', input: [{ type: 'text', text: 'additional' }] });
  await x.controller.dispatch('/stop', route); await Promise.all([...x.controller.background]);
  assert.deepEqual(x.local.calls.find(c => c.method === 'turn/interrupt').params, { threadId: 'live-a', turnId: 'turn-live' });
  assert(x.pushed.some(p => p.text === '中断后的终态'));
});
test('same session cannot accept a second running task', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  await x.controller.dispatch('first', route); await assert.rejects(x.controller.dispatch('second', route), /已有任务/);
  await x.controller.jobs.get('local:live-a').started; x.local.resolveRun('done'); await Promise.all([...x.controller.background]);
});
test('requests for unrelated sessions are neither accepted nor declined', t => {
  const x = setup(t); x.local.emit('serverRequest', { id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'unrelated', turnId: 't', command: 'echo x' } });
  assert.equal(x.local.answers.length, 0); assert.equal(x.controller.approvals.size, 0);
});
test('approval is bound to peer/backend/request and grants once, not for session', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'live-a', turnId: 't', command: 'echo x' } });
  const [code] = x.controller.approvals.keys();
  await assert.rejects(x.controller.dispatch(`/approve ${code}`, { ...route, peer: 'wrong-owner' }), /不属于/);
  await x.controller.dispatch(`/approve ${code}`, route);
  assert.deepEqual(x.local.answers, [{ id: 77, result: { decision: 'accept' } }]);
  await assert.rejects(x.controller.dispatch(`/approve ${code}`, route), /不存在/);
});
test('resolved requests and completed turns invalidate approval codes', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'live-a', turnId: 't' } });
  x.local.emit('notification', { method: 'serverRequest/resolved', params: { requestId: 1, threadId: 'live-a' } });
  assert.equal(x.controller.approvals.size, 0);
  x.local.emit('serverRequest', { id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'live-a', turnId: 't' } });
  x.local.emit('notification', { method: 'turn/completed', params: { threadId: 'live-a', turn: { id: 't', status: 'completed' } } });
  assert.equal(x.controller.approvals.size, 0);
});
test('interactive question answers validate question IDs and use protocol schema', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'live-a', questions: [{ id: 'choice', question: 'which?' }] } });
  const [code] = x.controller.approvals.keys();
  await assert.rejects(x.controller.dispatch(`/approve ${code}`, route), /\/answer/);
  await assert.rejects(x.controller.dispatch(`/answer ${code} {"wrong":["a"]}`, route), /问题ID/);
  await x.controller.dispatch(`/answer ${code} {"choice":["a"]}`, route);
  assert.deepEqual(x.local.answers[0].result, { answers: { choice: { answers: ['a'] } } });
});
test('permission decisions are limited to requested permissions and a single turn', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 4, method: 'item/permissions/requestApproval', params: { threadId: 'live-a', permissions: { network: { enabled: true } } } });
  const [code] = x.controller.approvals.keys(); await x.controller.dispatch(`/approve ${code}`, route);
  assert.deepEqual(x.local.answers[0].result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});
test('new projects are locally allowlisted and default read-only', async t => {
  const x = setup(t); await assert.rejects(x.controller.dispatch('/new /etc', route), /未在本机授权/);
  await x.controller.dispatch('/new', route);
  const call = x.local.calls.find(c => c.method === 'thread/start');
  assert.equal(call.params.sandbox, 'read-only'); assert.equal(call.params.approvalPolicy, 'on-request');
});
test('model choices are checked against backend availability; arbitrary RPC is not exposed', async t => {
  const x = setup(t); await assert.rejects(x.controller.dispatch('/model invented', route), /可用列表/);
  await x.controller.dispatch('/model test-model', route); assert.equal(x.store.read('control').peers[route.peer].model, 'test-model');
  await x.controller.dispatch('/use local:live-a', route); await assert.rejects(x.controller.dispatch('/rpc config/read', route), /未知命令/);
});
test('simultaneous outbox pumps cannot duplicate a send; controller remains behind Bridge allowlist', async t => {
  const x = setup(t); const sends = [];
  const bridge = new Bridge({ store: x.store, config: x.config, account: { botId: 'bot' }, controller: x.controller,
    weixin: { send: async (...args) => { await delay(10); sends.push(args); } } });
  bridge.queueReply(route, 'result'); await Promise.all([bridge.flushOutbox(), bridge.flushOutbox()]); assert.equal(sends.length, 1);
  const before = x.local.calls.length;
  await bridge.handle({ message_id: 1, message_type: 1, from_user_id: 'stranger', context_token: 'x', item_list: [{ type: 1, text_item: { text: '/sessions' } }] });
  assert.equal(x.local.calls.length, before);
});
test('same thread loaded by two backends is marked conflict and cannot be selected by catalog number', async t => {
  const x = setup(t); x.bridge.threads.set('live-a', thread('live-a'));
  await x.controller.dispatch('/sessions', route);
  const rows = x.controller.peer(route).rows; const index = rows.findIndex(r => r.threadId === 'live-a') + 1;
  await assert.rejects(x.controller.dispatch(`/use ${index}`, route), /冲突/);
});
test('remote transport refuses plaintext public hosts and URL-embedded credentials', () => {
  assert.throws(() => websocketTarget('ws://example.com'), /local/);
  assert.throws(() => websocketTarget('wss://x:y@example.com'), /local/);
  assert.throws(() => websocketTarget('wss://example.com'), /token/);
  assert.throws(() => websocketTarget('ws://127.0.0.1:1234?token=secret'), /local/);
});
test('real WebSocket transport handles JSON-RPC; disconnect does not kill a shared server', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let requests = 0;
  server.on('connection', socket => socket.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (m.id === undefined) return; requests++;
    socket.send(JSON.stringify({ id: m.id, result: m.method === 'thread/loaded/list' ? { data: ['live'] } : {} }));
  }));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  const first = new CodexClient({ endpoint, interactive: true }); await first.connect();
  assert.deepEqual(await first.request('thread/loaded/list', {}), { data: ['live'] }); first.close();
  const second = new CodexClient({ endpoint, passive: true }); await second.connect(); second.close();
  assert.equal(requests, 3);
});

test('explicit backend selection cannot bypass multi-backend ownership conflict', async t => {
  const x = setup(t); x.bridge.threads.set('live-a', thread('live-a'));
  await assert.rejects(x.controller.dispatch('/use local:live-a', route), /多个已接入后端/);
});
test('external watched final answers bypass progress throttling', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route); await x.controller.dispatch('/watch', route);
  x.local.emit('notification', { method: 'item/started', params: { threadId: 'live-a', item: { id: 'tool', type: 'commandExecution' } } });
  x.local.emit('notification', { method: 'item/completed', params: { threadId: 'live-a', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'FINAL_NOT_DROPPED' } } });
  await Promise.all([...x.controller.background]); assert(x.pushed.some(x => x.text.includes('FINAL_NOT_DROPPED')));
});
test('MCP form rejects unexpected properties and wrong scalar types', async t => {
  const x = setup(t); await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'live-a', mode: 'form', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } } });
  const [code] = x.controller.approvals.keys();
  await assert.rejects(x.controller.dispatch(`/answer ${code} {"confirm":"true"}`, route), /类型/);
  await assert.rejects(x.controller.dispatch(`/answer ${code} {"confirm":true,"extra":1}`, route), /不匹配/);
  await x.controller.dispatch(`/answer ${code} {"confirm":true}`, route);
  assert.deepEqual(x.local.answers[0].result, { action: 'accept', content: { confirm: true } });
});

test('a shared watch subscription does not consume another client private dynamic-tool request', async t => {
  const x = setup(t); x.local.endpoint = 'unix://';
  await x.controller.dispatch('/use local:live-a', route);
  x.local.emit('serverRequest', { id: 8, method: 'item/tool/call', params: { threadId: 'live-a', turnId: 'original-client-turn', tool: 'private_desktop_tool' } });
  assert.equal(x.local.answers.length, 0);
});
