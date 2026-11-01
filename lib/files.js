import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';

// Product guardrail, not a claim about Weixin's server limit.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export class ArtifactError extends Error { constructor(message) { super(message); this.permanent = true; } }
const digest = data => createHash('sha256').update(data).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readWorkspaceFile(workspace, requested, maxBytes = MAX_FILE_BYTES) {
  if (typeof requested !== 'string' || !requested || /[\x00-\x1f]/.test(requested)) throw new ArtifactError('文件路径无效。');
  let root;
  try { root = fs.realpathSync(workspace); } catch { throw new ArtifactError('当前会话工作目录在本机不可用，不能发送远端路径。'); }
  // macOS may expose the selected cwd as /var/... while realpath is /private/var/...
  // Map only the cwd alias; descendants still undergo the strict no-symlink checks below.
  const lexicalRoot = path.resolve(workspace);
  const lexicalRelative = path.relative(lexicalRoot, path.resolve(lexicalRoot, requested));
  const insideLexical = lexicalRelative && lexicalRelative !== '..' && !lexicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(lexicalRelative);
  const target = insideLexical ? path.resolve(root, lexicalRelative) : path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ArtifactError('只能发送当前会话工作目录内的普通文件。');
  const parts = relative.split(path.sep);
  if (parts.some(p => p.startsWith('.')) || /^(?:account|auth|credentials|secrets?|tokens?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keychain)$/i.test(path.basename(target))) throw new ArtifactError('隐藏文件、凭据文件及私钥不允许作为微信附件发送。');
  let fd;
  try {
    let cursor = root;
    for (const part of parts) { cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink()) throw new ArtifactError('为避免越界，附件路径不能包含符号链接。'); }
    if (!fs.lstatSync(target).isFile()) throw new ArtifactError('只能发送普通文件，不接受目录、设备或管道。');
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new ArtifactError('只能发送普通文件，不接受设备、目录或硬链接。');
    if (before.size > maxBytes) throw new ArtifactError(`附件超过本插件的 ${Math.floor(maxBytes / 1024 / 1024)} MiB 上限。`);
    if (fs.realpathSync(target) !== target) throw new ArtifactError('附件路径在读取时发生变化。');
    const chunks = []; let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count; if (total > maxBytes) throw new ArtifactError('附件在读取中增长并超出限制。');
      chunks.push(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd); const current = fs.statSync(target);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || fs.realpathSync(target) !== target) throw new ArtifactError('附件在读取时被修改或替换，请重新发送。');
    const data = Buffer.concat(chunks);
    return { data, fileName: path.basename(target), size: data.length, sha256: digest(data), path: target };
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('无法读取附件，请检查文件是否存在及读取权限。');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export class FileSpool {
  constructor(root) {
    this.root = path.join(root, 'outbox-files');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new ArtifactError('私有附件缓存不能是符号链接。');
    fs.chmodSync(this.root, 0o700);
  }
  file(id) { if (!UUID.test(id)) throw new ArtifactError('附件缓存编号无效。'); return path.join(this.root, id); }
  snapshot(workspace, requested) {
    const file = readWorkspaceFile(workspace, requested); const spoolId = randomUUID();
    const fd = fs.openSync(this.file(spoolId), 'wx', 0o600);
    try { fs.writeFileSync(fd, file.data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(this.root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return { spoolId, fileName: file.fileName, size: file.size, sha256: file.sha256,
      uploadKeys: { filekey: randomBytes(16).toString('hex'), aeskey: randomBytes(16).toString('hex') } };
  }
  read(item) {
    const file = this.file(item.spoolId); let data;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error();
      data = fs.readFileSync(file);
    } catch { throw new ArtifactError('待发送附件缓存丢失或无效，请重新 /send。'); }
    if (data.length !== item.size || digest(data) !== item.sha256) throw new ArtifactError('待发送附件校验失败，不会重新读取原文件。');
    return data;
  }
  remove(item) { try { fs.unlinkSync(this.file(item.spoolId)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function fileDirectives(text) {
  const files = []; const cleaned = String(text || '').replace(/\[\[weixin-file:([^\]\r\n]{1,1024})\]\]/g, (_, value) => {
    if (files.length < 5) files.push(value.trim()); return '';
  }).trim();
  return { text: cleaned, files: [...new Set(files)] };
}
export function fileDeliveryRequested(text) { return /发给我|发送给我|发我|发回|回传|作为附件|附件|供我确认|给我确认|(?:发送|发|传).{0,160}文件.{0,12}给我|(?:把|将).{0,160}(?:发|传).{0,4}(?:给我|我)|send.{0,30}file|attach|deliver.{0,30}file/i.test(text); }
export const FILE_OUTPUT_HINT = '\n\n[微信附件交付约定] 用户请求文件回传时，请把交付文件保存到本会话工作目录内，最终回答用 [[weixin-file:相对路径]] 标明每个交付文件（最多5个，单个不超过10MiB），桥接会随后作为真实附件发给用户检查。不要标记隐藏文件、凭据或私钥；不要声称文件已发送。此约定不授权超出原有沙箱权限。';
