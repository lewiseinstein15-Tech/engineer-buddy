import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, loadMcpConfig, connectMcpServers, buildMcpTools, describeMcpServers, MCP_CONFIG_PATH } from '../src/tools/mcp.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mini-mcp.js');
const nodeBin = process.execPath;

function tmpRoot(configJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mcp-'));
  if (configJson !== undefined) {
    fs.mkdirSync(path.join(dir, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(dir, MCP_CONFIG_PATH), configJson, 'utf8');
  }
  return dir;
}

// ── loadMcpConfig ────────────────────────────────────────────────────────────

test('loadMcpConfig: missing file → null (the normal case)', () => {
  assert.equal(loadMcpConfig(tmpRoot()), null);
});

test('loadMcpConfig: standard mcpServers shape', () => {
  const dir = tmpRoot(JSON.stringify({ mcpServers: { 'My Server': { command: 'npx', args: ['-y', 'srv'], env: { K: 'V' } } } }));
  const cfg = loadMcpConfig(dir);
  assert.equal(cfg.mcpServers['my-server'].command, 'npx');
  assert.deepEqual(cfg.mcpServers['my-server'].args, ['-y', 'srv']);
  assert.deepEqual(cfg.mcpServers['my-server'].env, { K: 'V' });
});

test('loadMcpConfig: bare map fallback + entries without command skipped', () => {
  const dir = tmpRoot(JSON.stringify({ one: { command: 'x' }, empty: { args: [] } }));
  const cfg = loadMcpConfig(dir);
  assert.equal(cfg.mcpServers.one.command, 'x');
  assert.equal(cfg.mcpServers.empty, undefined);
});

test('loadMcpConfig: invalid JSON throws with the file name', () => {
  assert.throws(() => loadMcpConfig(tmpRoot('{ nope')), /mcp\.json is not valid JSON/);
});

// ── McpClient end-to-end against the fixture ────────────────────────────────

test('McpClient: handshake, tools/list, tools/call (echo + add)', async () => {
  const client = new McpClient({ name: 'mini', command: nodeBin, args: [FIXTURE], initTimeoutMs: 8000 });
  try {
    const info = await client.start();
    assert.equal(info.name, 'mini-mcp');
    assert.equal(client.tools.length, 2);
    const echo = await client.callTool('echo', { text: 'hi buddy' });
    assert.equal(echo.content[0].text, 'echo: hi buddy');
    const sum = await client.callTool('add', { a: 2, b: 3 });
    assert.equal(sum.content[0].text, 'sum: 5');
  } finally {
    client.stop();
  }
});

test('McpClient: tolerates non-JSON banner noise on stdout', async () => {
  const client = new McpClient({ name: 'noisy', command: nodeBin, args: [FIXTURE, '--banner'], initTimeoutMs: 8000 });
  try {
    await client.start();
    assert.equal(client.info.name, 'mini-mcp');
  } finally {
    client.stop();
  }
});

test('McpClient: request timeout rejects cleanly', async () => {
  // start() applies initTimeoutMs to the initialize request — 150ms vs a
  // fixture that answers after 700ms must reject, not hang.
  const client = new McpClient({ name: 'slow', command: nodeBin, args: [FIXTURE, '--sleep', '700'], initTimeoutMs: 150 });
  try {
    await assert.rejects(() => client.start(), /did not answer initialize|timed out/);
  } finally {
    client.stop();
  }
});

test('McpClient: crashing server surfaces a clear error', async () => {
  const client = new McpClient({ name: 'crasher', command: nodeBin, args: [FIXTURE, '--crash'], initTimeoutMs: 5000 });
  await assert.rejects(() => client.start(), /exited|not running/);
  client.stop();
});

test('McpClient: requests after stop reject without throwing into the caller', async () => {
  const client = new McpClient({ name: 'x', command: nodeBin, args: [FIXTURE], initTimeoutMs: 8000 });
  await client.start();
  client.stop();
  await assert.rejects(() => client.callTool('echo', { text: 'a' }), /not running/);
});

// ── connectMcpServers (the startup path) ─────────────────────────────────────

test('connectMcpServers: good + bad servers never block startup', async () => {
  const cfg = JSON.stringify({
    mcpServers: {
      mini: { command: nodeBin, args: [FIXTURE] },
      broken: { command: 'definitely-not-a-real-binary-xyz' },
    },
  });
  const { connected, failed } = await connectMcpServers(tmpRoot(cfg), { initTimeoutMs: 8000 });
  assert.equal(connected.length, 1);
  assert.equal(connected[0].name, 'mini');
  assert.equal(connected[0].tools.length, 2);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'broken');
  connected[0].client.stop();
});

test('connectMcpServers: invalid config JSON lands in failed, no throw', async () => {
  const { connected, failed } = await connectMcpServers(tmpRoot('{ nope'));
  assert.equal(connected.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /not valid JSON/);
});

// ── buildMcpTools (the registry bridge) ──────────────────────────────────────

test('buildMcpTools: mcp__server__tool naming, risky gate, run works', async () => {
  const client = new McpClient({ name: 'mini', command: nodeBin, args: [FIXTURE], initTimeoutMs: 8000 });
  try {
    await client.start();
    const tools = buildMcpTools([{ name: client.name, client, tools: client.tools }]);
    assert.deepEqual(tools.map((t) => t.name), ['mcp__mini__echo', 'mcp__mini__add']);
    assert.ok(tools.every((t) => t.risky), 'bridged tools must be gated');
    const echo = tools[0];
    assert.match(echo.description, /\[mcp:mini\]/);
    assert.equal(await echo.run({ text: 'registry' }), 'echo: registry');
    assert.equal(await tools[1].run({ a: 10, b: 5 }), 'sum: 15');
    // args hint comes from the JSON schema
    assert.match(echo.args, /"text"/);
  } finally {
    client.stop();
  }
});

test('buildMcpTools: dead server → ERROR observation, never a throw', async () => {
  const fakeConn = {
    name: 'dead',
    tools: [{ name: 'gone', description: 'd', inputSchema: {} }],
    client: { callTool: async () => { throw new Error('server "dead" is not running'); } },
  };
  const [tool] = buildMcpTools([fakeConn]);
  const out = await tool.run({});
  assert.match(out, /^ERROR \(mcp:dead\)/);
});

test('buildMcpTools: isError results surface as ERROR with server tag', async () => {
  const client = new McpClient({ name: 'mini', command: nodeBin, args: [FIXTURE], initTimeoutMs: 8000 });
  try {
    await client.start();
    const [tool] = buildMcpTools([{ name: 'mini', client, tools: [{ name: 'unknown-tool', description: 'd', inputSchema: {} }] }]);
    const out = await tool.run({});
    assert.match(out, /^ERROR \(mcp:mini\)/);
  } finally {
    client.stop();
  }
});

test('describeMcpServers: rows for connected and failed servers', () => {
  const rows = describeMcpServers([{ name: 'mini', tools: [1, 2], client: { info: { name: 'mini-mcp' } } }], [{ name: 'bad', error: 'nope' }]);
  assert.deepEqual(rows.map((r) => [r[0], r[1]]), [['✓', 'mini'], ['✗', 'bad']]);
});
