// mini-mcp.js — a tiny MCP server fixture for offline tests.
//
// Speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0 on
// stdin/stdout. Exposes two tools:
//   echo({text})        -> "echo: <text>"
//   add({a, b})         -> "sum: <a + b>"
//
// Flags:
//   --sleep MS   delay every response (tests request timeouts)
//   --crash      exit right after answering initialize (tests dead servers;
//                uses synchronous writes so the response always lands)
//   --banner     print a non-JSON banner line first (tests stdout noise)
import fs from 'node:fs';
const banner = process.argv.includes('--banner');
const sleepIdx = process.argv.indexOf('--sleep');
const sleepMs = sleepIdx >= 0 ? Number(process.argv[sleepIdx + 1]) || 0 : 0;

if (banner) fs.writeSync(1, '*** mini-mcp starting (banner noise) ***\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});

function send(obj) {
  const out = `${JSON.stringify(obj)}\n`;
  if (sleepMs > 0) setTimeout(() => fs.writeSync(1, out), sleepMs);
  else fs.writeSync(1, out);
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON
  }
  if (msg.id === undefined || msg.id === null) return; // notification

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mini-mcp', version: '1.0.0' },
      },
    });
    if (process.argv.includes('--crash')) process.exit(1); // sync write already flushed
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo the given text back.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'add',
            description: 'Add two numbers.',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
    } else if (name === 'add') {
      const sum = Number(args.a || 0) + Number(args.b || 0);
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `sum: ${sum}` }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
    }
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}
