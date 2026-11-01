import { createInterface } from 'node:readline';
const threads = new Map(); const pending = new Map(); let next = 0;
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const p = m.params || {};
  const reply = result => send({ id: m.id, result });
  if (!m.method) {
    const request = pending.get(m.id); if (!request) return;
    if (!m.result?.success || !JSON.parse(m.result.contentItems[0].text).accepted) throw new Error('File receipt was not accepted.');
    send({ method: 'item/completed', params: { threadId: request.threadId, turnId: request.turnId, item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: '**测试文件已提交微信**，请确认。' } } });
    send({ method: 'turn/completed', params: { threadId: request.threadId, turn: { id: request.turnId, status: 'completed' } } }); return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') { if (!p.capabilities?.experimentalApi) throw new Error('experimentalApi required'); return reply({}); }
  if (m.method === 'thread/start') {
    if (!p.dynamicTools?.some(t => t.name === 'weixin_send_file')) throw new Error('missing actual tool');
    const thread = { id: 'tool-thread-' + ++next, cwd: p.cwd, status: { type: 'idle' } }; threads.set(thread.id, thread); return reply({ thread });
  }
  if (m.method === 'thread/name/set') return reply({});
  if (m.method === 'thread/loaded/list') return reply({ data: [...threads.keys()] });
  if (m.method === 'thread/read' || m.method === 'thread/resume') return reply({ thread: threads.get(p.threadId) });
  if (m.method === 'turn/start') {
    const turnId = 'turn-1'; const id = 'tool-call-1'; pending.set(id, { threadId: p.threadId, turnId });
    // Deliberately send before turn/start response to exercise early-request ordering.
    send({ id, method: 'item/tool/call', params: { threadId: p.threadId, turnId, callId: 'file-1', tool: 'weixin_send_file', arguments: { path: '通道测试.txt' } } });
    return reply({ turn: { id: turnId, status: 'inProgress' } });
  }
  send({ id: m.id, error: { code: -32601 } });
});
