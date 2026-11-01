import { EventEmitter } from 'node:events';

// No native Codex process/model call. Records mutations for presentation-only tests.
export class StyleBackend extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.loaded = false; this.calls = []; this.answers = []; this.closed = false; }
  async request(method, params = {}) {
    this.calls.push({ method, params });
    const thread = { id: 'style-thread', name: 'Markdown QA', cwd: this.cwd, source: 'cli', status: { type: this.loaded ? 'idle' : 'notLoaded' } };
    if (method === 'thread/loaded/list') return { data: this.loaded ? [thread.id] : [] };
    if (method === 'thread/list') return { data: [thread], nextCursor: null };
    if (method === 'thread/read') return { thread };
    if (method === 'thread/resume') { this.loaded = true; return { thread: { ...thread, status: { type: 'idle' } } }; }
    if (method === 'thread/start') { this.loaded = true; return { thread: { ...thread, id: 'new-style-thread' } }; }
    if (method === 'thread/name/set') return {};
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-style', status: 'completed', items: [{ type: 'agentMessage', text: '```js\nconst x = 1;\n```' }] }], nextCursor: null };
    if (method === 'model/list') return { data: [{ id: 'test-model' }] };
    if (['skills/list', 'mcpServerStatus/list'].includes(method)) return { data: [] };
    throw new Error(`Unexpected style-test RPC ${method}`);
  }
  send(value) { this.answers.push(value); }
}
