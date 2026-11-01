import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Store } from '../lib/store.js';
import { WeixinClient, safeBase, splitText } from '../lib/weixin.js';
import { login } from '../lib/login.js';
import { CodexClient } from '../lib/codex.js';
import { Bridge } from '../lib/bridge.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/fake-codex.js');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-weixin-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const msg = (id = 1, text = '你好', extra = {}) => ({ message_id: id, message_type: 1, message_state: 2, from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 1, text_item: { text } }], ...extra });
function setup(t, extra = {}) {
  const root = temp(t); const store = new Store(root);
  const calls = []; const replies = [];
  const config = { version: 1, workspace: root, sandbox: 'read-only', allowUsers: ['owner'] };
  const account = { botId: 'bot', token: 'token', userId: 'owner' };
  const codex = { thread: async id => { calls.push(['thread', id]); return id || 'thread-1'; }, run: async (id, text) => { calls.push(['run', id, text]); return `答复：${text}`; } };
  const weixin = { send: async (...args) => { replies.push(args); }, updates: async () => ({ ret: 0, msgs: [msg()], get_updates_buf: 'next' }) };
  const bridge = new Bridge({ store, config, account, codex, weixin, log: () => {}, ...extra });
  return { root, store, calls, replies, config, account, codex, weixin, bridge };
}

test('store is private, refuses corrupt state, and has an exclusive lock', t => {
  const store = new Store(temp(t)); store.write('state', { ok: 1 });
  assert.deepEqual(store.read('state'), { ok: 1 });
  assert.equal(fs.statSync(path.join(store.root, 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
  const release = store.lock(); assert.throws(() => store.lock(), /locked/); release();
  fs.writeFileSync(path.join(store.root, 'state.json'), '{'); assert.throws(() => store.read('state'), /restore a backup/);
});
test('host validation blocks lookalike hosts, userinfo, http and paths', () => {
  assert.equal(safeBase('ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
  for (const bad of ['https://weixin.qq.com.evil.test', 'https://evilweixin.qq.com', 'https://evil.test', 'http://ilinkai.weixin.qq.com', 'https://x@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com:8443']) assert.throws(() => safeBase(bad));
  assert.throws(() => safeBase('http://127.0.0.1:3000'));
});
test('UTF-8 chunking preserves Chinese and emoji without splitting code points', () => {
  const text = '中文😀'.repeat(1000); const chunks = splitText(text);
  assert.equal(chunks.join(''), text); assert(chunks.every(x => Buffer.byteLength(x) <= 1800));
});
test('authorized input -> Codex -> Weixin reply -> durable cursor; replay does not execute', async t => {
  const x = setup(t); await x.bridge.pollOnce(); await x.bridge.pollOnce();
  assert.equal(x.calls.filter(x => x[0] === 'run').length, 1);
  assert.equal(x.replies[0][0], 'owner'); assert.equal(x.replies[0][1], 'ctx'); assert.equal(x.replies[0][2], '答复：你好');
  assert.equal(x.store.read('state').cursor, 'next');
  const persisted = fs.readFileSync(path.join(x.root, 'state.json'), 'utf8');
  assert(!persisted.includes('ctx')); assert(!persisted.includes('答复'));
});
test('unauthorized senders, bot echoes, partial messages and groups cannot execute', async t => {
  const x = setup(t);
  for (const extra of [{ from_user_id: 'stranger' }, { group_id: 'g' }, { message_type: 2 }, { message_state: 1 }, { context_token: '' }, { message_id: undefined }]) await x.bridge.handle(msg(1, 'danger', extra));
  assert.equal(x.calls.length, 0); assert.equal(x.replies.length, 0);
});
test('persistent sessions resume, /new resets, unsupported media do not execute', async t => {
  const x = setup(t); await x.bridge.handle(msg(1));
  const restarted = new Bridge(x.bridge); await restarted.handle(msg(2, '第二条'));
  assert.equal(x.calls.filter(x => x[0] === 'thread')[1][1], 'thread-1');
  await restarted.handle(msg(3, '/new')); await restarted.handle(msg(4));
  assert.equal(x.calls.filter(x => x[0] === 'thread')[2][1], undefined);
  await restarted.handle(msg(5, '', { item_list: [{ type: 4, file_item: { file_name: 'x' } }] }));
  assert.equal(x.calls.filter(x => x[0] === 'run').length, 3);
});
test('failed reply stays in durable outbox; restart retries same client id, not Codex', async t => {
  const x = setup(t); let firstId;
  x.weixin.send = async (...args) => { firstId = args[3]; throw new Error('network'); };
  await assert.rejects(x.bridge.pollOnce(), /network/);
  assert.equal(x.store.read('state').cursor, '');
  const restarted = new Bridge({ ...x.bridge, weixin: { ...x.weixin, send: async (...args) => x.replies.push(args) } });
  await restarted.pollOnce();
  assert.equal(x.calls.filter(x => x[0] === 'run').length, 1);
  assert.equal(x.replies[0][3], firstId); assert.equal(x.store.read('state').cursor, 'next');
});
test('interrupted execution is reported on restart without replaying side effects', async t => {
  const x = setup(t); const state = x.store.read('state');
  state.entries.crash = { status: 'running', sender: 'owner', context: 'ctx', sent: 0, replies: [] };
  x.store.write('state', state);
  const restarted = new Bridge(x.bridge);
  x.weixin.updates = async () => ({ msgs: [] }); await restarted.pollOnce();
  assert.equal(x.calls.length, 0); assert.match(x.replies[0][2], /不会自动重跑/);
});
test('Codex failure is not retried and raw errors are not sent to Weixin', async t => {
  const x = setup(t); x.codex.run = async () => { throw new Error('secret-token'); };
  await x.bridge.handle(msg()); await x.bridge.handle(msg());
  assert.equal(x.replies.length, 1); assert(!x.replies[0][2].includes('secret-token'));
});
test('account change is rejected before processing', t => {
  const x = setup(t); assert.throws(() => new Bridge({ ...x.bridge, account: { botId: 'different' } }), /Account changed/);
});
test('Codex JSON-RPC handles early events, final phase and thread isolation', async t => {
  const c = new CodexClient({ command: process.execPath, args: [fixture], cwd: temp(t) }); t.after(() => c.close());
  await c.connect(); const id = await c.thread(null, { workspace: c.cwd, sandbox: 'read-only' });
  assert.equal(await c.run(id, '测试'), '答复：测试');
  assert.equal(await c.thread(id, { workspace: c.cwd, sandbox: 'read-only' }), id);
  await assert.rejects(c.run(id, 'FAIL'), /failed/);
});
test('Codex process exit rejects promptly', async t => {
  const c = new CodexClient({ command: process.execPath, args: [fixture], cwd: temp(t) }); t.after(() => c.close());
  await c.connect(); await assert.rejects(c.run('thread-1', 'CRASH'), /exited/);
});
test('Codex turn deadline terminates the worker', async t => {
  const c = new CodexClient({ command: process.execPath, args: [fixture], cwd: temp(t), turnTimeoutMs: 100 }); t.after(() => c.close());
  await c.connect(); await assert.rejects(c.run('thread-1', 'SLOW'), /timed out/);
  assert(c.closed);
});
test('install persists runtime outside npx cache, does not overwrite configuration', t => {
  const root = temp(t); const cli = path.join(here, '../bin/codex-weixin.js');
  const args = [cli, 'install', '--workspace', root, '--state-dir', path.join(root, 'state'), '--codex', fixture, '--no-login'];
  execFileSync(process.execPath, args);
  assert(fs.existsSync(path.join(root, 'state/runtime/lib/bridge.js')));
  assert(fs.existsSync(path.join(root, 'state/runtime/node_modules/qrcode-terminal/lib/main.js')));
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('qrcode-terminal')"], { cwd: path.join(root, 'state/runtime') });
  const config = JSON.parse(fs.readFileSync(path.join(root, 'state/config.json'))); assert.equal(config.sandbox, 'read-only');
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Command failed/);
  const status = JSON.parse(execFileSync(process.execPath, [path.join(root, 'state/runtime/bin/codex-weixin.js'), 'status', '--state-dir', path.join(root, 'state')], { encoding: 'utf8' }));
  assert.equal(status.weixinCredentialsStored, false); assert.equal(status.lockPresent, false);
});

async function server(t, handler) {
  const srv = http.createServer(handler); await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  return `http://127.0.0.1:${srv.address().port}`;
}
test('real HTTP serialization, token headers, cursor and context are correct', async t => {
  const requests = [];
  const baseUrl = await server(t, async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    requests.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('getupdates') ? { ret: 0, msgs: [msg()], get_updates_buf: 'next' } : { ret: 0 }));
  });
  const x = setup(t); x.bridge.weixin = new WeixinClient({ baseUrl, token: 'dummy-token', allowLocal: true });
  await x.bridge.pollOnce();
  assert.equal(requests[0].body.get_updates_buf, ''); assert.equal(requests[0].headers.authorization, 'Bearer dummy-token');
  assert.equal(requests[1].body.msg.context_token, 'ctx'); assert.equal(requests[1].body.msg.message_type, 2);
  assert.equal(requests[1].body.msg.item_list[0].text_item.text, '答复：你好');
});
test('HTTP 429, application -14, HTML errors and timeout are distinguished', async t => {
  let mode = '429';
  const baseUrl = await server(t, (req, res) => {
    if (mode === 'timeout') return;
    if (mode === '429') { res.writeHead(429); res.end('rate limit'); }
    else if (mode === 'html') res.end('<html>error</html>');
    else res.end('{"ret":-14}');
  });
  const client = new WeixinClient({ baseUrl, token: 'dummy', allowLocal: true, timeoutMs: 50 });
  await assert.rejects(client.send('owner', 'ctx', 'test'), e => e.status === 429);
  mode = 'expired'; await assert.rejects(client.send('owner', 'ctx', 'test'), e => e.code === -14);
  mode = 'html'; await assert.rejects(client.send('owner', 'ctx', 'test'), /invalid JSON/);
  mode = 'timeout'; await assert.rejects(client.send('owner', 'ctx', 'test'), e => e.code === 'TIMEOUT');
});
test('QR login uses unauthenticated GET status and stores verified owner identity', async t => {
  let sawQr; let sawStatus;
  const baseUrl = await server(t, async (req, res) => {
    if (req.url.includes('get_bot_qrcode')) {
      let text = ''; for await (const c of req) text += c;
      sawQr = { method: req.method, headers: req.headers, body: JSON.parse(text) };
      res.end('{"qrcode":"code","qrcode_img_content":"https://example.invalid/qr"}');
    } else { sawStatus = { method: req.method, headers: req.headers }; res.end(JSON.stringify({ status: 'confirmed', bot_token: 'dummy', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: baseUrl })); }
  });
  const account = await login(new WeixinClient({ baseUrl, allowLocal: true }), { showQr: async value => assert.match(value, /qr/), verify: async () => '123456' });
  assert.equal(sawQr.method, 'POST'); assert.deepEqual(sawQr.body, { local_token_list: [] });
  assert.equal(sawQr.headers.authorization, undefined); assert.equal(sawStatus.method, 'GET');
  assert.equal(sawStatus.headers.authorizationtype, undefined); assert.equal(account.userId, 'owner');
});
test('untrusted QR redirect is rejected before any credential transmission', async () => {
  const client = { baseUrl: 'https://ilinkai.weixin.qq.com', qr: async () => ({ qrcode: 'x', qrcode_img_content: 'x' }), qrStatus: async () => ({ status: 'scaned_but_redirect', redirect_host: 'evil.test' }) };
  await assert.rejects(login(client, { showQr: async () => {} }), /Untrusted/);
});
