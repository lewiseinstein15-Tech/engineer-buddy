// v0.48.0 — MCP AUTH HARDENING. Remote transports (Streamable HTTP) whose
// credentials cannot leak, and per-server rate limits with an honest
// in-band exhaustion observation. Every scored path here is offline: real
// loopback sockets on 127.0.0.1, or the injected postImpl seam for
// protocol-level behavior. Pins that carry the house rules:
//   - a credential VALUE never appears in any error, row, or event —
//     including against a hostile server that echoes it back;
//   - a missing env var is an honest connect failure — the literal
//     placeholder is never sent on the wire;
//   - config cannot disable certificate validation, embed secrets, or put
//     credentials in URLs — those doors do not exist;
//   - rate-limit exhaustion is an honest ERROR observation, never a sleep,
//     never a throw, and one server's exhausted budget never blocks another;
//   - a hostile session id cannot become a header-injection vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RateLimiter, expandEnvVars, buildTlsOptions, validateRemoteSpec, maskAuth,
  HttpMcpClient, REMOTE_DEFAULT_RATE,
} from '../src/mcphttp.js';
import { McpClient, loadMcpConfig, connectMcpServers, buildMcpTools, describeMcpServers } from '../src/tools/mcp.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FAKE = 'sk-fake-48-LEAKME-9f2'; // the planted fake credential for every leak probe
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v048-'));

/** A real loopback HTTP server with a request recorder. */
function srv(responder) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rec = { url: req.url, headers: req.headers, bodyText: Buffer.concat(chunks).toString('utf8') };
        requests.push(rec);
        let msg = null;
        try { msg = JSON.parse(rec.bodyText); } catch { /* junk stays junk */ }
        Promise.resolve(responder({ req, res, msg, rec })).catch(() => {
          try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"responder crash"}'); } catch { /* closing */ }
        });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/mcp` }));
  });
}
const closeSrv = (s) => new Promise((r) => s.server.close(r));
const isToolsCall = (rec) => rec.bodyText.includes('"tools/call"');

/** A standard MCP-over-HTTP responder factory. */
function mcpResponder({ token = null, sse = false, evil401 = false, sessionless = false, tools = null } = {}) {
  const sessions = new Set();
  const TOOLSET = tools || [{ name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
  return ({ req, res, msg }) => {
    if (!msg) { res.writeHead(400).end(); return; }
    const send = (obj, extra = {}) => {
      if (sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...extra });
        res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(obj));
      }
    };
    if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(evil401 ? { error: 'unauthorized', echoOfYourAuthHeader: req.headers.authorization, hint: FAKE } : { error: 'unauthorized' }));
      return;
    }
    if (msg.method === 'initialize') {
      const sid = crypto.randomBytes(8).toString('hex');
      sessions.add(sid);
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } } }, sessionless ? {} : { 'Mcp-Session-Id': sid });
      return;
    }
    if (msg.id === undefined || msg.id === null) { res.writeHead(202).end(); return; }
    if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLSET } }); return; }
    if (msg.method === 'tools/call') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }] } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  };
}

/** Injected _rawPost for protocol-level tests: no sockets, full control. */
function fakePost(responses) {
  const calls = [];
  const impl = async (target, body, headers) => {
    const i = calls.length;
    let parsedBody;
    try { parsedBody = JSON.parse(body); } catch { parsedBody = body; } // form-encoded oauth bodies are not JSON
    calls.push({ target, body: parsedBody, headers });
    const r = typeof responses[i] === 'function' ? responses[i]({ ...calls[i], n: i }) : responses[i];
    if (r === 'hang') return new Promise(() => {});
    return {
      status: r?.status ?? 200,
      headers: r?.headers ?? { 'content-type': 'application/json' },
      text: r?.text ?? JSON.stringify(r?.json ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}
const initOk = (extraHeaders = {}) => ({ json: { jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 't', version: '1' } } }, headers: { 'content-type': 'application/json', ...extraHeaders } });
const notif202 = () => ({ status: 202, headers: {}, text: '' });

// ─── A. RateLimiter ──────────────────────────────────────────────────────────
test('RateLimiter: burst to max, honest block with retry hint, window slides back open', () => {
  let t = 1000;
  const rl = new RateLimiter({ max: 3, perMinutes: 1, now: () => t });
  assert.deepEqual([rl.tryTake().ok, rl.tryTake().ok, rl.tryTake().ok], [true, true, true]);
  const blocked = rl.tryTake();
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60000);
  t += 60001; // window fully slid
  assert.equal(rl.tryTake().ok, true);
});

test('RateLimiter: a parallel burst cannot exceed the budget (race pin)', () => {
  const rl = new RateLimiter({ max: 1, perMinutes: 1, now: () => 0 });
  const results = Array.from({ length: 10 }, () => rl.tryTake());
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 9);
});

test('RateLimiter: junk budgets are refused honestly, hits list cannot grow unbounded', () => {
  assert.throws(() => new RateLimiter({ max: 0 }), /positive number/);
  assert.throws(() => new RateLimiter({ max: 5, perMinutes: -1 }), /positive number/);
  assert.throws(() => new RateLimiter({ max: 1e9 }), /capped at 100000/);
  const rl = new RateLimiter({ max: 2, perMinutes: 1440, now: () => 0 });
  rl.tryTake(); rl.tryTake();
  assert.equal(rl.hits.length, 2);
});

// ─── B. expandEnvVars ───────────────────────────────────────────────────────
test('expandEnvVars: substitutes from env; missing names error lists NAMES only', () => {
  assert.equal(expandEnvVars('Bearer ${T_OK}', { T_OK: 'x' }), 'Bearer x');
  assert.throws(() => expandEnvVars('Bearer ${T_A} ${T_B} ${T_A}', {}), (e) => /T_A, T_B/.test(e.message) && /missing environment variable/.test(e.message));
});

test('expandEnvVars: no ${} means no env dependency; empty env value counts as missing', () => {
  assert.equal(expandEnvVars('plain-value', {}), 'plain-value');
  assert.throws(() => expandEnvVars('${EMPTY}', { EMPTY: '' }), /EMPTY/);
});

// ─── C. buildTlsOptions ─────────────────────────────────────────────────────
test('buildTlsOptions: resolves PEM file paths to contents; missing file errors honestly', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ca.pem'), '-----BEGIN CERT-----\nCA\n-----END CERT-----');
  const opts = buildTlsOptions({ ca: path.join(dir, 'ca.pem') }, (p) => fs.readFileSync(p, 'utf8'));
  assert.match(opts.ca, /BEGIN CERT/);
  assert.throws(() => buildTlsOptions({ cert: path.join(dir, 'nope.pem') }, (p) => fs.readFileSync(p, 'utf8')), /cannot read/);
});

test('buildTlsOptions: null/empty is null — plain HTTPS needs no options', () => {
  assert.equal(buildTlsOptions(null), null);
  assert.equal(buildTlsOptions({}), null);
});

// ─── D. validateRemoteSpec ──────────────────────────────────────────────────
test('validateRemoteSpec: the refusal matrix — doors that do not exist', () => {
  const good = { url: 'https://mcp.example.com/mcp' };
  assert.equal(validateRemoteSpec(good).url, good.url);
  assert.throws(() => validateRemoteSpec({ url: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => validateRemoteSpec({ url: 'https://user:pass@host/mcp' }), /must not embed credentials/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', tls: { insecure: true } }), /tls\.insecure is not supported/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'bearer', token: FAKE } }), /auth\.token in config is refused/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'https://t', clientId: 'c', clientSecret: FAKE } }), /clientSecret in config is refused/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'admin' } }), /unknown auth\.type/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'bearer' } }), /tokenEnv/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'https://t', clientId: 'c' } }), /clientSecretEnv/);
  assert.throws(() => validateRemoteSpec({}), /needs a "url"/);
  assert.throws(() => validateRemoteSpec({ url: 'not a url' }), /not a valid URL/);
});

test('validateRemoteSpec: oauth2 tokenUrl must be https; http is loopback-only (dev)', () => {
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'http://evil.example.com/token', clientId: 'c', clientSecretEnv: 'S' } }), /https/);
  const ok = validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'http://127.0.0.1:9/token', clientId: 'c', clientSecretEnv: 'S' } });
  assert.equal(ok.auth.tokenHost, '127.0.0.1:9');
});

test('validateRemoteSpec: keeps NAMES, never values; header shape checked early', () => {
  const s = validateRemoteSpec({ url: 'https://h', headers: { 'X-Api-Key': 'plain-for-now' }, auth: { type: 'bearer', tokenEnv: 'TOK' }, tls: { ca: '/ca.pem' }, rateLimit: { max: 5, perMinutes: 2 } });
  assert.equal(s.auth.tokenEnv, 'TOK');
  assert.equal(s.rateLimit.max, 5);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', headers: { 'X-Bad': 42 } }), /must be a string/);
});

// ─── E. maskAuth ────────────────────────────────────────────────────────────
test('maskAuth: NAMES only — a resolved or literal secret can never appear', () => {
  assert.equal(maskAuth({ auth: { type: 'bearer', tokenEnv: 'TOK' } }), 'bearer via env TOK');
  assert.match(maskAuth({ auth: { type: 'oauth2', clientSecretEnv: 'SEC', tokenHost: 'h' } }), /oauth2 client-credentials/);
  assert.equal(maskAuth({ headers: { 'X-Api-Key': FAKE } }), '1 custom header');
  assert.ok(!maskAuth({ headers: { 'X-Api-Key': FAKE } }).includes(FAKE));
  assert.equal(maskAuth({ tls: { cert: '/c.pem' } }), 'mTLS');
  assert.equal(maskAuth({}), 'no auth');
});

// ─── F. real-socket end-to-end (JSON mode) ──────────────────────────────────
test('HttpMcpClient: handshake, tools/list, tools/call over Streamable HTTP; session id echoed', async () => {
  const s = await srv(mcpResponder({ token: FAKE }));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 4000 });
    await c.start();
    assert.equal(c.info.name, 'test-server');
    assert.equal(c.tools.length, 1);
    const out = await c.callTool('echo', { text: 'hello' });
    assert.equal(out.content[0].text, 'echo:hello');
    const calls = s.requests.filter(isToolsCall);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].headers['mcp-session-id'], 'session id must be echoed after initialize');
    c.stop();
  } finally { await closeSrv(s); }
});

test('HttpMcpClient: SSE responses parse end-to-end (event: message + data frame)', async () => {
  const s = await srv(mcpResponder({ token: FAKE, sse: true }));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 4000 });
    await c.start();
    const out = await c.callTool('echo', { text: 'sse' });
    assert.equal(out.content[0].text, 'echo:sse');
    c.stop();
  } finally { await closeSrv(s); }
});

// ─── G. auth failures stay honest and leak nothing ──────────────────────────
test('wrong token → honest HTTP 401 start failure naming the config, never the value', async () => {
  const s = await srv(mcpResponder({ token: 'right-token' }));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 4000 });
    await assert.rejects(() => c.start(), (e) => /HTTP 401/.test(e.message) && /auth config/.test(e.message) && !e.message.includes(FAKE));
    assert.equal(c.closed, true);
  } finally { await closeSrv(s); }
});

test('hostile server echoes the credential in the 401 body — the client still leaks nothing', async () => {
  const s = await srv(mcpResponder({ token: 'right-token', evil401: true }));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 4000 });
    let msg = '';
    try { await c.start(); } catch (e) { msg = e.message; }
    assert.match(msg, /HTTP 401/);
    assert.ok(!msg.includes(FAKE), `error must not carry the credential, got: ${msg}`);
  } finally { await closeSrv(s); }
});

test('missing bearer env → honest failure BEFORE any request; no placeholder ever sent', async () => {
  const s = await srv(mcpResponder({ token: 'x' }));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'ABSENT_VAR' }, env: {}, initTimeoutMs: 2000 });
    await assert.rejects(() => c.start(), /missing environment variable ABSENT_VAR/);
    assert.equal(s.requests.length, 0, 'no bytes may reach the wire without credentials');
    c.stop();
  } finally { await closeSrv(s); }
});

test('missing env inside a custom header → same honest refusal, literal ${} never sent', async () => {
  const s = await srv(mcpResponder({}));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, headers: { 'X-Api-Key': '${NOPE_VAR}' }, env: {}, initTimeoutMs: 2000 });
    await assert.rejects(() => c.start(), /NOPE_VAR/);
    assert.equal(s.requests.length, 0);
  } finally { await closeSrv(s); }
});

test('CR/LF injection through an env-resolved header value is refused by NAME', async () => {
  const s = await srv(mcpResponder({}));
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, headers: { 'X-Evil': '${INJ}' }, env: { INJ: 'v\r\nX-Pwned: 1' }, initTimeoutMs: 2000 });
    await assert.rejects(() => c.start(), (e) => /control characters/.test(e.message) && e.message.includes('X-Evil'));
    assert.equal(s.requests.length, 0);
  } finally { await closeSrv(s); }
});

// ─── H. protocol-level behavior (injected transport) ────────────────────────
test('429 from a remote is an honest message with the server hint; no auto-sleep', async () => {
  const post = fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' }, text: '{}' }]);
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post });
  await c.start();
  const t0 = Date.now();
  await assert.rejects(() => c.callTool('e', {}), (e) => /HTTP 429/.test(e.message) && /retry after 7s/.test(e.message) && /caller's decision/.test(e.message));
  assert.ok(Date.now() - t0 < 500, 'no sleeping on 429');
});

test('HTTP 500: honest, and the response BODY is never quoted (canary stays out)', async () => {
  const post = fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }, { status: 500, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ boom: FAKE }) }]);
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post });
  await c.start();
  await assert.rejects(() => c.callTool('e', {}), (e) => /HTTP 500/.test(e.message) && !e.message.includes(FAKE));
});

test('non-JSON, non-SSE content type is an honest error', async () => {
  const post = fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }, { status: 200, headers: { 'content-type': 'text/html' }, text: '<html>' }]);
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post });
  await c.start();
  await assert.rejects(() => c.callTool('e', {}), /Content-Type/);
});

test('hostile session id (CR/LF) is sanitized — no header-injection vector survives', async () => {
  const post = fakePost([
    initOk({ 'mcp-session-id': 'abc\r\nX-Evil: yes' }),
    notif202(),
    ({ headers }) => {
      if (/\r|\n/.test(headers['mcp-session-id'] || '')) return { status: 400, text: 'injection landed' };
      return { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } };
    },
    ({ headers }) => ({ json: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: `sid:${headers['mcp-session-id']}` }] } } }),
  ]);
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post });
  await c.start();
  assert.equal(c.sessionId, 'abcX-Evil:yes'); // sanitized: CR/LF (and spaces) gone, single line
  const out = await c.callTool('e', {});
  assert.ok(!out.content[0].text.includes('\r') && !out.content[0].text.includes('\n'));
});

test('SSE flood: hundreds of notifications are capped, the response still resolves', async () => {
  const frames = Array.from({ length: 500 }, (_, i) => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `n${i}` } })}\n\n`).join('');
  const post = fakePost([
    initOk(), notif202(),
    { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } },
    ({ body }) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, text: `${frames}event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n` }),
  ]);
  let seen = 0;
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post, onNotification: () => { seen += 1; } });
  await c.start();
  const out = await c.callTool('e', {});
  assert.equal(out.content[0].text, 'ok');
  assert.ok(seen <= 200, `flood cap must hold, saw ${seen}`);
});

test('SSE byte flood over the cap is refused honestly; missing reply for the id too', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const sse = (frames) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, text: frames });
  const list = { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } };
  const postA = fakePost([initOk(), notif202(), list, ({ body }) => sse(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: big } })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} })}\n\n`)]);
  const a = new HttpMcpClient({ name: 'a', url: 'https://x/mcp', postImpl: postA });
  await a.start();
  await assert.rejects(() => a.callTool('e', {}), /over .* bytes — refused/);
  const postB = fakePost([initOk(), notif202(), list, () => sse(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`)]);
  const b = new HttpMcpClient({ name: 'b', url: 'https://x/mcp', postImpl: postB });
  await b.start();
  await assert.rejects(() => b.callTool('e', {}), /never contained the reply/);
});

test('a hung remote cannot hang the transport: request timeout is socket-enforced', async () => {
  const s = await srv(() => { /* never responds */ });
  try {
    const c = new HttpMcpClient({ name: 'rmt', url: s.url, initTimeoutMs: 300, timeoutMs: 300 });
    await assert.rejects(() => c.start(), (e) => /timed out after 300ms/.test(e.message));
  } finally { await closeSrv(s); }
});

test('request after stop → honest "not running"; MCP-level errors carry the server code', async () => {
  const post = fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }, { json: { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad args' } } }]);
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post });
  await c.start();
  await assert.rejects(() => c.callTool('e', {}), (e) => /MCP error -32602: bad args/.test(e.message));
  c.stop();
  await assert.rejects(() => c.request('tools/call', {}), /not running/);
});

// ─── I. oauth2 client-credentials ───────────────────────────────────────────────
function oauthPost({ token, api }) {
  const calls = [];
  let tokenHits = 0;
  const norm = (r) => ({ status: r?.status ?? 200, headers: r?.headers ?? { 'content-type': 'application/json' }, text: r?.text ?? JSON.stringify(r?.json ?? {}) });
  const impl = async (target, body, headers) => {
    let parsedBody;
    try { parsedBody = JSON.parse(body); } catch { parsedBody = body; } // form-encoded oauth bodies are not JSON
    calls.push({ target, body: parsedBody, headers });
    if (target.endsWith('/token')) {
      tokenHits += 1;
      return norm(token(tokenHits));
    }
    return norm(api({ headers, body: calls[calls.length - 1].body }));
  };
  impl.calls = calls;
  impl.tokenHits = () => tokenHits;
  return impl;
}

const apiRoute = (handlers) => ({ body, headers }) => {
  const auth = headers.authorization ?? headers.Authorization; // real HTTP lowercases; the fake transport does not
  if (body.method === 'initialize') return handlers.initialize?.({ headers }) ?? initOk();
  if (body.id === undefined || body.id === null) return notif202();
  if (body.method === 'tools/list') return handlers.list?.() ?? { json: { jsonrpc: '2.0', id: body.id, result: { tools: [] } } };
  if (body.method === 'tools/call') return handlers.call({ headers: { ...headers, authorization: auth }, body });
  return { json: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } } };
};

test('oauth2: token fetched once at start, cached across calls; secret only from env', async () => {
  const post = oauthPost({
    token: (n) => (n === 1 ? { json: { access_token: FAKE, expires_in: 3600 } } : { status: 500, text: 'token endpoint must be hit once — cache violated' }),
    api: apiRoute({
      call: ({ headers }) => ({ json: { jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: `auth:${headers.authorization === `Bearer ${FAKE}` ? 'ok' : 'bad'}` }] } } }),
    }),
  });
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post, auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'cid', clientSecretEnv: 'SEC' }, env: { SEC: FAKE } });
  await c.start();
  const r1 = await c.callTool('e', {});
  assert.equal(r1.content[0].text, 'auth:ok');
  await c.callTool('e', {});
  assert.equal(post.tokenHits(), 1, 'the token must be cached, not re-fetched per call');
});

test('oauth2: a 401 mid-run triggers exactly ONE refresh + retry with the fresh token', async () => {
  const post = oauthPost({
    token: (n) => (n === 1 ? { json: { access_token: 'tok-v1', expires_in: 3600 } } : n === 2 ? { json: { access_token: 'tok-v2', expires_in: 3600 } } : { status: 500, text: 'refresh loop — bounded retry violated' }),
    api: apiRoute({
      call: ({ headers }) => (headers.authorization === 'Bearer tok-v1'
        ? { status: 401, headers: { 'content-type': 'application/json' }, text: '{"error":"stale"}' }
        : { json: { jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: 'ok-v2' }] } } }),
    }),
  });
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post, auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'cid', clientSecretEnv: 'SEC' }, env: { SEC: 's' } });
  await c.start();
  const out = await c.callTool('e', {});
  assert.equal(out.content[0].text, 'ok-v2');
  assert.equal(post.tokenHits(), 2, 'initial + exactly one refresh');
  const lastApi = post.calls.filter((x) => !x.target.endsWith('/token')).pop();
  assert.equal(lastApi.headers.authorization ?? lastApi.headers.Authorization, 'Bearer tok-v2');
});

test('oauth2: failing token endpoint is an honest start failure; missing env caught before any request', async () => {
  const post = oauthPost({ token: () => ({ status: 500, text: 'idp down' }), api: () => { throw new Error('api must not be reached'); } });
  const c = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: post, auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'cid', clientSecretEnv: 'SEC' }, env: { SEC: 's' } });
  await assert.rejects(() => c.start(), (e) => /oauth2 token request .* failed \(HTTP 500\)/.test(e.message));
  const c2 = new HttpMcpClient({ name: 'rmt', url: 'https://x/mcp', postImpl: fakePost([initOk()]), auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'cid', clientSecretEnv: 'MISSING_SEC' }, env: {} });
  await assert.rejects(() => c2.start(), /missing environment variable MISSING_SEC/);
  assert.throws(() => validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'http://evil.example.com/token', clientId: 'c', clientSecretEnv: 'S' } }), /https/);
});

// ─── J. config + wiring ─────────────────────────────────────────────────────
test('loadMcpConfig: command + url entries coexist; rateLimit rides along; bare-map fallback too', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.buddy'));
  fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({
    mcpServers: {
      loc: { command: 'node', args: ['x.js'], rateLimit: { max: 10, perMinutes: 2 } },
      rem: { url: 'https://mcp.example.com/mcp', auth: { type: 'bearer', tokenEnv: 'T' }, rateLimit: { max: 5 } },
    },
  }));
  const cfg = loadMcpConfig(dir);
  assert.equal(cfg.mcpServers.loc.command, 'node');
  assert.deepEqual(cfg.mcpServers.loc.rateLimit, { max: 10, perMinutes: 2 });
  assert.equal(cfg.mcpServers.rem.url, 'https://mcp.example.com/mcp');
  assert.equal(cfg.mcpServers.rem.auth.tokenEnv, 'T');
  fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({ bare: { url: 'https://b.example.com/mcp' } }));
  const bare = loadMcpConfig(dir);
  assert.equal(bare.mcpServers.bare.url, 'https://b.example.com/mcp');
});

test('connectMcpServers: mixed trio — good stdio + good remote + junk remote — is 2 up, 1 honest failure', async () => {
  const s = await srv(mcpResponder({}));
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.buddy'));
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({
      mcpServers: {
        loc: { command: process.execPath, args: [path.join(REPO, 'examples', 'echo-mcp.js')] },
        rmt: { url: s.url },
        junk: { url: 'not a url at all' },
      },
    }));
    const { connected, failed } = await connectMcpServers(dir, { initTimeoutMs: 6000, home: dir });
    const names = connected.map((c) => c.name).sort();
    assert.deepEqual(names, ['loc', 'rmt']);
    const j = failed.find((f) => f.name === 'junk');
    assert.ok(j && /not a valid URL/.test(j.error), `junk url must fail honestly, got: ${JSON.stringify(failed)}`);
    for (const c of connected) c.client.stop?.();
  } finally { await closeSrv(s); }
});

test('connectMcpServers: remote servers get the default budget; stdio stays unlimited; explicit config wins', async () => {
  const s = await srv(mcpResponder({}));
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.buddy'));
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({
      mcpServers: {
        loc: { command: process.execPath, args: [path.join(REPO, 'examples', 'echo-mcp.js')] },
        rmt: { url: s.url },
        rmt2: { url: s.url.replace('/mcp', '/mcp2'), rateLimit: { max: 5, perMinutes: 3 } },
      },
    }));
    const { connected } = await connectMcpServers(dir, { initTimeoutMs: 6000, home: dir });
    const byName = Object.fromEntries(connected.map((c) => [c.name, c]));
    assert.equal(byName.loc.client.rateLimiter, null);
    assert.equal(byName.rmt.client.rateLimiter.max, REMOTE_DEFAULT_RATE.max);
    assert.equal(byName.rmt2.client.rateLimiter.max, 5);
    assert.equal(byName.rmt2.client.rateLimiter.perMinutes, 3);
    for (const c of connected) c.client.stop?.();
  } finally { await closeSrv(s); }
});

test('per-server budget: the 3rd bridged call is an honest in-band refusal; the server saw exactly 2', async () => {
  const s = await srv(mcpResponder({}));
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.buddy'));
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({
      mcpServers: { rmt: { url: s.url, rateLimit: { max: 2, perMinutes: 1 } } },
    }));
    const { connected } = await connectMcpServers(dir, { initTimeoutMs: 5000, home: dir });
    const conn = connected.find((c) => c.name === 'rmt');
    const tools = buildMcpTools(connected);
    const echo = tools.find((t) => t.name === 'mcp__rmt__echo');
    assert.ok(echo, 'remote tool must be bridged');
    assert.match(await echo.run({ text: 'a' }), /echo:a/);
    assert.match(await echo.run({ text: 'b' }), /echo:b/);
    const third = await echo.run({ text: 'c' });
    assert.match(third, /^ERROR \(mcp:rmt\): rate limited — the per-server budget \(2 calls \/ 1 min\)/);
    assert.match(third, /No call was made\./);
    assert.equal(s.requests.filter(isToolsCall).length, 2, 'the refused call must never reach the wire');
    conn.client.stop?.();
  } finally { await closeSrv(s); }
});

test('the budget is per SERVER: two tools share it; other servers are unaffected', async () => {
  const s = await srv(mcpResponder({}, ));
  const tools2 = [
    { name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'now', description: 'd', inputSchema: { type: 'object', properties: {} } },
  ];
  const s2 = await srv(mcpResponder({ tools: tools2 }));
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.buddy'));
    fs.writeFileSync(path.join(dir, '.buddy', 'mcp.json'), JSON.stringify({
      mcpServers: { a: { url: s.url, rateLimit: { max: 2, perMinutes: 1 } }, b: { url: s2.url, rateLimit: { max: 2, perMinutes: 1 } } },
    }));
    const { connected } = await connectMcpServers(dir, { initTimeoutMs: 5000, home: dir });
    const tools = buildMcpTools(connected);
    const run = (n, args) => tools.find((t) => t.name === n).run(args);
    assert.match(await run('mcp__a__echo', { text: '1' }), /echo:1/);
    assert.match(await run('mcp__b__now', {}), /echo:/); // server b's default echo shape
    assert.match(await run('mcp__a__echo', { text: '2' }), /echo:2/);
    assert.match(await run('mcp__a__echo', { text: '3' }), /rate limited/);
    assert.match(await run('mcp__b__now', {}), /echo:/, "a's exhausted budget must not block b");
  } finally { await closeSrv(s); await closeSrv(s2); }
});

test('/mcp rows: remote servers render host + masked auth; the credential value appears nowhere', async () => {
  const s = await srv(mcpResponder({}));
  try {
    const c2 = new HttpMcpClient({ name: 'rmt', url: s.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 4000 });
    await c2.start();
    const rows = describeMcpServers([{ name: 'rmt', client: c2, tools: c2.tools }], []);
    const flat = JSON.stringify(rows);
    assert.match(flat, /bearer via env TOK/);
    assert.ok(!flat.includes(FAKE), `/mcp must never render the token, got: ${flat}`);
    c2.stop();
  } finally { await closeSrv(s); }
});

test('stdio McpClient: rateLimit param plumbs a limiter; default stays null (unchanged behavior)', () => {
  const withRl = new McpClient({ name: 'x', command: 'node', rateLimit: { max: 3, perMinutes: 1 } });
  assert.equal(withRl.rateLimiter.max, 3);
  const without = new McpClient({ name: 'x', command: 'node' });
  assert.equal(without.rateLimiter, null);
});

// ─── K. the leak probe finale ───────────────────────────────────────────────
test('LEAK PROBE: every failure path, every row — the planted fake token appears nowhere', async () => {
  const dir = tmp();
  const collected = [];
  // 1. wrong token against an evil-echo server (real socket)
  const evil = await srv(mcpResponder({ token: 'right', evil401: true }));
  try {
    const c = new HttpMcpClient({ name: 'a', url: evil.url, auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE }, initTimeoutMs: 3000 });
    try { await c.start(); } catch (e) { collected.push(e.message); }
    // 2. 500 whose body contains the token
    const post = fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }, { status: 500, headers: { 'content-type': 'application/json' }, text: FAKE.repeat(50) }]);
    const c2 = new HttpMcpClient({ name: 'b', url: 'https://x/mcp', postImpl: post });
    await c2.start();
    try { await c2.callTool('e', {}); } catch (e) { collected.push(e.message); }
    // 3. oauth refresh failure
    const postO = fakePost([({ target }) => (target.endsWith('/token') ? { status: 403, text: FAKE } : initOk())]);
    const c3 = new HttpMcpClient({ name: 'c', url: 'https://x/mcp', postImpl: postO, auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'c', clientSecretEnv: 'S' }, env: { S: FAKE } });
    try { await c3.start(); } catch (e) { collected.push(e.message); }
    // 4. validation refusals
    for (const bad of [
      () => validateRemoteSpec({ url: `https://${FAKE}@h/mcp` }),
      () => validateRemoteSpec({ url: 'https://h', auth: { type: 'bearer', token: FAKE } }),
      () => validateRemoteSpec({ url: 'https://h', auth: { type: 'oauth2', tokenUrl: 'https://t', clientId: 'c', clientSecret: FAKE } }),
    ]) {
      try { bad(); } catch (e) { collected.push(e.message); }
    }
    // 5. rows rendered from a connected client (the failed row's error is a
    // benign string — hostile caller-provided strings are a different threat
    // model than our own code paths, which is what this probe pins)
    const c4 = new HttpMcpClient({ name: 'd', url: 'https://x/mcp', postImpl: fakePost([initOk(), notif202(), { json: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }]), auth: { type: 'bearer', tokenEnv: 'TOK' }, env: { TOK: FAKE } });
    await c4.start();
    collected.push(JSON.stringify(describeMcpServers([{ name: 'd', client: c4, tools: c4.tools }], [{ name: 'f', error: 'connect refused' }])));
    const joined = collected.join('\n');
    assert.ok(joined.length > 100, 'the probe must have collected real output');
    assert.ok(!joined.includes(FAKE), `the planted token leaked:\n${joined.slice(0, 800)}`);
    c2.stop(); c4.stop();
  } finally { await closeSrv(evil); }
});
