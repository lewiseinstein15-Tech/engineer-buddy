// context.test.js — /context: the token budget breakdown (P1: "do big things
// with a small context window" starts with SEEING the window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { renderContextBar } from '../src/terminal/ui.js';
import { SLASH_COMMANDS } from '../src/terminal/repl.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ctx-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

test('context: breakdown sums exactly to the real system prompt + conversation', () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({
    router: { order: ['fake'], chat: async () => ({ text: '{"tool":"say","message":"x"}', model: 'fake', gateway: 'fake', latencyMs: 1 }) },
    tools,
    harness,
    charBudget: 48000,
  });
  chat.messages.push({ role: 'user', content: 'hello world' });
  const b = chat.contextBreakdown();
  const sum = Object.values(b.parts).reduce((a, n) => a + n, 0);
  assert.equal(sum, b.system, 'the sections account for every character of the system prompt');
  assert.ok(b.system > 1000, 'system prompt has real weight');
  assert.equal(b.conversation, chat.historyChars());
  assert.equal(b.budget, 48000);
  assert.equal(b.turns, 1);
  assert.equal(b.planMode, false);
});

test('context: plan mode changes the tools section (exit_plan swaps in)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const modes = { plan: false };
  const chat = createChat({
    router: { order: ['fake'], chat: async () => ({ text: '{"tool":"say","message":"x"}', model: 'fake', gateway: 'fake', latencyMs: 1 }) },
    tools,
    harness,
    modes,
  });
  const normal = chat.contextBreakdown();
  modes.plan = true;
  const planned = chat.contextBreakdown();
  assert.equal(planned.planMode, true);
  assert.ok(planned.parts.toolsAndProtocol !== normal.parts.toolsAndProtocol, 'the tool list really swaps');
});

test('context: the bar renders sections, percentages and a busy bar', () => {
  const out = renderContextBar({
    parts: { systemprompt: 4000, memory: 1200, toolGuidance: 1500, guardrails: 900, skillsBlock: 0, toolsAndProtocol: 600 },
    system: 8200,
    conversation: 12000,
    budget: 48000,
    turns: 7,
    planMode: false,
  });
  assert.match(out, /Context/);
  assert.match(out, /7 messages/);
  assert.match(out, /12\.0k \/ 48\.0k chars/);
  assert.match(out, /25%/);
  assert.match(out, /systemprompt/);
  assert.match(out, /memory/);
  assert.doesNotMatch(out, /skillsBlock/, 'zero sections are hidden');
  assert.match(out, /8\.2k chars/);
  // over-budget turns red logic exists (bar char present either way)
  assert.match(out, /[█░]/);
});

test('context: /context is registered in the palette', () => {
  assert.ok(SLASH_COMMANDS.includes('context'));
});
