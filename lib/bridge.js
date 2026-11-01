import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { splitText } from './weixin.js';
import { UserError } from './sessions.js';
import { FileSpool, ArtifactError } from './files.js';
import { weixinPlainText } from './channel-tools.js';
import { splitMarkdown } from './presentation.js';
import { message, codeBlock, actionHint, controlMarkdown } from './messages.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HELP = message('微信 Codex 帮助', '直接发送任务给 Codex。', actionHint('新建会话', '/new'), actionHint('当前状态', '/status'), '当前模式仅接受文字，不支持图片、文件、语音或群聊；不能远程扩大权限。');

export class Bridge {
  constructor({ store, config, account, weixin, codex, controller, log = console.log }) {
    Object.assign(this, { store, config, account, weixin, codex, controller, log });
    this.spool = new FileSpool(store.root);
    this.state = store.read('state', { version: 1, cursor: '', sessions: {}, entries: {} });
    if (this.state.version !== 1) throw new Error('Unsupported bridge state version.');
    if (this.state.botId && this.state.botId !== account.botId) throw new Error('Account changed; use a separate state directory.');
    this.state.botId = account.botId;
    // Recover an interrupted task even if the backend no longer replays the input.
    for (const entry of Object.values(this.state.entries)) {
      if (entry.status === 'running') {
        entry.replies = [{ text: this.formatText(message('上次任务中断', '结果未知，不会自动重跑。请先检查工作区。', actionHint('新建会话', '/new'))), id: randomUUID() }];
        entry.sent = 0; entry.status = 'ready';
      }
    }
    this.save();
  }
  save() { this.store.write('state', this.state); }
  formatText(text) { return this.config.messageFormat === 'plain' ? weixinPlainText(text) : String(text ?? ''); }
  chunks(text) { return this.config.messageFormat === 'plain' ? splitText(text) : splitMarkdown(text); }
  async deliver(entry, signal) {
    while (entry.sent < entry.replies.length) {
      const chunk = entry.replies[entry.sent];
      if (chunk.type === 'file') {
        try {
          if (!chunk.media) {
            const bytes = this.spool.read(chunk.file);
            chunk.media = await this.weixin.uploadFile(entry.sender, bytes, chunk.file.uploadKeys, signal);
            this.save(); // Keep upload metadata before any user-visible send.
          }
          await this.weixin.sendFile(entry.sender, entry.context, { ...chunk.file, media: chunk.media }, chunk.id, signal);
          entry.fileDelivery ||= { accepted: 0, failed: 0 }; entry.fileDelivery.accepted++; entry.fileDelivery.lastAcceptedAt = Date.now();
        } catch (error) {
          if (signal?.aborted) throw error;
          chunk.attempts = (chunk.attempts || 0) + 1; this.save();
          const auth = error.code === -14 || ((error.status === 401 || error.status === 403) && error.code !== 'CDN_HTTP');
          if (!auth && (error.permanent || chunk.attempts >= 5)) {
            const old = chunk.file; this.spool.remove(old);
            entry.fileDelivery ||= { accepted: 0, failed: 0 }; entry.fileDelivery.failed++;
            Object.assign(chunk, { type: 'text', id: randomUUID(), text: this.formatText(message('附件发送未确认', codeBlock(old.fileName), '未确认发送成功，已停止自动重试。请先检查微信；网络异常时可能已经收到，请避免重复发送。', actionHint('确认未收到后再发（替换路径）', '/f <相对路径>'))) });
            delete chunk.file; delete chunk.media; this.save(); continue;
          }
          throw error;
        }
      } else await this.weixin.send(entry.sender, entry.context, chunk.text, chunk.id, signal);
      entry.sent++; this.save();
      if (chunk.type === 'file') this.spool.remove(chunk.file);
    }
    entry.status = 'delivered';
    // Keep only the replay tombstone after successful delivery, not reply content/tokens.
    delete entry.sender; delete entry.context; delete entry.replies; delete entry.sent;
    this.save();
  }
  async handle(msg, signal) {
    if (!msg || msg.message_type !== 1 || msg.group_id || !this.config.allowUsers.includes(msg.from_user_id)) return;
    if (msg.message_state !== undefined && msg.message_state !== 2) return;
    if (!msg.context_token || (msg.message_id === undefined && msg.seq === undefined)) return;
    const peer = hash([this.account.botId, msg.from_user_id]);
    const key = hash([peer, msg.message_id ?? `seq:${msg.seq}`]);
    let entry = this.state.entries[key];
    if (entry?.status === 'delivered') return;
    if (entry?.status === 'running') {
      // A prior process may have executed a side effect. Never execute it again.
      entry.replies = this.chunks(this.formatText(message('上次任务中断', '结果未知，不会自动重跑。请先检查工作区。', actionHint('新建会话', '/new')))).map(text => ({ text, id: randomUUID() }));
      entry.sent = 0; entry.status = 'ready'; this.save();
    }
    if (entry?.status === 'ready') { if (!this.controller) await this.flushOutbox(signal); return; }
    entry = { sender: msg.from_user_id, context: msg.context_token, status: 'running', sent: 0, replies: [] };
    this.state.entries[key] = entry; this.save();
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    const text = items.filter(x => x.type === 1 && typeof x.text_item?.text === 'string').map(x => x.text_item.text).join('\n').trim();
    let reply;
    if (items.some(x => x.type !== 1) || !text) reply = message('暂不支持此消息', '当前版本仅接受纯文本任务，请直接发送文字。');
    else if (Buffer.byteLength(text) > 32000) reply = message('任务过长', '请控制在 32KB 内。');
    else if (this.controller) {
      try { reply = await this.controller.dispatch(text, { peer, sender: msg.from_user_id, context: msg.context_token, signal }); }
      catch (error) {
        reply = error instanceof UserError ? controlMarkdown(error.message, '操作未执行') : error.rpcMethod
          ? message('后端请求失败', `后端 ${error.backend || 'Codex'} 的 ${error.rpcMethod} 请求被拒绝（${error.rpcCode ?? '连接异常'}，${error.rpcCategory || '未分类'}）。`, '没有自动重复执行任务。', actionHint('检查当前状态', '/st'))
          : message('控制请求失败', '未自动重试，请检查后端连接。', actionHint('检查当前状态', '/st'));
        this.log(`Session controller failed: method=${error.rpcMethod || 'local'} code=${error.rpcCode || error.code || 'none'} category=${error.rpcCategory || error.name}; payload suppressed.`);
      }
    }
    else if (text === '/help') reply = HELP;
    else if (text === '/status') reply = message('当前状态', `**目录**\n\n${codeBlock(this.config.workspace)}`, `**权限**：${this.config.sandbox}`, `**会话**\n\n${codeBlock(this.state.sessions[peer] || '未开始')}`);
    else if (text === '/new') { delete this.state.sessions[peer]; this.save(); reply = message('已新建会话', '下条消息开始新任务。'); }
    else if (text.startsWith('/')) reply = HELP;
    else {
      try {
        const threadId = await this.codex.thread(this.state.sessions[peer], this.config);
        this.state.sessions[peer] = threadId; this.save();
        reply = await this.codex.run(threadId, text);
      } catch {
        // Do not expose raw provider errors or auto-repeat potentially executed tasks.
        this.log('Codex task failed or was interrupted; no automatic execution retry.');
        reply = message('Codex 执行失败或中断', '结果可能未知，不会自动重跑。请在本机检查登录、配置与工作区。', actionHint('必要时新建会话', '/new'));
      }
    }
    const plainReply = this.formatText(reply);
    const allChunks = plainReply ? this.chunks(plainReply) : [];
    const chunks = allChunks.length > 40 ? [...allChunks.slice(0, 39), this.formatText(message('输出已截断', '请在本机 Codex 会话查看完整结果。'))] : allChunks;
    entry.replies = chunks.map(text => ({ text, id: randomUUID() })); entry.status = 'ready'; this.save();
    if (!this.controller) await this.flushOutbox(signal);
  }
  queueReply(route, text) {
    const actionKey = text && typeof text === 'object' && text.deliveryKey ? `tool:${hash(text.deliveryKey)}` : null;
    const fingerprint = actionKey ? hash([text.type, text.path, text.cwd, text.text]) : null;
    if (actionKey && this.state.entries[actionKey]) {
      const old = this.state.entries[actionKey];
      if (old.fingerprint !== fingerprint) throw new Error('Channel call identity reused with different arguments.');
      return { entryId: actionKey, ...old.receipt };
    }
    if (text && typeof text === 'object' && text.type === 'file') {
      const pending = Object.values(this.state.entries).filter(e => e.status === 'ready').flatMap(e => e.replies?.slice(e.sent) || []).filter(r => r.type === 'file');
      if (pending.length >= 10) throw new ArtifactError('待发附件已达10个，请等待发送完成。');
      const file = this.spool.snapshot(text.cwd, text.path);
      if (pending.reduce((n, r) => n + r.file.size, 0) + file.size > 50 * 1024 * 1024) { this.spool.remove(file); throw new ArtifactError('待发附件缓存超过50MiB，请等待发送完成。'); }
      const id = randomUUID();
      const entryId = actionKey || `file:${id}`;
      const receipt = { fileName: file.fileName, size: file.size, sha256: file.sha256 };
      this.state.entries[entryId] = { status: 'ready', sender: route.sender, context: route.context, sent: 0, fingerprint, receipt,
        replies: [{ type: 'file', id, file }] };
      this.save(); return { entryId, ...receipt };
    }
    const plain = this.formatText(text?.type === 'text' ? text.text : text);
    if (!plain) { if (actionKey) throw new Error('Empty channel text.'); return; }
    const chunks = this.chunks(plain);
    if (chunks.length > 40) chunks.splice(39, chunks.length - 39, '输出已截断，请在本机查看完整内容。');
    const entryId = actionKey || `async:${randomUUID()}`;
    this.state.entries[entryId] = { status: 'ready', sender: route.sender, context: route.context, sent: 0, fingerprint,
      replies: chunks.map(text => ({ text, id: randomUUID() })) };
    this.save(); return { entryId };
  }
  async sendAction(route, payload, { timeoutMs = 90000 } = {}) {
    if (!route.sender || !route.context || !payload.deliveryKey) throw new Error('Missing originating route or call identity.');
    const queued = this.queueReply(route, payload);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const entry = this.state.entries[queued.entryId];
      if (entry.fileDelivery?.failed) return { ...queued, status: 'unknown_or_failed', accepted: false, retry: false };
      if (entry.status === 'delivered') return { ...queued, status: 'api_accepted', accepted: true, userConfirmed: false };
      if (route.signal?.aborted) break;
      await delay(50);
    }
    // Leave the durable outbox intact; the caller must not turn uncertainty into duplicate sends.
    return { ...queued, status: 'pending_or_unknown', accepted: false, retry: false };
  }
  async flushOutbox(signal) {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const entry of Object.values(this.state.entries)) if (entry.status === 'ready') await this.deliver(entry, signal);
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }
  async pollOnce(signal) {
    // The poller and async event delivery share one serial outbox writer.
    if (!this.controller) await this.flushOutbox(signal);
    if (this.deliveryFatal) throw this.deliveryFatal;
    const result = await this.weixin.updates(this.state.cursor, signal);
    if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw new Error('Invalid Weixin message list.');
    for (const msg of result.msgs || []) { signal?.throwIfAborted(); await this.handle(msg, signal); }
    if (typeof result.get_updates_buf === 'string' && result.get_updates_buf) { this.state.cursor = result.get_updates_buf; this.save(); }
  }
  async run(signal) {
    const pump = this.controller ? setInterval(() => {
      if (!signal.aborted && Date.now() >= (this.deliveryRetryAt || 0)) this.flushOutbox(signal).then(() => {
        this.deliveryFailures = 0;
      }).catch(error => {
        if (signal.aborted) return;
        if (error.code === -14 || ((error.status === 401 || error.status === 403) && error.code !== 'CDN_HTTP')) this.deliveryFatal = error;
        this.deliveryFailures = (this.deliveryFailures || 0) + 1;
        this.deliveryRetryAt = Date.now() + Math.min(30000, 1000 * 2 ** this.deliveryFailures);
        this.log('Async Weixin delivery failed; durable outbox retained with backoff.');
      });
    }, 1000) : null;
    pump?.unref();
    try {
    let failures = 0;
    while (!signal.aborted) {
      try { await this.pollOnce(signal); failures = 0; await delay(250, undefined, { signal }); }
      catch (error) {
        if (signal.aborted) break;
        if (error.code === -14 || error.status === 401 || error.status === 403) throw new Error('Weixin session expired or unauthorized. Run login again.');
        failures++;
        if (failures >= 5) throw new Error('Bridge stopped after 5 failures. Inspect connectivity and restart.');
        this.log(`Weixin request failed (${error.status || error.code || 'network/state'}); backing off.`);
        await delay(Math.min(30000, 1000 * 2 ** failures), undefined, { signal });
      }
    }
    } finally { if (pump) clearInterval(pump); }
  }
}
