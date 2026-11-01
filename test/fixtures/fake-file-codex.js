#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const threads = new Map(); let turn = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line); if (message.id === undefined || !message.method) return;
 const { method, params: p } = message; const reply = result => send({ id: message.id, result });
 if (method === 'initialize') return reply({});
 if (method === 'thread/start') { const id = `thread-${threads.size+1}`; const thread = { id, cwd: p.cwd, source: 'appServer', status: { type: 'idle' } }; threads.set(id, thread); return reply({ thread, cwd: p.cwd }); }
 if (method === 'thread/loaded/list') return reply({ data: [...threads.keys()] });
 if (method === 'thread/list') return reply({ data: [...threads.values()], nextCursor: null });
 if (method === 'thread/name/set') { threads.get(p.threadId).name = p.name; return reply({}); }
 if (method === 'thread/resume' && !threads.get(p.threadId).name) { send({ id: message.id, error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` } }); return; }
 if (method === 'thread/read' || method === 'thread/resume') return reply({ thread: threads.get(p.threadId), cwd: threads.get(p.threadId).cwd });
 if (method === 'turn/start') {
  const id = `turn-${++turn}`; const fileName = '测试报告.txt';
  fs.writeFileSync(path.join(threads.get(p.threadId).cwd, fileName), '附件链路确认成功\n', 'utf8');
  reply({ turn: { id, status: 'inProgress' } });
  send({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `文件已生成，请确认。\n[[weixin-file:${fileName}]]` } } });
  send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed' } } }); return;
 }
 send({ id: message.id, error: { code: -32601 } });
});
