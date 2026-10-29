// v0.56.0 — MULTI-MODEL ROUTING (§11): strongest for planning, fastest for
// chores; /effort low|medium|high as the user's dial. Tests run against the
// pure policy module (src/brain/effort.js), the REAL GatewayRouter (in-memory
// gateway adapters — the routing decision is the unit under test, not the
// HTTP wire), the REAL chat loop (createChat over a scripted router), the
// REAL sub-agent path (runSubagent → runAgent → route hook), the REAL event
// projection and the REAL session-config builder (buildRoutingConfig).
// Pins that carry the house rules:
//   - THE PERMUTATION CONTRACT: routeForStep never invents, drops or
//     duplicates a gateway — junk in, the same multiset out; filtering
//     hostile names is the ROUTER's job and lives there;
//   - THE OPERATOR DECLARES QUALITY: tiers come from buddy.config.json; the
//     engine never guesses (junk tier = NAMED and ignored); undeclared tiers
//     mean routing is byte-identical inertness;
//   - THE PIN IS ABSOLUTE: an explicit /model <name> can never be demoted by
//     the routing heuristics;
//   - THE EMA ONLY BREAKS TIES inside the declared 'fast' tier — a latency
//     number can never promote a gateway the operator did not call fast;
//   - FACTS, NOT CONTENT: the route event carries names, classes, effort —
//     zero message text (the events-log discipline, v0.55 carried).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TIERS, normalizeTier, normalizeRoutingMode, classifyStep,
  fastFirst, strongFirst, routeForStep, makeStepRouter,
} from '../src/brain/effort.js';
import { GatewayRouter } from '../src/brain/router.js';
import { createChat } from '../src/agent/chat.js';
import { runSubagent, parseAgentMd } from '../src/agent/subagents.js';
import { projectEvent } from '../src/eventslog.js';
import { buildRoutingConfig } from '../src/terminal/repl.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-route56-'));
}

// ── normalizeTier / normalizeRoutingMode — canonical-or-null ────────────────

test('normalizeTier: canonical tiers pass through', () => {
  for (const t of TIERS) assert.equal(normalizeTier(t), t);
  assert.deepEqual([...TIERS].sort(), ['fast', 'general', 'strong']);
});

test('normalizeTier: case/whitespace tolerated, junk nulled', () => {
  assert.equal(normalizeTier(' STRONG '), 'strong');
  assert.equal(normalizeTier('Fast'), 'fast');
  assert.equal(normalizeTier('strongest'), null);
  assert.equal(normalizeTier('STRONG;rm -rf'), null);
  assert.equal(normalizeTier(1), null);
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier({ tier: 'strong' }), null);
  assert.equal(normalizeTier(['strong']), null);
});

test('normalizeRoutingMode: auto/off canonical, absent = auto, junk null', () => {
  assert.equal(normalizeRoutingMode('auto'), 'auto');
  assert.equal(normalizeRoutingMode(' OFF '), 'off');
  assert.equal(normalizeRoutingMode(undefined), 'auto');
  assert.equal(normalizeRoutingMode(null), 'auto');
  assert.equal(normalizeRoutingMode(''), 'auto');
  assert.equal(normalizeRoutingMode('on'), null);
  assert.equal(normalizeRoutingMode(true), null);
  assert.equal(normalizeRoutingMode(0), null);
  assert.equal(normalizeRoutingMode('auto;drop table'), null);
});

// ── classifyStep — decided BEFORE the call, junk-safe ───────────────────────

test('classifyStep: first call of a turn is planning', () => {
  assert.equal(classifyStep({ index: 1, remaining: 14 }), 'planning');
});

test('classifyStep: middle mechanical steps are chores', () => {
  assert.equal(classifyStep({ index: 4, lastTool: 'fs_read', remaining: 10 }), 'chore');
});

test('classifyStep: a step after todo continues the plan (planning)', () => {
  assert.equal(classifyStep({ index: 3, lastTool: 'todo', remaining: 11 }), 'planning');
});

test('classifyStep: final budgeted step is planning (the report is synthesis)', () => {
  assert.equal(classifyStep({ index: 14, lastTool: 'shell', remaining: 1 }), 'planning');
});

test('classifyStep: plan-mode wrap pressure (<=2 left) is planning', () => {
  assert.equal(classifyStep({ index: 7, lastTool: 'fs_read', planMode: true, remaining: 2 }), 'planning');
  assert.equal(classifyStep({ index: 5, lastTool: 'fs_read', planMode: true, remaining: 5 }), 'chore');
});

test('classifyStep: junk inputs degrade deterministically, never throw', () => {
  assert.equal(classifyStep({}), 'planning'); // index defaults 1
  assert.equal(classifyStep({ index: NaN, remaining: NaN }), 'chore');
  assert.equal(classifyStep({ index: '2', remaining: '5', lastTool: { toString: () => 'todo' } }), 'chore');
  assert.equal(classifyStep({ index: -1e9, remaining: 1e9 }), 'chore');
  assert.equal(classifyStep(null), 'planning'); // defaults
  assert.equal(classifyStep('not-an-object'), 'planning'); // string junk → defaults
});

// ── routeForStep — the permutation contract ─────────────────────────────────

const isPermutationOf = (out, input) => {
  if (!Array.isArray(out) || out.length !== input.length) return false;
  const a = [...out].sort().join('\u0000');
  const b = [...input].sort().join('\u0000');
  return a === b;
};

test('routeForStep: planning leads strong, chore leads fast, permutation always', () => {
  const order = ['kilo', 'llm7', 'pollinations'];
  const tiers = { kilo: 'strong', pollinations: 'fast' };
  const p = routeForStep({ cls: 'planning', effort: 'medium', order, tiers });
  const c = routeForStep({ cls: 'chore', effort: 'medium', order, tiers });
  assert.deepEqual(p, ['kilo', 'llm7', 'pollinations']);
  assert.deepEqual(c, ['pollinations', 'kilo', 'llm7']);
  assert.ok(isPermutationOf(p, order) && isPermutationOf(c, order));
});

test('routeForStep: effort high = strong everywhere, low = fast everywhere', () => {
  const order = ['a', 'b', 'c'];
  const tiers = { b: 'strong', a: 'fast' };
  assert.deepEqual(routeForStep({ cls: 'chore', effort: 'high', order, tiers }), ['b', 'a', 'c']);
  assert.deepEqual(routeForStep({ cls: 'planning', effort: 'low', order, tiers }), ['a', 'b', 'c']);
});

test('routeForStep: fast tier sorts by EMA, unknown latencies after, stable', () => {
  const order = ['f1', 'f2', 'f3', 'g'];
  const tiers = { f1: 'fast', f2: 'fast', f3: 'fast' };
  const latency = new Map([['f3', 120], ['f1', 40]]); // f2 unknown → after f1, before? unknowns last: f1, f3, f2
  assert.deepEqual(routeForStep({ cls: 'chore', effort: 'medium', order, tiers, latency }), ['f1', 'f3', 'f2', 'g']);
});

test('routeForStep: EMA junk (NaN/negative/huge object) treated as unknown, no throw', () => {
  const order = ['f1', 'f2', 'g'];
  const tiers = { f1: 'fast', f2: 'fast' };
  const latency = new Map([['f1', NaN], ['f2', -5]]);
  assert.deepEqual(routeForStep({ cls: 'chore', order, tiers, latency }), ['f1', 'f2', 'g']);
  const poison = new Map([['f1', { ema: { ema: 1 } }], ['f2', Infinity]]);
  assert.deepEqual(routeForStep({ cls: 'chore', order, tiers, latency: poison }), ['f1', 'f2', 'g']);
});

test('routeForStep: the pin is ABSOLUTE — pinned head, bias on the tail only', () => {
  const order = ['kilo', 'llm7', 'pollinations'];
  const tiers = { kilo: 'strong', pollinations: 'fast' };
  const out = routeForStep({ cls: 'chore', effort: 'medium', order, tiers, pinned: 'kilo' });
  assert.equal(out[0], 'kilo'); // pinned first even though it is the STRONG one and this is a chore
  assert.ok(isPermutationOf(out, order));
  const out2 = routeForStep({ cls: 'planning', effort: 'medium', order, tiers, pinned: 'pollinations' });
  assert.equal(out2[0], 'pollinations');
});

test('routeForStep: unknown pinned name ignored, full permutation', () => {
  const order = ['a', 'b'];
  const out = routeForStep({ cls: 'chore', order, pinned: 'nope' });
  assert.ok(isPermutationOf(out, order));
});

test('routeForStep: junk in → same multiset out (no filtering here, that is the router) ', () => {
  const order = ['a', '__proto__', 'b', 42, null, 'a'];
  const out = routeForStep({ cls: 'chore', effort: 'low', order });
  assert.ok(isPermutationOf(out, order), 'junk entries are preserved, not filtered');
  assert.deepEqual(routeForStep({ cls: 'chore', order: [] }), []);
  assert.deepEqual(routeForStep({ cls: 'chore', order: 'not-an-array' }), []);
});

test('routeForStep: permutation fuzz — 120 random orders × levels × classes', () => {
  let seed = 56056;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  for (let i = 0; i < 120; i++) {
    const order = [...names].sort(() => rnd() - 0.5);
    const tiers = {};
    for (const n of names) if (rnd() < 0.5) tiers[n] = ['strong', 'fast', 'general'][Math.floor(rnd() * 3)];
    const latency = new Map(names.filter(() => rnd() < 0.5).map((n) => [n, Math.floor(rnd() * 5000) + 1]));
    for (const effort of ['low', 'medium', 'high']) {
      for (const cls of ['planning', 'chore']) {
        const out = routeForStep({ cls, effort, order, tiers, latency, pinned: rnd() < 0.3 ? order[Math.floor(rnd() * order.length)] : null });
        assert.ok(isPermutationOf(out, order), `permutation broke: ${JSON.stringify({ order, tiers, effort, cls })} → ${JSON.stringify(out)}`);
      }
    }
  }
});

// ── strongFirst / fastFirst standalone ──────────────────────────────────────

test('strongFirst: stable partition, general keeps relative order', () => {
  assert.deepEqual(strongFirst(['a', 'b', 'c', 'd'], { c: 'strong', a: 'strong' }), ['a', 'c', 'b', 'd']);
  assert.deepEqual(strongFirst(['a', 'b'], {}), ['a', 'b']);
});

test('fastFirst: no fast tier = identity', () => {
  assert.deepEqual(fastFirst(['a', 'b'], { a: 'strong' }, new Map([['b', 1]])), ['a', 'b']);
});

// ── the REAL router honors opts.chain ───────────────────────────────────────

function fakeGateway(name, { fail = false, vision = false, ctxLimit = null } = {}) {
  return {
    name,
    ...(vision ? { vision: true } : {}),
    ...(ctxLimit ? { ctxLimit } : {}),
    async chat(messages, opts) {
      if (fail) throw new Error(`${name} is down`);
      return { text: `answer-from-${name}`, model: `${name}-model` };
    },
  };
}

test('router: opts.chain reorders the walk for ONE call only', async () => {
  const gw = new Map([['a', fakeGateway('a')], ['b', fakeGateway('b')], ['c', fakeGateway('c')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a', 'b', 'c'] });
  const out = await r.chat([{ role: 'user', content: 'hi' }], { chain: ['c', 'a', 'b'] });
  assert.equal(out.gateway, 'c');
  assert.equal(r.order.join(','), 'a,b,c'); // the base order untouched
  const out2 = await r.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out2.gateway, 'a'); // next call walks the default again
});

test('router: hostile chain entries filtered (non-string, unknown, duplicate, __proto__)', async () => {
  const gw = new Map([['a', fakeGateway('a')], ['b', fakeGateway('b')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a', 'b'] });
  const out = await r.chat([{ role: 'user', content: 'hi' }], {
    chain: ['__proto__', 'constructor', '../a', 42, null, 'b', 'nope', 'b', 'a'],
  });
  assert.equal(out.gateway, 'b'); // first VALID entry wins; 'a' was a duplicate-filtered later entry
  const out2 = await r.chat([{ role: 'user', content: 'hi' }], { chain: ['junk1', 'junk2', {}] });
  assert.equal(out2.gateway, 'a'); // all-junk chain degrades to the default order
});

test('router: chain composes with vision-first (correctness constraint on top)', async () => {
  const gw = new Map([
    ['txt', fakeGateway('txt')],
    ['see', fakeGateway('see', { vision: true })],
  ]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['txt', 'see'] });
  const img = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }];
  const out = await r.chat(img, { chain: ['txt', 'see'] }); // chain puts the blind one first
  assert.equal(out.gateway, 'see'); // vision-first still wins — routing cannot break seeing
});

test('router: chain composes with circuit breakers (open gateway skipped with reason)', async () => {
  const gw = new Map([['a', fakeGateway('a')], ['b', fakeGateway('b')]]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['a', 'b'] });
  r._recordFailure('b', { rateLimited: true, retryAfterMs: 5000 }); // park b
  const out = await r.chat([{ role: 'user', content: 'hi' }], { chain: ['b', 'a'] });
  assert.equal(out.gateway, 'a'); // open circuit skips even a chain-told-first gateway
});

test('router: chain composes with ctx windows (oversized gateway skipped)', async () => {
  const gw = new Map([
    ['small', fakeGateway('small', { ctxLimit: 10 })],
    ['big', fakeGateway('big')],
  ]);
  const r = new GatewayRouter(gw, { gatewayOrder: ['small', 'big'] });
  const out = await r.chat([{ role: 'user', content: 'x'.repeat(500) }], { chain: ['small', 'big'] });
  assert.equal(out.gateway, 'big');
});

// ── the REAL chat loop routes per step ──────────────────────────────────────

function scriptedChatGateway(name, script) {
  let i = 0;
  return {
    name,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return { text: step, model: `${name}-model` };
    },
  };
}

const TODO_THEN_CHORES_THEN_SAY = [
  '{"tool":"todo","args":{"todos":[{"id":1,"text":"plan it","status":"in_progress"}]},"why":"plan first"}',
  '{"tool":"echoy","args":{},"why":"a chore"}',
  '{"tool":"echoy","args":{},"why":"another chore"}',
  '{"tool":"say","message":"done"}',
];

function routeSession({ order, tiers, effort, routing, events, extra = {} }) {
  const gw = new Map(order.map((n) => [n, scriptedChatGateway(n, TODO_THEN_CHORES_THEN_SAY)]));
  const router = new GatewayRouter(gw, { gatewayOrder: order });
  const seen = [];
  for (const n of order) {
    const g = gw.get(n);
    const orig = g.chat.bind(g);
    g.chat = (msgs, opts) => { seen.push({ gateway: n, chain: opts?.chain || null }); return orig(msgs, opts); };
  }
  const chat = createChat({
    router,
    tools: [{ name: 'echoy', description: 'echo', args: '{}', run: async () => 'ok', maxCalls: 6 }, { name: 'todo', description: 'plan', args: '{}', run: async () => 'ok' }],
    harness: { guardrails: [], memory: '' },
    maxStepsPerTurn: 14,
    maxTokens: 400,
    effort: effort ? { ...effort } : null,
    routing,
    onEvent: (ev) => events.push(ev),
    ...extra,
  });
  return { chat, router, seen };
}

test('chat loop: medium effort — step 1 rides STRONG, chores ride FAST', async () => {
  const events = [];
  const { chat, seen } = routeSession({
    order: ['strong', 'fasty', 'gen'],
    tiers: { strong: 'strong', fasty: 'fast' },
    routing: { mode: 'auto', tiers: { strong: 'strong', fasty: 'fast' } },
    events,
  });
  await chat.turn('make a plan then do the chores');
  assert.equal(seen[0].gateway, 'strong'); // step 1 = planning
  // step 1's strong-first permutation EQUALS the base order (strong already
  // leads) — the honest no-noise contract: no chain opt, no route fact.
  assert.equal(seen[0].chain, null);
  const choreCalls = seen.filter((s) => s.gateway === 'fasty');
  assert.ok(choreCalls.length >= 2, `chores rode fast (${seen.map((s) => s.gateway).join(',')})`);
  for (const c of choreCalls) assert.deepEqual(c.chain, ['fasty', 'strong', 'gen']); // fast leads on chores
  const routeFacts = events.filter((e) => e.type === 'route');
  assert.ok(routeFacts.length >= 2, `route facts logged (${routeFacts.length})`);
  assert.ok(routeFacts.every((f) => f.class === 'chore'), 'facts only fire when the chain genuinely reorders (chores)');
  for (const f of routeFacts) {
    assert.ok(Array.isArray(f.chain) && f.chain.length === 3);
    assert.ok(!JSON.stringify(f).includes('plan it'), 'route facts carry names/classes only, never task text');
  }
});

test('chat loop: effort high — EVERY call rides strong; low — EVERY call rides fast', async () => {
  const eventsHigh = [];
  const s1 = routeSession({ order: ['strong', 'fasty'], tiers: { strong: 'strong', fasty: 'fast' }, routing: { mode: 'auto', tiers: { strong: 'strong', fasty: 'fast' } }, events: eventsHigh, effort: { level: 'high', maxSteps: 8, maxTokens: 300 } });
  await s1.chat.turn('do it');
  assert.ok(s1.seen.every((s) => s.gateway === 'strong'), JSON.stringify(s1.seen.map((s) => s.gateway)));

  const eventsLow = [];
  const s2 = routeSession({ order: ['strong', 'fasty'], tiers: { strong: 'strong', fasty: 'fast' }, routing: { mode: 'auto', tiers: { strong: 'strong', fasty: 'fast' } }, events: eventsLow, effort: { level: 'low', maxSteps: 8, maxTokens: 300 } });
  await s2.chat.turn('do it');
  assert.ok(s2.seen.every((s) => s.gateway === 'fasty'), JSON.stringify(s2.seen.map((s) => s.gateway)));
});

test('chat loop: routing off (or no tiers) = byte-identical inertness, zero route facts', async () => {
  for (const routing of [{ mode: 'off', tiers: { strong: 'strong' } }, { mode: 'auto', tiers: {} }, null]) {
    const events = [];
    const { chat, seen } = routeSession({ order: ['strong', 'fasty'], routing, events });
    await chat.turn('do it');
    assert.ok(seen.every((s) => s.chain === null), 'no chain opt ever rides');
    assert.equal(events.filter((e) => e.type === 'route').length, 0);
    assert.ok(seen.every((s) => s.gateway === 'strong'), 'default order untouched');
  }
});

test('chat loop: the pin is absolute INSIDE the loop (router.pinned)', async () => {
  const events = [];
  const { chat, router, seen } = routeSession({
    order: ['strong', 'fasty'],
    tiers: { strong: 'strong', fasty: 'fast' },
    routing: { mode: 'auto', tiers: { strong: 'strong', fasty: 'fast' } },
    events,
  });
  router.order = ['fasty', 'strong']; // what /model fasty does
  router.pinned = 'fasty';
  await chat.turn('do it');
  assert.ok(seen.every((s) => s.gateway === 'fasty'), `pin held: ${seen.map((s) => s.gateway).join(',')}`);
});

// ── sub-agents ride the same policy ─────────────────────────────────────────

test('runSubagent: routing reaches the sub-agent loop (first step strong, chores fast)', async () => {
  const order = ['strong', 'fasty'];
  const script = [
    '{"tool":"probe","args":{},"why":"orient"}',
    '{"tool":"probe","args":{},"why":"chore"}',
    '{"tool":"finish","result":"report done"}',
  ];
  const gw = new Map(order.map((n) => [n, scriptedChatGateway(n, script)]));
  const router = new GatewayRouter(gw, { gatewayOrder: order });
  const seen = [];
  for (const n of order) {
    const g = gw.get(n);
    const orig = g.chat.bind(g);
    g.chat = (msgs, opts) => { seen.push({ gateway: n, chain: opts?.chain || null }); return orig(msgs, opts); };
  }
  const agent = parseAgentMd(['---', 'name: scout', 'tools: probe', '---', 'probe things'].join('\n'));
  const report = await runSubagent({
    router,
    agent,
    parentTools: [{ name: 'probe', description: 'probe', args: '{}', run: async () => 'ok' }],
    task: 'probe it',
    routing: { mode: 'auto', tiers: { strong: 'strong', fasty: 'fast' }, effort: 'medium' },
  });
  assert.match(report, /report done/); // runSubagent returns the raw report; the PREFIX is the task tool's
  assert.equal(seen[0].gateway, 'strong'); // step 1 = planning
  assert.equal(seen[0].chain, null); // strong already leads → no chain rides (no-noise contract)
  assert.equal(seen[1].gateway, 'fasty'); // middle chore
  assert.deepEqual(seen[1].chain, ['fasty', 'strong']);
  assert.equal(seen[2].gateway, 'fasty'); // index 3 of a 8-step budget = remaining 6 → still a chore
});

test('runSubagent: routing off → no chains, default order', async () => {
  const order = ['strong', 'fasty'];
  const script = ['{"tool":"finish","result":"done"}'];
  const gw = new Map(order.map((n) => [n, scriptedChatGateway(n, script)]));
  const router = new GatewayRouter(gw, { gatewayOrder: order });
  const seen = [];
  for (const n of order) {
    const g = gw.get(n);
    const orig = g.chat.bind(g);
    g.chat = (msgs, opts) => { seen.push({ gateway: n, chain: opts?.chain || null }); return orig(msgs, opts); };
  }
  const agent = parseAgentMd(['---', 'name: scout', '---', 'x'].join('\n'));
  await runSubagent({ router, agent, parentTools: [], task: 'x', routing: { mode: 'off', tiers: { strong: 'strong' } } });
  assert.ok(seen.every((s) => s.chain === null && s.gateway === 'strong'));
});

test('makeStepRouter: mode off → null factory; genuine reorder → the chain; no-op → null (not noise)', () => {
  assert.equal(makeStepRouter({ mode: 'off' }), null);
  assert.equal(makeStepRouter({ mode: 'junk' }), null);
  const sr = makeStepRouter({ mode: 'auto', tiers: { b: 'fast' }, getOrder: () => ['a', 'b'], getEffort: () => 'medium' });
  assert.deepEqual(sr({ index: 2, remaining: 5 }), ['b', 'a']); // chore fast-first genuinely reorders
  const sr2 = makeStepRouter({ mode: 'auto', tiers: {}, getOrder: () => ['a', 'b'], getEffort: () => 'medium' });
  assert.equal(sr2({ index: 1, remaining: 5 }), null); // no tiers → inert
  const sr3 = makeStepRouter({ mode: 'auto', tiers: { a: 'strong' }, getOrder: () => ['a', 'b'], getEffort: () => 'medium' });
  assert.equal(sr3({ index: 1, remaining: 5 }), null); // strong already leads → no chain, not noise
});

test('makeStepRouter: a hostile getOrder throw / junk order degrades to null', () => {
  const sr = makeStepRouter({ mode: 'auto', tiers: { a: 'strong' }, getOrder: () => { throw new Error('boom'); } });
  assert.equal(sr({ index: 1 }), null);
  const sr2 = makeStepRouter({ mode: 'auto', tiers: { a: 'strong' }, getOrder: () => 'not-a-list' });
  assert.equal(sr2({ index: 1 }), null);
});

// ── events projection: facts, not content ───────────────────────────────────

test('projectEvent route row: names + class + effort, chain capped, junk tamed', () => {
  const row = projectEvent({ type: 'route', class: 'planning', effort: 'high', chain: ['a', 'b'] });
  assert.equal(row.type, 'route');
  assert.equal(row.class, 'planning');
  assert.equal(row.effort, 'high');
  assert.deepEqual(row.chain, ['a', 'b']);
  const junk = projectEvent({ type: 'route', class: { toString: () => 'planning' }, chain: [1, null, 'x'.repeat(50)] });
  assert.equal(junk.class, 'chore'); // only the canonical string survives
  assert.deepEqual(junk.chain, ['x'.repeat(20)]); // non-strings dropped, long names capped
});

// ── buildRoutingConfig: the operator's declaration, junk NAMED ──────────────

test('buildRoutingConfig: tiers parsed from config, junk tier named+ignored, junk mode named+auto', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  const warnings = [];
  const origErr = console.error;
  console.error = (...a) => warnings.push(a.join(' '));
  try {
    const cfg = buildRoutingConfig(
      { gateways: { kilo: { tier: 'strong' }, llm7: { tier: 'STRONG' }, duckai: { tier: 'fastest' }, ollama: {} } },
      root,
      null
    );
    assert.deepEqual(cfg.tiers, { kilo: 'strong', llm7: 'strong' });
    assert.equal(cfg.mode, 'auto');
    assert.equal(cfg.effort, 'medium');
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ chat: { routing: 'OFF ' } }));
    assert.equal(buildRoutingConfig({}, root, null).mode, 'off');
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ chat: { routing: 'always-strong' } }));
    assert.equal(buildRoutingConfig({}, root, null).mode, 'auto');
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ chat: { routing: 1 } }));
    buildRoutingConfig({}, root, null);
    assert.ok(warnings.some((w) => /gateways\.duckai\.tier/.test(w)), 'junk tier NAMED');
    assert.ok(warnings.some((w) => /chat\.routing/.test(w)), 'junk mode NAMED');
  } finally {
    console.error = origErr;
  }
});

test('buildRoutingConfig: the effort getter is LIVE over the ref (sub-agent bias follows /effort)', () => {
  const effortRef = { level: 'medium', maxSteps: 14, maxTokens: 1500 };
  const cfg = buildRoutingConfig({}, tmp(), effortRef);
  assert.equal(cfg.effort, 'medium');
  effortRef.level = 'high';
  assert.equal(cfg.effort, 'high');
});
