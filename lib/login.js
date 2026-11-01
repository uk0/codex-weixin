import { setTimeout as delay } from 'node:timers/promises';
import { safeBase } from './weixin.js';

export async function login(client, { showQr, verify, signal, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let qr; let baseUrl = client.baseUrl; let verifyCode; let refreshes = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!qr) {
      qr = await client.qr(signal);
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('Incomplete QR response.');
      await showQr(qr.qrcode_img_content); baseUrl = client.baseUrl; verifyCode = undefined;
    }
    let result;
    try { result = await client.qrStatus(qr.qrcode, { baseUrl, verifyCode, signal }); }
    catch (error) { if (error.code === 'TIMEOUT' || error.status >= 500) continue; throw error; }
    switch (result.status) {
      case 'confirmed':
        if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('Incomplete login credentials; sender authorization unavailable.');
        return { token: result.bot_token, botId: result.ilink_bot_id, userId: result.ilink_user_id,
          baseUrl: safeBase(result.baseurl || client.baseUrl, client.allowLocal) };
      case 'scaned_but_redirect':
        if (!result.redirect_host) throw new Error('Missing QR redirect host.');
        baseUrl = safeBase(result.redirect_host, client.allowLocal); break;
      case 'need_verifycode': verifyCode = await verify(); break;
      case 'expired':
        if (++refreshes > 3) throw new Error('QR refresh limit exceeded.');
        qr = undefined; break;
      case 'binded_redirect': throw new Error('Bot is already bound. Re-run login and follow Weixin instructions.');
      case 'verify_code_blocked': throw new Error('Weixin verification blocked; retry login later.');
      case 'wait': case 'scaned': break;
      default: throw new Error('Unknown Weixin QR status.');
    }
    await delay(500, undefined, { signal });
  }
  throw new Error('Weixin login timed out.');
}
