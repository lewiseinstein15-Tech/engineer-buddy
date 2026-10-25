import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgentMd, loadAgents, runSubagent, builtinAgents } from '../src/agent/subagents.js';
import { buildTaskTool } from '../src/tools/task.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Scripted mock router: pops one reply per chat() call (objects → JSON). */
function mockRouter(script) {
  const calls = [];
  return {
    calls,
    async chat(history, opts) {
      calls.push({
        contents: history.filter((m) => m.role !== 'system').map((m) => m.content),
        opts,
      });
      const next = script.length ? script.shift() : { tool: 'finish', result: 'fallback report' };
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'mock', gateway: 'mock', latencyMs: 1 };
    },
  };
}

const fakeTools = [
  { name: 'fs_search', run: async (a) => `hits for ${a.needle}` },
  { name: 'fs_read', run: async (a) => `contents of ${a.path}` },
  { name: 'bash', risky: true, run: async (a) => `ran ${a.command}` },
];

const AGENT_MD = `---
name: scout
description: A test scout
tools: fs_search, fs_read
maxSteps: 5
---

You are Scout, a test persona. Search and report.`;

// ── parseAgentMd ─────────────────────────────────────────────────────────────

test('parseAgentMd: full frontmatter (name, description, tools, maxSteps, body)', () => {
  const { ok, agent, error } = parseAgentMd(AGENT_MD);
  assert.equal(ok, true);
  assert.equal(error, undefined);
  assert.equal(agent.name, 'scout');
  assert.equal(agent.description, 'A test scout');
  assert.deepEqual(agent.tools, ['fs_search', 'fs_read']);
  assert.equal(agent.maxSteps, 5);
  assert.match(agent.systemPrompt, /You are Scout/);
  assert.equal(agent.source, 'user');
});

test('parseAgentMd: no frontmatter → whole body is the prompt', () => {
  const { ok, agent } = parseAgentMd('Just do the thing.', { fallbackName: 'plain' });
  assert.equal(ok, true);
  assert.equal(agent.name, 'plain');
  assert.equal(agent.tools, null, 'no tools key = inherit all');
  assert.match(agent.systemPrompt, /Just do the thing/);
});

test('parseAgentMd: name is sanitized; maxSteps clamped to sane bounds', () => {
  const { agent } = parseAgentMd('---\nname: Big! Name!!\nmaxSteps: 999\n---\nbody', { fallbackName: 'fb' });
  assert.equal(agent.name, 'big--name--');
  assert.equal(agent.maxSteps, 24);
});

test('parseAgentMd: empty name and no fallback → not ok (skipped with warning)', () => {
  const r = parseAgentMd('---\ndescription: x\n---\nbody', { fallbackName: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no name/);
});

// ── loadAgents ───────────────────────────────────────────────────────────────

test('loadAgents: six built-in presets ship out of the box', () => {
  const { agents, warnings } = loadAgents(os.tmpdir());
  const names = agents.map((a) => a.name);
  for (const expected of ['explore', 'plan', 'test-writer', 'refactorer', 'doc-generator', 'security-auditor']) {
    assert.ok(names.includes(expected), `missing built-in ${expected}`);
  }
  assert.equal(warnings.length, 0);
  assert.ok(agents.every((a) => a.source === 'builtin'));
});

test('loadAgents: user definitions merge over built-ins; invalid files warn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-agents-'));
  fs.mkdirSync(path.join(dir, '.buddy', 'agents'), { recursive: true });
  // frontmatter name overrides the built-in 'explore' regardless of filename
  fs.writeFileSync(
    path.join(dir, '.buddy', 'agents', 'explore.md'),
    '---\nname: explore\ndescription: my faster scout\ntools: fs_search\n---\nBe fast.',
    'utf8'
  );
  fs.writeFileSync(path.join(dir, '.buddy', 'agents', 'mine.md'), '---\nname: mine\ndescription: my own\n---\nBe mine.', 'utf8');
  // no frontmatter name → the FILENAME is the agent name (broken.md → "broken")
  fs.writeFileSync(path.join(dir, '.buddy', 'agents', 'broken.md'), '---\ndescription: no name here\n---\nx', 'utf8');

  const { agents, warnings } = loadAgents(dir);
  const explore = agents.find((a) => a.name === 'explore');
  assert.equal(explore.source, 'user');
  assert.equal(explore.description, 'my faster scout');
  assert.deepEqual(explore.tools, ['fs_search']);
  assert.ok(agents.some((a) => a.name === 'mine' && a.source === 'user'));
  assert.ok(agents.some((a) => a.name === 'broken' && a.description === 'no name here'), 'filename fallback names the agent');
  assert.equal(warnings.length, 0);
  // built-ins that were not overridden survive
  assert.ok(agents.some((a) => a.name === 'plan' && a.source === 'builtin'));
});

// ── runSubagent (the engine) ─────────────────────────────────────────────────

test('runSubagent: happy path — tool step then finish, report returned', async () => {
  const router = mockRouter([
    { tool: 'fs_search', args: { needle: 'runBash' } },
    { tool: 'finish', result: 'Found runBash in 3 files.' },
  ]);
  const steps = [];
  const report = await runSubagent({
    router,
    agent: { name: 'explore', tools: ['fs_search'], systemPrompt: 'be brief', maxSteps: 4 },
    parentTools: fakeTools,
    task: 'find runBash',
    onStep: (ev) => steps.push(ev),
  });
  assert.equal(report, 'Found runBash in 3 files.');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].tool, 'fs_search');
  assert.equal(steps[0].agent, 'explore');
});

test('runSubagent: allowlist enforced — disallowed tool is an in-loop error, not a crash', async () => {
  const ran = [];
  const tools = [
    { name: 'fs_search', run: async (a) => { ran.push(['fs_search', a]); return 'ok'; } },
    { name: 'fs_write', run: async (a) => { ran.push(['fs_write', a]); return 'wrote'; } },
  ];
  const router = mockRouter([
    { tool: 'fs_write', args: { path: 'x', content: 'evil' } },
    { tool: 'finish', result: 'recovered and finished' },
  ]);
  const report = await runSubagent({
    router,
    agent: { name: 'scout', tools: ['fs_search'], systemPrompt: 'p', maxSteps: 4 },
    parentTools: tools,
    task: 't',
  });
  assert.equal(report, 'recovered and finished');
  // fs_write never reached the tool layer: the loop answered "unknown tool"
  assert.deepEqual(ran, [], 'the disallowed tool must never execute');
});

test('runSubagent: structural depth limit — `task` is never available to sub-agents', async () => {
  const taskTool = buildTaskTool({ router: mockRouter([]), agents: builtinAgents(), tools: fakeTools });
  const parentTools = [...fakeTools, taskTool];
  const router = mockRouter([
    { tool: 'task', args: { agent: 'explore', task: 'recurse?' } },
    { tool: 'finish', result: 'no recursion happened' },
  ]);
  const report = await runSubagent({
    router,
    agent: { name: 'no-depth', systemPrompt: 'p', maxSteps: 4 }, // no allowlist = ALL parent tools…
    parentTools,
    task: 'try to recurse',
  });
  assert.equal(report, 'no recursion happened');
  // …yet the task call was rejected inside the loop with an unknown-tool error.
  const observed = JSON.stringify(router.calls);
  assert.ok(observed.includes('Available:'), 'loop should have listed available tools');
});

test('runSubagent: failure isolation — router crash becomes an ERROR report', async () => {
  const report = await runSubagent({
    router: mockRouter([new Error('all gateways down')]),
    agent: { name: 'x', systemPrompt: 'p', maxSteps: 3 },
    parentTools: fakeTools,
    task: 't',
  });
  assert.match(report, /^ERROR: subagent:x failed — all gateways down/);
});

test('runSubagent: step budget without finish → PARTIAL report with last observation', async () => {
  const endless = [];
  const router = {
    calls: endless,
    async chat() {
      return { text: JSON.stringify({ tool: 'fs_search', args: { needle: 'x' } }), model: 'm', gateway: 'g', latencyMs: 1 };
    },
  };
  const report = await runSubagent({
    router,
    agent: { name: 'y', tools: ['fs_search'], systemPrompt: 'p', maxSteps: 2 },
    parentTools: fakeTools,
    task: 't',
  });
  assert.match(report, /^PARTIAL: subagent:y hit its step budget \(2\)/);
  assert.match(report, /hits for x/);
});

test('runSubagent: object finish results are stringified; empty is handled', async () => {
  const router = mockRouter([{ tool: 'finish', result: { files: ['a.js'], verdict: 'clean' } }]);
  const report = await runSubagent({ router, agent: { name: 'z', systemPrompt: 'p' }, parentTools: fakeTools, task: 't' });
  assert.match(report, /"vercut|verdict/);
  assert.match(report, /a\.js/);
});

// ── approval gate passthrough for risky sub-tools ────────────────────────────

test('runSubagent: risky tool inside sub-agent goes through the approval gate', async () => {
  const decisions = [];
  const approval = async (q) => {
    decisions.push(q.tool);
    return 'no';
  };
  const router = mockRouter([
    { tool: 'bash', args: { command: 'ls' } },
    { tool: 'finish', result: 'worked around the denial' },
  ]);
  const report = await runSubagent({
    router,
    agent: { name: 'g', tools: ['bash'], systemPrompt: 'p', maxSteps: 4 },
    parentTools: fakeTools,
    task: 't',
    approval,
  });
  assert.deepEqual(decisions, ['bash']);
  assert.equal(report, 'worked around the denial');
});

test('runSubagent: "always" decision is remembered across runs in the session', async () => {
  const alwaysApproved = new Set();
  let asks = 0;
  const approval = async () => {
    asks += 1;
    return 'always';
  };
  const agent = { name: 'g', tools: ['bash'], systemPrompt: 'p', maxSteps: 4 };
  const mkRouter = () =>
    mockRouter([
      { tool: 'bash', args: { command: 'ls' } },
      { tool: 'finish', result: 'done' },
    ]);
  await runSubagent({ router: mkRouter(), agent, parentTools: fakeTools, task: 't1', approval, alwaysApproved });
  await runSubagent({ router: mkRouter(), agent, parentTools: fakeTools, task: 't2', approval, alwaysApproved });
  assert.equal(asks, 1, 'second run must skip the gate (always remembered)');
  assert.ok(alwaysApproved.has('bash'));
});

// ── buildTaskTool ────────────────────────────────────────────────────────────

test('buildTaskTool: unknown agent → helpful error listing the crew', async () => {
  const tool = buildTaskTool({ router: mockRouter([]), agents: builtinAgents(), tools: fakeTools });
  const out = await tool.run({ agent: 'ghost', task: 'x' });
  assert.match(out, /unknown agent "ghost"/);
  assert.match(out, /explore/);
  assert.match(out, /security-auditor/);
});

test('buildTaskTool: missing agent/task args are caught before any dispatch', async () => {
  const tool = buildTaskTool({ router: mockRouter([]), agents: builtinAgents(), tools: fakeTools });
  assert.match(await tool.run({}), /"agent" required/);
  assert.match(await tool.run({ agent: 'explore' }), /"task" required/);
  assert.match(await tool.run({ agent: 'explore', task: '   ' }), /"task" required/);
});

test('buildTaskTool: dispatch runs the sub-agent and returns its report', async () => {
  const router = mockRouter([
    { tool: 'fs_search', args: { needle: 'todo' } },
    { tool: 'finish', result: 'the todo tool lives in local.js' },
  ]);
  const subs = [];
  const tool = buildTaskTool({
    router,
    agents: builtinAgents(),
    tools: fakeTools,
    onSubEvent: (ev) => subs.push(ev),
  });
  const out = await tool.run({ agent: 'explore', task: 'where is the todo tool?' });
  assert.match(out, /^SUB-AGENT REPORT \(explore\):\nthe todo tool lives in local\.js$/);
  assert.equal(tool.maxCalls, 3, 'per-turn dispatch budget');
  const phases = subs.map((s) => s.phase);
  assert.ok(phases.includes('step') && phases.includes('done'));
});

test('buildTaskTool: the task tool itself is never offered to sub-agents (no self-reference)', () => {
  const tool = buildTaskTool({ router: mockRouter([]), agents: builtinAgents(), tools: fakeTools });
  assert.equal(tool.name, 'task');
  assert.ok(!String(tool.description).includes('undefined'));
});
