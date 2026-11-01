#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Store, validateConfig } from '../lib/store.js';
import { WeixinClient, API_BASE } from '../lib/weixin.js';
import { login } from '../lib/login.js';
import { CodexClient } from '../lib/codex.js';
import { Bridge } from '../lib/bridge.js';
import { SessionController } from '../lib/sessions.js';

const { positionals, values: flags } = parseArgs({ allowPositionals: true, options: {
  'state-dir': { type: 'string' }, 'new-workspace': { type: 'string' }, workspace: { type: 'string' }, codex: { type: 'string' },
  model: { type: 'string' }, control: { type: 'boolean' }, name: { type: 'string' }, endpoint: { type: 'string' }, 'token-env': { type: 'string' }, 'allow-user': { type: 'string', multiple: true },
  'workspace-write': { type: 'boolean' }, 'no-login': { type: 'boolean' }, start: { type: 'boolean' }, help: { type: 'boolean' },
} });
const command = positionals[0] || 'help';
const root = path.resolve(flags['state-dir'] || process.env.CODEX_WEIXIN_HOME || path.join(os.homedir(), '.local', 'share', 'codex-weixin'));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function help() {
  console.log(`codex-weixin 0.5.1 — 独立微信 ↔ Codex 桥接（不是腾讯或 OpenAI 官方产品）\n\n  install --workspace /absolute/project [--workspace-write] [--no-login] [--start]\n  login                   微信扫码授权\n  start [--control]       前台启动；--control 启用多会话控制\n  backend-add --name ID --endpoint unix:///PATH [--token-env NAME]
  project-add --name NAME --workspace PATH [--workspace-write]
  status                  只显示本地配置状态（不检查微信在线状态）\n  doctor                  验证 Codex App Server 握手，不调用模型\n\n通用：--state-dir PATH\n新会话目录：--new-workspace PATH（安装时配置，默认 ~/Desktop/Codex，存在时使用）\n安装：--codex PATH --model NAME --allow-user USER_ID（可重复）\n默认只读；不改 ~/.codex/config.toml，不安装系统后台服务。`);
}
function checkCodex(binary = 'codex') {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, shell: false });
  if (result.error || result.status !== 0) throw new Error('Codex CLI unavailable; install Codex, log in locally, then retry.');
  return result.stdout.trim();
}
function install(store) {
  if (store.read('config')) throw new Error('Already configured; refusing to overwrite. Use a separate --state-dir for another bot.');
  const workspace = fs.realpathSync(path.resolve(flags.workspace || process.cwd()));
  const config = validateConfig({ version: 1, control: true, workspace, sandbox: flags['workspace-write'] ? 'workspace-write' : 'read-only',
    newSessionWorkspace: fs.realpathSync(path.resolve(flags['new-workspace'] || (fs.existsSync(path.join(os.homedir(), 'Desktop', 'Codex')) ? path.join(os.homedir(), 'Desktop', 'Codex') : workspace))),
    codex: flags.codex || 'codex', ...(flags.model ? { model: flags.model } : {}), allowUsers: flags['allow-user'] || [] });
  console.log(checkCodex(config.codex));
  const runtime = path.join(root, 'runtime');
  if (source !== runtime) {
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const item of ['bin', 'lib', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
      const from = path.join(source, item);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(runtime, item), { recursive: true });
    }
    // npm/npx may hoist dependencies beside this package, not inside it.
    const require = createRequire(import.meta.url);
    fs.mkdirSync(path.join(runtime, 'node_modules'), { recursive: true });
    const dependencies = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).dependencies;
    for (const name of Object.keys(dependencies)) {
      const dependency = path.dirname(require.resolve(`${name}/package.json`));
      fs.cpSync(dependency, path.join(runtime, 'node_modules', name), { recursive: true });
    }
  }
  store.write('config', config);
  console.log(`已配置：${workspace}\n权限：${config.sandbox}\n本地数据：${root}`);
  console.log('注意：Codex 复用现有登录与插件；文件沙箱不会限制已有 MCP/插件的外部操作。只授权你自己控制的微信用户。');
}
async function doLogin(store) {
  const config = validateConfig(store.read('config'));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Login cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const account = await login(new WeixinClient(), {
      signal: controller.signal,
      showQr: async value => {
        console.log('请使用微信扫描二维码，并确认授权（不要转发二维码）：');
        const { default: qrcode } = await import('qrcode-terminal');
        qrcode.generate(value, { small: true });
      },
      verify: () => terminal.question('请输入微信显示的验证码：', { signal: controller.signal }),
    });
    const previous = store.read('account');
    const state = store.read('state');
    if ((previous && previous.botId !== account.botId) || (state?.botId && state.botId !== account.botId)) throw new Error('Different bot account; use a separate --state-dir to preserve existing sessions.');
    // Save authorization before credentials; a crash fails closed rather than allowing a stranger.
    config.allowUsers = [...new Set([...config.allowUsers, account.userId])];
    store.write('config', config); store.write('account', account);
    console.log('微信已授权；扫码用户已加入本地白名单。');
  } finally { terminal.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
async function doctor(store) {
  const config = validateConfig(store.read('config'));
  console.log(checkCodex(config.codex));
  const client = new CodexClient({ command: config.codex, cwd: config.workspace });
  try { await client.connect(); console.log('Codex App Server initialize/initialized: OK（未调用模型，未验证微信收发）'); }
  finally { client.close(); }
}
async function start(store) {
  const config = validateConfig(store.read('config')); const account = store.read('account');
  if (!account?.token || !account.botId || !account.userId) throw new Error('Run login first.');
  if (!config.allowUsers.length) throw new Error('No allowed senders configured; refusing to start.');
  const release = store.lock(); const abort = new AbortController();
  const controlMode = !!(flags.control || config.control);
  const codex = new CodexClient({ command: config.codex, cwd: config.workspace, interactive: controlMode });
  const stop = () => { abort.abort(new Error('Bridge stopped.')); codex.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const backends = new Map(); let controller;
  try {
    await codex.connect();
    const weixin = new WeixinClient({ baseUrl: account.baseUrl || API_BASE, token: account.token });
    console.log(`微信 ↔ Codex 桥接启动：${config.workspace} (${config.sandbox})。Ctrl+C 退出。`);
    const bridge = new Bridge({ store, config, account, weixin, codex });
    if (controlMode) {
      backends.set('bridge', { client: codex, catalog: false, label: '本桥接的新会话后端' });
      const configs = [{ id: 'local', endpoint: 'unix://', label: '共享CLI daemon' }, ...(config.backends || [])];
      for (const backend of configs) {
        const client = new CodexClient({ endpoint: backend.endpoint, tokenEnv: backend.tokenEnv, interactive: true });
        try { await client.connect(); backends.set(backend.id, { client, catalog: true, label: backend.label || backend.id }); }
        catch { client.close(); console.log(`后端 ${backend.id} 连接失败；不自动启动或迁移原会话。`); }
      }
      controller = new SessionController({ store, config, backends, publish: (route, text) => bridge.queueReply(route, text), sendAction: (route, payload) => bridge.sendAction(route, payload) });
      bridge.controller = controller;
      console.log('多会话控制已启用。微信发送 /sessions 查看目录；仅历史可见的会话不会自动恢复。');
    }
    await bridge.run(abort.signal);
  } finally {
    controller?.close(); for (const b of backends.values()) if (b.client !== codex) b.client.close();
    stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop); release();
  }
}
async function main() {
  if (flags.help || command === 'help') { help(); return; }
  if (!['install', 'login', 'start', 'status', 'doctor', 'backend-add', 'project-add'].includes(command) || positionals.length !== 1) throw new Error('Unknown command; use --help.');
  const store = new Store(root);
  // All state-changing commands share a single lock, not only the polling worker.
  if (command === 'start') { await start(store); return; }
  if (command === 'doctor') { await doctor(store); return; }
  if (command === 'status') {
    const config = store.read('config'); const account = store.read('account');
    console.log(JSON.stringify({ configured: !!config, workspace: config?.workspace, sandbox: config?.sandbox,
      newSessionWorkspace: config?.newSessionWorkspace || config?.workspace, newSessionSandbox: config?.newSessionSandbox || config?.sandbox,
      allowedSenders: config?.allowUsers?.length || 0, weixinCredentialsStored: !!account?.token,
      lockPresent: fs.existsSync(path.join(root, 'run.lock')), note: 'Local state only; not an online health check.' }, null, 2)); return;
  }
  const release = store.lock();
  try {
    if (command === 'backend-add' || command === 'project-add') {
      const config = validateConfig(store.read('config'));
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(flags.name || '') || ['bridge', 'local', 'default'].includes(flags.name)) throw new Error('Choose a unique non-reserved name.');
      if (command === 'backend-add') {
        if (!flags.endpoint || !/^(unix|ws|wss):\/\//.test(flags.endpoint)) throw new Error('Provide a Codex endpoint.');
        if (config.backends?.some(b => b.id === flags.name)) throw new Error('Backend already configured.');
        config.backends = [...(config.backends || []), { id: flags.name, endpoint: flags.endpoint, ...(flags['token-env'] ? { tokenEnv: flags['token-env'] } : {}) }];
      } else {
        if (!flags.workspace) throw new Error('Provide --workspace.');
        const workspace = fs.realpathSync(path.resolve(flags.workspace));
        if (!fs.statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
        if (config.projects?.some(p => p.name === flags.name)) throw new Error('Project already configured.');
        config.projects = [...(config.projects || []), { name: flags.name, workspace, sandbox: flags['workspace-write'] ? 'workspace-write' : 'read-only' }];
      }
      store.write(`config-backup-${Date.now()}`, store.read('config')); store.write('config', config);
      console.log('已保存并回读：', command === 'backend-add' ? store.read('config').backends.map(b => b.id).join(',') : store.read('config').projects.map(p => p.name).join(','));
    }
    if (command === 'install') install(store);
    if (command === 'login' || (command === 'install' && !flags['no-login'])) await doLogin(store);
  } finally { release(); }
  if (command === 'install') {
    const invocation = `node ${JSON.stringify(path.join(root, 'runtime', 'bin', 'codex-weixin.js'))} --state-dir ${JSON.stringify(root)}`;
    if (flags.start) await start(store);
    else console.log(`启动命令：\n${invocation} start${flags['no-login'] ? `\n先扫码：\n${invocation} login` : ''}`);
  }
}
main().catch(error => { console.error(`codex-weixin: ${error.message}`); process.exitCode = 1; });
