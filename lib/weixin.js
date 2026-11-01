import { randomBytes, randomUUID, createHash, createCipheriv } from 'node:crypto';
import { MAX_FILE_BYTES } from './files.js';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
// Wire version follows the upstream protocol snapshot, not this package version.
export const CHANNEL_VERSION = '2.4.10';

export class WeixinError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

export function safeBase(value, allowLocal = false) {
  const u = new URL(value.includes('://') ? value : `https://${value}`);
  const local = allowLocal && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!local && (u.protocol !== 'https:' || !(u.hostname === 'weixin.qq.com' || u.hostname.endsWith('.weixin.qq.com')) || (u.port && u.port !== '443'))) throw new Error('Untrusted Weixin API host.');
  if (u.username || u.password || u.search || u.hash || (!local && u.pathname !== '/')) throw new Error('Invalid Weixin API base URL.');
  return u.href.replace(/\/$/, '');
}

export function splitText(text, limit = 1800) {
  const chunks = []; let chunk = ''; let bytes = 0;
  for (const char of text || '（Codex 未返回文本）') {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class WeixinClient {
  constructor({ baseUrl = API_BASE, token, allowLocal = false, timeoutMs = 15000, cdnBaseUrl = 'https://novac2c.cdn.weixin.qq.com/c2c' } = {}) {
    this.baseUrl = safeBase(baseUrl, allowLocal); this.token = token; this.allowLocal = allowLocal; this.timeoutMs = timeoutMs; this.cdnBaseUrl = cdnBaseUrl;
  }
  async request(endpoint, { body, baseUrl = this.baseUrl, timeoutMs = this.timeoutMs, signal } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    const signals = [AbortSignal.timeout(timeoutMs)]; if (signal) signals.push(signal);
    let response;
    try {
      response = await fetch(`${safeBase(baseUrl, this.allowLocal)}/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.name === 'TimeoutError') throw new WeixinError('Weixin request timed out.', { code: 'TIMEOUT' });
      throw new WeixinError('Weixin network request failed.');
    }
    if (!response.ok) throw new WeixinError(`Weixin HTTP ${response.status}`, { status: response.status });
    let data;
    try { data = await response.json(); } catch { throw new WeixinError('Weixin returned invalid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WeixinError('Invalid Weixin response.');
    for (const code of [data.ret, data.errcode]) {
      if (code !== undefined && code !== 0) throw new WeixinError(`Weixin API error ${Number(code)}`, { code });
    }
    return data;
  }
  meta() { return { channel_version: CHANNEL_VERSION, bot_agent: 'CodexWeixin/0.5.1' }; }
  qr(signal) { return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, signal }); }
  qrStatus(qrcode, { baseUrl, verifyCode, signal } = {}) {
    const query = new URLSearchParams({ qrcode }); if (verifyCode) query.set('verify_code', verifyCode);
    return this.request(`ilink/bot/get_qrcode_status?${query}`, { baseUrl, timeoutMs: 40000, signal });
  }
  updates(cursor = '', signal) {
    return this.request('ilink/bot/getupdates', { body: { get_updates_buf: cursor, base_info: this.meta() }, timeoutMs: 45000, signal });
  }
  async uploadFile(to, data, keys, signal) {
    if (!Buffer.isBuffer(data) || data.length > MAX_FILE_BYTES) throw new WeixinError('Invalid attachment bytes.');
    if (!/^[0-9a-f]{32}$/i.test(keys.aeskey) || !/^[0-9a-f]{32}$/i.test(keys.filekey)) throw new WeixinError('Invalid file encryption parameters.');
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(keys.aeskey, 'hex'), null);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const grant = await this.request('ilink/bot/getuploadurl', { body: {
      filekey: keys.filekey, media_type: 3, to_user_id: to, rawsize: data.length,
      rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: ciphertext.length,
      no_need_thumb: true, aeskey: keys.aeskey, base_info: this.meta(),
    }, signal });
    const target = (typeof grant.upload_full_url === 'string' ? grant.upload_full_url.trim() : '') || (typeof grant.upload_param === 'string' && grant.upload_param ? `${this.cdnBaseUrl}/upload?${new URLSearchParams({ encrypted_query_param: grant.upload_param, filekey: keys.filekey })}` : null);
    if (!target) { const error = new WeixinError('Weixin did not return an upload target.'); error.permanent = true; throw error; }
    const url = safeCdnUrl(target, this.allowLocal);
    const signals = [AbortSignal.timeout(60000)]; if (signal) signals.push(signal);
    let response;
    try {
      // Never forward bot Authorization or cookies to a CDN upload target.
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext, redirect: 'error', signal: AbortSignal.any(signals) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new WeixinError(error.name === 'TimeoutError' ? 'CDN upload timed out.' : 'CDN upload failed.', { code: 'CDN_NETWORK' });
    }
    if (response.status !== 200) {
      const error = new WeixinError(`CDN HTTP ${response.status}`, { status: response.status, code: 'CDN_HTTP' });
      error.permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      await response.body?.cancel(); throw error;
    }
    const param = response.headers.get('x-encrypted-param'); await response.body?.cancel();
    if (!param || param.length > 16384) throw new WeixinError('CDN upload response is missing download metadata.', { code: 'CDN_METADATA' });
    return { encrypt_query_param: param, aes_key: Buffer.from(keys.aeskey, 'utf8').toString('base64'), encrypt_type: 1 };
  }
  sendFile(to, context, file, clientId = randomUUID(), signal) {
    if (!context) throw new Error('Missing inbound context token; refusing an unbound reply.');
    return this.request('ilink/bot/sendmessage', { body: { msg: {
      from_user_id: '', to_user_id: to, client_id: clientId, message_type: 2, message_state: 2,
      context_token: context, item_list: [{ type: 4, file_item: { file_name: file.fileName,
        len: String(file.size), media: file.media } }],
    }, base_info: this.meta() }, signal });
  }
  send(to, context, text, clientId = randomUUID(), signal) {
    if (!context) throw new Error('Missing inbound context token; refusing an unbound reply.');
    return this.request('ilink/bot/sendmessage', { body: { msg: {
      from_user_id: '', to_user_id: to, client_id: clientId, message_type: 2, message_state: 2,
      context_token: context, item_list: [{ type: 1, text_item: { text } }],
    }, base_info: this.meta() }, signal });
  }
}

export function safeCdnUrl(value, allowLocal = false) {
  let url;
  try { url = new URL(value); } catch { const error = new WeixinError('Invalid CDN upload target.'); error.permanent = true; throw error; }
  const local = allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') || (url.port && url.port !== '443'))) || url.username || url.password || url.hash) {
    const error = new WeixinError('Untrusted CDN upload target.'); error.permanent = true; throw error;
  }
  return url.href;
}
