import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { SessionController } from '../lib/sessions.js';
import { Bridge } from '../lib/bridge.js';
import { splitMarkdown } from '../lib/presentation.js';
import { confirmationMessage, approvalMessage, helpMessage, codeBlock, controlMarkdown, moreMessage } from '../lib/messages.js';
import { StyleBackend } from './fixtures/style-backend.js';

const route = { peer: 'style-owner', sender: 'owner', context: 'test-context' };
const blocks = text => [...text.matchAll(/^```(?:\w*)\n([\s\S]*?)\n```$/gm)].map(m => m[1]);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-style-'));
  const store = new Store(root), client = new StyleBackend(root), pushed = [];
  const config = { workspace: root, sandbox: 'read-only', allowUsers: ['owner'] };
  const controller = new SessionController({ store, config, backends: new Map([['local', { client }]]), publish: async (r, text) => pushed.push(text) });
  t.after(() => { controller.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, client, config, controller, pushed };
}

test('confirmations have separate copyable commands and preserve them through splitting', () => {
  for (const action of ['resume', 'archive', 'unarchive', 'delete']) {
    const text = confirmationMessage(action, 'local/fixture', 'deadbeef');
    assert.match(text, /^## /); assert.match(text, /120 秒/);
    assert.deepEqual(blocks(text), ['/confirm deadbeef']);
    const chunks = splitMarkdown(text, 500);
    assert(chunks.every(c => Buffer.byteLength(c) <= 500));
    assert.deepEqual(chunks.flatMap(blocks), ['/confirm deadbeef']);
  }
});
test('approvals separate data from commands and distinguish questions/browser authorization', () => {
  const text = approvalMessage('local/fixture', 'deadbeef', 'item/commandExecution/requestApproval', '{"command":"echo x"}');
  assert.deepEqual(blocks(text), ['{"command":"echo x"}', '/ok deadbeef', '/no deadbeef']);
  const form = approvalMessage('local/fixture', 'deadbeef', 'item/tool/requestUserInput', '{}');
  assert(blocks(form).includes('/answer deadbeef {}')); assert(!form.includes('/ok '));
  const pending = approvalMessage('local/fixture', 'deadbeef', 'item/fileChange/requestApproval', '', { compact: true, remainingSeconds: 7 });
  assert.match(pending, /文件修改/); assert.match(pending, /7 秒/); assert(!pending.includes('120 秒'));
  const url = approvalMessage('local/fixture', 'deadbeef', 'mcpServer/elicitation/request', '{}', { urlMode: true });
  assert.match(url, /浏览器授权/); assert(!url.includes('/answer ')); assert(!url.includes('/ok '));
});
test('help uses one command per code block, including aliases and full help', () => {
  for (const all of [false, true]) {
    const commands = blocks(helpMessage(all)); assert(commands.length >= 12);
    assert(commands.every(c => c.startsWith('/') && !c.includes('\n')));
    assert(commands.includes('/s')); assert(commands.includes('/n'));
  }
});
test('data fences cannot be closed by embedded backticks; fallbacks retain Markdown', () => {
  assert.equal(codeBlock('x\n```\n/confirm not-a-real-code'), '````\nx\n```\n/confirm not-a-real-code\n````');
  assert.equal(controlMarkdown('first\nsecond'), '## 提示\n\nfirst\n\nsecond');
  assert.equal(controlMarkdown('## Title\n\n```js\nx\n```'), '## Title\n\n```js\nx\n```');
  assert.equal(controlMarkdown(''), '');
  assert.deepEqual(blocks(moreMessage(3, 'abcdef')), ['/more abcdef']);
});
test('formatted confirmation remains owner-bound, explicit, single-use and non-executing', async t => {
  const x = setup(t); await x.controller.dispatch('/u local:style-thread', route);
  const text = await x.controller.dispatch('/resume', route), [command] = blocks(text);
  assert.match(command, /^\/confirm [a-f0-9]{8}$/);
  assert(!x.client.calls.some(c => c.method === 'thread/resume'));
  await assert.rejects(x.controller.dispatch(command, { ...route, peer: 'stranger' }), /尚未选择|确认码/);
  await x.controller.dispatch(command, route);
  assert.equal(x.client.calls.filter(c => c.method === 'thread/resume').length, 1);
  await assert.rejects(x.controller.dispatch(command, route), /无效/);
});
test('controller command families are Markdown; history preserves model code blocks', async t => {
  const x = setup(t); await x.controller.dispatch('/u local:style-thread', route);
  for (const command of ['/h', '/h all', '/st', '/backends', '/s', '/p', '/models', '/skills', '/mcp', '/files', '/a', '/hist', '/unwatch', '/more']) {
    assert.match(await x.controller.dispatch(command, route), /^## /, command);
  }
  assert.match(await x.controller.dispatch('/hist', route), /```js\nconst x = 1;\n```/);
});
test('approval push and listing have matching codes and do not auto-approve', async t => {
  const x = setup(t); x.client.loaded = true; await x.controller.dispatch('/u local:style-thread', route);
  x.client.emit('serverRequest', { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'style-thread', command: 'echo test' } });
  await Promise.all([...x.controller.background]);
  const [code] = x.controller.approvals.keys();
  assert(blocks(x.pushed[0]).includes(`/ok ${code}`));
  assert(blocks(await x.controller.dispatch('/a', route)).includes(`/no ${code}`));
  assert.equal(x.client.answers.length, 0);
  await x.controller.dispatch(`/no ${code}`, route);
  assert.deepEqual(x.client.answers, [{ id: 9, result: { decision: 'decline' } }]);
});
test('bridge formats errors and legacy controls without decorating ordinary model answers', async t => {
  const x = setup(t), sent = [];
  const bridge = new Bridge({ store: x.store, config: x.config, account: { botId: 'test' }, log: () => {}, weixin: { send: async (peer, context, text) => sent.push(text) }, codex: { thread: async () => 't', run: async () => 'Plain model answer' } });
  let id = 0;
  const step = async text => { await bridge.handle({ message_id: ++id, message_type: 1, from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 1, text_item: { text } }] }); await bridge.flushOutbox(); };
  await step('task'); assert.equal(sent.pop(), 'Plain model answer');
  await step('/help'); assert.match(sent.pop(), /^## /);
  bridge.controller = { dispatch: async () => { throw new Error('private error'); } };
  await step('/st'); const failure = sent.pop(); assert.match(failure, /^## 控制请求失败/); assert.deepEqual(blocks(failure), ['/st']);
  bridge.queueReply(route, 'Model async answer'); await bridge.flushOutbox(); assert.equal(sent.pop(), 'Model async answer');
});
