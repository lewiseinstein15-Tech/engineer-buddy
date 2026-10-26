// autocompact.test.js — P1: the loop compacts PROACTIVELY at ~80% of the char
// budget instead of waiting for the 100% wall (the turn that hits the wall
// pays for the full window before shrinking). Locks down:
//   1. fires at >80% but below 100% (auto:true event)
//   2. stays silent below the threshold
//   3. the anti-churn guard: a soft over-80% state with <6 fresh messages
//      does NOT re-compact, but the hard wall (>100%) still bypasses it —
//      the v0.9.4 "seven compactions in one turn" lesson, kept safe
//   4. /compact (force) still works under the threshold (auto:false)
//   5. /context carries autoAt and the bar renders the hint
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat, AUTO_COMPACT_AT } from '../src/agent/chat.js';
import { renderContextBar } from '../src/terminal/ui.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ac-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

function fakeRouter(script, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(done)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

const SAY = '{"tool":"say","message":"ok"}';

test('autocompact: fires at >80% of budget, below the wall (auto event)', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  // budget 10000 → soft threshold 8000. 5 pre-filled messages of 1600 = 8000
  // chars; the new user message pushes history past 8000 with only 6 messages.
  const chat = createChat({
    router: fakeRouter(['SUMMARY OF THE EARLIER SETUP', SAY]),
    tools,
    harness,
    charBudget: 10000,
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 5; i++) chat.messages.push({ role: 'user', content: `m${i}: ${'x'.repeat(1597)}` });
  assert.ok(chat.historyChars() > 10000 * AUTO_COMPACT_AT, 'history sits past the soft line');
  assert.ok(chat.historyChars() <= 10000, '…but still UNDER the hard wall');
  const out = await chat.turn('next step please');
  assert.equal(out.said, 'ok');
  const comp = events.find((e) => e.type === 'compaction');
  assert.ok(comp, 'compaction fired');
  assert.equal(comp.auto, true, 'marked as AUTO (proactive, not the wall)');
  assert.equal(chat.compactCount, 1);
  assert.ok(chat.historyChars() < 8000, 'history shrank back under the soft line');
  assert.match(chat.messages[0].content, /SUMMARY OF THE EARLIER SETUP/);
});

test('autocompact: silent below the threshold', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const chat = createChat({
    router: fakeRouter([SAY]),
    tools,
    harness,
    charBudget: 48000,
    onEvent: (e) => events.push(e),
  });
  await chat.turn('tiny task');
  assert.equal(chat.compactCount, 0);
  assert.ok(!events.some((e) => e.type === 'compaction'));
});

test('autocompact: anti-churn guard holds at 80%+, hard wall still bypasses it', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  // Turn A compacts (6 messages, ~9500 chars, budget 10000). Then a soft
  // over-80% state with <6 fresh messages must NOT re-compact; pushing past
  // 100% must.
  const chat = createChat({
    router: fakeRouter(['FIRST SUMMARY', SAY, SAY, SAY, 'SECOND SUMMARY', SAY]),
    tools,
    harness,
    charBudget: 10000,
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 5; i++) chat.messages.push({ role: 'user', content: `m${i}: ${'x'.repeat(1893)}` });
  await chat.turn('turn a'); // → auto-compaction #1
  assert.equal(chat.compactCount, 1);
  const lenAfterFirst = chat.messages.length;

  // Turn B: one more turn (say only) — under the soft line, no compaction.
  await chat.turn('turn b');
  assert.equal(chat.compactCount, 1);

  // Soft over-80% with few fresh messages: blocked by the anti-churn guard.
  chat.messages.push({ role: 'user', content: `huge: ${'y'.repeat(2400)}` });
  await chat.turn('turn c');
  assert.equal(chat.compactCount, 1, 'guard blocks a re-compact with <6 fresh messages');
  assert.ok(chat.historyChars() > 10000 * AUTO_COMPACT_AT, 'still past the soft line');

  // Cross the hard wall → the guard is bypassed.
  chat.messages.push({ role: 'user', content: `huge2: ${'z'.repeat(2600)}` });
  await chat.turn('turn d');
  assert.equal(chat.compactCount, 2, 'hard wall (>100%) forces relief');
  const comp2 = events.filter((e) => e.type === 'compaction').at(-1);
  assert.equal(comp2.auto, true);
  assert.ok(chat.messages.length < lenAfterFirst + 8, 'history actually shrank');
});

test('autocompact: /compact still forces a summary under the threshold (auto:false)', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const chat = createChat({
    router: fakeRouter(['FORCED SUMMARY']),
    tools,
    harness,
    charBudget: 48000,
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 6; i++) chat.messages.push({ role: 'user', content: `m${i}: ${'x'.repeat(200)}` });
  const r = await chat.compactNow();
  assert.equal(r.compacted, true);
  assert.equal(chat.compactCount, 1);
  const comp = events.find((e) => e.type === 'compaction');
  assert.equal(comp.auto, false, 'manual /compact is not an auto compaction');
  assert.match(chat.messages[0].content, /FORCED SUMMARY/);
});

test('autocompact: /context carries autoAt and the bar shows the hint', () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const chat = createChat({
    router: { order: ['fake'], chat: async () => ({ text: SAY, model: 'fake', gateway: 'fake', latencyMs: 1 }) },
    tools,
    harness,
    charBudget: 48000,
  });
  chat.messages.push({ role: 'user', content: 'hello' });
  const b = chat.contextBreakdown();
  assert.equal(b.autoAt, Math.round(48000 * AUTO_COMPACT_AT));
  const out = renderContextBar(b);
  assert.match(out, /auto-compact at ~38\.4k chars \(80% of budget\)/);
  // …and stays absent when autoAt is not provided (old callers).
  const plain = renderContextBar({ parts: { systemprompt: 100 }, system: 100, conversation: 10, budget: 48000, turns: 1, planMode: false });
  assert.doesNotMatch(plain, /auto-compact/);
});
