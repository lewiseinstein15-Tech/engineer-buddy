#!/usr/bin/env node
// examples/echo-mcp.js — a tiny MCP server for trying Buddy's MCP client.
//
// Pure Node, zero dependencies, zero installs. Run it in 60 seconds:
//
//   1. Create .buddy/mcp.json in your workspace:
//        {
//          "mcpServers": {
//            "demo": { "command": "node", "args": ["examples/echo-mcp.js"] }
//          }
//        }
//   2. Start buddy — the banner shows:  mcp: demo connected (3 tools)
//   3. Type:  use the mcp__demo__echo tool to say "hello"
//      (first use hits the approval gate — that is the per-tool consent)
//   4. /mcp shows the server + tool tables.
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio transport).
//   initialize → notifications/initialized → tools/list → tools/call …
// Everything the server prints to stdout must be one JSON object per line;
// logs go to stderr (Buddy drains stderr, so it never pollutes the model).
import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'echo-demo', version: '1.0.0' };

// ── the three demo tools ─────────────────────────────────────────────────────
// Every tool returns the MCP result shape: { content: [{ type: 'text', text }] }
// (plus isError: true when something went wrong — Buddy renders that as ERROR).

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the given text back. The "hello world" of MCP tools.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to echo' },
        shout: { type: 'boolean', description: 'return the text in CAPS' },
      },
      required: ['text'],
    },
    run(args) {
      const text = String(args?.text ?? '');
      const out = args?.shout ? text.toUpperCase() : text;
      return { content: [{ type: 'text', text: out }] };
    },
  },
  {
    name: 'now',
    description: 'Returns the current date and time, optionally in a named IANA timezone.',
    inputSchema: {
      type: 'object',
      properties: {
        tz: { type: 'string', description: 'IANA timezone, e.g. Africa/Nairobi or UTC (optional, default UTC)' },
      },
    },
    run(args) {
      const tz = typeof args?.tz === 'string' && args.tz ? args.tz : 'UTC';
      try {
        const text = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: tz }).format(new Date());
        return { content: [{ type: 'text', text: `${text} (${tz})` }] };
      } catch {
        return { content: [{ type: 'text', text: `unknown timezone "${tz}"` }], isError: true };
      }
    },
  },
  {
    name: 'word_count',
    description: 'Counts characters, words and lines of the given text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to analyze' },
      },
      required: ['text'],
    },
    run(args) {
      const text = String(args?.text ?? '');
      const words = text.split(/\s+/).filter(Boolean).length;
      const lines = text ? text.split(/\r?\n/).length : 0;
      return { content: [{ type: 'text', text: `characters: ${text.length} · words: ${words} · lines: ${lines}` }] };
    },
  },
];

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────

function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      };
    }
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      };
    }
    if (method === 'tools/call') {
      const name = String(params?.name || '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true } };
      }
      return { jsonrpc: '2.0', id, result: tool.run(params?.arguments || {}) };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `server error: ${e?.message || e}` }], isError: true },
    };
  }
}

// ── stdio main loop ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // tolerate junk lines like a well-behaved server
  }
  if (msg?.id === undefined || msg?.id === null) return; // notification — never reply
  process.stdout.write(`${JSON.stringify(handleRequest(msg))}\n`);
});
rl.on('close', () => process.exit(0));
