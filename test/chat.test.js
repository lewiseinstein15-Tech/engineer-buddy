import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat, buildSystemPrompt, PROTOCOL_PREAMBLE } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
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
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-chat-'));
}

test('buildSystemPrompt: protocol first, harness parts included', () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const s = buildSystemPrompt({ harness, tools });
  assert.ok(s.startsWith(PROTOCOL_PREAMBLE.slice(0, 40)));
  assert.ok(s.includes('## Tools') && s.includes('fs_read') && s.includes('bash'));
  assert.ok(s.includes('## Guardrails') && s.includes('## Project memory'));
});

test('chat: plain say ends the turn', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const chat = createChat({ router: fakeRouter(['{"tool":"say","message":"hello there"}']), tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('hi');
  assert.equal(out.said, 'hello there');
  assert.equal(out.steps, 1);
  assert.equal(events[0].type, 'user');
  assert.equal(events[1].type, 'say');
});

test('chat: tool call → observation → say', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const router = fakeRouter(['{"tool":"fs_read","args":{"path":"a.txt"}}', '{"tool":"say","message":"read it"}']);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('read a.txt');
  assert.equal(out.said, 'read it');
  const toolEv = events.find((e) => e.type === 'tool');
  assert.equal(toolEv.tool, 'fs_read');
  assert.match(toolEv.observation, /alpha/);
});

test('chat: "finish" is accepted as a say', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const chat = createChat({ router: fakeRouter(['{"tool":"finish","result":"all good"}']), tools, harness });
  const out = await chat.turn('wrap up');
  assert.equal(out.said, 'all good');
});

test('chat: protocol violation triggers one self-repair, history stays clean', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const calls = [];
  const router = fakeRouter(['I think we should look at the files first.', '{"tool":"say","message":"repaired"}'], calls);
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('go');
  assert.equal(out.said, 'repaired');
  // violation exchange (assistant+user) was spliced out: user + say remain
  assert.equal(chat.messages.length, 2);
  assert.equal(calls.length, 2);
});

test('chat: unrepairable protocol violation surfaces an error event', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const router = fakeRouter(['nope', 'still nope']);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('go');
  assert.equal(out.said, null);
  assert.ok(out.error);
  assert.equal(events.at(-1).type, 'error');
});

test('chat: unknown tool returns an error observation, model recovers', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const router = fakeRouter(['{"tool":"deploy_to_prod","args":{}}', '{"tool":"say","message":"oops, no such tool"}']);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  await chat.turn('ship it');
  const toolEv = events.find((e) => e.type === 'tool');
  assert.match(toolEv.observation, /ERROR: unknown tool "deploy_to_prod"/);
});

test('chat: user denial blocks risky tools and informs the model', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const approvals = [];
  const router = fakeRouter(['{"tool":"fs_write","args":{"path":"evil.js","content":"x"}}', '{"tool":"say","message":"understood, not writing"}']);
  const chat = createChat({
    router, tools, harness,
    approval: async (req) => { approvals.push(req.tool); return 'no'; },
    onEvent: (e) => events.push(e),
  });
  await chat.turn('write evil.js');
  assert.deepEqual(approvals, ['fs_write']);
  const toolEv = events.find((e) => e.type === 'tool');
  assert.equal(toolEv.denied, true);
  assert.match(toolEv.observation, /DENIED by the user/);
  assert.ok(!fs.existsSync(path.join(root, 'evil.js')));
});

test('chat: "always" approval asks once per tool', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  let asks = 0;
  const router = fakeRouter([
    '{"tool":"fs_append","args":{"path":"log.md","content":"one"}}',
    '{"tool":"fs_append","args":{"path":"log.md","content":"two"}}',
    '{"tool":"say","message":"done"}',
  ]);
  const chat = createChat({
    router, tools, harness,
    approval: async () => { asks++; return 'always'; },
  });
  await chat.turn('append twice');
  assert.equal(asks, 1);
  assert.match(fs.readFileSync(path.join(root, 'log.md'), 'utf8'), /one\ntwo|one\n\ntwo/);
});

test('chat: turn budget stops runaway loops with a clear message', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const router = fakeRouter(Array(20).fill('{"tool":"fs_list","args":{}}'));
  const chat = createChat({ router, tools, harness, maxStepsPerTurn: 3, onEvent: (e) => events.push(e) });
  const out = await chat.turn('loop forever');
  assert.equal(out.steps, 3);
  assert.equal(out.said, null);
  assert.match(events.at(-1).text, /Turn budget reached \(3 steps\)/);
});

test('chat: context compaction summarizes old messages via the brain', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const events = [];
  const long = 'x'.repeat(600);
  const router = fakeRouter([
    `{"tool":"say","message":"${long}"}`,   // turn 1 reply (long)
    `{"tool":"say","message":"${long}"}`,   // turn 2 reply
    `{"tool":"say","message":"${long}"}`,   // turn 3 reply
    'COMPACTED SUMMARY OF EARLIER WORK',    // compaction call during turn 4
    '{"tool":"say","message":"fourth reply"}',
  ]);
  const chat = createChat({ router, tools, harness, charBudget: 50, onEvent: (e) => events.push(e) });
  await chat.turn('task one');
  await chat.turn('task two');
  await chat.turn('task three');
  assert.equal(chat.compactCount, 0); // head < 2 keeps messages until turn 4
  const out = await chat.turn('task four');
  assert.equal(out.said, 'fourth reply');
  assert.equal(chat.compactCount, 1);
  const comp = events.find((e) => e.type === 'compaction');
  assert.ok(comp && comp.dropped >= 2);
  assert.match(chat.messages[0].content, /COMPACTED SUMMARY OF EARLIER WORK/);
});

test('chat: say content must survive JSON-in-JSON (message with quotes)', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const reply = JSON.stringify({ tool: 'say', message: 'use {"tool":"fs_read"} next time' });
  const chat = createChat({ router: fakeRouter([reply]), tools, harness });
  const out = await chat.turn('advise');
  assert.equal(out.said, 'use {"tool":"fs_read"} next time');
});
