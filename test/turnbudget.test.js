// The turn budget — the ladder, the override, the off switch (v0.64.1).
// The live commit task died TWICE at 14 steps with "I paused mid-task" while
// still writing the first commit message: test → commit → docs → push → CI →
// tag is 20-40 honest steps, not 14. Three disciplines:
//   - the effort presets are RAISED: low 8→12, medium 14→30, high 24→48;
//   - chat.maxSteps in .buddy/settings.json overrides the ladder when
//     declared (resolveTurnBudget: absent → preset, 0/'off' → Infinity,
//     2..1000 → that, junk → NAMED + the preset holds);
//   - the library default (createChat without effort) stays 14 — pinned, so
//     the budget-end message keeps teaching the escape hatch by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { resolveTurnBudget } from '../src/settings.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-budget-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

function fakeRouter(script) {
  return {
    chat: async () => {
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

test('resolveTurnBudget: absent legs land on null (the effort preset stands), silently', () => {
  for (const v of [undefined, null, '']) {
    const r = resolveTurnBudget(v);
    assert.equal(r.budget, null, `leg ${JSON.stringify(v)} → preset stands`);
    assert.equal(r.note, null, `leg ${JSON.stringify(v)} → no note`);
  }
});

test('resolveTurnBudget: 0/off legs REMOVE the budget (Infinity)', () => {
  for (const v of [false, 0, '0', 'off', 'false']) {
    const r = resolveTurnBudget(v);
    assert.equal(r.budget, Infinity, `leg ${JSON.stringify(v)} → budget removed`);
    assert.equal(r.note, null, `leg ${JSON.stringify(v)} → a deliberate off switch is silent`);
  }
});

test('resolveTurnBudget: a positive integer (2..1000, number or string) arms the budget', () => {
  for (const [v, want] of [[40, 40], ['40', 40], [' 40 ', 40], [2, 2], [1000, 1000]]) {
    const r = resolveTurnBudget(v);
    assert.equal(r.budget, want, `leg ${JSON.stringify(v)} → ${want}`);
    assert.equal(r.note, null);
  }
});

test('resolveTurnBudget: junk is NAMED and the preset holds', () => {
  for (const v of [true, 'abc', '7.5', 1, -1, 7.5, 1e21, 1001, {}, NaN]) {
    const r = resolveTurnBudget(v);
    assert.equal(r.budget, null, `junk ${JSON.stringify(v) || String(v)} can never arm a budget`);
    assert.match(r.note, /chat\.maxSteps: .+the effort preset holds/, `junk ${JSON.stringify(v) || String(v)} is named`);
  }
});

test('a raised preset gives a long task room — 40 honest steps then a finish', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const script = [...Array(39).fill('{"tool":"fs_list","args":{}}'), '{"tool":"say","message":"finally done"}'];
  const chat = createChat({ router: fakeRouter(script), tools, harness, effort: { level: 'medium', maxSteps: 30, maxTokens: 1500 }, onEvent: (e) => events.push(e) });
  chat.effort.maxSteps = 40; // what chat.maxSteps: 40 produces through the ref
  const out = await chat.turn('the long commit task');
  assert.equal(out.said, 'finally done', 'the turn finishes instead of pausing');
  assert.equal(out.steps, 40, 'the say landed exactly on the last budgeted step');
  assert.ok(!events.some((e) => e.type === 'error' && /Turn budget reached/.test(e.text)), 'no budget event fired');
  fs.rmSync(root, { recursive: true, force: true });
});

test('budget REMOVED (Infinity): 30 steps and still no budget event', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const script = [...Array(30).fill('{"tool":"fs_list","args":{}}'), '{"tool":"say","message":"unbounded but finished"}'];
  const chat = createChat({ router: fakeRouter(script), tools, harness, effort: { level: 'medium', maxSteps: Infinity, maxTokens: 1500 }, onEvent: (e) => events.push(e) });
  const out = await chat.turn('no budget declared');
  assert.equal(out.said, 'unbounded but finished');
  assert.ok(!events.some((e) => e.type === 'error' && /Turn budget reached/.test(e.text)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the library default stays 14 — and the message teaches the chat.maxSteps hatch', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const script = [...Array(15).fill('{"tool":"fs_list","args":{}}')];
  const chat = createChat({ router: fakeRouter(script), tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('default ladder');
  assert.equal(out.steps, 14);
  assert.equal(out.said, null);
  const last = events.at(-1);
  assert.match(last.text, /Turn budget reached \(14 steps\)/);
  assert.match(last.text, /chat\.maxSteps in \.buddy\/settings\.json/, 'the escape hatch is named');
  fs.rmSync(root, { recursive: true, force: true });
});
