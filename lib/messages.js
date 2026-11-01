// Built-in UI messages only. Never rewrite model answers or interpret user text as commands.
export function codeBlock(value, language = '') {
  const text = String(value ?? '');
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(x => x.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
export function inlineCode(value) {
  const text = String(value ?? '').replace(/[\r\n]/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) || []).map(x => x.length)) + 1);
  return `${fence} ${text} ${fence}`;
}
export const actionHint = (label, command) => `**${label}**\n\n${codeBlock(command)}`;
export const message = (title, ...sections) => `## ${title}\n\n${sections.filter(Boolean).join('\n\n')}`;
export function controlMarkdown(value, title = '提示') {
  const text = String(value ?? '');
  if (!text.trim() || /^#{1,6}\s/.test(text)) return text;
  // Don't alter already-fenced data or command blocks. Plain fallback notices get paragraphs.
  return message(title, text.includes('```') ? text : text.split(/\n+/).filter(Boolean).join('\n\n'));
}
export function confirmationMessage(action, selected, code) {
  const title = { resume: '恢复会话', archive: '归档会话', unarchive: '取消归档', delete: '删除会话' }[action] || action;
  return message(`${title}需要确认`, `**目标会话**：${inlineCode(selected)}`,
    action === 'resume' ? '**请先核实**：该会话没有在未接入的桌面或 IDE 后端运行，避免两个执行者。' : '请核对目标，确认后才会执行。',
    actionHint('确认操作（复制后发送）', `/confirm ${code}`),
    '**有效期**：120 秒。切换会话或桥接重启后失效；不发送则不会执行。');
}
export function approvalMessage(target, code, method, details, { compact = false, urlMode = false, remainingSeconds = 120 } = {}) {
  const form = ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(method);
  const browserAuth = method === 'mcpServer/elicitation/request' && urlMode;
  const kind = { 'item/commandExecution/requestApproval': '命令执行', 'item/fileChange/requestApproval': '文件修改', 'item/permissions/requestApproval': '权限申请', 'item/tool/requestUserInput': '交互问题', 'mcpServer/elicitation/request': 'MCP 交互' }[method] || method;
  return message(browserAuth ? '需要浏览器授权' : form ? '需要你的回答' : '需要单次授权', `**目标会话**：${inlineCode(target)}`,
    `**请求类型**：${kind}`,
    !compact && `**请求详情**（最多 6000 字符；截断时请在本机查看完整内容）\n\n${codeBlock(details, 'json')}`,
    browserAuth ? '请在本机或浏览器完成授权；微信不会代填凭据。' : form ? actionHint('填写回答（替换 JSON 后发送）', `/answer ${code} {}`) : actionHint('单次同意', `/ok ${code}`),
    actionHint('拒绝', `/no ${code}`), `**剩余有效期**：${remainingSeconds} 秒，超时默认拒绝。不会扩大整个会话权限。`);
}
export const moreMessage = (remaining, code) => message('还有后续内容', `剩余 **${remaining} 段**；继续读取不会重新执行任务。`, actionHint('继续', `/more ${code}`));

const HELP = [
  ['会话目录', '/s'], ['项目目录', '/p'], ['切换会话（替换编号）', '/u <编号>'], ['新建会话', '/n'],
  ['当前状态', '/st'], ['查看历史', '/hist'], ['继续长结果', '/more'], ['发送文件（替换路径）', '/f <相对路径>'],
  ['单次同意（替换确认码）', '/ok <确认码>'], ['拒绝（替换确认码）', '/no <确认码>'],
  ['追加指令（替换内容）', '/+ <追加指令>'], ['停止当前任务', '/q'],
];
const EXTRA = [
  ['后端状态', '/backends'], ['下一页会话', '/s next'], ['归档会话', '/s archived'], ['恢复会话（另需确认）', '/resume'],
  ['订阅进度', '/watch'], ['停止订阅', '/unwatch'], ['待审批请求', '/a'], ['提交表单（替换确认码和JSON）', '/answer <确认码> {}'],
  ['交付文件目录', '/files'], ['模型目录', '/models'], ['选择模型（替换ID）', '/model <模型ID>'],
  ['推理档位（示例）', '/effort high'], ['技能目录', '/skills'], ['MCP状态', '/mcp'], ['重命名（替换名称）', '/rename <名称>'],
  ['创建会话分支', '/fork'], ['归档（另需确认）', '/archive'], ['取消归档（另需确认）', '/unarchive'], ['删除（另需确认）', '/delete'],
  ['执行已确认操作（替换确认码）', '/confirm <确认码>'],
];
export function helpMessage(all = false) {
  return message('微信 Codex 帮助', '直接说任务即可；以下每个代码块都是单条命令。尖括号内为需要替换的参数。',
    ...[...HELP, ...(all ? EXTRA : [['完整命令', '/h all']])].map(([label, command]) => actionHint(label, command)),
    '原长命令仍可用。仅历史可见不等于可以实时接管；不会自动批准操作。');
}
