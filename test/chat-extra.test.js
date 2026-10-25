import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools, runBash } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function fakeRouter(script, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const todoState = { latest: null };
  const tools = buildLocalTools({ scope, todoState });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness, todoState };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-extra-'));
}

test('chat: pre-aborted signal returns immediately without brain calls', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const calls = [];
  const chat = createChat({ router: fakeRouter(['{"tool":"say","message":"nope"}'], calls), tools, harness });
  const ctrl = new AbortController();
  ctrl.abort();
  const out = await chat.turn('go', { signal: ctrl.signal });
  assert.equal(out.aborted, true);
  assert.equal(out.said, null);
  assert.equal(calls.length, 0);
});

test('chat: mid-turn abort stops before the next brain call', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const calls = [];
  const router = fakeRouter(['{"tool":"fs_list","args":{}}', '{"tool":"say","message":"never reached"}'], calls);
  const ctrl = new AbortController();
  const chat = createChat({
    router,
    tools,
    harness,
    onEvent: (e) => {
      if (e.type === 'tool') ctrl.abort();
    },
  });
  const out = await chat.turn('go', { signal: ctrl.signal });
  assert.equal(out.aborted, true);
  assert.equal(calls.length, 1); // second model call never happened
  assert.match(chat.messages.at(-1).content, /interrupted this turn/);
});

test('chat: compactNow forces a summary even under budget', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const calls = [];
  const long = 'x'.repeat(200);
  const router = fakeRouter(
    [`{"tool":"say","message":"${long}"}`, `{"tool":"say","message":"${long}"}`, `{"tool":"say","message":"${long}"}`, 'SUMMARY OF EARLIER TALK'],
    calls
  );
  const chat = createChat({ router, tools, harness, charBudget: 99999 });
  await chat.turn('one');
  await chat.turn('two');
  await chat.turn('three');
  assert.equal(chat.compactCount, 0);
  const r = await chat.compactNow();
  assert.equal(r.compacted, true);
  assert.equal(chat.compactCount, 1);
  assert.match(chat.messages[0].content, /SUMMARY OF EARLIER TALK/);
});

test('chat: usage() accumulates calls and chars per gateway', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const chat = createChat({ router: fakeRouter(['{"tool":"say","message":"hello world"}']), tools, harness });
  await chat.turn('hi there friend');
  const u = chat.usage();
  assert.equal(u.calls, 1);
  assert.ok(u.charsIn > 0 && u.charsOut > 0);
  assert.equal(u.byGateway.fake.calls, 1);
});

test('chat: todo tool updates state and event carries items', async () => {
  const { tools, harness, todoState } = makeBuddy(tmpRoot());
  const events = [];
  const router = fakeRouter([
    '{"tool":"todo","args":{"items":[{"text":"read the failing test","status":"in_progress"},{"text":"patch it"}]}}',
    '{"tool":"say","message":"planned"}',
  ]);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  await chat.turn('plan the fix');
  assert.equal(todoState.latest.length, 2);
  assert.equal(todoState.latest[0].status, 'in_progress');
  assert.equal(todoState.latest[1].status, 'pending'); // default
  const ev = events.find((e) => e.type === 'tool');
  assert.equal(ev.tool, 'todo');
  assert.equal(ev.args.items.length, 2);
  assert.match(ev.observation, /PLAN \(0\/2 done\)/);
});

test('chat: approval request carries a rendered diff preview', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'cfg.js'), 'const a = 1;\n', 'utf8');
  const { tools, harness } = makeBuddy(root);
  const seen = [];
  const router = fakeRouter([
    '{"tool":"fs_replace","args":{"path":"cfg.js","find":"const a = 1;","replace":"const a = 2;"}}',
    '{"tool":"say","message":"patched"}',
  ]);
  const chat = createChat({
    router,
    tools,
    harness,
    approval: async (req) => {
      seen.push(req);
      return 'yes';
    },
  });
  await chat.turn('bump the constant');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'fs_replace');
  assert.ok(seen[0].preview, 'preview must be present');
  assert.match(seen[0].preview, /const a = 1;/);
  assert.match(seen[0].preview, /const a = 2;/);
  assert.equal(fs.readFileSync(path.join(root, 'cfg.js'), 'utf8'), 'const a = 2;\n');
});

test('chat: broken preview never blocks the gate', async () => {
  const root = tmpRoot();
  const { scope, harness } = makeBuddy(root);
  const tools = buildLocalTools({ scope });
  tools.find((t) => t.name === 'fs_write').preview = () => {
    throw new Error('preview exploded');
  };
  const router = fakeRouter(['{"tool":"fs_write","args":{"path":"ok.txt","content":"data"}}', '{"tool":"say","message":"wrote"}']);
  const chat = createChat({ router, tools, harness, approval: async () => 'yes' });
  const out = await chat.turn('write it');
  assert.equal(out.said, 'wrote');
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'data');
});

test('runBash: trusted mode bypasses policy (pipes allowed), untrusted blocks', async () => {
  const root = tmpRoot();
  const trusted = await runBash('echo hello | tr a-z A-Z', { cwd: root, trusted: true, timeoutMs: 15000 });
  assert.equal(trusted.ok, true);
  assert.match(trusted.stdout, /HELLO/);
  const untrusted = await runBash('echo hello | tr a-z A-Z', { cwd: root, timeoutMs: 15000 });
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.stderr, /BLOCKED/);
});

test('runBash: pre-aborted signal kills the child fast', async () => {
  const root = tmpRoot();
  const ctrl = new AbortController();
  ctrl.abort();
  const t0 = Date.now();
  const r = await runBash('sleep 5', { cwd: root, signal: ctrl.signal, timeoutMs: 30000 });
  assert.equal(r.interrupted, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 3000, `should die immediately, took ${Date.now() - t0}ms`);
});

test('system prompt advertises the plan protocol when todo exists', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const { buildSystemPrompt } = await import('../src/agent/chat.js');
  const s = buildSystemPrompt({ harness, tools });
  assert.match(s, /## Plan protocol/);
  assert.match(s, /todo/);
});
