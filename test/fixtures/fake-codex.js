#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli test-double'); process.exit(0); }
let initialized = false; let nextThread = 0; let nextTurn = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) return;
  if (m.method === 'initialize') { initialized = true; send({ id: m.id, result: { userAgent: 'test' } }); return; }
  if (m.id === undefined) return;
  if (!initialized) { send({ id: m.id, error: { code: -32000 } }); return; }
  const p = m.params;
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (!['read-only', 'workspace-write'].includes(p.sandbox) || p.approvalPolicy !== 'never') { send({ id: m.id, error: { code: -32602 } }); return; }
    send({ id: m.id, result: { thread: { id: p.threadId || `thread-${++nextThread}` } } }); return;
  }
  if (m.method === 'turn/start') {
    const text = p.input[0].text; const turn = { id: `turn-${++nextTurn}`, status: text === 'FAIL' ? 'failed' : 'completed' };
    if (text === 'CRASH') process.exit(3);
    if (text === 'SLOW') return;
    // Deliberately emit completion BEFORE the RPC response to exercise the race.
    send({ method: 'item/completed', params: { threadId: 'unrelated', turnId: turn.id, item: { id: 'wrong', type: 'agentMessage', text: 'must not leak' } } });
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'working' } } });
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `答复：${text}` } } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn } });
    send({ id: m.id, result: { turn } }); return;
  }
  send({ id: m.id, error: { code: -32601 } });
});
