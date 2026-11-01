import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
  }
  read(name, fallback = null) {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Invalid ${name}.json; restore a backup instead of resetting state.`); }
  }
  write(name, value) {
    const target = path.join(this.root, `${name}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    const dir = fs.openSync(this.root, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  lock() {
    const file = path.join(this.root, 'run.lock');
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error('Bridge is locked. If no bridge is running, remove run.lock manually.');
    }
    return () => fs.unlinkSync(file);
  }
}

export function validateConfig(config) {
  if (!config || config.version !== 1) throw new Error('Run install first.');
  if (!['read-only', 'workspace-write'].includes(config.sandbox)) throw new Error('Invalid sandbox.');
  if (config.messageFormat !== undefined && !['markdown', 'plain'].includes(config.messageFormat)) throw new Error('Invalid messageFormat.');
  if (!path.isAbsolute(config.workspace) || !fs.statSync(config.workspace).isDirectory()) throw new Error('Workspace must be an existing absolute directory.');
  if (!Array.isArray(config.allowUsers) || !config.allowUsers.every(x => typeof x === 'string' && x.length > 0)) throw new Error('Invalid allowUsers.');
  return config;
}
