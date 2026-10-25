// Tests for the v0.9.4 live-test hardening:
//   1. tryRepairJson — recover sloppy JSON (literal newlines/tabs in strings)
//   2. layer-1 repair runs in ALL modes before salvage/repair-retry
//   3. salvage guard — a '{'-starting broken reply is never salvaged as a plan
//   4. research-repeat guard — identical fs_search repeats get a nudge
//   5. cap error in plan mode points at exit_plan
//   6. compaction summaries carry the anti-imitation guard line
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryRepairJson } from '../src/util.js';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { buildExitPlanTool, listPlans } from '../src/tools/planmode.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hard-'));
}

function makeBuddy(root, modes) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools: modes ? [...tools, buildExitPlanTool({ modes, root })] : tools, harness };
}

function fakeRouter(script) {
  const calls = [];
  return {
    calls,
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

// kilo's v0.9.3 live failure: a say-JSON whose message value contains REAL
// newlines (markdown headers) — invalid JSON, unparseable by extractJson.
const SLOPPY_SAY =
  '{"tool":"say","message":"**Engineering Conversation Summary** (≤220 words)\n\n**Active Plan Mode**: read-only enforced.\n\n**Open Questions**: None identified."}';
const SLOPPY_MESSAGE = '**Engineering Conversation Summary** (≤220 words)\n\n**Active Plan Mode**: read-only enforced.\n\n**Open Questions**: None identified.';

// ── tryRepairJson ────────────────────────────────────────────────────────────

test('tryRepairJson: valid JSON passes through unchanged', () => {
  assert.deepEqual(tryRepairJson('{"tool":"say","message":"hi"}'), { tool: 'say', message: 'hi' });
});

test('tryRepairJson: escapes literal newlines/tabs inside string values', () => {
  assert.deepEqual(tryRepairJson(SLOPPY_SAY), { tool: 'say', message: SLOPPY_MESSAGE });
});

test('tryRepairJson: keeps existing escapes intact', () => {
  const ok = '{"tool":"say","message":"line1\\nline2"}';
  assert.deepEqual(tryRepairJson(ok), { tool: 'say', message: 'line1\nline2' });
});

test('tryRepairJson: returns null on prose without braces and on hopeless braces', () => {
  assert.equal(tryRepairJson('no json here at all'), null);
  assert.equal(tryRepairJson('{"tool":"say" "message":"unfixable comma soup'), null);
  assert.equal(tryRepairJson(''), null);
});

// ── Layer-1 recovery in the chat loop ────────────────────────────────────────

test('normal mode: sloppy say-JSON is recovered as a say (kilo v0.9.3 case)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({ router: fakeRouter([SLOPPY_SAY]), tools, harness });
  const out = await chat.turn('summarize');
  assert.equal(out.said, SLOPPY_MESSAGE);
  assert.equal(out.error, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan mode: a { starting broken reply is NOT salvaged into the gate', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const { tools, harness } = makeBuddy(root, modes);
  const approvals = [];
  const chat = createChat({
    router: fakeRouter([SLOPPY_SAY]),
    tools,
    harness,
    modes,
    approval: async (p) => {
      approvals.push(p);
      return 'yes';
    },
  });
  const out = await chat.turn('find a bug');
  // layer 1 recovers the intended say — no junk plan, no gate, mode stays ON
  assert.equal(out.said, SLOPPY_MESSAGE);
  assert.deepEqual(approvals, [], 'garbage must never become an approved plan');
  assert.equal(modes.plan, true);
  assert.equal(listPlans(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repair retry also gets the sloppy-JSON recovery', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({ router: fakeRouter(['not json, just prose', SLOPPY_SAY]), tools, harness });
  const out = await chat.turn('hello');
  assert.equal(out.said, SLOPPY_MESSAGE);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Research-repeat guard ────────────────────────────────────────────────────

test('identical fs_search repeats get a nudge; changed args do not', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const router = fakeRouter([
    '{"tool":"fs_search","args":{"needle":"alpha"}}',
    '{"tool":"fs_search","args":{"needle":"alpha"}}',
    '{"tool":"fs_search","args":{"needle":"beta"}}',
    '{"tool":"say","message":"done"}',
  ]);
  const chat = createChat({ router, tools, harness });
  await chat.turn('search around');
  const obs = chat.messages.filter((m) => m.content.startsWith('TOOL OBSERVATION')).map((m) => m.content);
  assert.equal(obs.length, 3);
  assert.ok(!obs[0].includes('identical repeat'), 'first call is clean');
  assert.match(obs[1], /NOTE: identical repeat of fs_search/);
  assert.ok(!obs[2].includes('identical repeat'), 'changed args are clean');
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan mode: burning the fs_search cap points at exit_plan', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const { tools, harness } = makeBuddy(root, modes);
  const same = '{"tool":"fs_search","args":{"needle":"todo"}}';
  const router = fakeRouter([same, same, same, same, same, same, same]);
  const chat = createChat({ router, tools, harness, modes });
  await chat.turn('research');
  const obs = chat.messages.filter((m) => m.content.startsWith('TOOL OBSERVATION')).map((m) => m.content);
  assert.equal(obs.length, 7, 'six searches run, the 7th hits the cap');
  assert.match(obs[6], /already used 6\/6/);
  assert.match(obs[6], /call exit_plan with the plan you have/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Compaction anti-imitation guard ──────────────────────────────────────────

test('compaction summary message tells the model not to imitate it', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const read = '{"tool":"fs_read","args":{"path":"README.md"}}';
  const router = fakeRouter([read, read, read, read, read, read]);
  const chat = createChat({ router, tools, harness, charBudget: 50, maxStepsPerTurn: 5 });
  await chat.turn('research a lot');
  const summary = chat.messages.find((m) => m.content.includes('[Earlier conversation, summarized'));
  assert.ok(summary, 'compaction must have run at a 50-char budget');
  assert.match(summary.content, /Do not repeat it, do not imitate its format/);
  fs.rmSync(root, { recursive: true, force: true });
});
