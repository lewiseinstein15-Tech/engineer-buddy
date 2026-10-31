// The tool-call cap — REMOVED by default (v0.64.1). The old `impl.maxCalls ?? 6`
// in the main turn loop strangled honest research turns: the live-probe session
// burned 6/6 fs_reads on camera and died mid-task with half the gateway plane
// unread ("ERROR: tool "fs_read" already used 6/6 times this turn"). Now:
//   - a tool that declares NO maxCalls runs UNLIMITED per turn (the step budget,
//     the identical-repeat guard and the forced wrap-up stay the real bounds);
//   - a tool's DECLARED maxCalls still wins (task's 3-call stampede guard,
//     planmode's 3, gitwrite's 8 — product decisions, untouched);
//   - chat.toolCallCap in .buddy/settings.json re-arms a GLOBAL cap for
//     undeclared tools (resolveToolCallCap: absent/false/0/'off' → Infinity,
//     positive integer → cap, junk → NAMED + the default holds).
// Pins that carry the house rules:
//   - 9 undeclared calls in ONE turn: every one runs, zero cap errors;
//   - a declared maxCalls:2 still fires on the 3rd call, same message shape;
//   - an armed toolCallCap:3 fires on the 4th call;
//   - the resolver legs: absent/false/0/'off'/'false'/null → Infinity, '7'/7 → 7,
//     true/'abc'/7.5/-1/objects/1e21 → Infinity WITH a note naming the junk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { resolveToolCallCap } from '../src/settings.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-cap-'));
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

const obsOf = (chat) => chat.messages.filter((m) => m.content.startsWith('TOOL OBSERVATION')).map((m) => m.content);

test('default: a tool that declares no maxCalls runs UNLIMITED — 9 fs_reads, zero cap errors', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const read = '{"tool":"fs_read","args":{"path":"README.md"}}';
  const script = [...Array(9).fill(read), '{"tool":"say","message":"done"}'];
  const chat = createChat({ router: fakeRouter(script), tools, harness, maxStepsPerTurn: 12 });
  const out = await chat.turn('read a lot');
  const obs = obsOf(chat);
  assert.equal(obs.length, 9, 'all nine reads ran');
  for (const [i, o] of obs.entries()) assert.ok(!/already used/.test(o), `read #${i + 1} never hit a cap: ${o.slice(0, 80)}`);
  assert.equal(out.said, 'done');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a DECLARED maxCalls still bounds its tool — the product caps survive', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const probe = {
    name: 'cap_probe',
    description: 'fake tool with a declared 2-call cap',
    args: '',
    run: async () => 'ok',
    maxCalls: 2,
  };
  const call = '{"tool":"cap_probe","args":{}}';
  const script = [call, call, call, '{"tool":"say","message":"gave up"}'];
  const chat = createChat({ router: fakeRouter(script), tools: [...tools, probe], harness, maxStepsPerTurn: 6 });
  await chat.turn('use the probe');
  const obs = obsOf(chat);
  assert.equal(obs.length, 3);
  assert.ok(!/already used/.test(obs[0]) && !/already used/.test(obs[1]), 'calls 1-2 run clean');
  assert.match(obs[2], /ERROR: tool "cap_probe" already used 2\/2 times this turn/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an ARMED chat.toolCallCap re-arms the global cap for undeclared tools', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const search = '{"tool":"fs_search","args":{"needle":"x"}}';
  const script = [...Array(4).fill(search), '{"tool":"say","message":"stopped"}'];
  const chat = createChat({ router: fakeRouter(script), tools, harness, toolCallCap: 3, maxStepsPerTurn: 6 });
  await chat.turn('search a lot');
  const obs = obsOf(chat);
  assert.equal(obs.length, 4);
  assert.match(obs[3], /already used 3\/3 times this turn. Work differently or say\./);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveToolCallCap: absent/false/0/off legs all land on Infinity, silently', () => {
  for (const v of [undefined, null, '', false, 0, '0', 'off', 'false']) {
    const r = resolveToolCallCap(v);
    assert.equal(r.cap, Infinity, `leg ${JSON.stringify(v)} → unlimited`);
    assert.equal(r.note, null, `leg ${JSON.stringify(v)} → no note`);
  }
});

test('resolveToolCallCap: a positive integer (number or string) arms the cap', () => {
  assert.equal(resolveToolCallCap(12).cap, 12);
  assert.equal(resolveToolCallCap('7').cap, 7);
  assert.equal(resolveToolCallCap(' 42 ').cap, 42, 'numeric strings tolerate whitespace');
  assert.equal(resolveToolCallCap(100000).cap, 100000);
  for (const r of [resolveToolCallCap(12), resolveToolCallCap('7')]) assert.equal(r.note, null);
});

test('resolveToolCallCap: junk is NAMED and the unlimited default holds', () => {
  for (const v of [true, 'abc', '7.5', -1, 7.5, 1e21, {}, ['6'], NaN]) {
    const r = resolveToolCallCap(v);
    assert.equal(r.cap, Infinity, `junk ${JSON.stringify(v) || String(v)} can never cap a turn`);
    assert.match(r.note, /chat\.toolCallCap: .+the default \(unlimited\) holds/, `junk ${JSON.stringify(v) || String(v)} is named`);
  }
});
