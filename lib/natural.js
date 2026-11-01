import fs from 'node:fs';
import path from 'node:path';
import { ArtifactError } from './files.js';

export function isNewRequest(text) {
  return /^(?:(?:请|帮我|麻烦)?\s*)?(?:new(?:\s*(?:一下|一个))?|新建(?:一个|个|一下)?(?:会话|对话)|(?:开启|开始)(?:一个|个)?新(?:会话|对话))[。.!！]?$/i.test(text.trim());
}
function unquote(value) {
  let s = value.trim();
  for (const [left, right] of [['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['《', '》']]) {
    if (s.startsWith(left) && s.endsWith(right)) { s = s.slice(left.length, -right.length).trim(); break; }
  }
  return s;
}
export function parseFileSendRequest(text) {
  const s = text.trim().replace(/[。！!？?]+$/, '').trim();
  if (s.startsWith('/') || s.length > 1500) return null;
  // Requests to create/modify first must remain model tasks, not file lookups.
  if (/(?:生成|新建|创建|制作|写一|编写|修改|编辑|转换|导出|打包|压缩|整理|汇总|做一|create\b|generate\b|edit\b|convert\b|export\b)/i.test(s)) return null;
  const polite = '(?:(?:请你?|麻烦你?|帮我|能不能|能否|可以)\\s*)*';
  const endings = '(?:给我|我|过来)(?:看看|看一下|看下|确认(?:一下)?|一下)?';
  const patterns = [
    new RegExp(`^${polite}(?:把|将)\\s*(.+?)\\s*(?:发送|发|回传|传送|传)${endings}$`, 'i'),
    new RegExp(`^${polite}(?:发送|发|回传|传送|传)(?:给我)?(?:一下)?(?:一个|一份|这份|这个|个|份)?\\s*(.+?)\\s*${endings}$`, 'i'),
    new RegExp(`^${polite}给我(?:发送|发|传)(?:一下)?(?:一个|一份|个|份)?\\s*(.+)$`, 'i'),
    /^send\s+(?:me\s+)?(?:(?:the|a|an)\s+)?(?:file\s+)?(.+?)(?:\s+to\s+me)?$/i,
  ];
  let raw;
  for (const pattern of patterns) { const m = s.match(pattern); if (m) { raw = m[1]; break; } }
  if (raw === undefined) {
    const short = s.match(new RegExp(`^${polite}(?:发送|发|回传)\\s+(?:文件\\s+)?(.+)$`, 'i'));
    if (short && /(?:\.[a-z0-9]{1,10}$|[/\\])/.test(unquote(short[1]))) raw = short[1];
  }
  if (raw === undefined) return null;
  raw = raw.trim().replace(/([”》"'`])\s*文件$/, '$1');
  const quoted = /^["'`“《]/.test(raw);
  if (!quoted) raw = raw.replace(/\s*(?:这个|这份)?文件$/, '').replace(/^(?:文件\s+|一个\s+|一份\s+)/, '');
  const selector = unquote(raw);
  return { selector };
}

const skipped = new Set(['node_modules', '__pycache__', 'venv', 'site-packages']);
const normalized = text => text.normalize('NFC').toLocaleLowerCase();
function allowed(root, value) {
  const target = path.resolve(root, value); const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ArtifactError('只能发送当前会话工作目录内的文件。');
  if (relative.split(path.sep).some(p => p.startsWith('.')) || /^(?:account|auth|credentials|secrets?|tokens?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keychain)$/i.test(path.basename(target))) throw new ArtifactError('隐藏文件、凭据和私钥不能作为附件发送。');
  return { target, relative };
}
function regularWithoutLinks(root, relative) {
  let current = root;
  try {
    for (const component of relative.split(path.sep)) { current = path.join(current, component); if (fs.lstatSync(current).isSymbolicLink()) return false; }
    const stat = fs.lstatSync(current); return stat.isFile() && stat.nlink === 1;
  } catch { return false; }
}
export function findRequestedFiles(workspace, selector, { known = [], maxEntries = 2500, maxDepth = 4 } = {}) {
  let root;
  try { root = fs.realpathSync(workspace); } catch { throw new ArtifactError('当前会话目录在本机不可用。'); }
  if (!selector || /[\x00-\x1f]/.test(selector)) throw new ArtifactError('请提供文件名或路径，例如“把报告.pdf发给我”。');
  const direct = allowed(root, selector);
  if (regularWithoutLinks(root, direct.relative)) return { matches: [direct.relative], truncated: false, exact: true };
  if (path.isAbsolute(selector) || /[/\\]/.test(selector)) return { matches: [], truncated: false };
  const q = normalized(selector); const hasExtension = !!path.extname(selector);
  const exact = name => normalized(name) === q || (!hasExtension && normalized(path.parse(name).name) === q);
  const knownMatches = [];
  for (const item of known) {
    try {
      const candidate = allowed(root, item.path);
      if (exact(path.basename(candidate.relative)) && regularWithoutLinks(root, candidate.relative)) knownMatches.push(candidate.relative);
    } catch {}
  }
  if (knownMatches.length) return { matches: [...new Set(knownMatches)], truncated: false, exact: true };
  if (/^(?:刚才|上次|之前|最新)(?:的)?(?:那|这个|这份|那个|那份)?$/.test(selector) && known.length === 1) {
    try { const candidate = allowed(root, known[0].path); if (regularWithoutLinks(root, candidate.relative)) return { matches: [candidate.relative], truncated: false, exact: true }; } catch {}
  }
  const exactMatches = []; const fuzzyMatches = []; let count = 0; let truncated = false;
  const visit = (directory, depth) => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++count > maxEntries) { truncated = true; return; }
      if (entry.name.startsWith('.') || skipped.has(entry.name) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth) visit(target, depth + 1); if (truncated) return; continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target);
      try { allowed(root, relative); } catch { continue; }
      if (exact(entry.name)) exactMatches.push(relative);
      else if (q.length >= 2 && normalized(entry.name).includes(q)) fuzzyMatches.push(relative);
      if (exactMatches.length > 20 || fuzzyMatches.length > 100) { truncated = true; return; }
    }
  };
  visit(root, 0);
  return { matches: (exactMatches.length ? exactMatches : fuzzyMatches).slice(0, 20), truncated, exact: exactMatches.length > 0 };
}
