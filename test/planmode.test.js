// Tests for plan mode: PLAN_TOOLS allowlist, plan persistence, the exit_plan
// tool, chat-loop enforcement (system prompt + hard wall), and shift+tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAN_TOOLS,
  PLANS_DIR,
  planModePrompt,
  slugify,
  savePlan,
  listPlans,
  buildExitPlanTool,
} from '../src/tools/planmode.js';
import { createChat, buildSystemPrompt } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { applyKey } from '../src/terminal/inputbox.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-plan-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

/** Base tools + exit_plan registered — exactly how an interactive session builds them. */
function makePlanBuddy(root, modes, extra = []) {
  const { tools, harness } = makeBuddy(root);
  return { tools: [...tools, buildExitPlanTool({ modes, root }), ...extra], harness };
}

function fakeRouter(script) {
  const calls = [];
  return {
    order: ['fake'],
    calls,
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

// ── Allowlist & prompt ───────────────────────────────────────────────────────

test('PLAN_TOOLS: research tools only — no writes, no bash, no task, no shells', () => {
  for (const t of ['fs_read', 'fs_search', 'fs_list', 'todo', 'web_search', 'web_fetch', 'skill', 'exit_plan']) {
    assert.ok(PLAN_TOOLS.has(t), `missing ${t}`);
  }
  for (const blocked of ['fs_write', 'fs_replace', 'fs_append', 'bash', 'task', 'bash_bg', 'bash_output', 'kill_shell', 'say']) {
    assert.ok(!PLAN_TOOLS.has(blocked), `must NOT contain ${blocked}`);
  }
});

test('planModePrompt: read-only contract + exit_plan door', () => {
  const p = planModePrompt();
  assert.match(p, /READ-ONLY/);
  assert.match(p, /exit_plan/);
  assert.match(p, /fs_write/); // names what is blocked
  assert.match(p, /Never claim a change is made/);
});

// ── Persistence ──────────────────────────────────────────────────────────────

test('slugify: lowercase, dashes, safe length', () => {
  assert.equal(slugify('Add a Plan Mode! (v2)'), 'add-a-plan-mode-v2');
  assert.equal(slugify('  --weird___name--  '), 'weird-name');
  assert.equal(slugify('x'.repeat(100)).length, 40);
  assert.equal(slugify(''), 'plan');
  assert.equal(slugify('!!!'), 'plan');
});

test('savePlan + listPlans: writes under .buddy/plans, newest first', () => {
  const root = tmpRoot();
  const p1 = savePlan(root, { task: 'add plan mode', plan: '## Steps\n1. research\n2. implement' });
  const p2 = savePlan(root, { task: 'second plan', plan: '## Steps\n1. other' });
  assert.ok(p1.includes(PLANS_DIR));
  assert.ok(path.basename(p1).endsWith('add-plan-mode.md'));
  const body = fs.readFileSync(p1, 'utf8');
  assert.match(body, /# Plan — add plan mode/);
  assert.match(body, /1\. research/);
  const list = listPlans(root);
  assert.equal(list.length, 2);
  assert.equal(path.basename(list[0].file), path.basename(p2)); // newest first
  fs.rmSync(root, { recursive: true, force: true });
});

test('listPlans: empty/missing dir returns [] without throwing', () => {
  assert.deepEqual(listPlans(tmpRoot()), []);
  assert.deepEqual(listPlans('/nonexistent-root-xyz'), []);
});

// ── exit_plan tool ───────────────────────────────────────────────────────────

test('exit_plan: renders summary and previews the plan body', () => {
  const tool = buildExitPlanTool({ modes: { plan: true }, root: tmpRoot() });
  assert.equal(tool.name, 'exit_plan');
  assert.equal(tool.risky, true);
  assert.match(tool.render({ summary: 'split the loop' }), /exit_plan split the loop/);
  const preview = tool.preview({ plan: 'line1\nline2' });
  assert.match(preview, /line1\nline2/);
  // long plans truncate with a marker
  const long = tool.preview({ plan: Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n') });
  assert.match(long, /\(\d+ more lines\)/);
});

test('exit_plan: requires plan text and an active plan mode', async () => {
  const tool = buildExitPlanTool({ modes: { plan: false }, root: tmpRoot() });
  assert.match(await tool.run({ summary: 'x' }), /ERROR: plan required/);
  assert.match(await tool.run({ plan: 'do things' }), /ERROR: plan mode is not active/);
  const nullModes = buildExitPlanTool({ modes: null, root: tmpRoot() });
  assert.match(await nullModes.run({ plan: 'do things' }), /ERROR: plan mode is not active/);
});

test('exit_plan: approval flips modes.plan OFF, saves the plan, fires onApproved', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const seen = [];
  const tool = buildExitPlanTool({ modes, root, onApproved: (info) => seen.push(info) });
  const out = await tool.run({ summary: 'split the ReAct loop', plan: '## Plan\n1. do it' });
  assert.match(out, /PLAN APPROVED/);
  assert.match(out, /plan mode is now OFF/);
  assert.equal(modes.plan, false);
  assert.equal(seen.length, 1);
  assert.ok(fs.existsSync(seen[0].saved));
  const body = fs.readFileSync(seen[0].saved, 'utf8');
  assert.match(body, /1\. do it/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Chat integration ─────────────────────────────────────────────────────────

test('system prompt: plan mode swaps tool list and injects the section', () => {
  const { tools, harness } = makePlanBuddy(tmpRoot(), { plan: true }); // exit_plan registered like a live session
  const planOn = buildSystemPrompt({ harness, tools, planMode: true });
  const planOff = buildSystemPrompt({ harness, tools, planMode: false });
  assert.match(planOn, /## Plan mode \(READ-ONLY\)/);
  assert.ok(!planOn.includes('- fs_write:')); // write tool hidden in plan mode
  assert.ok(planOn.includes('- exit_plan:')); // door visible
  assert.ok(!planOff.includes('exit_plan')); // hidden outside plan mode
  assert.ok(!planOff.includes('## Plan mode'));
  assert.ok(planOff.includes('- fs_write:'));
});

test('plan mode: fs_write is refused by the hard wall, tool never runs', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({
    router: fakeRouter(['{"tool":"fs_write","args":{"path":"evil.txt","content":"nope"}}']),
    tools,
    harness,
    modes: { plan: true },
  });
  await chat.turn('write something');
  assert.ok(!fs.existsSync(path.join(root, 'evil.txt')), 'file must not be created');
  const ev = chat.messages.find((m) => m.content.startsWith('TOOL OBSERVATION'));
  assert.match(ev.content, /plan mode is active/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan mode: exit_plan approval mid-turn unlocks edits in the SAME turn', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const { tools, harness } = makePlanBuddy(root, modes);
  const approvals = [];
  const router = fakeRouter([
    '{"tool":"exit_plan","args":{"summary":"write file","plan":"## Plan\\n1. write evil.txt"}}',
    '{"tool":"fs_write","args":{"path":"planned.txt","content":"done"}}',
    '{"tool":"say","message":"plan executed"}',
  ]);
  const chat = createChat({
    router,
    tools,
    harness,
    modes,
    approval: async ({ tool }) => {
      approvals.push(tool);
      return 'yes';
    },
  });
  const out = await chat.turn('plan then implement');
  assert.equal(out.said, 'plan executed');
  // exit_plan gates the plan; fs_write (still risky) gates the edit after unlock
  assert.deepEqual(approvals, ['exit_plan', 'fs_write']);
  assert.equal(modes.plan, false, 'plan mode must be off after approval');
  assert.equal(fs.readFileSync(path.join(root, 'planned.txt'), 'utf8'), 'done');
  // the plan is saved for /plans
  assert.equal(listPlans(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan mode: denied exit_plan keeps plan mode ON and edits stay blocked', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const { tools, harness } = makePlanBuddy(root, modes);
  const router = fakeRouter([
    '{"tool":"exit_plan","args":{"summary":"write file","plan":"1. write"}}',
    '{"tool":"fs_write","args":{"path":"nope.txt","content":"x"}}',
    '{"tool":"say","message":"refined instead"}',
  ]);
  const chat = createChat({
    router,
    tools,
    harness,
    modes,
    approval: async () => 'no',
  });
  const out = await chat.turn('try to sneak it through');
  assert.equal(out.said, 'refined instead');
  assert.equal(modes.plan, true, 'denial must keep plan mode ON');
  assert.ok(!fs.existsSync(path.join(root, 'nope.txt')));
  const deny = chat.messages.find((m) => m.content.includes('DENIED by the user'));
  assert.ok(deny, 'denial observation must reach the model');
  fs.rmSync(root, { recursive: true, force: true });
});

test('plan mode: bash and a registered task tool are blocked too', async () => {
  const root = tmpRoot();
  const modes = { plan: true };
  const taskStub = {
    name: 'task',
    description: 'sub-agent dispatch',
    args: '{"agent":"explore","prompt":"x"}',
    run: async () => {
      throw new Error('task tool MUST never run in plan mode');
    },
  };
  const { tools, harness } = makePlanBuddy(root, modes, [taskStub]);
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"bash","args":{"command":"touch sneaky.txt"}}',
      '{"tool":"task","args":{"agent":"explore","prompt":"snoop"}}',
    ]),
    tools,
    harness,
    modes,
  });
  await chat.turn('run around the gate');
  const observations = chat.messages.filter((m) => m.content.startsWith('TOOL OBSERVATION'));
  assert.match(observations[0].content, /plan mode is active/);
  assert.match(observations[1].content, /plan mode is active/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── shift+tab mode cycle key ─────────────────────────────────────────────────

test('applyKey: shift+tab is mode-cycle, plain tab still completes', () => {
  assert.deepEqual(applyKey({ name: 'tab', shift: true, sequence: '\x1b[Z' }), { action: 'mode-cycle' });
  assert.deepEqual(applyKey({ name: 'tab', shift: false }), { action: 'complete' });
  assert.deepEqual(applyKey({ name: 'tab' }), { action: 'complete' });
});
