// Requires a local .tgz built by npm pack. npm is forced offline; no publishing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const archive = path.resolve(process.argv[2] || `codex-weixin-cli-${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version}.tgz`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-weixin-npx-'));
try {
  const state = path.join(root, 'state');
  const fake = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
  const output = execFileSync('npx', ['--yes', '--offline', '--package', archive, 'codex-weixin', 'install', '--no-login', '--workspace', root, '--state-dir', state, '--codex', fake], { encoding: 'utf8' });
  assert.match(output, /read-only/);
  const runtime = path.join(state, 'runtime');
  assert(fs.existsSync(path.join(runtime, 'node_modules/qrcode-terminal/package.json')));
  // Resolve QR from the copied runtime, not the npm cache's hoisted dependency.
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('qrcode-terminal')"], { cwd: runtime });
  const status = JSON.parse(execFileSync(process.execPath, [path.join(runtime, 'bin/codex-weixin.js'), 'status', '--state-dir', state], { encoding: 'utf8' }));
  assert.equal(status.configured, true); assert.equal(status.weixinCredentialsStored, false);
  assert.equal(status.sandbox, 'read-only');
  console.log('PASS: offline npx tarball install -> durable runtime -> QR dependency resolution -> persisted config readback (no login/model call).');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
