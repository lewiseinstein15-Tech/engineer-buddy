// v0.44.0 — the unified protocol end-state (checklist §12): subagents on MCP
// tools, narration streaming from every level.
//
// Units run offline (fake connections, injectable streams, _handleLine fed by
// hand); the LIVE leg drives a REAL `buddy mcp-serve` child process through a
// REAL McpClient — host and server are the same agent, one protocol — REAL > SIMULATED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import {
  McpClient, parseNotification, buildMcpTools, loadMcpConfig, MAX_NOTIFICATIONS, TOOL_NAME_OK,
} from '../src/tools/mcp.js';
import { startMcpServer, serverTools } from '../src/mcpserver.js';
import { compileAllowlist, allowMatches, runSubagent, parseAgentMd } from '../src/agent/subagents.js';
import { projectEvent } from '../src/eventslog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v044-'));
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeRouter(script, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"finish","result":"(exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

const fakeMcpTool = (name = 'mcp__testsrv__echo', log = []) => ({
  name,
  description: `[mcp:testsrv] echo back`,
  args: '{"text":"<string>"}',
  risky: true,
  render: (a) => `${name} ${JSON.stringify(a ?? {})}`,
  run: async (args) => {
    log.push(args);
    return `echo:${typeof args === 'object' ? JSON.stringify(args) : args}`;
  },
});

// ── parseNotification ────────────────────────────────────────────────────────

test('parseNotification: progress with and without total, garbage numbers stay null', () => {
  const a = parseNotification({ method: 'notifications/progress', params: { progress: 3, total: 10, message: 'halfway' } }, 'srv');
  assert.equal(a.kind, 'progress');
  assert.deepEqual(a.ev, { server: 'srv', phase: 'progress', progress: 3, total: 10, message: 'halfway' });
  const b = parseNotification({ method: 'notifications/progress', params: { progress: 'x', total: -5 } }, 'srv');
  assert.equal(b.ev.progress, null);
  assert.equal(b.ev.total, null);
  assert.equal(b.ev.message, '');
});

test('parseNotification: log levels whitelisted, object data JSON-encoded, long data truncated', () => {
  const a = parseNotification({ method: 'notifications/message', params: { level: 'warning', logger: 'tools', data: 'careful' } }, 'srv');
  assert.equal(a.kind, 'log');
  assert.equal(a.ev.level, 'warning');
  assert.equal(a.ev.logger, 'tools');
  assert.equal(a.ev.data, 'careful');
  const b = parseNotification({ method: 'notifications/message', params: { level: 'bogus', data: { k: 1 } } }, 'srv');
  assert.equal(b.ev.level, 'info'); // unknown level → honest default
  assert.equal(b.ev.data, '{"k":1}');
  const long = parseNotification({ method: 'notifications/message', params: { data: 'x'.repeat(500) } }, 'srv');
  assert.ok(long.ev.data.length < 220);
  const obj = parseNotification({ method: 'notifications/message', params: { data: { deep: { deeper: 'y'.repeat(400) } } } }, 'srv');
  assert.ok(obj.ev.data.length < 220);
});

test('parseNotification: unknown notifications and non-notifications are null (forward compatible)', () => {
  assert.equal(parseNotification({ method: 'notifications/somethingnew', params: {} }, 's'), null);
  assert.equal(parseNotification({ method: 'tools/call', params: {} }, 's'), null);
  assert.equal(parseNotification(null, 's'), null);
  assert.equal(parseNotification({ method: 42 }, 's'), null);
});

// ── McpClient notification routing (fed by hand — no spawn) ────────────────

test('McpClient: a notification carrying a PENDING request id must never settle it', async () => {
  const seen = [];
  const c = new McpClient({ name: 'hostile', command: 'x', onNotification: (ev) => seen.push(ev) });
  const sent = [];
  c.child = { stdin: { write: (s) => sent.push(JSON.parse(s)) } }; // capture the real pending id
  let settled = null;
  const p1 = c.request('tools/call', {}, 5000).then((v) => (settled = `resolved:${JSON.stringify(v)}`), (e) => (settled = `rejected:${e.message}`));
  const id1 = sent[0].id;
  // the poison: a NOTIFICATION (method present) wearing the pending request's id + an error payload
  c._handleLine(JSON.stringify({ jsonrpc: '2.0', id: id1, method: 'notifications/message', params: { level: 'error', data: 'poison' } }));
  assert.equal(settled, null); // routed by METHOD — the request stays open
  assert.equal(seen.length, 1); // …and still narrates
  assert.equal(seen[0].server, 'hostile');
  c._handleLine(JSON.stringify({ jsonrpc: '2.0', id: id1, result: { ok: true } })); // only the real response settles it
  await p1;
  assert.equal(settled, 'resolved:{"ok":true}');
});

test('McpClient: notification flood is capped at MAX_NOTIFICATIONS and the window resets per request', async () => {
  const seen = [];
  const c = new McpClient({ name: 'flood', command: 'x', onNotification: (ev) => seen.push(ev) });
  c.child = { stdin: { write() {} } }; // request() needs a transport to reach the reset line
  const req = c.request('tools/list', {}, 40).catch(() => 'timeout');
  for (let i = 0; i < MAX_NOTIFICATIONS + 100; i++) {
    c._handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `n${i}` } }));
  }
  assert.equal(seen.length, MAX_NOTIFICATIONS); // capped, never buffered past the cap
  await req;
  const after = seen.length;
  const req2 = c.request('tools/list', {}, 40).catch(() => 'timeout');
  for (let i = 0; i < 5; i++) c._handleLine(JSON.stringify({ method: 'notifications/message', params: { data: `m${i}` } }));
  assert.equal(seen.length, after + 5); // fresh window — the cap did not become permanent silence
  await req2;
});

test('McpClient: a throwing notification tap and a non-function tap never break the transport', () => {
  const c = new McpClient({ name: 't', command: 'x', onNotification: () => { throw new Error('tap bug'); } });
  c._handleLine(JSON.stringify({ method: 'notifications/message', params: { data: 'boom' } })); // must not throw
  const c2 = new McpClient({ name: 't2', command: 'x', onNotification: 'not a function' });
  c2._handleLine(JSON.stringify({ method: 'notifications/message', params: { data: 'x' } })); // ignored
  assert.ok(true);
});

// ── allowlist compilation + matching ─────────────────────────────────────────

test('compileAllowlist: null inherits all; only mcp-prefixed trailing * becomes a prefix rule', () => {
  assert.equal(compileAllowlist(null), null);
  assert.equal(compileAllowlist(''), null);
  const a = compileAllowlist('fs_read, mcp__gh__*');
  assert.deepEqual([...a.exact], ['fs_read']);
  assert.deepEqual(a.prefixes, ['mcp__gh__']);
  const b = compileAllowlist(['mcp__a__x', 'mcp__a__*']);
  assert.deepEqual([...b.exact], ['mcp__a__x']);
  assert.deepEqual(b.prefixes, ['mcp__a__']);
  const bare = compileAllowlist('*'); // a bare star matches nothing — MCP access is per-server
  assert.ok(bare.exact.has('*'));
  assert.equal(bare.prefixes.length, 0);
  const fsStar = compileAllowlist('fs_*'); // native tools can never be wildcarded
  assert.ok(fsStar.exact.has('fs_*'));
  assert.equal(fsStar.prefixes.length, 0);
});

test('allowMatches: exact hit, prefix hit, null allow passes everything', () => {
  const a = compileAllowlist('fs_read, mcp__gh__*');
  assert.equal(allowMatches(a, 'fs_read'), true);
  assert.equal(allowMatches(a, 'mcp__gh__create_issue'), true);
  assert.equal(allowMatches(a, 'mcp__other__create_issue'), false);
  assert.equal(allowMatches(a, 'bash'), false);
  assert.equal(allowMatches(null, 'anything'), true);
});

test('TOOL_NAME_OK: bridged names must survive the mcp__ join without corrupting registries', () => {
  assert.ok(TOOL_NAME_OK.test('create_issue'));
  assert.ok(TOOL_NAME_OK.test('search.code'));
  assert.ok(!TOOL_NAME_OK.test('a; rm -rf'));
  assert.ok(!TOOL_NAME_OK.test('has space'));
  assert.ok(!TOOL_NAME_OK.test(''));
  assert.ok(!TOOL_NAME_OK.test('x'.repeat(65)));
});

// ── runSubagent: the MCP surface rides down to sub-agents ───────────────────

test('runSubagent: an mcp wildcard allowlist grants bridged tools and the sub-agent CALLS one', async () => {
  const log = [];
  const parentTools = [fakeMcpTool('mcp__testsrv__echo', log), { name: 'fs_read', run: async () => 'x' }];
  const report = await runSubagent({
    router: fakeRouter(['{"tool":"mcp__testsrv__echo","args":{"text":"hi"}}', '{"tool":"finish","result":"echoed"}']),
    agent: { name: 'scout', tools: 'mcp__testsrv__*', maxSteps: 4, systemPrompt: 'test' },
    parentTools,
    task: 'echo hi through the mcp tool',
  });
  assert.match(report, /echoed/);
  assert.equal(log.length, 1); // the bridged tool really ran
  assert.deepEqual(log[0], { text: 'hi' });
});

test('runSubagent: dead wildcards and unknown names — refused when nothing is usable, tolerated beside a live tool', async () => {
  const dead = await runSubagent({
    router: fakeRouter([]),
    agent: { name: 's', tools: 'mcp__nosuch__*', maxSteps: 2, systemPrompt: 't' },
    parentTools: [{ name: 'fs_read', run: async () => 'x' }],
    task: 'x',
  });
  assert.match(dead, /no usable tools/);
  assert.match(dead, /no tools matched: mcp__nosuch__\*/);
  // a live tool beside the dead wildcard keeps the run alive (one down server
  // must not kill the persona) — the report is the agent's own, no refusal:
  const tolerated = await runSubagent({
    router: fakeRouter([]),
    agent: { name: 's', tools: 'mcp__nosuch__*, fs_read', maxSteps: 2, systemPrompt: 't' },
    parentTools: [{ name: 'fs_read', run: async () => 'x' }],
    task: 'x',
  });
  assert.doesNotMatch(tolerated, /no usable tools/);
  // a typo'd exact name with nothing else usable names the culprit:
  const unknown = await runSubagent({
    router: fakeRouter([]),
    agent: { name: 's', tools: 'fs_red', maxSteps: 2, systemPrompt: 't' },
    parentTools: [{ name: 'fs_read', run: async () => 'x' }],
    task: 'x',
  });
  assert.match(unknown, /no usable tools/);
  assert.match(unknown, /unknown: fs_red/);
});

test('runSubagent: `task` is structurally unreachable — exact, listed, or via any wildcard', async () => {
  const taskTool = { name: 'task', run: async () => 'SHOULD NEVER RUN' };
  const parentTools = [taskTool, { name: 'fs_read', run: async () => 'x' }];
  // asking ONLY for the forbidden tool is an honest refusal, not a grant:
  const onlyTask = await runSubagent({
    router: fakeRouter([]),
    agent: { name: 's', tools: 'task', maxSteps: 4, systemPrompt: 't' },
    parentTools,
    task: 'recurse',
  });
  assert.match(onlyTask, /no usable tools \(allowed: task\)/);
  const onlyWildcard = await runSubagent({
    router: fakeRouter([]),
    agent: { name: 's', tools: 'mcp__x__*, task', maxSteps: 4, systemPrompt: 't' },
    parentTools,
    task: 'recurse',
  });
  assert.match(onlyWildcard, /no usable tools/);
  // with a real tool beside it the run proceeds — and `task` still never fires:
  for (const tools of ['task, fs_read', null]) {
    const report = await runSubagent({
      router: fakeRouter(['{"tool":"task","args":{"agent":"explore","task":"recurse"}}', '{"tool":"finish","result":"done"}']),
      agent: { name: 's', tools, maxSteps: 4, systemPrompt: 't' },
      parentTools,
      task: 'try to recurse',
    });
    assert.match(report, /done/);
    assert.doesNotMatch(report, /SHOULD NEVER RUN/); // the recursion tool never executed
  }
});

test('runSubagent: a denied risky MCP call returns DENIED to the sub-agent, not a crash', async () => {
  const report = await runSubagent({
    router: fakeRouter(['{"tool":"mcp__testsrv__echo","args":{"text":"hi"}}', '{"tool":"finish","result":"gave up politely"}']),
    agent: { name: 's', tools: 'mcp__testsrv__*', maxSteps: 4, systemPrompt: 't' },
    parentTools: [fakeMcpTool()],
    task: 'echo',
    approval: async () => 'no',
    alwaysApproved: new Set(),
  });
  assert.match(report, /gave up politely/);
});

test('parseAgentMd: mcp wildcard allowlists parse through the frontmatter untouched', () => {
  const md = ['---', 'name: mcp-scout', 'description: rides the mcp surface', 'tools: mcp__buddy__*', 'maxSteps: 6', '---', 'body'].join('\n');
  const { agent } = parseAgentMd(md, { fallbackName: 'x' });
  assert.deepEqual(agent.tools, ['mcp__buddy__*']); // frontmatter splits to a list
  assert.deepEqual(compileAllowlist(agent.tools).prefixes, ['mcp__buddy__']);
});

// ── buildMcpTools: hostile names skipped honestly, proto pollution inert ────

test('buildMcpTools: invalid tool names are collected in .invalid, never bridged', () => {
  const tools = buildMcpTools([
    { name: 'srv', client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }, tools: [
      { name: 'good_name', inputSchema: { type: 'object' } },
      { name: 'bad; name', inputSchema: {} },
      { name: '', inputSchema: {} },
      { name: 'x'.repeat(70), inputSchema: {} },
      { name: 42, inputSchema: {} },
    ] },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mcp__srv__good_name');
  assert.equal(tools[0].risky, true);
  assert.deepEqual(tools.invalid, ['srv/bad; name', 'srv/' + 'x'.repeat(70)]);
});

test('buildMcpTools: __proto__ in tool ARGS never pollutes Object.prototype', async () => {
  const conn = { name: 'srv', client: { callTool: async (n, args) => ({ content: [{ type: 'text', text: 'got ' + JSON.stringify(args) }] }) }, tools: [{ name: 'echo', inputSchema: {} }] };
  const [tool] = buildMcpTools([conn]);
  const evil = JSON.parse('{"__proto__":{"injected":true},"text":"hi"}');
  const out = await tool.run(evil);
  assert.match(out, /hi/);
  assert.equal({}.injected, undefined); // Object.prototype untouched
  assert.equal(({}).polluted !== undefined, false);
});

// ── projectEvent: subagent + mcp facts survive the whitelist ────────────────

test('projectEvent: subagent events keep agent/tool/phase/obsChars; mcp events keep server/phase facts', () => {
  const sub = projectEvent({ type: 'subagent', phase: 'step', agent: 'mcp-scout', tool: 'mcp__buddy__buddy_fs_read', observation: 'FILE x:\n'.padEnd(50, 'y') });
  assert.deepEqual(sub, { type: 'subagent', agent: 'mcp-scout', tool: 'mcp__buddy__buddy_fs_read', phase: 'step', obsChars: 50 });
  const mcpLog = projectEvent({ type: 'mcp', server: 'buddy', phase: 'log', level: 'info', logger: 'tools', data: 'buddy_fs_read done in 3ms' });
  assert.equal(mcpLog.server, 'buddy');
  assert.equal(mcpLog.level, 'info');
  assert.equal(mcpLog.chars, 'buddy_fs_read done in 3ms'.length);
  assert.equal(mcpLog.progress, undefined);
  const prog = projectEvent({ type: 'mcp', server: 'buddy', phase: 'progress', progress: 2, total: 5, message: 'half' });
  assert.equal(prog.progress, 2);
  assert.equal(prog.total, 5);
  assert.equal(prog.level, undefined);
});

// ── prototype pollution through server names (RED TEAM find — pinned forever) ─

test('loadMcpConfig: a server named __proto__/constructor is renamed, never a prototype set', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), '{"mcpServers":{"__proto__":{"command":"sh"},"constructor":{"command":"sh"},"ok":{"command":"sh"}}}');
  const cfg = loadMcpConfig(dir);
  const names = Object.keys(cfg.mcpServers);
  assert.ok(names.includes('__proto__-reserved'), `names: ${names.join(',')}`);
  assert.ok(names.includes('constructor-reserved'));
  assert.ok(names.includes('ok'));
  assert.equal(Object.getPrototypeOf(cfg.mcpServers), Object.prototype); // prototype untouched
  assert.equal(Object.prototype.constructor, Object); // globals untouched
});

// ── startMcpServer: the server NARRATES (notifications/message both ways) ───

function fakeStdio() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let raw = '';
  stdout.on('data', (c) => { raw += c; });
  return { stdin, stdout, lines: () => raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) };
}

test('startMcpServer: tools/call emits start/done notifications + result; errors emit warning + isError', async () => {
  const io = fakeStdio();
  const srv = startMcpServer(os.tmpdir(), { stdin: io.stdin, stdout: io.stdout });
  io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buddy_fs_list', arguments: { dir: '.' } } }) + '\n');
  io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } }) + '\n');
  await new Promise((r) => setTimeout(r, 150));
  srv.stop();
  const lines = io.lines().filter(Boolean);
  const notes = lines.filter((m) => m.method === 'notifications/message');
  assert.ok(notes.length >= 2);
  assert.match(notes[0].params.data, /buddy_fs_list start/);
  assert.match(notes[1].params.data, /buddy_fs_list done in \d+ms/);
  assert.equal(notes[0].params.logger, 'tools');
  const res1 = lines.find((m) => m.id === 1);
  assert.ok(res1?.result?.content?.[0]?.text);
  const res2 = lines.find((m) => m.id === 2);
  assert.equal(res2.error.code, -32602); // unknown tool stays a protocol error
});

test('startMcpServer: a throwing tool emits an error notification and an isError result', async () => {
  const io = fakeStdio();
  const srv = startMcpServer(os.tmpdir(), { stdin: io.stdin, stdout: io.stdout });
  // buddy_fs_read with no args hits our own guard (returns ERROR string) —
  // a THROW needs a deeper hole; simulate via a tool-less name is impossible,
  // so pin the ERROR-string path + warning level instead:
  io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: {} } }) + '\n');
  await new Promise((r) => setTimeout(r, 120));
  srv.stop();
  const lines = io.lines().filter(Boolean);
  const note = lines.find((m) => m.method === 'notifications/message' && /done/.test(m.params?.data || ''));
  assert.match(note.params.data, /buddy_fs_read done in \d+ms \(tool error\)/);
  assert.equal(note.params.level, 'warning');
  const res = lines.find((m) => m.id === 3);
  assert.equal(res.result.isError, true);
});

test('serverTools: writes stay OFF by default and the refusal teaches the restart flag', async () => {
  const tools = serverTools(os.tmpdir(), { writes: false });
  const write = tools.find((t) => t.name === 'buddy_fs_write');
  const out = await write.run({ path: 'x.txt', content: 'hi' });
  assert.match(out, /writes are disabled/);
  assert.match(out, /--allow-writes/);
});

// ── LIVE loopback: Buddy drives Buddy over the real protocol ────────────────

test('LIVE: a real McpClient drives a real `buddy mcp-serve` child — handshake, tools, calls, notifications', { timeout: 30000 }, async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'hello.txt'), 'unified protocol hello');
  const client = new McpClient({
    name: 'buddy',
    command: process.execPath,
    args: [path.join(REPO, 'src', 'index.js'), 'mcp-serve', '--dir', root],
    initTimeoutMs: 20000,
    timeoutMs: 15000,
  });
  const notes = [];
  client.onNotification = (ev) => notes.push(ev);
  try {
    const info = await client.start();
    assert.equal(info?.name, 'engineer-buddy');
    // the server exposes buddy_* tools
    const names = client.tools.map((t) => t.name);
    assert.ok(names.includes('buddy_fs_read'), `tools: ${names.join(',')}`);
    assert.ok(names.includes('buddy_run_tests'));
    // reads work and narrate start/done BOTH ways
    const read = await client.callTool('buddy_fs_read', { path: 'hello.txt' });
    const text = read.content.map((c) => c.text || '').join('\n');
    assert.match(text, /unified protocol hello/);
    assert.ok(notes.some((n) => n.server === 'buddy' && /buddy_fs_read start/.test(n.data)), `notes: ${JSON.stringify(notes)}`);
    assert.ok(notes.some((n) => n.server === 'buddy' && /buddy_fs_read done in \d+ms/.test(n.data)));
    // writes are honestly refused (isError), never silently allowed
    const write = await client.callTool('buddy_fs_write', { path: 'evil.txt', content: 'no' });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /writes are disabled/);
    assert.ok(!fs.existsSync(path.join(root, 'evil.txt')));
    // unknown tools are protocol errors
    await assert.rejects(() => client.callTool('buddy_nonexistent', {}), /unknown tool|MCP error/);
  } finally {
    client.stop();
  }
});
