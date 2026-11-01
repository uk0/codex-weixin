import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export class CodexClient extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server'], cwd, requestTimeoutMs = 30000, turnTimeoutMs = 600000, endpoint, tokenEnv, interactive = false, passive = false } = {}) {
    super(); this.command = command; this.args = args; this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs; this.turnTimeoutMs = turnTimeoutMs;
    this.endpoint = endpoint; this.tokenEnv = tokenEnv; this.interactive = interactive; this.passive = passive;
    this.nextId = 1; this.pending = new Map(); this.closed = false;
  }
  async connect() {
    if (this.endpoint) {
      const target = websocketTarget(this.endpoint, this.tokenEnv);
      this.socket = new WebSocket(target.url, { handshakeTimeout: this.requestTimeoutMs, ...target.options });
      this.socket.on('message', data => this.receive(data.toString()));
      this.socket.on('error', () => this.fail(new Error('Codex WebSocket connection failed.')));
      this.socket.once('close', () => this.fail(new Error('Codex WebSocket disconnected.')));
      await new Promise((resolve, reject) => {
        this.socket.once('open', resolve);
        this.socket.once('error', () => reject(new Error('Cannot connect to Codex endpoint.')));
      });
    } else {
      this.child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.child.stderr.resume();
      this.child.stdin.on('error', error => this.fail(new Error(`Codex stdin failed (${error.code || 'unknown'}).`)));
      this.child.on('error', error => this.fail(new Error(`Cannot start Codex (${error.code || 'unknown'}).`)));
      this.child.once('exit', (code, signal) => this.fail(new Error(`Codex exited (${code ?? signal}).`)));
      this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      this.lines.on('line', line => this.receive(line));
    }
    await this.request('initialize', { clientInfo: { name: 'codex_weixin', title: 'Codex Weixin', version: '0.5.1' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.fail(new Error('Invalid Codex JSON-RPC output.')); this.close(); return; }
    if (msg.method && msg.id !== undefined) {
      if (this.interactive || this.passive) { this.emit('serverRequest', msg); return; }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) this.send({ id: msg.id, result: { decision: 'decline' } });
      else this.send({ id: msg.id, error: { code: -32601, message: 'Interactive requests are not supported by this bridge.' } });
    } else if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(msg.id);
      if (msg.error) {
        const error = new Error(`Codex RPC ${pending.method} failed (${msg.error.code}).`); error.rpcCode = msg.error.code; error.rpcMethod = pending.method;
        error.rpcCategory = /no rollout found/i.test(msg.error.message || '') ? 'noRollout' : /thread not loaded/i.test(msg.error.message || '') ? 'notLoaded' : 'rejected';
        pending.reject(error);
      } else pending.resolve(msg.result);
    } else if (msg.method) this.emit('notification', msg);
  }
  send(msg) {
    if (this.closed) throw new Error('Codex is disconnected.');
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex is disconnected.');
      this.socket.send(JSON.stringify(msg)); return;
    }
    if (!this.child?.stdin.writable) throw new Error('Codex is disconnected.');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex is disconnected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC ${method} timed out.`)); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('fatal', error);
  }
  async thread(threadId, config) {
    const params = { cwd: config.workspace, approvalPolicy: 'never', sandbox: config.sandbox,
      ...(config.model ? { model: config.model } : {}) };
    const result = threadId
      ? await this.request('thread/resume', { ...params, threadId })
      : await this.request('thread/start', params);
    if (!result.thread?.id) throw new Error('Codex did not return a thread id.');
    return result.thread.id;
  }
  async run(threadId, text, options = {}) {
    let turnId; let queue = []; const messages = new Map();
    let finish; let rejectDone;
    const done = new Promise((resolve, reject) => { finish = resolve; rejectDone = reject; });
    // Attach a rejection observer immediately; a process exit may precede turn/start's response.
    done.catch(() => {});
    const timer = setTimeout(() => {
      const error = new Error('Codex turn timed out; execution outcome is unknown.');
      rejectDone(error); this.fail(error); this.close();
    }, this.turnTimeoutMs);
    const onFatal = error => rejectDone(error);
    const processEvent = event => {
      const p = event.params;
      if (p?.threadId !== threadId) return;
      if (event.method === 'item/completed' && p.turnId === turnId && p.item?.type === 'agentMessage') {
        messages.set(p.item.id, { text: String(p.item.text || '').slice(0, 200000), phase: p.item.phase });
      }
      if (event.method === 'turn/completed' && p.turn?.id === turnId) {
        if (p.turn.status !== 'completed') rejectDone(new Error(`Codex turn ${p.turn.status}; not retried automatically.`));
        else {
          const all = [...messages.values()]; const final = all.filter(x => x.phase === 'final_answer');
          finish((final.length ? final : all).map(x => x.text).join('\n\n'));
        }
      }
    };
    const onEvent = event => {
      if (event.params?.threadId !== threadId) return;
      if (!['item/completed', 'turn/completed'].includes(event.method)) return;
      if (!turnId) queue.push(event); else processEvent(event);
    };
    this.on('notification', onEvent); this.on('fatal', onFatal);
    try {
      const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
      turnId = result.turn?.id;
      if (!turnId) throw new Error('Codex did not return a turn id.');
      options.onStarted?.(turnId);
      for (const event of queue) processEvent(event); queue = [];
      return await done;
    } finally {
      clearTimeout(timer); this.off('notification', onEvent); this.off('fatal', onFatal);
    }
  }
  close() {
    if (this.socket) {
      this.socket.close(); const socket = this.socket;
      const timer = setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 1000); timer.unref();
    }
    if (this.child && this.child.exitCode === null && !this.child.signalCode) {
      this.child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (this.child.exitCode === null && !this.child.signalCode) this.child.kill('SIGKILL'); }, 2000);
      killTimer.unref();
    }
    this.fail(new Error('Codex bridge stopped.'));
    this.lines?.close();
  }
}

export function websocketTarget(endpoint, tokenEnv) {
  if (endpoint.startsWith('unix://')) {
    const file = endpoint.slice(7) || path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock');
    if (!path.isAbsolute(file) || /[?#]/.test(file)) throw new Error('Invalid absolute Unix socket path.');
    const stat = fs.statSync(file);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Codex socket is not owned by the current user.');
    return { url: `ws+unix://${file}:/`, options: {} };
  }
  const url = new URL(endpoint);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['ws:', 'wss:'].includes(url.protocol) || (url.protocol === 'ws:' && !local) || url.username || url.password || url.search || url.hash) throw new Error('Use a local ws:// or authenticated wss:// Codex endpoint.');
  if (!local && !tokenEnv) throw new Error('Remote Codex endpoints require a token environment variable.');
  const options = {};
  if (tokenEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv) || !process.env[tokenEnv]) throw new Error('Codex token environment variable is missing.');
    options.headers = { Authorization: `Bearer ${process.env[tokenEnv]}` };
  }
  return { url: url.href, options };
}
