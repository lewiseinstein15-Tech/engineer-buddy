#!/usr/bin/env node
// examples/echo-mcp-http.js — a REMOTE MCP server for trying Buddy's HTTP
// transport (v0.48.0), the sibling of examples/echo-mcp.js (stdio).
//
// Pure Node, zero dependencies, zero installs. Run it in 60 seconds:
//
//   1. export MCP_HTTP_TOKEN='dev-token-123'
//   2. node examples/echo-mcp-http.js --port 8931
//   3. Create .buddy/mcp.json in your workspace:
//        {
//          "mcpServers": {
//            "remote-demo": {
//              "url": "http://127.0.0.1:8931/mcp",
//              "auth": { "type": "bearer", "tokenEnv": "MCP_HTTP_TOKEN" }
//            }
//          }
//        }
//   4. Start buddy — /mcp shows the host + "bearer via env MCP_HTTP_TOKEN"
//      (the token VALUE is never rendered anywhere).
//   5. Type: use the mcp__remote-demo__echo tool to say "hello"
//
// Protocol: Streamable-HTTP-style MCP — one JSON-RPC 2.0 POST per message at
// /mcp; responses are application/json (or SSE with --sse). A session id is
// issued on initialize and required afterwards, like the spec's servers do.
//
// Flags:
//   --port N     listen port (default 8931; use 0 for an ephemeral port)
//   --sse        respond as text/event-stream instead of application/json
//   --evil-echo  RED-TEAM MODE: 401 bodies echo the caller's Authorization
//                header back, and 500 bodies contain junk. A client that
//                ever surfaces a credential would fail against this server.
//                Buddy's client must pass: credentials are never quoted.
//
// Honesty: without MCP_HTTP_TOKEN set the server REFUSES to start — a demo
// of auth must have a token, and a default token would be a lie.
import http from 'node:http';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = (() => {
  const i = args.indexOf('--port');
  return i >= 0 ? Number(args[i + 1]) : 8931;
})();
const TOKEN = process.env.MCP_HTTP_TOKEN;
if (!TOKEN) {
  console.error('refusing to start: MCP_HTTP_TOKEN is not set — an auth demo without a token would be a lie');
  process.exit(1);
}
const EVIL = flag('--evil-echo');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back (proves the round trip).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'now',
    description: 'Current server time in Africa/Nairobi (EAT).',
    inputSchema: { type: 'object', properties: {} },
  },
];

function jsonResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function jsonError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const sessions = new Set();

const SSE = flag('--sse');

/** One respond point: JSON body, or the same JSON wrapped as an SSE event. */
function respond(res, status, obj, extraHeaders = {}) {
  if (SSE) {
    res.writeHead(status, { 'Content-Type': 'text/event-stream', ...extraHeaders });
    res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(obj));
  }
}

function handleInitialize(req, res, msg) {
  const sid = crypto.randomBytes(12).toString('hex');
  sessions.add(sid);
  respond(res, 200, {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo-mcp-http', version: '0.48.0' },
    },
  }, { 'Mcp-Session-Id': sid });
}

function handleToolsCall(msg) {
  const name = String(msg.params?.name || '');
  if (name === 'echo') {
    const text = String(msg.params?.arguments?.text ?? '');
    return jsonResult(msg.id, { content: [{ type: 'text', text: `echo: ${text}` }] });
  }
  if (name === 'now') {
    return jsonResult(msg.id, { content: [{ type: 'text', text: `now: ${new Date().toISOString()} (Africa/Nairobi)` }] });
  }
  return jsonError(msg.id, -32602, `unknown tool: ${name}`);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'post json-rpc to /mcp' }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let msg = null;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* junk */ }
    if (!msg || typeof msg !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not json' }));
      return;
    }
    const auth = req.headers.authorization || '';
    const isNotification = msg.id === undefined || msg.id === null;
    const method = String(msg.method || '');

    // The auth gate: every message must carry the token — even initialize.
    // That is the point of an auth demo.
    if (auth !== `Bearer ${TOKEN}`) {
      const body = EVIL
        ? JSON.stringify({ error: 'unauthorized', echoOfYourAuthHeader: auth, hint: 'a hostile server echoes your credential — a leaking client would print this' })
        : JSON.stringify({ error: 'unauthorized' });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (method === 'initialize') {
      handleInitialize(req, res, msg);
      return;
    }
    // Every non-initialize message must carry the session id we issued.
    const sid = String(req.headers['mcp-session-id'] || '');
    if (!sid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing mcp-session-id header' }));
      return;
    }
    if (!sessions.has(sid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown session' }));
      return;
    }
    if (isNotification) {
      // notifications expect no response body; 202 is the spec shape.
      res.writeHead(202).end();
      return;
    }
    if (method === 'ping') {
      respond(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      respond(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map(({ run, ...rest }) => rest) } });
      return;
    }
    if (method === 'tools/call') {
      const out = handleToolsCall(msg);
      respond(res, 200, JSON.parse(out));
      return;
    }
    respond(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${method}` } });
  });
});

server.listen(portArg, '127.0.0.1', () => {
  const { port } = server.address();
  console.error(`echo-mcp-http listening on http://127.0.0.1:${port}/mcp${SSE ? ' (sse mode)' : ''}${EVIL ? ' (EVIL-ECHO red-team mode)' : ''}`);
  if (EVIL) console.error('RED-TEAM MODE: 401 bodies echo the caller credential — a leaking client will fail the drill');
});
