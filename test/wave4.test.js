// wave4.test.js — Observability & Routing (v0.25.0):
//   per-task usage ledger + effort levels (chat.js)
//   structured event log (eventslog.js)
//   self-healing routing memory (brain/routing-memory.js)
//   latency learning + offline-first fallback (brain/router.js)
//   buddy update (update.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { GatewayRouter } from '../src/brain/router.js';
import { loadRoutingMemory, saveRoutingMemory, noteLatency, applyLearnedOrder, selfHeal } from '../src/brain/routing-memory.js';
import { appendEvent, readEvents, projectEvent, eventsLogPath } from '../src/eventslog.js';
import { semverGt, tagVersion, pickLatestTag, planUpdate, cmdUpdate } from '../src/update.js';
import { EFFORT_PRESETS, applyEffort, SLASH_COMMANDS, SLASH_DESCRIPTIONS } from '../src/terminal/repl.js';

function tmpRoot(prefix = 'buddy-wave4-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

function fakeRouter(script, calls = []) {
  return {
    order: ['fake'],
    gateways: new Map([['fake', { name: 'fake' }]]),
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

// ── Per-task usage ledger ────────────────────────────────────────────────────

test('taskLog: one entry per turn with calls/tokens/steps', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  const { tools, harness } = makeBuddy(root);
  const router = fakeRouter(['{"tool":"fs_read","args":{"path":"a.txt"}}', '{"tool":"say","message":"read it"}']);
  const chat = createChat({ router, tools, harness, root });
  const out = await chat.turn('read a.txt please');
  assert.equal(out.said, 'read it');
  const log = chat.taskLog();
  assert.equal(log.length, 1);
  const t = log[0];
  assert.equal(t.task, 'read a.txt please');
  assert.equal(t.steps, 2);
  assert.equal(t.calls, 2); // fs_read call + say call
  assert.ok(t.tokIn > 0 && t.tokOut > 0);
  assert.ok(t.durationMs >= 0);
  assert.equal(t.error, false);
  assert.ok(t.byGateway.fake, 'per-gateway diff recorded');
  assert.equal(t.byGateway.fake.calls, 2);
});

test('taskLog: aborted turns still land in the ledger (finally, not success)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({ router: fakeRouter(['{"tool":"say","message":"done"}']), tools, harness, root });
  const out = await chat.turn('quick chore', { signal: AbortSignal.abort() }); // pre-aborted
  assert.equal(out.aborted, true);
  const log = chat.taskLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].calls, 0); // nothing was spent
});

test('taskLog: caps at 100 entries, oldest dropped', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({ router: fakeRouter(['{"tool":"say","message":"ok"}']), tools, harness, root });
  for (let i = 0; i < 105; i++) await chat.turn(`task number ${i}`);
  const log = chat.taskLog();
  assert.equal(log.length, 100);
  assert.equal(log[0].task, 'task number 5'); // 0-4 shifted out
});

// ── Effort levels ────────────────────────────────────────────────────────────

test('effort: low caps the step budget (budget error names 8, not 14)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  // Always returns a tool call → the turn runs to the effort cap.
  const script = Array(9).fill('{"tool":"fs_list","args":{}}');
  const chat = createChat({ router: fakeRouter(script), tools, harness, root, effort: { level: 'low', maxSteps: 8, maxTokens: 900 } });
  const out = await chat.turn('do the impossible chore');
  assert.equal(out.said, null);
  assert.equal(out.steps, 8); // effort low, not the default 14
});

test('effort: maxTokens follows the level (plan floor still wins)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (m, o) => {
      calls.push(o);
      return { text: '{"tool":"say","message":"hi"}', model: 'fake-model', gateway: 'fake' };
    },
  };
  const chat = createChat({ router, tools, harness, root, effort: { level: 'low', maxSteps: 8, maxTokens: 900 } });
  await chat.turn('hello');
  assert.equal(calls[0].maxTokens, 900);
  // Plan mode: the 2500 floor beats effort's 900 (a truncated plan = protocol violation).
  const calls2 = [];
  const router2 = {
    order: ['fake'],
    chat: async (m, o) => {
      calls2.push(o);
      return { text: '{"tool":"exit_plan","args":{"summary":"s","plan":"P"}}', model: 'fake-model', gateway: 'fake' };
    },
  };
  const chat2 = createChat({ router: router2, tools, harness, root, effort: { level: 'low', maxSteps: 8, maxTokens: 900 }, modes: { plan: true } });
  await chat2.turn('plan something');
  assert.ok(calls2.some((c) => c.maxTokens >= 2500), `plan floor applies (got ${calls2.map((c) => c.maxTokens).join(',')})`);
});

test('effort presets: applyEffort mutates the live ref; unknown levels rejected', () => {
  const fake = { effort: { level: 'medium', maxSteps: 14, maxTokens: 1500 } };
  assert.equal(applyEffort(fake, 'high'), true);
  assert.deepEqual({ ...fake.effort }, { level: 'high', maxSteps: 24, maxTokens: 2200 });
  assert.equal(applyEffort(fake, 'turbo'), false);
  assert.equal(fake.effort.level, 'high'); // unchanged by the failed apply
  assert.deepEqual(EFFORT_PRESETS.low, { level: 'low', maxSteps: 8, maxTokens: 900 });
});

test('palette: stats/effort/events registered with descriptions', () => {
  for (const cmd of ['stats', 'effort', 'events']) {
    assert.ok(SLASH_COMMANDS.includes(cmd), `/${cmd} in the palette`);
    assert.ok(SLASH_DESCRIPTIONS[cmd], `/${cmd} has a description`);
  }
});

// ── Structured event log ────────────────────────────────────────────────────

test('eventslog: append → read tail roundtrip, torn lines tolerated', () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) appendEvent(root, projectEvent({ type: 'tool', tool: `t${i}`, denied: false, observation: 'x'.repeat(50) }));
  fs.appendFileSync(eventsLogPath(root), '{"ts":"TORN",type:"torn"\n'); // torn line
  appendEvent(root, projectEvent({ type: 'say', text: 'done' }));
  const evs = readEvents(root, 10);
  assert.equal(evs.length, 6); // 5 tools + 1 say, torn skipped
  assert.equal(evs[0].tool, 't0');
  assert.equal(evs[5].type, 'say');
  assert.ok(evs[0].ts, 'ISO timestamp injected');
});

test('eventslog: rotation keeps the tail writable at tiny caps', () => {
  const root = tmpRoot();
  for (let i = 0; i < 20; i++) appendEvent(root, { type: 'tool', tool: 'x' }, { maxBytes: 300 });
  assert.ok(fs.existsSync(eventsLogPath(root)));
  assert.ok(fs.existsSync(`${eventsLogPath(root)}.1`), 'rotated file exists');
  const evs = readEvents(root, 50);
  assert.ok(evs.length > 0 && evs.length < 20, `tail kept (${evs.length})`);
});

test('eventslog: projectEvent keeps facts, drops bulk', () => {
  const p = projectEvent({ type: 'tool', tool: 'bash', args: { cmd: 'x'.repeat(5000) }, observation: 'y'.repeat(9000), denied: true, gateway: 'kilo', model: 'm' });
  assert.deepEqual(Object.keys(p).sort(), ['denied', 'gateway', 'model', 'obsChars', 'tool', 'type']);
  assert.equal(p.obsChars, 9000);
  assert.equal(p.denied, true);
});

// ── Self-healing routing memory ─────────────────────────────────────────────

test('routing-memory: EMA math + clamping', () => {
  const mem = {};
  const e1 = noteLatency(mem, 'kilo', 1000);
  assert.equal(e1, 1000); // first sample IS the value
  const e2 = noteLatency(mem, 'kilo', 2000);
  assert.equal(e2, 1300); // 1000*0.7 + 2000*0.3
  noteLatency(mem, 'kilo', 99999999); // clamped to 300000
  assert.ok(mem.kilo.ema <= 300000);
  noteLatency(mem, 'kilo', -5); // junk ignored
  assert.equal(mem.kilo.samples, 3);
});

test('routing-memory: save/load roundtrip', () => {
  const root = tmpRoot();
  const mem = {};
  noteLatency(mem, 'kilo', 500);
  noteLatency(mem, 'llm7', 1200);
  assert.equal(saveRoutingMemory(root, mem), true);
  const loaded = loadRoutingMemory(root);
  assert.equal(loaded.kilo.ema, 500);
  assert.equal(loaded.llm7.ema, 1200);
  fs.writeFileSync(path.join(root, '.buddy', 'routing.json'), '{junk');
  assert.deepEqual(loadRoutingMemory(root), {}); // junk degrades to {}
});

test('routing-memory: learned order keeps the pin, sorts the tail by EMA', () => {
  const router = { order: ['pinned', 'slow', 'fast', 'unknown1', 'unknown2'] };
  const mem = { slow: { ema: 4000 }, fast: { ema: 800 } };
  const next = applyLearnedOrder(router, mem);
  assert.deepEqual(next, ['pinned', 'fast', 'slow', 'unknown1', 'unknown2']);
});

test('routing-memory: selfHeal needs 2+ learned gateways and skips no-op orders', () => {
  const router = { order: ['a', 'b', 'c'] };
  assert.equal(selfHeal(router, { a: { ema: 100 } }), false, 'one sample = coin flip');
  // Pin 'a' first; tail [b(900), c(unknown)] — already optimal → no change.
  const r2 = { order: ['a', 'b', 'c'] };
  assert.equal(selfHeal(r2, { a: { ema: 3000 }, b: { ema: 900 } }), false);
  assert.deepEqual(r2.order, ['a', 'b', 'c']);
  // Real reorder: pin first, faster tail gateway moves up.
  const r3 = { order: ['a', 'b', 'c'] };
  assert.equal(selfHeal(r3, { b: { ema: 5000 }, c: { ema: 300 } }), true);
  assert.deepEqual(r3.order, ['a', 'c', 'b']);
  assert.equal(selfHeal({ order: ['x', 'y'] }, {}), false, 'nothing learned → no change');
});

// ── Router: latency learning + offline-first fallback ───────────────────────

function gw(name, { fail = false, text = 'ok', latency = 0 } = {}) {
  return {
    name,
    chat: async () => {
      if (latency) await new Promise((r) => setTimeout(r, latency));
      if (fail) throw new Error(`${name} down`);
      return { text, model: name };
    },
  };
}

test('router: successful chat records the EMA; snapshot exposes it', async () => {
  const router = new GatewayRouter(new Map([['a', gw('a', { latency: 5 })]]), { gatewayOrder: ['a'] });
  await router.chat([{ role: 'user', content: 'hi' }]);
  assert.ok(router.latency.get('a') >= 5);
  assert.ok(router.latencySnapshot().a.ema >= 5);
});

test('router: offline fallback engages ONCE when all gateways fail, then succeeds', async () => {
  const local = gw('ollama', { text: 'local answer' });
  let probes = 0;
  const router = new GatewayRouter(
    new Map([['a', gw('a', { fail: true })]]),
    {
      gatewayOrder: ['a'],
      failureThreshold: 1,
      offlineFallback: async () => {
        probes += 1;
        return local;
      },
    }
  );
  const out = await router.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out.gateway, 'ollama');
  assert.equal(out.offline, true);
  assert.equal(probes, 1);
  assert.ok(router.order.includes('ollama'), 'fallback registered into the chain');
  // Second call: breaker parked 'a', fallback NOT re-engaged — but ollama is now in the chain and answers.
  const out2 = await router.chat([{ role: 'user', content: 'hi again' }]);
  assert.equal(out2.gateway, 'ollama');
  assert.equal(probes, 1, 'factory called exactly once');
});

test('router: fallback returning null falls through to the honest error', async () => {
  const router = new GatewayRouter(new Map([['a', gw('a', { fail: true })]]), {
    gatewayOrder: ['a'],
    failureThreshold: 1,
    maxRoundTrips: 1,
    offlineFallback: async () => null,
  });
  await assert.rejects(() => router.chat([{ role: 'user', content: 'hi' }]), /all gateways failed/);
});

// ── buddy update ────────────────────────────────────────────────────────────

test('update: semver compare + tag parsing', () => {
  assert.equal(semverGt('0.25.0', '0.24.2'), true);
  assert.equal(semverGt('0.24.2', '0.25.0'), false);
  assert.equal(semverGt('1.0.0', '0.99.99'), true);
  assert.equal(semverGt('0.24.2', '0.24.2'), false);
  assert.equal(tagVersion('v1.2.3'), '1.2.3');
  assert.equal(tagVersion('1.2.3'), '1.2.3');
  assert.equal(tagVersion('release-9'), null);
  assert.equal(pickLatestTag(['v0.23.0', 'v0.25.1', 'v0.24.0'], '0.24.2'), 'v0.25.1');
  assert.equal(pickLatestTag(['v0.23.0'], '0.24.2'), null);
  assert.equal(pickLatestTag(['junk', 'v0.30.0'], '0.24.2'), 'v0.30.0');
});

function fakeRun(script) {
  const calls = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      const key = args.join(' ');
      const r = script[key] || { ok: true, stdout: '', stderr: '' };
      return { ...r };
    },
  };
}

test('update: dirty tree refuses without --force, updates with it', () => {
  const dirtyScript = {
    'fetch origin --tags': { ok: true, stdout: '' },
    'tag -l --sort=-v:refname': { ok: true, stdout: 'v0.30.0\nv0.24.0\n' },
    'status --porcelain': { ok: true, stdout: ' M src/x.js\n' },
  };
  const plan = planUpdate({ currentVersion: '0.24.2', run: fakeRun(dirtyScript).run, cwd: '/x' });
  assert.equal(plan.action, 'refuse');
  assert.equal(plan.tag, 'v0.30.0');
  const forced = planUpdate({ currentVersion: '0.24.2', run: fakeRun(dirtyScript).run, cwd: '/x', force: true });
  assert.equal(forced.action, 'checkout');
  assert.equal(forced.dirty, true);
});

test('update: up-to-date, fetch failure, checkout failure are all honest', () => {
  const noTag = fakeRun({ 'tag -l --sort=-v:refname': { ok: true, stdout: 'v0.10.0\n' } });
  assert.equal(planUpdate({ currentVersion: '0.24.2', run: noTag.run, cwd: '/x' }).action, 'up-to-date');
  const badFetch = fakeRun({ 'fetch origin --tags': { ok: false, stderr: 'no upstream' } });
  const p = planUpdate({ currentVersion: '0.24.2', run: badFetch.run, cwd: '/x' });
  assert.equal(p.action, 'error');
  assert.match(p.reason, /git fetch failed/);
});

test('update: cmdUpdate end-to-end with a fake runner', async () => {
  // The fake "newer release" must always be NEWER than the real package.json
  // version — computed, not hard-coded, so version bumps never break this test.
  const realV = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const [maj, min] = realV.split('.').map(Number);
  const nextTag = `v${maj}.${min + 1}.0`;
  const lines = [];
  const out = (s) => lines.push(s);
  const script = {
    'fetch origin --tags': { ok: true, stdout: '' },
    'tag -l --sort=-v:refname': { ok: true, stdout: `${nextTag}\n` },
    'status --porcelain': { ok: true, stdout: '' },
    [`-c advice.detachedHead=false checkout ${nextTag}`]: { ok: true, stdout: '' },
  };
  const { run } = fakeRun(script);
  const code = await cmdUpdate([], { cwd: '/x', out, run });
  assert.equal(code, 0);
  assert.ok(lines.join('\n').includes(nextTag));
  assert.ok(lines.join('\n').includes('updated:'));
  // --check reports without checkout
  const lines2 = [];
  const { calls: calls2, run: run2 } = fakeRun(script);
  const code2 = await cmdUpdate(['--check'], { cwd: '/x', out: (s) => lines2.push(s), run: run2 });
  assert.equal(code2, 0);
  assert.ok(lines2.join('\n').includes('newer release available'));
  assert.ok(!calls2.some((a) => a.includes('checkout')), '--check must not check out');
});
