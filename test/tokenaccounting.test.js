// tokenaccounting.test.js — Build 13 (P1): real token accounting.
//
// Locks down:
//   1. extractUsage: OpenAI shape, camelCase, Ollama native counters, junk → null
//   2. estimateTokens: chars ÷ 4, ceil, safe on junk
//   3. gwCtxLimit: config override wins, fallback otherwise
//   4. the router skips gateways whose window cannot hold the request —
//      without burning an attempt on them — and reports WHY in the skipped list
//   5. the no-deadlock rule: when NO gateway fits, limits are relaxed and the
//      biggest window is tried first (a maybe-rejected call beats never calling)
//   6. chat.usage(): real tokens summed when the gateway reports; chars ÷ 4
//      estimate when it doesn't; mixed sessions label both counts
//   7. compaction calls are accounted like any other brain call
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractUsage, estimateTokens, gwCtxLimit } from '../src/brain/usage.js';
import { GatewayRouter } from '../src/brain/router.js';
import { createChat } from '../src/agent/chat.js';
import { fmtTok } from '../src/terminal/repl.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

const SAY = '{"tool":"say","message":"ok"}';

test('usage: extractUsage reads OpenAI, camelCase and Ollama shapes', () => {
  const openai = extractUsage({ usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 } });
  assert.deepEqual(openai, { promptTokens: 120, completionTokens: 34, totalTokens: 154 });
  const camel = extractUsage({ usage: { promptTokens: 10, completionTokens: 5 } });
  assert.equal(camel.totalTokens, 15);
  const ollama = extractUsage({ prompt_eval_count: 90, eval_count: 20 });
  assert.deepEqual(ollama, { promptTokens: 90, completionTokens: 20, totalTokens: 110 });
  // no usage block at all → null (caller falls back to the estimate)
  assert.equal(extractUsage({ choices: [] }), null);
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage({ usage: { prompt_tokens: 'junk' } }), null);
  // total absent but parts present → summed
  const summed = extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
  assert.equal(summed.totalTokens, 10);
});

test('usage: estimateTokens is chars ÷ 4, ceil, junk-safe', () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(401), 101);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(-3), 0);
  assert.equal(estimateTokens('nope'), 0);
});

test('usage: gwCtxLimit — config override wins, fallback when unset/junk', () => {
  assert.equal(gwCtxLimit({ ctxLimit: 1234 }, 8000), 1234);
  assert.equal(gwCtxLimit({}, 8000), 8000);
  assert.equal(gwCtxLimit({ ctxLimit: 'lots' }, 8000), 8000);
  assert.equal(gwCtxLimit({ ctxLimit: 0 }, 8000), 8000);
});

function gw(name, { ctxLimit = null, fail = false } = {}) {
  const calls = [];
  return {
    name,
    ...(ctxLimit ? { ctxLimit } : {}),
    calls,
    chat: async (messages) => {
      calls.push(messages);
      if (fail) throw new Error(`${name} is down`);
      return { text: 'ok', model: name, gateway: name };
    },
  };
}

test('router: skips a gateway whose window cannot hold the request (no attempt burned)', async () => {
  const small = gw('small', { ctxLimit: 10 });
  const big = gw('big', { ctxLimit: 100000 });
  const router = new GatewayRouter(new Map([['small', small], ['big', big]]), { gatewayOrder: ['small', 'big'] });
  // ~100 chars → ~25 tok: fits big, too big for small (10 tok).
  const out = await router.chat([{ role: 'user', content: 'x'.repeat(100) }]);
  assert.equal(out.gateway, 'big');
  assert.equal(small.calls.length, 0, 'small never saw the request');
  assert.equal(big.calls.length, 1);
});

test('router: reports the window skip reason in the final error when everything fails', async () => {
  const small = gw('small', { ctxLimit: 10 });
  const big = gw('big', { ctxLimit: 100000, fail: true });
  const router = new GatewayRouter(new Map([['small', small], ['big', big]]), { gatewayOrder: ['small', 'big'], maxRoundTrips: 1 });
  await assert.rejects(
    router.chat([{ role: 'user', content: 'x'.repeat(100) }]),
    (e) => {
      assert.match(e.message, /small: context too big/);
      assert.match(e.message, /big: big is down/);
      return true;
    }
  );
  assert.equal(small.calls.length, 0);
});

test('router: no gateway fits → limits relaxed, biggest window tried first', async () => {
  const tiny = gw('tiny', { ctxLimit: 5 });
  const smallish = gw('smallish', { ctxLimit: 50 });
  const router = new GatewayRouter(new Map([['tiny', tiny], ['smallish', smallish]]), { gatewayOrder: ['tiny', 'smallish'] });
  // 1000 chars → ~250 tok: neither window holds it. Must STILL call —
  // biggest window first — not refuse.
  const out = await router.chat([{ role: 'user', content: 'x'.repeat(1000) }]);
  assert.equal(out.gateway, 'smallish', 'largest window first');
  assert.equal(smallish.calls.length, 1);
  assert.equal(tiny.calls.length, 0);
});

test('router: gateways without a ctxLimit are always eligible (back-compat)', async () => {
  const free = gw('free'); // no ctxLimit
  const router = new GatewayRouter(new Map([['free', free]]), { gatewayOrder: ['free'] });
  const out = await router.chat([{ role: 'user', content: 'x'.repeat(5000) }]);
  assert.equal(out.gateway, 'free');
  assert.equal(free.calls.length, 1);
});

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

test('chat usage: gateway-reported tokens are summed and labeled reported', async () => {
  const { tools, harness } = makeBuddy(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tok-')));
  const router = {
    order: ['fake'],
    chat: async (messages) => ({
      text: SAY,
      model: 'm',
      gateway: 'fake',
      usage: { promptTokens: 500, completionTokens: 20 },
    }),
  };
  const chat = createChat({ router, tools, harness });
  const r = await chat.turn('hello, do the thing');
  assert.equal(r.said, 'ok');
  const u = chat.usage();
  assert.equal(u.calls, 1);
  assert.equal(u.tokIn, 500, 'real prompt tokens, not the estimate');
  assert.equal(u.tokOut, 20);
  assert.equal(u.reportedCalls, 1);
  assert.equal(u.estimatedCalls, 0);
  assert.equal(u.byGateway.fake.tokIn, 500);
});

test('chat usage: no reported usage → chars ÷ 4 estimate, labeled estimated', async () => {
  const { tools, harness } = makeBuddy(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tok-')));
  const router = {
    order: ['fake'],
    chat: async (messages) => ({ text: SAY, model: 'm', gateway: 'fake' }),
  };
  const chat = createChat({ router, tools, harness });
  await chat.turn('x'.repeat(400));
  const u = chat.usage();
  assert.equal(u.calls, 1);
  assert.equal(u.tokIn, Math.ceil(u.charsIn / 4), 'estimate is exactly chars ÷ 4 of what was sent');
  assert.equal(u.tokOut, Math.ceil(u.charsOut / 4));
  assert.ok(u.charsIn > 400, 'charsIn includes the system prompt + message');
  assert.equal(u.estimatedCalls, 1);
  assert.equal(u.reportedCalls, 0);
});

test('chat usage: mixed session counts both sources honestly', async () => {
  const { tools, harness } = makeBuddy(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tok-')));
  let n = 0;
  const router = {
    order: ['fake'],
    chat: async (messages) => {
      n++;
      return n % 2
        ? { text: SAY, gateway: 'fake', usage: { promptTokens: 100, completionTokens: 10 } }
        : { text: SAY, gateway: 'fake' };
    },
  };
  const chat = createChat({ router, tools, harness });
  await chat.turn('first');
  chat.messages.splice(0); // second turn, fresh
  await chat.turn('second');
  const u = chat.usage();
  assert.equal(u.calls, 2);
  assert.equal(u.reportedCalls, 1);
  assert.equal(u.estimatedCalls, 1);
});

test('chat usage: compaction calls are accounted like any other brain call', async () => {
  const { tools, harness } = makeBuddy(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tok-')));
  const script = ['COMPACT SUMMARY TEXT', SAY];
  const router = {
    order: ['fake'],
    chat: async () => ({
      text: script.shift() ?? SAY,
      gateway: 'fake',
      usage: { promptTokens: 1000, completionTokens: 50 },
    }),
  };
  const chat = createChat({
    router,
    tools,
    harness,
    charBudget: 2000,
  });
  // keep = 4 → head needs ≥ 2 dropped messages, so prefill 6 disposables.
  for (const c of 'abcdef') chat.messages.push({ role: 'user', content: c.repeat(200) });
  const res = await chat.compactNow();
  assert.ok(res.compacted, 'compaction ran');
  const u = chat.usage();
  assert.equal(u.calls, 1, 'the summarizer call is on the books');
  assert.equal(u.tokIn, 1000);
  assert.equal(u.tokOut, 50);
});

test('fmtTok: human token display', () => {
  assert.equal(fmtTok(940), '940');
  assert.equal(fmtTok(128400), '128.4k');
  assert.equal(fmtTok(0), '0');
  assert.equal(fmtTok(undefined), '0');
});
