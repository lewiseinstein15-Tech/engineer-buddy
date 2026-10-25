// End-to-end test for the SHIPPED example server (examples/echo-mcp.js).
// The unit suite uses fixtures/mini-mcp.js; this one proves the exact file
// users are told to run also speaks Buddy's client dialect (v0.8.3).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, buildMcpTools } from '../src/tools/mcp.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'echo-mcp.js');

describe('example MCP server (examples/echo-mcp.js)', () => {
  test('full round-trip: initialize → tools/list → tools/call → bridged naming', async () => {
    const client = new McpClient({
      name: 'demo',
      command: process.execPath,
      args: [EXAMPLE],
      initTimeoutMs: 10000,
      timeoutMs: 10000,
    });
    try {
      const info = await client.start();
      assert.equal(info?.name, 'echo-demo');
      const names = client.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['echo', 'now', 'word_count']);

      // echo: args round-trip + the shout flag
      const echo = await client.callTool('echo', { text: 'hi buddy', shout: true });
      assert.equal(echo.isError, undefined);
      assert.equal(echo.content[0].text, 'HI BUDDY');

      // word_count: multiline text
      const wc = await client.callTool('word_count', { text: 'one two three\nfour' });
      assert.match(wc.content[0].text, /words: 4/);
      assert.match(wc.content[0].text, /lines: 2/);

      // now: optional args + a real IANA timezone
      const now = await client.callTool('now', { tz: 'Africa/Nairobi' });
      assert.match(now.content[0].text, /Africa\/Nairobi/);

      // error surface: unknown tool → isError result (never a crash)
      const unk = await client.callTool('nope', {});
      assert.equal(unk.isError, true);

      // bridging: the same names the model sees via /tools
      const bridged = buildMcpTools([{ name: 'demo', client, tools: client.tools }]);
      const bridgedNames = bridged.map((t) => t.name).sort();
      assert.deepEqual(bridgedNames, ['mcp__demo__echo', 'mcp__demo__now', 'mcp__demo__word_count']);
      assert.equal(bridged[0].risky, true, 'bridged MCP tools are approval-gated');
    } finally {
      client.stop();
    }
  });
});
