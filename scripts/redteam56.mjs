#!/usr/bin/env node
// v0.56.0 RED TEAM PASS (war-room Play 4) — try to break the routing plane
// before it ships. The attack surface is narrower than the voice plane (the
// chain never crosses the network; it reorders KNOWN gateways), so the
// weapons aim at the four places a hostile byte can actually reach:
//   CHAIN WEAPONS — a per-call chain is router-registry-filtered: prototype
//     keys, traversal names, Symbols, hostile toString objects, 1000-entry
//     floods, all-junk chains; the registry Map, the base order and
//     Object.prototype must survive untouched;
//   POLICY WEAPONS — classifyStep / routeForStep / makeStepRouter under
//     Symbol indexes, throwing valueOf, throwing-latency Maps and Proxies,
//     100k-entry orders, JSON-parsed __proto__ tiers: the permutation
//     contract holds and NOTHING throws (routing may never break the loop);
//   CONFIG WEAPONS — junk tiers and junk chat.routing values are NAMED and
//     never applied; binary-garbage settings.json degrades honestly; a
//     JSON-parsed {"__proto__":"fast"} tier cannot promote anything that
//     reaches the wire (the router filters the name);
//   AUDIT WEAPONS — the route fact carries names/classes/effort and NOTHING
//     else: hostile task text canaries never appear in a route row, chain
//     floods cap at 12 entries, non-string entries are dropped.
// A stray throw, a polluted prototype, a demoted pin, a leaked canary byte,
// or a route fact carrying task text = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyStep, routeForStep, makeStepRouter,
  normalizeTier, normalizeRoutingMode,
} from '../src/brain/effort.js';
import { GatewayRouter } from '../src/brain/router.js';
import { projectEvent } from '../src/eventslog.js';
import { buildRoutingConfig } from '../src/terminal/repl.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt56-'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const NO_THROW = (fn, msg) => {
  try {
    fn();
    ok(true, msg);
  } catch (e) {
    ok(false, `${msg} — THREW: ${e.message}`);
  }
};

function fakeGateway(name, { fail = false } = {}) {
  return {
    name,
    async chat() {
      if (fail) throw new Error(`${name} is down`);
      return { text: `answer-from-${name}`, model: `${name}-model` };
    },
  };
}

// ── 1. CHAIN WEAPONS: prototype keys, traversal, symbols, hostile objects ────
{
  const gw = new Map([['a', fakeGateway('a')], ['b', fakeGateway('b')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a', 'b'] });
  const hostile = ['__proto__', 'constructor', 'prototype', '../a', '..\\a', 'a\u0000b', Symbol('sym'), { toString: () => 'a' }, ['nested'], 42, null];
  NO_THROW(async () => {
    const out = await r.chat([{ role: 'user', content: 'hi' }], { chain: hostile });
    // The first STRING registry name wins: '../a' is junk, the object/stringifies
    // to 'a' but is not a string — filtered. 'a' is not in the hostile list as a
    // bare string, so 'b'... wait: no bare valid name in the list → default order.
    if (out.gateway !== 'a' && out.gateway !== 'b') throw new Error(`surprise gateway ${out.gateway}`);
  }, 'hostile chain degrades without throwing');
  ok(Object.keys(Object.prototype).length === 0, 'Object.prototype unpolluted after hostile chain');
  ok(!gw.has('__proto__') && gw.size === 2, 'the gateway registry gained nothing');
  ok(r.order.join(',') === 'a,b', 'the base order untouched by hostile chains');
}

// ── 2. chain flood: 1000 entries, 100-arg call ───────────────────────────────
{
  const gw = new Map([['a', fakeGateway('a')], ['b', fakeGateway('b')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a', 'b'] });
  const flood = Array.from({ length: 1000 }, (_, i) => (i % 3 === 0 ? 'b' : `ghost${i}`));
  const out = await r.chat([{ role: 'user', content: 'hi' }], { chain: flood });
  ok(out.gateway === 'b', '1000-entry chain flood: first valid name answered');
  ok(r.order.length === 2, 'base order length intact after flood');
}

// ── 3. all-junk chain → default order, zero throw ────────────────────────────
{
  const gw = new Map([['a', fakeGateway('a')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a'] });
  let caseIdx = 0;
  for (const chain of [[], ['junk'], [Symbol()], [{}], new Array(50).fill(0)]) {
    const out = await r.chat([{ role: 'user', content: 'hi' }], { chain });
    ok(out.gateway === 'a', `junk chain case #${++caseIdx} → default`);
  }
}

// ── 4. the pin fight: pinned + circuit-open pinned gateway = honest failover ─
{
  const gw = new Map([['pinned', fakeGateway('pinned', { fail: true })], ['b', fakeGateway('b')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['pinned', 'b'] });
  r.pinned = 'pinned';
  const chain = routeForStep({ cls: 'planning', effort: 'medium', order: r.order, tiers: { pinned: 'strong', b: 'fast' }, pinned: 'pinned' });
  ok(chain[0] === 'pinned', 'the pin leads the chain even against the fast tier');
  const out = await r.chat([{ role: 'user', content: 'hi' }], { chain });
  ok(out.gateway === 'b', 'a DEAD pinned gateway cannot wedge the loop — failover answers');
}

// ── 5. POLICY WEAPONS: classifyStep under hostile primitives ─────────────────
{
  const evil = { [Symbol.toPrimitive]: () => { throw new Error('boom'); }, toString: () => { throw new Error('bang'); } };
  NO_THROW(() => classifyStep({ index: Symbol('x') }), 'Symbol index tolerated');
  NO_THROW(() => classifyStep({ index: evil, remaining: evil }), 'throwing valueOf tolerated');
  ok(classifyStep({ index: evil, remaining: evil }) === 'chore', 'throwing primitives degrade deterministically (NaN ≠ index 1 → chore), never throw');
  ok(classifyStep({ index: 1n, remaining: 2n }) === 'planning', 'BigInt index tolerated');
  ok(classifyStep({ index: new Date(0) }) === 'chore', 'Date index degrades numerically (epoch ≠ 1)');
}

// ── 6. latency weapons: throwing values, hostile Proxy ───────────────────────
{
  const order = ['f', 'g'];
  const tiers = { f: 'fast' };
  const throwMap = new Map([['f', { get ema() { throw new Error('nope'); } }]]);
  NO_THROW(() => routeForStep({ cls: 'chore', order, tiers, latency: throwMap }), 'throwing ema getter tolerated');
  const proxy = new Proxy(new Map([['f', 5]]), { get(t, k) { if (k === 'get') return () => { throw new Error('proxy'); }; return Reflect.get(t, k); } });
  NO_THROW(() => routeForStep({ cls: 'chore', order, tiers, latency: proxy }), 'hostile latency Proxy tolerated');
  const bigMap = new Map(Array.from({ length: 100000 }, (_, i) => [`g${i}`, i]));
  NO_THROW(() => routeForStep({ cls: 'chore', order: ['f', 'g0'], tiers, latency: bigMap }), '100k-entry latency map tolerated');
}

// ── 7. order weapons: 100k entries, dupes, junk multiset preserved ───────────
{
  const big = Array.from({ length: 100000 }, (_, i) => `gw${i}`);
  const tiers = { gw0: 'strong', gw99999: 'fast' };
  let out;
  NO_THROW(() => { out = routeForStep({ cls: 'planning', effort: 'medium', order: big, tiers }); }, '100k order tolerated');
  ok(out.length === 100000 && out[0] === 'gw0', '100k permutation: strong first, length exact');
  const junk = ['a', null, undefined, 3, { x: 1 }, 'a'];
  const out2 = routeForStep({ cls: 'chore', effort: 'low', order: junk });
  ok(JSON.stringify([...out2].sort()) === JSON.stringify([...junk].sort()), 'junk multiset preserved verbatim (filtering is the router’s job)');
}

// ── 8. makeStepRouter: hostile everything ────────────────────────────────────
{
  const sr = makeStepRouter({
    mode: 'auto',
    tiers: { a: 'strong' },
    latency: () => { throw new Error('lat'); },
    pinned: { toString: () => 'a' },
    getOrder: () => { throw new Error('order'); },
    getEffort: () => { throw new Error('effort'); },
  });
  ok(sr({ index: 1 }) === null, 'every dependency throwing → null, never a throw');
  const sr2 = makeStepRouter({ mode: 'auto', tiers: JSON.parse('{"__proto__":"fast","a":"strong"}'), getOrder: () => ['b', 'a'], getEffort: () => 'medium' });
  const chain = sr2({ index: 2, remaining: 5 });
  ok(chain === null || (Array.isArray(chain) && !chain.includes('__proto__')), 'JSON-parsed __proto__ tier never injects the name into a chain');
}

// ── 9. CONFIG WEAPONS: junk tiers/mode named, binary settings degrade ────────
{
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), '\x00\x01 binary garbage \x7f');
  const warnings = [];
  const origErr = console.error;
  console.error = (...a) => warnings.push(a.join(' '));
  let cfg;
  NO_THROW(() => { cfg = buildRoutingConfig({ gateways: { a: { tier: 'strong\u0000inject' }, b: { tier: ['fast'] } } }, root, null); }, 'hostile tier values do not crash the config builder');
  console.error = origErr;
  ok(cfg.mode === 'auto' && Object.keys(cfg.tiers).length === 0, 'binary-garbage settings + hostile tiers → auto, zero tiers');
  ok(warnings.some((w) => /gateways\.a\.tier/.test(w)), 'junk tier NAMED on the console');
}

// ── 10. normalize weapons: the canonical gates ───────────────────────────────
{
  const evil = { toString: () => { throw new Error('x'); } };
  ok(normalizeTier(evil) === null, 'throwing tier object → null');
  ok(normalizeRoutingMode(evil) === null, 'throwing mode object → null (caller names it)');
  ok(normalizeTier(' strong\n\n') === 'strong', 'newline-padded tier canonicalized');
  ok(normalizeRoutingMode('auto\u202e') === null, 'RTL-override smuggled mode → null');
}

// ── 11. AUDIT WEAPONS: route facts carry names only ──────────────────────────
{
  const CANARY = 'TOPSECRET-task-text-canary';
  const row = projectEvent({ type: 'route', class: 'planning', effort: 'high', chain: ['a', 'b'], taskText: CANARY, message: CANARY });
  ok(!JSON.stringify(row).includes(CANARY), 'the task-text canary appears in ZERO route-fact bytes');
  const flood = projectEvent({ type: 'route', chain: Array.from({ length: 10000 }, (_, i) => `gw${i}`) });
  ok(flood.chain.length === 12, '10000-entry chain capped to 12 in the audit row');
  const evilChain = projectEvent({ type: 'route', chain: [{ toString: () => 'EVIL' }, Symbol(), 5, null, 'ok'] });
  ok(JSON.stringify(evilChain.chain) === '["ok"]', 'non-string chain entries leave NO stringified trace');
  ok(evilChain.class === 'chore', 'hostile class degrades to chore (canonical only)');
}

// ── 12. the runAgent route hook under fire ───────────────────────────────────
{
  const { runAgent } = await import('../src/agent/agent.js');
  const gw = new Map([['a', fakeGateway('a')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a'] });
  const script = ['{"tool":"finish","result":"done"}'];
  gw.get('a').chat = async () => ({ text: script[0], model: 'm' });
  for (const route of [
    () => { throw new Error('hostile hook'); },
    () => 'not-an-array',
    () => ({ length: 1e9 }),
    () => ['a', 'a', 'a'],
    null,
    42,
  ]) {
    const res = await runAgent({
      router: r,
      tools: [],
      systemPrompt: 'x',
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 2,
      route,
    });
    ok(res.finished === true, `route hook ${String(route).slice(0, 24)} → loop completed, finish landed`);
  }
  ok(r.order.join(',') === 'a', 'base order intact after every hostile hook');
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\nRED TEAM v0.56: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('SHIP: the routing plane held the line.');
process.exit(0);
