// Local-only binary upload stand-in. Never use these test parameters for real service traffic.
const http = require('http');
const crypto = require('crypto');
const state = { uploads: [] }; // One local run, one test state; no deployment/session promises.
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && url.pathname === '/__state') return json(200, state);
  if (req.method !== 'POST' || url.pathname !== '/upload') return json(501, { error: 'not modeled' });
  if (req.headers.authorization || req.headers.cookie) return json(400, { error: 'bot credentials must not reach CDN' });
  try {
    const info = JSON.parse(Buffer.from(url.searchParams.get('encrypted_query_param'), 'base64url').toString());
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const ciphertext = Buffer.concat(chunks);
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(info.aeskey, 'hex'), null);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (url.searchParams.get('filekey') !== info.filekey || plaintext.length !== info.rawsize || crypto.createHash('md5').update(plaintext).digest('hex') !== info.md5) return json(400, { error: 'ciphertext contract' });
    state.uploads.push({ filekey: info.filekey, size: plaintext.length, sha256: crypto.createHash('sha256').update(plaintext).digest('hex'), authorizationAbsent: true });
    res.setHeader('x-encrypted-param', Buffer.from(JSON.stringify({ filekey: info.filekey, md5: info.md5 })).toString('base64url')); res.end('');
  } catch { json(400, { error: 'invalid binary upload' }); }
}).listen(process.env.PORT || 4501);
