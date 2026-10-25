// todov2.test.js — todo v2: dependency-aware plans (DAG).
//
// The v0.9.6 live test validated the design in the wild: kilo asked for
// ids + blocked_by the moment plan mode let it implement. These tests pin
// the contract: ids, blocked_by validation, blocked-transition refusal,
// READY NOW auto-promotion, items:[] clear, notes, back-compat with the
// v1 shape, and the plan surviving compaction (todo anchor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat, buildSystemPrompt } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { renderTodo } from '../src/terminal/ui.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const todoState = { latest: null };
  const tools = buildLocalTools({ scope, todoState });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness, todoState };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-todov2-'));
}

function fakeRouter(script) {
  return {
    order: ['fake'],
    chat: async () => {
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

test('todo v2: ids are auto-assigned and statuses normalize (v1 shape still works)', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({ items: [{ text: 'first', status: 'in_progress' }, { text: 'second' }] });
  assert.match(out, /PLAN \(0\/2 done\)/);
  assert.match(out, /#1 first/);
  assert.match(out, /#2 second/);
  assert.equal(todoState.latest[0].id, '1');
  assert.equal(todoState.latest[1].status, 'pending');
});

test('todo v2: blocked_by string normalizes to an array', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({ items: [{ id: 'a', text: 'research' }, { id: 'b', text: 'fix', blocked_by: 'a' }] });
  assert.match(out, /\(after #a\)/);
  assert.deepEqual(todoState.latest[1].blocked_by, ['a']);
});

test('todo v2: unknown blocker id is refused with the valid ids listed', async () => {
  const { tools } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({ items: [{ id: '1', text: 'one' }, { id: '2', text: 'two', blocked_by: ['9'] }] });
  assert.match(out, /ERROR: item "2" blocked_by unknown id "9"/);
  assert.match(out, /valid ids: 1, 2/);
});

test('todo v2: duplicate ids and self-blocks are refused', async () => {
  const { tools } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const dup = await todo.run({ items: [{ id: '1', text: 'a' }, { id: '1', text: 'b' }] });
  assert.match(dup, /ERROR: duplicate item id "1"/);
  const self = await todo.run({ items: [{ id: '1', text: 'a', blocked_by: ['1'] }] });
  assert.match(self, /ERROR: item "1" cannot block itself/);
});

test('todo v2: a blocked item cannot start while its blocker is open', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({
    items: [
      { id: '1', text: 'write failing test', status: 'in_progress' },
      { id: '2', text: 'patch the bug', status: 'done', blocked_by: ['1'] },
    ],
  });
  assert.match(out, /ERROR: blocked_by violated/);
  assert.match(out, /"2" \(done\) is blocked by "1" \(in_progress\)/);
  assert.equal(todoState.latest, null, 'a broken plan is never stored');
});

test('todo v2: same DAG in a legal state is accepted and shows READY NOW', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({
    items: [
      { id: '1', text: 'write failing test', status: 'done' },
      { id: '2', text: 'patch the bug', status: 'in_progress', blocked_by: ['1'] },
      { id: '3', text: 'run the suite', status: 'pending', blocked_by: ['2'] },
    ],
  });
  assert.match(out, /PLAN \(1\/3 done\)/);
  assert.match(out, /\[x\] #1/);
  assert.match(out, /\[~\] #2 patch the bug \(after #1\)/);
  assert.doesNotMatch(out, /READY NOW/, 'nothing new is unblocked while #2 is open');
  // finish #2 → #3 becomes ready
  const out2 = await todo.run({
    items: [
      { id: '1', text: 'write failing test', status: 'done' },
      { id: '2', text: 'patch the bug', status: 'done', blocked_by: ['1'] },
      { id: '3', text: 'run the suite', status: 'pending', blocked_by: ['2'] },
    ],
  });
  assert.match(out2, /READY NOW: #3/);
  assert.equal(todoState.latest[2].status, 'pending');
});

test('todo v2: notes ride along and stay capped', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  const out = await todo.run({ items: [{ id: '1', text: 'refactor', notes: 'keep it boring' }] });
  assert.match(out, /- \[ \] #1 refactor - keep it boring/);
  assert.equal(todoState.latest[0].notes, 'keep it boring');
});

test('todo v2: an empty items array clears the plan', async () => {
  const { tools, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  await todo.run({ items: [{ text: 'temp' }] });
  assert.equal(todoState.latest.length, 1);
  const out = await todo.run({ items: [] });
  assert.match(out, /PLAN cleared/);
  assert.equal(todoState.latest, null);
});

test('todo v2: non-array items are refused without crashing', async () => {
  const { tools } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  assert.match(await todo.run({ items: 'nope' }), /ERROR: items must be an array/);
  assert.match(await todo.run({}), /ERROR: items must be an array/);
});

test('todo v2: chat loop stores ids and blocked_by into todoState', async () => {
  const { tools, harness, todoState } = makeBuddy(tmpRoot());
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"todo","args":{"items":[{"id":"1","text":"read"},{"id":"2","text":"fix","blocked_by":["1"]}]}}',
      '{"tool":"say","message":"planned"}',
    ]),
    tools,
    harness,
    todoState,
  });
  await chat.turn('plan the fix');
  assert.equal(todoState.latest.length, 2);
  assert.deepEqual(todoState.latest[1].blocked_by, ['1']);
});

test('todo v2: the plan survives compaction (todo anchor in the summary)', async () => {
  const { tools, harness, todoState } = makeBuddy(tmpRoot());
  const todo = tools.find((t) => t.name === 'todo');
  await todo.run({
    items: [
      { id: '1', text: 'write failing test', status: 'done' },
      { id: '2', text: 'patch the bug', status: 'in_progress', blocked_by: ['1'] },
    ],
  });
  const calls = [];
  const chat = createChat({
    router: {
      order: ['fake'],
      chat: async (messages, opts) => {
        calls.push({ messages, opts });
        return { text: 'summary text', model: 'fake', gateway: 'fake', latencyMs: 1 };
      },
    },
    tools,
    harness,
    todoState,
    charBudget: 10, // force compaction on every call
  });
  // Compaction needs a head to summarize (keep = 4) — seed old history.
  for (let i = 0; i < 6; i++) chat.messages.push({ role: i % 2 ? 'assistant' : 'user', content: `old message ${i} padding padding` });
  await chat.turn('keep implementing');
  // The plan does NOT go into the summarizer prompt — it is prepended to the
  // post-compaction history itself, so it survives every future compaction.
  const summaryMsg = chat.messages.find((m) => m.role === 'user' && m.content.includes('Earlier conversation, summarized'));
  assert.ok(summaryMsg, 'compaction replaced the head with a summary');
  assert.match(summaryMsg.content, /CURRENT PLAN \(todo tool/);
  assert.match(summaryMsg.content, /#2 patch the bug/);
});

test('todo v2: system prompt advertises the v2 protocol', () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const s = buildSystemPrompt({ harness, tools });
  assert.match(s, /## Plan protocol/);
  assert.match(s, /blocked_by/);
  assert.match(s, /READY NOW/);
  assert.match(s, /empty items array clears/);
});

test('renderTodo: shows ids and blocked-by chains', () => {
  const out = renderTodo([
    { id: '1', text: 'read files', status: 'done' },
    { id: '2', text: 'patch bug', status: 'in_progress', blocked_by: ['1'] },
  ]);
  assert.match(out, /#1 read files/);
  assert.match(out, /#2 patch bug/);
  assert.match(out, /after #1/);
});
