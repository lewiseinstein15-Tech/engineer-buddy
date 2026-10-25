// MCP server mode (v0.15.0) — Buddy as an MCP stdio server, symmetry with
// the client. Protocol level: initialize / tools/list / tools/call over
// newline-delimited JSON-RPC 2.0; capability level: read/test/patch/todo.
//
// Two real bugs this suite froze in place: process.exit() racing the pipe
// (the handshake got truncated envelopes) and a `return` at ESM top level
// (a syntax error that only showed up when a child imported the file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverTools, startMcpServer } from '../src/mcpserver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mcpsrv-'));
}

// ── Capability level (in-process) ────────────────────────────────────────────

test('serverTools: read trio works through LocalScope, secrets refused', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOP_SECRET=1\n'); // exists → the guard throws
  const tools = Object.fromEntries(serverTools(root).map((t) => [t.name, t]));
  assert.match(await tools.buddy_fs_list.run({}), /src/);
  assert.match(await tools.buddy_fs_read.run({ path: 'src/a.js' }), /export const a = 1/);
  assert.match(await tools.buddy_fs_search.run({ needle: 'a = 1' }), /src\/a\.js:1/);
  // LocalScope.read throws BuddyError on secret paths — the tool surface
  // converts it to an ERROR string, the protocol layer to an isError result.
  assert.match(await tools.buddy_fs_read.run({ path: '.env' }), /^ERROR: .*secrets/);
});

test('serverTools: repo map + tests + todo state round-trip', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'ok.test.js'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('ok passes', () => assert.equal(1, 1));\n");
  fs.writeFileSync(path.join(root, '.buddy', 'todo.json'), JSON.stringify({ savedAt: 'now', items: [{ id: '1', text: 'ship it', status: 'in_progress', blocked_by: [] }] }));
  const tools = Object.fromEntries(serverTools(root).map((t) => [t.name, t]));
  assert.match(await tools.buddy_todo_state.run({}), /#1 ship it/);
  assert.equal(await tools.buddy_todo_state.run({ clear: true }), 'PLAN cleared.');
  assert.match(await tools.buddy_todo_state.run({}), /no todo plan saved/);
  const map = await tools.buddy_repo_map.run({});
  assert.equal(typeof map, 'string');
  const tests = await tools.buddy_run_tests.run({ target: 'test/ok.test.js' });
  assert.match(String(tests), /pass/i, `structured verdict expected, got: ${String(tests).slice(0, 200)}`);
});

test('serverTools: writes are OFF by default and refused with the fix in the message', async () => {
  const root = tmpRoot();
  const tools = Object.fromEntries(serverTools(root).map((t) => [t.name, t]));
  const out = await tools.buddy_fs_write.run({ path: 'x.txt', content: 'hi' });
  assert.match(out, /^ERROR: writes are disabled/);
  assert.match(out, /--allow-writes/);
  const patch = await tools.buddy_apply_patch.run({ path: 'x.txt', find: 'a', replace: 'b' });
  assert.match(patch, /^ERROR: writes are disabled/);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('serverTools: --allow-writes flips the mutating pair on', async () => {
  const root = tmpRoot();
  const tools = Object.fromEntries(serverTools(root, { writes: true }).map((t) => [t.name, t]));
  fs.writeFileSync(path.join(root, 'x.txt'), 'hello world\n');
  const w = await tools.buddy_fs_write.run({ path: 'y.txt', content: 'new' });
  assert.match(w, /^OK/);
  const p = await tools.buddy_apply_patch.run({ path: 'x.txt', find: 'world', replace: 'there' });
  assert.match(p, /^OK replaced snippet/);
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'hello there\n');
});

// ── Protocol level (in-process loop with fake stdio) ─────────────────────────

class FakeStdio {
  constructor() {
    this.out = '';
    this.handlers = {};
  }
  write(s) { this.out += s; return true; }
  setEncoding() {}
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  removeListener() {}
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
  get lines() { return this.out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
}

test('protocol: initialize → tools/list → tools/call round-trip', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'f.txt'), 'content\n');
  const stdin = new FakeStdio();
  const stdout = new FakeStdio();
  const srv = startMcpServer(root, { stdin, stdout });
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } } }) + '\n');
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: { path: 'f.txt' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 20));
  const lines = stdout.lines;
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, 'engineer-buddy');
  assert.equal(lines[0].result.protocolVersion, '2024-11-05');
  assert.equal(lines.length, 3, 'notifications get no response');
  const listed = lines[1].result.tools;
  assert.ok(listed.length >= 8, 'read trio + map + tests + todo + 2 writers');
  assert.ok(listed.every((t) => t.name && t.description && t.inputSchema), 'schema on every tool');
  assert.ok(!('run' in listed[0]), 'run functions never leak into the listing');
  const call = lines[2];
  assert.equal(call.id, 3);
  assert.match(call.result.content[0].text, /content/);
  assert.notEqual(call.result.isError, true);
  srv.stop();
});

test('protocol: unknown tool → JSON-RPC error; failing tool → isError result; unknown method → -32601', async () => {
  const root = tmpRoot();
  const stdin = new FakeStdio();
  const stdout = new FakeStdio();
  const srv = startMcpServer(root, { stdin, stdout });
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } }) + '\n');
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: {} } }) + '\n');
  stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 30));
  // Replies can reorder when a tool awaits — match by id, not position.
  const byId = new Map(stdout.lines.map((l) => [l.id, l]));
  assert.equal(byId.get(1).error.code, -32602);
  assert.equal(byId.get(2).result.isError, true);
  assert.match(byId.get(2).result.content[0].text, /^ERROR/);
  assert.equal(byId.get(3).error.code, -32601);
  srv.stop();
});

// ── End-to-end over a REAL child process (the transport Buddy ships) ─────────

function spawnServer(root, extraArgs = ['mcp-serve', '--dir', root]) {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      } catch { /* noise */ }
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout on ${method}`)); }, 10000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, request, stop: () => child.kill('SIGKILL') };
}

test('end-to-end: real child process handshake + call + clean exit', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'e2e.txt'), 'over the pipe\n');
  const srv = spawnServer(root);
  try {
    const init = await srv.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    assert.equal(init.result.serverInfo.name, 'engineer-buddy');
    const listed = await srv.request('tools/list');
    assert.ok(listed.result.tools.some((t) => t.name === 'buddy_run_tests'));
    const call = await srv.request('tools/call', { name: 'buddy_fs_read', arguments: { path: 'e2e.txt' } });
    assert.match(call.result.content[0].text, /over the pipe/);
  } finally {
    srv.stop();
  }
});
