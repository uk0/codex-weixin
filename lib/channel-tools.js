// The model chooses the operation. These tools expose transport only, never recipients or RPC.
export const CHANNEL_TOOLS = [
  { type: 'function', name: 'weixin_list_sessions', description: 'Read current visible Codex session metadata across connected backends. Returns stable numbers/refs, status, scope and pagination. For all sessions set includeArchived:true and follow nextCursor until null; disclose incomplete coverage. No history bodies or automatic resume.', inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, includeArchived: { type: 'boolean' } }, additionalProperties: false } },
  { type: 'function', name: 'weixin_list_projects', description: 'List configured projects, visible session workspaces, and immediate directory candidates under the local configured project root. Does not grant permissions. Render findings in concise Markdown. Reuse a recent session catalog if available.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'weixin_select_session', description: 'Only on an explicit user request to switch: select an exact ref returned by weixin_list_sessions. Never guesses a thread ID or resumes history automatically. Existing sessions may lack channel tools; report the returned capability limits.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'weixin_send_file', description: 'Send an existing file to the Weixin user who started this turn. Use this tool when the user requests a file; choose/locate/create the file using native Codex tools first. Path must be inside this session workspace, non-hidden, non-sensitive, <=10MiB. Returns API acceptance, not proof the user opened it. Never use [[weixin-file:...]] text markers. Do not retry unknown/pending delivery.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative or absolute file path inside the session cwd.' } }, required: ['path'], additionalProperties: false,
  } },
  { type: 'function', name: 'weixin_send_text', description: 'Send an intermediate message to the originating Weixin user. Ordinary final answers are forwarded automatically; avoid sending the same answer twice. Keep messages brief. Markdown source is preserved by default. Do not retry unknown/pending delivery.', inputSchema: {
    type: 'object', properties: { text: { type: 'string', description: 'Short user-facing message.' } }, required: ['text'], additionalProperties: false,
  } },
];

export function catalogArguments(tool, args) {
  const field = tool === 'weixin_list_sessions' ? 'cursor' : tool === 'weixin_select_session' ? 'ref' : null;
  const allowed = tool === 'weixin_list_sessions' ? ['cursor', 'includeArchived'] : field ? [field] : [];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Invalid inventory tool arguments.');
  if (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean') throw new Error('Invalid archived filter.');
  if (field && args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > 180)) throw new Error('Invalid inventory cursor/ref.');
  if (tool === 'weixin_select_session' && !args.ref) throw new Error('Missing session ref.');
  return args;
}

export function toolPayload(tool, args) {
  const field = tool === 'weixin_send_file' ? 'path' : tool === 'weixin_send_text' ? 'text' : null;
  if (!field || !args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length !== 1 || typeof args[field] !== 'string' || !args[field].trim()) throw new Error('Invalid channel tool arguments.');
  if (args[field].length > (field === 'text' ? 8000 : 4096)) throw new Error('Channel tool argument too long.');
  return { type: field === 'path' ? 'file' : 'text', [field]: args[field] };
}

// Optional compatibility formatter, NOT the default. No assertion about client rendering.
export function weixinPlainText(value) {
  let fence = null;
  return String(value || '').split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) { fence = marker[1]; return ''; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; return ''; }
      return line; // Never rewrite Markdown-looking characters inside source code.
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return '';
    return line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '')
      .replace(/`([^`]+)`/g, '\u0000$1\u0000')
      .split('\u0000').map((part, i) => i % 2 ? part : part
        .replace(/!?\[([^\]]*)\]\(([^\s)]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/__([^\n]+?)__/g, '$1').replace(/~~([^\n]+?)~~/g, '$1'))
      .join('');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
