import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.js';
import { Bridge } from '../lib/bridge.js';
import { SessionController } from '../lib/sessions.js';
import { CHANNEL_TOOLS, toolPayload, weixinPlainText } from '../lib/channel-tools.js';
import { readWorkspaceFile } from '../lib/files.js';
const route = { peer: 'qa', sender: 'owner', context: 'test-context' };
function fixture(t, weixin = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '报告.txt'), 'test content');
  const store = new Store(path.join(root, 'state'));
  return { root, store, bridge: new Bridge({ store, config: {}, account: { botId: 'test' }, weixin }) };
}
test('channel tools cannot set recipient, cwd, arbitrary RPC or unknown fields', () => {
  assert.equal(CHANNEL_TOOLS.length, 5);
  assert.deepEqual(toolPayload('weixin_send_file', { path: '报告.txt' }), { type: 'file', path: '报告.txt' });
  for (const args of [{ path: 'x', to: 'stranger' }, { path: 'x', cwd: '/' }, [], null, { path: '' }]) assert.throws(() => toolPayload('weixin_send_file', args));
  assert.throws(() => toolPayload('thread/delete', { text: 'x' }));
});
test('absolute paths through the selected cwd alias work without allowing descendant symlinks', t => {
  const x = fixture(t); const alias = path.join(x.root, 'cwd-alias'); fs.symlinkSync(x.root, alias);
  assert.equal(readWorkspaceFile(alias, path.join(alias, '报告.txt')).data.toString(), 'test content');
  fs.symlinkSync(path.join(x.root, '报告.txt'), path.join(x.root, 'child-link.txt'));
  assert.throws(() => readWorkspaceFile(alias, 'child-link.txt'), /符号链接/);
});
test('Weixin plain text removes presentation Markdown, preserving readable links and code', () => {
  assert.equal(weixinPlainText('# 标题\n**重点**\n[文档](https://example.test)\n```js\nconst x = 1;\n```'), '标题\n重点\n文档 (https://example.test)\n\nconst x = 1;');
  assert.equal(weixinPlainText('```py\nx ** y\n```'), 'x ** y');
  assert.equal(weixinPlainText('`**not bold**`'), '**not bold**');
});
test('Markdown is preserved by default; plain text is an explicit compatibility option', async t => {
  const sent = []; const x = fixture(t, { send: async (to, context, text) => sent.push(text) });
  const markdown = '# 标题\n**加粗**\n- 列表\n```js\nconst n = 1;\n```';
  x.bridge.queueReply(route, markdown); await x.bridge.flushOutbox(); assert.equal(sent[0], markdown);
  x.bridge.config.messageFormat = 'plain'; x.bridge.queueReply(route, markdown); await x.bridge.flushOutbox();
  assert(!sent[1].includes('**')); assert(sent[1].includes('const n = 1;'));
});
test('file tool waits for send acceptance, deduplicates concurrent and replayed calls', async t => {
  let sent = 0; const x = fixture(t, { uploadFile: async () => ({}), sendFile: async () => { await delay(30); sent++; } });
  const payload = { type: 'file', path: '报告.txt', cwd: x.root, deliveryKey: ['local', 'thread', 'turn', 'call'] };
  let finished = false;
  const first = x.bridge.sendAction(route, payload).then(r => { finished = true; return r; });
  const duplicate = x.bridge.sendAction(route, payload);
  await delay(15); assert.equal(finished, false); assert.equal(sent, 0);
  await x.bridge.flushOutbox();
  for (const receipt of await Promise.all([first, duplicate])) { assert.equal(receipt.accepted, true); assert.equal(receipt.userConfirmed, false); }
  const restarted = new Bridge({ store: x.store, config: {}, account: { botId: 'test' }, weixin: {} });
  assert.equal((await restarted.sendAction(route, payload)).accepted, true);
  assert.equal(sent, 1); assert.equal(fs.readdirSync(x.bridge.spool.root).length, 0);
  await assert.rejects(restarted.sendAction(route, { ...payload, path: 'other.txt' }), /identity/);
});
test('timeout is unknown, not successful; replay keeps the same queued action', async t => {
  const x = fixture(t); const payload = { type: 'file', path: '报告.txt', cwd: x.root, deliveryKey: ['one'] };
  const result = await x.bridge.sendAction(route, payload, { timeoutMs: 1 });
  assert.equal(result.accepted, false); assert.equal(result.retry, false); assert.equal(result.status, 'pending_or_unknown');
  assert.equal(Object.keys(x.bridge.state.entries).length, 1);
  assert.equal((await x.bridge.sendAction(route, payload, { timeoutMs: 1 })).entryId, result.entryId);
});
test('permanent failure is not returned to Codex as successful sending', async t => {
  const x = fixture(t, { send: async () => {}, uploadFile: async () => { throw Object.assign(new Error('denied'), { permanent: true }); } });
  const result = x.bridge.sendAction(route, { type: 'file', path: '报告.txt', cwd: x.root, deliveryKey: ['denied'] });
  await x.bridge.flushOutbox(); assert.equal((await result).accepted, false);
});
test('only owned, matching turns get channel tools; route and cwd come from job, not model/watch', async t => {
  const x = fixture(t); const client = new EventEmitter(); const answers = []; client.send = m => answers.push(m); client.endpoint = 'unix://';
  const actions = []; const controller = new SessionController({ store: x.store, config: {}, backends: new Map([['local', { client }]]), sendAction: async (r, p) => { actions.push({ r, p }); return { accepted: true }; } }); t.after(() => controller.close());
  controller.routes.set('local:thread', new Map([['watcher', { ...route, sender: 'wrong' }]]));
  controller.state.channelThreads['local:thread'] = { version: 1 };
  const msg = { id: 'server-1', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'weixin_send_file', arguments: { path: '报告.txt' } } };
  controller.onRequest('local', msg); assert.equal(actions.length, 0);
  controller.jobs.set('local:thread', { started: Promise.resolve(), turnId: 'other', origin: route, cwd: x.root });
  controller.onRequest('local', msg); await Promise.all([...controller.background]); assert.equal(actions.length, 0);
  controller.jobs.get('local:thread').turnId = 'turn'; controller.onRequest('local', msg); await Promise.all([...controller.background]);
  assert.equal(actions.length, 1); assert.equal(actions[0].r.sender, 'owner'); assert.equal(actions[0].p.cwd, x.root);
  assert.equal(answers[0].result.success, true);
});
