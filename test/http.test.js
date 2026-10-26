// HTTP client tool (v0.26.0): env-ref auth (secrets never in args), retries,
// SSRF guard, method gating (riskyWhen), reporters wiring, permissions subject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  runHttpRequest,
  buildHttpTool,
  resolveAuthHeaders,
  SAFE_METHODS,
  HTTP_METHODS,
} from '../src/tools/http.js';
import { subjectFor, evaluatePermission } from '../src/permissions.js';

/** Fake fetch: records calls, replies per URL match. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    return handler(url, opts, calls);
  };
  fn.calls = calls;
  return fn;
}

const jsonRes = (status, body, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// ── auth resolution ──────────────────────────────────────────────────────────

test('resolveAuthHeaders: bearer/basic/header from env refs; secrets never in args', () => {
  const env = { GITHUB_TOKEN: 'ghp_secret_value', CREDS: 'me:pass123' };
  const bearer = resolveAuthHeaders({ type: 'bearer', env: 'GITHUB_TOKEN' }, env);
  assert.equal(bearer.headers.authorization, 'Bearer ghp_secret_value');
  const basic = resolveAuthHeaders({ type: 'basic', env: 'CREDS' }, env);
  assert.equal(basic.headers.authorization, `Basic ${Buffer.from('me:pass123').toString('base64')}`);
  const hdr = resolveAuthHeaders({ type: 'header', env: 'GITHUB_TOKEN', name: 'X-Api-Key' }, env);
  assert.equal(hdr.headers['x-api-key'], 'ghp_secret_value');
  // literal secrets are refused
  const literal = resolveAuthHeaders({ type: 'bearer', token: 'ghp_x' }, env);
  assert.match(literal.error, /never passed in args/);
  const missing = resolveAuthHeaders({ type: 'bearer', env: 'NOT_SET' }, env);
  assert.match(missing.error, /NOT_SET is not set/);
  assert.ok(!JSON.stringify(missing).includes('ghp'), 'no secret leak');
  assert.match(resolveAuthHeaders({ type: 'basic', env: 'NO_COLON' }, { NO_COLON: 'justname' }).error, /user:password/);
  assert.match(resolveAuthHeaders({ type: 'weird' }, {}).error, /bearer \| basic \| header/);
  assert.deepEqual(resolveAuthHeaders(null, env).headers, {});
});

// ── request mechanics ────────────────────────────────────────────────────────

test('runHttpRequest: GET with query merge + JSON pretty-print', async () => {
  const f = fakeFetch(() => jsonRes(200, { ok: true, items: [1, 2] }, { 'content-type': 'application/json' }));
  const out = await runHttpRequest(
    { method: 'GET', url: 'https://api.example.com/v1/items?page=1', query: { per: '50' }, headers: { Accept: 'application/json' } },
    { fetchImpl: f }
  );
  assert.match(out, /HTTP 200 GET https:\/\/api\.example\.com\/v1\/items\?page=1/);
  assert.match(out, /per=50/, 'query param merged into the request URL');
  assert.match(out, /"items": \[/, 'JSON pretty-printed');
  const sent = f.calls[0];
  assert.equal(sent.opts.method, 'GET');
  assert.equal(sent.opts.headers.accept, 'application/json');
});

test('runHttpRequest: auth header reaches the request; secret never in the observation', async () => {
  const f = fakeFetch(() => jsonRes(200, 'fine'));
  const out = await runHttpRequest(
    { url: 'https://api.example.com/private', auth: { type: 'bearer', env: 'T' } },
    { fetchImpl: f, env: { T: 'super_secret_123' } }
  );
  assert.equal(f.calls[0].opts.headers.authorization, 'Bearer super_secret_123');
  assert.ok(!out.includes('super_secret_123'), 'secret value absent from the tool output');
});

test('runHttpRequest: POST body object → JSON body + content-type; GET body ignored', async () => {
  const f = fakeFetch(() => jsonRes(201, { id: 7 }, { 'content-type': 'application/json' }));
  const out = await runHttpRequest(
    { method: 'POST', url: 'https://api.example.com/issues', body: { title: 'hi' } },
    { fetchImpl: f }
  );
  assert.match(out, /HTTP 201/);
  assert.equal(f.calls[0].opts.body, '{"title":"hi"}');
  assert.equal(f.calls[0].opts.headers['content-type'], 'application/json');
  const f2 = fakeFetch(() => jsonRes(200, 'x'));
  await runHttpRequest({ method: 'GET', url: 'https://api.example.com/', body: { nope: true } }, { fetchImpl: f2 });
  assert.equal(f2.calls[0].opts.body, undefined, 'GET carries no body');
});

test('runHttpRequest: retries on 5xx then succeeds; honest failure when exhausted; 4xx never retried', async () => {
  let n = 0;
  const f = fakeFetch(() => {
    n += 1;
    return jsonRes(n === 1 ? 503 : 200, 'ok');
  });
  const out = await runHttpRequest({ url: 'https://api.example.com/flaky', retries: 1 }, { fetchImpl: f });
  assert.match(out, /attempt 2\/2/);
  assert.match(out, /HTTP 200/);
  // exhausted (retries:1 → 2 attempts, ~300ms backoff between)
  const f2 = fakeFetch(() => jsonRes(500, 'boom'));
  const out2 = await runHttpRequest({ url: 'https://api.example.com/dead', retries: 1 }, { fetchImpl: f2 });
  assert.match(out2, /retries exhausted — 2 attempts/);
  assert.match(out2, /HTTP 500/, 'the final response body is still shown');
  assert.equal(f2.calls.length, 2);
  // 404: no retry — the URL is wrong, hammering it helps nobody
  const f3 = fakeFetch(() => jsonRes(404, 'nope'));
  await runHttpRequest({ url: 'https://api.example.com/none', retries: 3 }, { fetchImpl: f3 });
  assert.equal(f3.calls.length, 1, '4xx is not retried');
});

test('runHttpRequest: SSRF guard, scheme allowlist, method allowlist, caps', async () => {
  const f = fakeFetch(() => jsonRes(200, 'x'));
  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/meta', 'http://10.0.0.1/x']) {
    assert.match(await runHttpRequest({ url }, { fetchImpl: f }), /local\/internal addresses are blocked/, url);
  }
  assert.equal(f.calls.length, 0, 'blocked requests never reach fetch');
  assert.match(await runHttpRequest({ url: 'file:///etc/passwd' }, { fetchImpl: f }), /http\(s\) URLs/);
  assert.match(await runHttpRequest({ method: 'TRACE', url: 'https://api.example.com/' }, { fetchImpl: f }), /not allowed/);
  assert.match(
    await runHttpRequest({ url: 'https://api.example.com/big' }, { fetchImpl: f, timeoutMs: 10 }),
    /HTTP 200/
  );
  const long = 'x'.repeat(9000);
  const out = await runHttpRequest({ url: 'https://api.example.com/long', max_chars: 500 }, {
    fetchImpl: fakeFetch(() => jsonRes(200, long)),
  });
  assert.match(out, /truncated — 9000 chars total/);
});

test('runHttpRequest: network error retries then reports honestly; abort timeout', async () => {
  const f = fakeFetch(() => {
    throw new Error('ECONNRESET');
  });
  const out = await runHttpRequest({ url: 'https://api.example.com/x', retries: 1 }, { fetchImpl: f });
  assert.match(out, /failed after 2 attempts — ECONNRESET/);
  const f2 = fakeFetch(() => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  });
  const out2 = await runHttpRequest({ url: 'https://api.example.com/slow' }, { fetchImpl: f2, timeoutMs: 50 });
  assert.match(out2, /timed out after 0.05s/);
});

test('buildHttpTool: riskyWhen gates mutations only; description names reporters', () => {
  const tool = buildHttpTool({ reporters: [{ name: 'ci' }, { name: 'prices' }] });
  assert.equal(tool.name, 'http');
  assert.equal(tool.riskyWhen({ method: 'GET' }), false);
  assert.equal(tool.riskyWhen({ method: 'HEAD' }), false);
  assert.equal(tool.riskyWhen({ method: 'OPTIONS' }), false);
  assert.equal(tool.riskyWhen({ method: 'POST' }), true);
  assert.equal(tool.riskyWhen({ method: 'DELETE' }), true);
  assert.equal(tool.riskyWhen({}), false, 'method defaults to GET');
  assert.match(tool.description, /\/report <name>/);
  assert.match(tool.description, /ci, prices/);
  assert.doesNotMatch(buildHttpTool({}).description, /reporters configured/);
  assert.deepEqual([...SAFE_METHODS].sort(), ['GET', 'HEAD', 'OPTIONS']);
  assert.equal(HTTP_METHODS.has('PUT'), true);
});

test('http permissions: url is the subject; domain rules work for http too', () => {
  assert.equal(subjectFor('http', { url: 'https://api.github.com/x' }), 'https://api.github.com/x');
  const perms = { defaultMode: 'ask', allow: ['http(domain:api.github.com)'], deny: ['http(domain:evil.example)'] };
  assert.equal(evaluatePermission(perms, 'http', { url: 'https://api.github.com/repos/a/b' }), 'allow');
  assert.equal(evaluatePermission(perms, 'http', { url: 'https://evil.example/x' }), 'deny');
  assert.equal(evaluatePermission(perms, 'http', { url: 'https://other.example/x' }), 'ask');
});

// ── chat loop integration: riskyWhen drives the approval gate ────────────────

test('chat loop: riskyWhen(GET) skips the gate; riskyWhen(POST) asks', async () => {
  const { createChat } = await import('../src/agent/chat.js');
  const asked = [];
  const makeChat = (script) =>
    createChat({
      router: {
        order: ['x'],
        chat: async () => ({ text: script.shift() }),
      },
      tools: [
        { name: 'say', description: 'd', args: '{}', run: async ({ message }) => message },
        {
          name: 'http',
          description: 'd',
          args: '{}',
          riskyWhen: (a) => String(a?.method || 'GET').toUpperCase() !== 'GET',
          run: async () => 'http ran',
        },
      ],
      harness: '',
      root: os.tmpdir(),
      permissions: { defaultMode: 'ask', allow: [], deny: [] },
      approval: async (req) => {
        asked.push(req.tool);
        return 'yes';
      },
    });
  // GET — safe, no approval
  let c = makeChat(['{"tool":"http","args":{"method":"GET","url":"https://api.example.com/"}}', '{"tool":"say","message":"done"}']);
  await c.turn('fetch it');
  assert.deepEqual(asked, [], 'GET never asks');
  // POST — gated
  c = makeChat(['{"tool":"http","args":{"method":"POST","url":"https://api.example.com/"}}', '{"tool":"say","message":"done"}']);
  await c.turn('create it');
  assert.deepEqual(asked, ['http'], 'POST asks at the gate');
});
