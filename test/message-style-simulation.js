// Actual bridge + Weixin HTTP serialization; fake Codex backend and Postman Weixin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { SessionController } from '../lib/sessions.js';
import { Bridge } from '../lib/bridge.js';
import { WeixinClient } from '../lib/weixin.js';
import { StyleBackend } from './fixtures/style-backend.js';
const base = process.argv[2]; assert.match(base || '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-style-http-'));
const store = new Store(root), client = new StyleBackend(root);
const config = { workspace: root, sandbox: 'read-only', allowUsers: ['owner'] };
const weixin = new WeixinClient({ baseUrl: base + '/weixin', token: 'dummy-token', allowLocal: true });
const bridge = new Bridge({ store, config, account: { botId: 'style-test' }, weixin, log: () => {} });
const controller = new SessionController({ store, config, backends: new Map([['local', { client }]]), publish: (route, text) => bridge.queueReply(route, text) });
bridge.controller = controller;
const control = async body => { const r = await fetch(base + '/weixin/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); };
const state = async () => (await (await fetch(base + '/weixin/__state')).json()).replies;
let id = 0;
const step = async (text, items = [{ type: 1, text_item: { text } }]) => {
  const before = (await state()).length;
  await control({ messages: [{ message_id: ++id, message_type: 1, message_state: 2, from_user_id: 'owner', context_token: 'test-context', item_list: items }] });
  await bridge.pollOnce(); await bridge.flushOutbox();
  const texts = (await state()).slice(before).map(m => m.item_list[0].text_item.text);
  assert(texts.length > 0); assert(texts.every(t => Buffer.byteLength(t) <= 1800));
  assert.match(texts[0], /^## /);
  return texts.join('\n\n');
};
try {
  await control({ reset: true });
  await step('/u local:style-thread');
  const confirmation = await step('/resume');
  const command = confirmation.match(/^```\n(\/confirm [a-f0-9]{8})\n```$/m)?.[1];
  assert(command); assert.equal(client.calls.filter(c => c.method === 'thread/resume').length, 0);
  // Fresh mock-only code, never a code copied from a real user message.
  await step(command);
  assert.equal(client.calls.filter(c => c.method === 'thread/resume').length, 1);
  client.emit('serverRequest', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'style-thread', command: 'echo style-test', reason: 'mock-only approval' } });
  await Promise.all([...controller.background]); await bridge.flushOutbox();
  const [code] = controller.approvals.keys();
  const pending = await step('/a'); assert(pending.includes(`\n/ok ${code}\n`)); assert.equal(client.answers.length, 0);
  await step(`/no ${code}`); assert.deepEqual(client.answers, [{ id: 99, result: { decision: 'decline' } }]);
  for (const text of ['/h all', '/st', '/hist', '/files', '/f', '/unknown', '/p']) await step(text);
  await step('', [{ type: 2 }]);
  const replies = await state();
  const report = { result: 'PASS', environment: 'fake Codex backend + Postman Weixin HTTP stand-in', inboundMessages: id, textMessages: replies.length,
    confirmationCommandStandalone: true, noResumeBeforeExplicitMockConfirmation: true, approvalNotAutomatic: true, commandsSurviveHttpChunking: true,
    nativeCodexCalls: 0, realWeixinDelivery: false, visibleClientRenderingVerified: false };
  fs.mkdirSync('artifacts/message-style', { recursive: true });
  fs.writeFileSync('artifacts/message-style/simulation.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('artifacts/message-style/confirmation-preview.md', confirmation.replace(/\/confirm [a-f0-9]{8}/g, '/confirm <确认码>'));
  console.log(JSON.stringify(report, null, 2));
} finally { controller.close(); fs.rmSync(root, { recursive: true, force: true }); }
