import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayRouter } from '../src/brain/router.js';
import { BuddyError, RateLimitError } from '../src/util.js';

function fakeGateway(name, behavior) {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    async chat(messages, opts) {
      calls++;
      const out = behavior(calls);
      if (out instanceof RateLimitError || out instanceof BuddyError) throw out;
      return out;
    },
  };
}

const OK = (text = 'ok') => ({ text, model: 'test-model', gateway: 'x' });

test('router: happy path uses first gateway', async () => {
  const a = fakeGateway('a', () => OK('from-a'));
  const b = fakeGateway('b', () => OK('from-b'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'] });
  const out = await r.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out.text, 'from-a');
  assert.equal(out.gateway, 'a');
  assert.equal(a.calls(), 1);
  assert.equal(b.calls(), 0);
});

test('router: failover to next gateway on error', async () => {
  const a = fakeGateway('a', () => new BuddyError('down', { code: 'NETWORK' }));
  const b = fakeGateway('b', () => OK('from-b'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'] });
  const out = await r.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out.text, 'from-b');
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0].gateway, 'a');
});

test('router: circuit breaker opens after threshold and skips gateway', async () => {
  let mode = 'fail';
  const a = fakeGateway('a', () => (mode === 'fail' ? new BuddyError('down') : OK('recovered')));
  const b = fakeGateway('b', () => OK('from-b'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), {
    gatewayOrder: ['a', 'b'],
    failureThreshold: 2,
    cooldownMs: 60000,
    maxRoundTrips: 1,
  });
  await r.chat([{ role: 'user', content: 'x' }]); // a fails once
  await r.chat([{ role: 'user', content: 'x' }]); // a fails twice → breaker opens
  const snap = r.healthSnapshot().find((s) => s.name === 'a');
  assert.equal(snap.circuitOpen, true);
  const callsBefore = a.calls();
  await r.chat([{ role: 'user', content: 'x' }]); // a skipped
  assert.equal(a.calls(), callsBefore);
  // after cooldown it can recover
  mode = 'ok';
  r.state.get('a').openUntil = Date.now() - 1;
  const out = await r.chat([{ role: 'user', content: 'x' }]);
  assert.equal(out.text, 'recovered');
});

test('router: rate limit parks gateway with retryAfter', async () => {
  const a = fakeGateway('a', () => new RateLimitError('limited', { retryAfterMs: 50000 }));
  const b = fakeGateway('b', () => OK('from-b'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'], maxRoundTrips: 2 });
  const out = await r.chat([{ role: 'user', content: 'x' }]);
  assert.equal(out.text, 'from-b');
  assert.ok(r.healthSnapshot().find((s) => s.name === 'a').circuitOpen);
});

test('router: ALL_GATEWAYS_FAILED after exhausting round trips', async () => {
  const a = fakeGateway('a', () => new BuddyError('down'));
  const b = fakeGateway('b', () => new BuddyError('down'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'], maxRoundTrips: 2, failureThreshold: 99 });
  await assert.rejects(() => r.chat([{ role: 'user', content: 'x' }]), /all gateways failed/i);
  assert.equal(a.calls(), 2);
  assert.equal(b.calls(), 2);
});

// v0.9.6 live test: the brain-offline line showed kilo/pollinations/duckai
// failures but never llm7 — llm7's circuit was already open, so it was
// silently skipped and vanished from the report. The final error must cover
// EVERY gateway in the chain.
test('router: circuit-open gateway still appears in ALL_GATEWAYS_FAILED', async () => {
  let bMode = 'ok';
  const a = fakeGateway('a', () => new BuddyError('down'));
  const b = fakeGateway('b', () => (bMode === 'ok' ? OK('from-b') : new BuddyError('boom-b')));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), {
    gatewayOrder: ['a', 'b'],
    failureThreshold: 2,
    cooldownMs: 60000,
    maxRoundTrips: 1,
  });
  await r.chat([{ role: 'user', content: 'x' }]); // a: failure 1
  await r.chat([{ role: 'user', content: 'x' }]); // a: failure 2 → circuit opens
  assert.ok(r.healthSnapshot().find((s) => s.name === 'a').circuitOpen);
  bMode = 'fail';
  let err = null;
  try {
    await r.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the chain to fail');
  assert.equal(err.code, 'ALL_GATEWAYS_FAILED');
  assert.match(err.message, /a: circuit open \(retry in ~\d+s\)/); // llm7 must not vanish
  assert.match(err.message, /b: boom-b/);
  assert.ok(Array.isArray(err.data.skipped) && err.data.skipped.some((s) => s.gateway === 'a'));
  assert.equal(a.calls(), 2); // never tried again while the circuit is open
});

// v0.9.6 live test: kilo got rate-limited with a 60s Retry-After, every other
// gateway also failed, and Buddy just said "brain offline" — no hint that
// waiting a minute would fix it.
test('router: rate-limited final error carries a wait hint', async () => {
  const a = fakeGateway('a', () => new RateLimitError('limited', { retryAfterMs: 60000 }));
  const b = fakeGateway('b', () => new BuddyError('down'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'], maxRoundTrips: 1, failureThreshold: 99 });
  let err = null;
  try {
    await r.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the chain to fail');
  assert.equal(err.code, 'ALL_GATEWAYS_FAILED');
  assert.match(err.message, /a: rate-limited \(\d+s\)/);
  assert.match(err.message, /wait ~\d+s for the rate limit to lift, then say "continue"/);
});

test('router: no wait hint when nothing is rate-limited', async () => {
  const a = fakeGateway('a', () => new BuddyError('down'));
  const b = fakeGateway('b', () => new BuddyError('down'));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'], maxRoundTrips: 1, failureThreshold: 99 });
  let err = null;
  try {
    await r.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the chain to fail');
  assert.equal(err.code, 'ALL_GATEWAYS_FAILED');
  assert.doesNotMatch(err.message, /wait ~\d+s/);
  assert.match(err.message, /a: down \| b: down/);
});
