// Conservative distribution guard, not a replacement for manual secret review.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const pkg = JSON.parse(fs.readFileSync('package.json'));
assert.equal(pkg.repository.url, 'git+https://github.com/uk0/codex-weixin.git');
assert.equal(pkg.bin['codex-weixin'], 'bin/codex-weixin.js');
const entries = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0].files;
const rootFiles = new Set(['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'docs/CLI.md', 'docs/ARCHITECTURE.md']);
for (const { path: name } of entries) assert(rootFiles.has(name) || /^(bin|lib)\/[\w-]+\.js$/.test(name), `Unexpected package file: ${name}`);
const ignored = new Set(['.git', 'node_modules', 'artifacts', 'dist', '.codebase-memory']);
const forbiddenNames = /^(account|config|control|state)\.json$|^run\.lock$|^\.env(?:\.|$)|^\.npmrc$|\.(pem|key)$/;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  new RegExp('/' + 'Users/[^\\s/]+/'),
  new RegExp('/' + 'home/(?!runner/)[^\\s/]+/'),
];
let checked = 0;
function walk(dir = '.') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, e.name);
    if (ignored.has(e.name) || /\.(tgz|log|ndjson)$/.test(e.name)) continue;
    assert(!e.isSymbolicLink(), `Symlink in release checkout: ${name}`);
    assert(!forbiddenNames.test(e.name), `Private state/config file: ${name}`);
    if (e.isDirectory()) { walk(name); continue; }
    if (!e.isFile()) continue;
    const data = fs.readFileSync(name, 'utf8');
    for (const re of patterns) assert(!re.test(data), `Sensitive-looking content: ${name}`);
    checked++;
  }
}
walk();
console.log(`PASS: ${entries.length} allowlisted package files; ${checked} source files reviewed by release guard.`);
