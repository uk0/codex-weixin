// Local-only, stateful stand-in based on docs/weixin.openapi.json.
// Control routes are test fixtures, not part of the Weixin API.
const http = require('http');
const key = 'weixin.state';
const initial = () => ({ mode: 'ok', requests: [], replies: [] });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = req.body || {};
  const state = await pm.state.get(key) || initial();
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/__control' && req.method === 'POST') {
    const next = body.reset ? initial() : state;
    if (body.mode) next.mode = body.mode;
    if (body.failFileOnce !== undefined) next.failFileOnce = body.failFileOnce;
    if (Array.isArray(body.messages)) { next.controlled = true; next.queue = body.messages; }
    await pm.state.set(key, next); return json(200, { ok: true });
  }
  if (url.pathname === '/__state' && req.method === 'GET') return json(200, state);
  state.requests.push({ path: url.pathname, method: req.method, body }); await pm.state.set(key, state);
  if (state.mode === 'http429') return json(429, { error: 'rate limit' });
  if (state.mode === 'html') { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>gateway</html>'); }
  if (state.mode === 'expired') return json(200, { ret: -14 });
  if (url.pathname === '/ilink/bot/get_bot_qrcode' && req.method === 'POST') {
    if (!Array.isArray(body.local_token_list) || req.headers.authorization) return json(400, { error: 'QR request contract' });
    return json(200, { qrcode: 'test-qr', qrcode_img_content: 'https://example.invalid/weixin-qr' });
  }
  if (url.pathname === '/ilink/bot/get_qrcode_status' && req.method === 'GET') {
    return json(200, { status: 'confirmed', bot_token: 'dummy-token', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' });
  }
  if (req.headers.authorization !== 'Bearer dummy-token' || req.headers.authorizationtype !== 'ilink_bot_token' || !body.base_info?.channel_version) return json(401, { error: 'auth contract' });
  if (url.pathname === '/ilink/bot/getupdates' && req.method === 'POST') {
    if (typeof body.get_updates_buf !== 'string') return json(400, { error: 'cursor contract' });
    if (state.controlled) { const messages = state.queue || []; state.queue = []; await pm.state.set(key, state); return json(200, { ret: 0, msgs: messages, get_updates_buf: `control-${state.requests.length}` }); }
    const message = { message_id: 1, message_type: 1, message_state: 2, from_user_id: 'owner', context_token: 'test-context', item_list: [{ type: 1, text_item: { text: '验证微信到 Codex 的消息链路' } }] };
    return json(200, { ret: 0, msgs: [{ ...message, message_id: 2, from_user_id: 'stranger' }, { ...message, message_id: 3, group_id: 'group' }, message], get_updates_buf: 'cursor-1' });
  }
  if (url.pathname === '/ilink/bot/getuploadurl' && req.method === 'POST') {
    if (body.media_type !== 3 || !/^[a-f0-9]{32}$/.test(body.aeskey || '') || !/^[a-f0-9]{32}$/.test(body.filekey || '') || body.filesize !== (Math.floor(body.rawsize / 16) + 1) * 16 || body.no_need_thumb !== true) return json(400, { error: 'file upload contract' });
    state.grants ||= []; state.grants.push(body); await pm.state.set(key, state);
    // Test-only encoded metadata. Real upload parameters are supplied opaquely by Weixin.
    return json(200, { ret: 0, upload_param: Buffer.from(JSON.stringify({ filekey: body.filekey, aeskey: body.aeskey, rawsize: body.rawsize, md5: body.rawfilemd5 })).toString('base64url') });
  }
  if (url.pathname === '/ilink/bot/sendmessage' && req.method === 'POST') {
    if (state.mode === 'send500') return json(500, { error: 'send failed' });
    if (body.msg?.context_token !== 'test-context' || body.msg.to_user_id !== 'owner' || !body.msg.client_id || body.msg.message_type !== 2) return json(400, { error: 'reply contract' });
    const item = body.msg.item_list?.[0];
    if (item?.type === 4) {
      if (state.failFileOnce) { state.failFileOnce = false; await pm.state.set(key, state); return json(500, { error: 'file send failed before acceptance' }); }
      const file = item.file_item;
      let metadata; try { metadata = JSON.parse(Buffer.from(file.media.encrypt_query_param, 'base64url').toString()); } catch { return json(400, { error: 'file media reference contract' }); }
      const grant = (state.grants || []).find(g => g.filekey === metadata.filekey);
      if (!grant || file.len !== String(grant.rawsize) || !file.file_name || file.media.encrypt_type !== 1 || Buffer.from(file.media.aes_key, 'base64').toString() !== grant.aeskey) return json(400, { error: 'file message contract' });
    }
    state.replies.push(body.msg); await pm.state.set(key, state); return json(200, { ret: 0 });
  }
  json(501, { error: 'Not modeled by this client protocol subset.' });
}).listen(process.env.PORT || 4500);
