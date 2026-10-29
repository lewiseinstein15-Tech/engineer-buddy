// v0.48.0 RED TEAM PASS (war-room Play 4) — try to break the MCP auth
// hardening before it ships: credential exfiltration through every error
// path (including a hostile server that echoes the credential back),
// placeholder leakage, config doors that must not exist (tls.insecure,
// literal secrets, URL credentials), header injection through env values,
// hostile session ids, SSE floods, unbounded oauth refresh loops, rate-limit
// races and cross-server bleed. Every attack must be refused HONESTLY and
// must NEVER leak the planted fake token. A leak, a crash, or an unbounded
// loop = ship blocked.
import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  RateLimiter, expandEnvVars, buildTlsOptions, validateRemoteSpec, maskAuth, HttpMcpClient,
} from '../src/mcphttp.js';
import { describeMcpServers } from '../src/tools/mcp.js';

const FAKE = 'sk-redteam-48-LEAKME-7c3f';
const initOk = (extra = {}) => ({ json: { jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 't', version: '1' } } }, headers: { 'content-type': 'application/json', ...extra } });
const notif202 = () => ({ status: 202, headers: {}, text: '' });
const listOk = () => ({ json: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] } } });

function fakePost(responses) {
  const calls = [];
  const impl = async (target, body, headers) => {
    const i = calls.length;
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    calls.push({ target, body: parsed, headers });
    const r = typeof responses[i] === 'function' ? responses[i]({ ...calls[i], n: i }) : responses[i];
    return { status: r?.status ?? 200, headers: r?.headers ?? { 'content-type': 'application/json' }, text: r?.text ?? JSON.stringify(r?.json ?? {}) };
  };
  impl.calls = calls;
  return impl;
}
function loopback(responder) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        let msg = null;
        try { msg = JSON.parse(requests.at(-1).body); } catch { /* junk */ }
        Promise.resolve(responder({ req, res, msg })).catch(() => { try { res.writeHead(500).end(); } catch { /* gone */ } });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp`, requests }));
  });
}
const close = (s) => new Promise((r) => s.server.close(r));

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? ` → ${detail}` : ''}`); }
};
const errs = [];
const attempt = async (name, fn) => {
  try {
    const detail = await fn();
    ok(true, name, typeof detail === 'string' ? detail : '');
  } catch (e) {
    fail++;
    errs.push(e);
    ok(false, name, `${e?.message || e}`.slice(0, 220));
  }
};

console.log(`\nRED TEAM v0.48 — MCP auth hardening (planted credential: present in config, must appear NOWHERE)\n`);

// ── 1. the credential-leak matrix ───────────────────────────────────────────
await attempt('hostile 401 echoes the credential — error stays clean', async () => {
  const s = await loopback(({ res }) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized', yourHeader: FAKE, leak: FAKE.repeat(3) })); });
  try {
    const c = new HttpMcpClient({ name: 'evil', url: s.url, auth: { type: 'bearer', tokenEnv: 'T' }, env: { T: FAKE } });
    let msg = '';
    try { await c.start(); } catch (e) { msg = e.message; }
    ok(msg.includes('HTTP 401') && !msg.includes(FAKE), '401 error clean', '');
    return 'leak-free';
  } finally { await close(s); }
});

await attempt('500 body stuffed with the credential — never quoted', async () => {
  const post = fakePost([initOk(), notif202(), listOk(), { status: 500, headers: { 'content-type': 'application/json' }, text: FAKE.repeat(100) }]);
  const c = new HttpMcpClient({ name: 'evil', url: 'https://x/mcp', postImpl: post });
  await c.start();
  let msg = '';
  try { await c.callTool('echo', {}); } catch (e) { msg = e.message; }
  ok(msg.includes('HTTP 500') && !msg.includes(FAKE), '500 error clean');
});

await attempt('missing env — the literal ${NAME} never reaches the wire', async () => {
  const s = await loopback(({ res }) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  try {
    const c = new HttpMcpClient({ name: 'r', url: s.url, headers: { 'X-K': '${NO_SUCH_VAR_48}' }, auth: { type: 'bearer', tokenEnv: 'ALSO_MISSING_48' }, env: {} });
    let failed = false;
    try { await c.start(); } catch { failed = true; }
    const sent = JSON.stringify(s.requests.map((r) => r.headers));
    ok(failed && s.requests.length === 0 && !sent.includes('${'), 'nothing sent, no placeholder');
  } finally { await close(s); }
});

await attempt('CR/LF injection through an env-resolved header is refused by NAME', async () => {
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', headers: { 'X-E': '${INJ}' }, env: { INJ: 'v\r\nX-Pwned: 1' } });
  let msg = '';
  try { await c.start(); } catch (e) { msg = e.message; }
  ok(/control characters/.test(msg) && msg.includes('X-E') && !msg.includes('Pwned: 1'), 'injection refused');
});

// ── 2. doors that must not exist ────────────────────────────────────────────
await attempt('tls.insecure is refused — cert validation cannot be disabled', async () => {
  let msg = '';
  try { validateRemoteSpec({ url: 'https://x/mcp', tls: { insecure: true } }); } catch (e) { msg = e.message; }
  ok(/tls\.insecure is not supported/.test(msg), 'door welded shut');
});

await attempt('literal secrets in config are refused (bearer token + oauth2 secret)', async () => {
  const r1 = (() => { try { validateRemoteSpec({ url: 'https://x', auth: { type: 'bearer', token: FAKE } }); return ''; } catch (e) { return e.message; } })();
  const r2 = (() => { try { validateRemoteSpec({ url: 'https://x', auth: { type: 'oauth2', tokenUrl: 'https://t', clientId: 'c', clientSecret: FAKE } }); return ''; } catch (e) { return e.message; } })();
  ok(/auth\.token in config is refused/.test(r1) && /clientSecret in config is refused/.test(r2), 'both refused');
});

await attempt('URL-embedded credentials are refused (user:pass@host)', async () => {
  let msg = '';
  try { validateRemoteSpec({ url: `https://admin:${FAKE}@x/mcp` }); } catch (e) { msg = e.message; }
  ok(/must not embed credentials/.test(msg) && !msg.includes(FAKE), 'refused, value not echoed');
});

await attempt('http:// oauth2 tokenUrl is loopback-only', async () => {
  let msg = '';
  try { validateRemoteSpec({ url: 'https://x', auth: { type: 'oauth2', tokenUrl: 'http://token.evil.example.com/t', clientId: 'c', clientSecretEnv: 'S' } }); } catch (e) { msg = e.message; }
  ok(/must be https/.test(msg), 'refused');
});

// ── 3. hostile server behavior ──────────────────────────────────────────────
await attempt('hostile session id (CR/LF) is sanitized before it ever rides a request', async () => {
  const post = fakePost([initOk({ 'mcp-session-id': `a${FAKE.slice(0, 4)}\r\nX-Evil: yes` }), notif202(), listOk(), ({ headers }) => ({ json: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: `sid=${headers['mcp-session-id'] ?? headers['Mcp-Session-Id']}` }] } } })]);
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', postImpl: post });
  await c.start();
  const out = await c.callTool('echo', {});
  const sid = String(post.calls[3].headers['mcp-session-id'] ?? '');
  ok(!/[\r\n]/.test(sid) && !sid.includes('\r') && !sid.includes('\n'), 'session id arrives as ONE single-line header value (hostile bytes stripped, remaining data inert)');
});

await attempt('SSE notification flood is capped, response still resolves', async () => {
  const frames = Array.from({ length: 1000 }, (_, i) => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `n${i}` } })}\n\n`).join('');
  const post = fakePost([initOk(), notif202(), listOk(), ({ body }) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, text: `${frames}event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n` })]);
  let seen = 0;
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', postImpl: post, onNotification: () => { seen += 1; } });
  await c.start();
  const out = await c.callTool('echo', {});
  ok(seen <= 200 && out.content[0].text === 'ok', `saw ${seen}/1000`);
});

await attempt('SSE byte flood over 2MB is refused honestly', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const post = fakePost([initOk(), notif202(), listOk(), ({ body }) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: big } })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} })}\n\n` })]);
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', postImpl: post });
  await c.start();
  let msg = '';
  try { await c.callTool('echo', {}); } catch (e) { msg = e.message; }
  ok(/bytes — refused/.test(msg), 'refused');
});

await attempt('oauth2 refresh is BOUNDED: a server that 401s fresh tokens gets one retry, then honesty', async () => {
  const token = fakePost([]); // not used — we drive via oauthPost-like structure below
  const calls = { token: 0, api: 0 };
  const post = async (target, body, headers) => {
    if (String(target).endsWith('/token')) {
      calls.token += 1;
      if (calls.token > 2) throw new Error('UNBOUNDED REFRESH LOOP');
      return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ access_token: `tok-${calls.token}`, expires_in: 3600 }) };
    }
    calls.api += 1;
    if (headers.authorization ?? headers.Authorization) {
      return { status: 401, headers: { 'content-type': 'application/json' }, text: '{"error":"nope"}' };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }) };
  };
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', postImpl: post, auth: { type: 'oauth2', tokenUrl: 'https://idp/token', clientId: 'c', clientSecretEnv: 'S' }, env: { S: 's' } });
  let msg = '';
  try { await c.start(); } catch (e) { msg = e.message; }
  ok(/rejected the credentials \(HTTP 401\)/.test(msg) && calls.token === 2, `refreshes=${calls.token - 1} (bounded), honest failure`);
});

// ── 4. rate limiter ────────────────────────────────────────────────────────
await attempt('limiter race: a parallel burst cannot exceed the budget', async () => {
  const rl = new RateLimiter({ max: 1, perMinutes: 1, now: () => 0 });
  const results = await Promise.all(Array.from({ length: 50 }, () => rl.tryTake()));
  ok(results.filter((r) => r.ok).length === 1, 'exactly 1 of 50 through');
});

await attempt('limiter isolation: an exhausted server never blocks another', async () => {
  const a = new RateLimiter({ max: 1, perMinutes: 1, now: () => 0 });
  const b = new RateLimiter({ max: 1, perMinutes: 1, now: () => 0 });
  a.tryTake(); const blocked = a.tryTake().ok === false;
  ok(blocked && b.tryTake().ok, 'b unaffected by a');
});

await attempt('429 never auto-sleeps (the caller decides)', async () => {
  const post = fakePost([initOk(), notif202(), listOk(), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' }, text: '{}' }]);
  const c = new HttpMcpClient({ name: 'r', url: 'https://x/mcp', postImpl: post });
  await c.start();
  const t0 = Date.now();
  let msg = '';
  try { await c.callTool('echo', {}); } catch (e) { msg = e.message; }
  ok(/HTTP 429/.test(msg) && Date.now() - t0 < 500, `returned in ${Date.now() - t0}ms`);
});

// ── 5. rendering surfaces ──────────────────────────────────────────────────
await attempt('/mcp rows + maskAuth never render a credential value', async () => {
  const spec = { url: 'https://x/mcp', headers: { 'X-Api-Key': FAKE, Authorization: `Bearer ${FAKE}` }, auth: { type: 'bearer', tokenEnv: 'T' } };
  const rows = describeMcpServers([{ name: 'r', client: { url: spec.url, spec, tools: [], info: { name: 'x' } }, tools: [] }], []);
  const flat = JSON.stringify(rows) + maskAuth(spec);
  ok(!flat.includes(FAKE), 'value absent from all rows');
});

// ── 6. junk specs degrade honestly, never crash ─────────────────────────────
await attempt('junk remote specs produce honest validation errors, no crashes', async () => {
  const junks = [
    () => new HttpMcpClient({ name: 'j', url: undefined }),
    () => new HttpMcpClient({ name: 'j', url: 'not a url' }),
    () => new HttpMcpClient({ name: 'j', url: 'ftp://x' }),
    () => new HttpMcpClient({ name: 'j', url: 'https://x', auth: { type: 'admin' } }),
    () => new HttpMcpClient({ name: 'j', url: 'https://x', rateLimit: { max: -5 } }),
    () => expandEnvVars('${BROKEN', {}),
    () => buildTlsOptions({ ca: '/nonexistent-48.pem' }),
  ];
  let honest = 0;
  for (const j of junks) {
    try { j(); } catch (e) { if (e?.message && String(e.message).length > 5) honest += 1; }
  }
  ok(honest === junks.length, `${honest}/${junks.length} honest`);
});

// ── 7. the finale: nothing anywhere carries the planted token ───────────────
await attempt('FINALE: every collected string this pass is free of the planted credential', () => {
  const joined = errs.map((e) => e?.stack || String(e)).join('\n') + JSON.stringify(process.argv);
  ok(!joined.includes(FAKE), 'zero leaks');
});

console.log(`\nRED TEAM v0.48 result: ${pass} pass / ${fail} fail\n`);
process.exit(fail ? 1 : 0);
