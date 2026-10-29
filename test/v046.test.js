// v046.test.js — the benchmark's FIRST FULL LIVE RUN (7 dims, real keyless
// brain, this repo's own machinery) scored 5/7 and the two FAILs were real:
//
//   recover FAIL — "no checkpoint manifest mentions the file the killed child
//   wrote". FALSE ALARM BY THE SCORER: the checkpoint manifest was ON DISK the
//   whole time mentioning src/lib/fib.js; the scorer parsed only the JSON
//   argText form ({"path":"..."}) while the real one-shot stream ships the
//   RENDERED card form ("fs_write src/lib/fib.js"). A scorer that cannot read
//   its own evidence would have "fixed" a working feature — the fix is the
//   reader, not the product: writeTargetFromEvent() now honors every shape and
//   guesses NOTHING on junk.
//
//   reason FAIL — 1/5 tool calls carried a why. REAL: the preamble taught
//   "skip it when obvious" and the model read that as default-off. The house
//   discipline is decisions carry a why — the preamble now teaches
//   default-include, and the benchmark's reason task states the rubric (a
//   referee hands the expectation over, it does not mind-read it).
//
// Pins here are the unit-level half; the LIVE half is the next full
// `buddy benchmark` run — 7/7 expected, artifacts on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeTargetFromEvent, brainOffline } from '../src/benchmark.js';
import { PROTOCOL_PREAMBLE, createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

test('v046 writeTargetFromEvent: the RENDERED argText form the real stream ships (the exact shape the 5/7 run missed)', () => {
  const ev = { type: 'tool', tool: 'fs_write', argText: 'fs_write src/lib/fib.js', observation: 'OK create src/lib/fib.js (194 bytes)' };
  assert.equal(writeTargetFromEvent(ev), 'fib.js');
  assert.equal(writeTargetFromEvent({ argText: 'fs_write test/slug.test.js' }), 'slug.test.js');
  assert.equal(writeTargetFromEvent({ argText: 'fs_write CHANGELOG.md' }), 'CHANGELOG.md');
});

test('v046 writeTargetFromEvent: the JSON argText form still parses (older shape, never regressed)', () => {
  assert.equal(writeTargetFromEvent({ argText: '{"path":"src/lib/fib.js","content":"..."}' }), 'fib.js');
  assert.equal(writeTargetFromEvent({ argText: 'fs_write {"path":"a/b/c.txt"}' }), 'c.txt');
});

test('v046 writeTargetFromEvent: session-shaped events carry args.path', () => {
  assert.equal(writeTargetFromEvent({ args: { path: 'docs/summary.md' } }), 'summary.md');
  assert.equal(writeTargetFromEvent({ args: { path: '  spaced.txt  ' } }), 'spaced.txt');
  // args wins when both shapes ride one event
  assert.equal(writeTargetFromEvent({ args: { path: 'x/args.txt' }, argText: 'fs_write x/argtext.txt' }), 'args.txt');
});

test('v046 writeTargetFromEvent: HOSTILE INPUTS — junk is null, never a guess', () => {
  assert.equal(writeTargetFromEvent(null), null);
  assert.equal(writeTargetFromEvent(undefined), null);
  assert.equal(writeTargetFromEvent(42), null);
  assert.equal(writeTargetFromEvent('fs_write sneaky.txt'), null); // a string is not an event
  assert.equal(writeTargetFromEvent({}), null);
  assert.equal(writeTargetFromEvent({ argText: '' }), null);
  assert.equal(writeTargetFromEvent({ argText: 'fs_write' }), null); // no target at all
  assert.equal(writeTargetFromEvent({ argText: 'fs_write    ' }), null);
  assert.equal(writeTargetFromEvent({ argText: '{"path":}' }), null); // torn JSON
  assert.equal(writeTargetFromEvent({ argText: '{"path":42}' }), null); // non-string path
  assert.equal(writeTargetFromEvent({ argText: 'rm -rf / ; fs_write' }), null); // not a write event payload
  assert.equal(writeTargetFromEvent({ args: { path: '' }, argText: 'garbage' }), null);
  assert.equal(writeTargetFromEvent({ argText: 'fs_write "quoted path.txt"' }), null); // quoted junk — refuse, don't guess
  assert.equal(writeTargetFromEvent({ argText: 'x'.repeat(100000) + ' fs_write a.txt' }), null); // anchored form only
});

test('v046 writeTargetFromEvent: basename semantics documented — the manifest walk matches in-root manifests by basename', () => {
  // traversal-looking input degrades to its basename; the manifest store only
  // ever contains in-root relpaths (writes outside root are refused), so the
  // match is against in-root truth on both sides.
  assert.equal(writeTargetFromEvent({ argText: 'fs_write ../../../etc/fib.js' }), 'fib.js');
  assert.equal(writeTargetFromEvent({ args: { path: '/abs/outside/root.txt' } }), 'root.txt');
});

test('v046 PROTOCOL_PREAMBLE: whys are default-INCLUDE now — the 5/7 run taught us the old wording was a default-off', () => {
  assert.match(PROTOCOL_PREAMBLE, /Include it on EVERY tool call by default/);
  assert.match(PROTOCOL_PREAMBLE, /Decisions carry a why/);
  assert.doesNotMatch(PROTOCOL_PREAMBLE, /skip it only when the reason is obvious/);
  // the protocol line still teaches the shape
  assert.match(PROTOCOL_PREAMBLE, /\{"tool":"<tool-name>","args":\{\.\.\.\},"why":"\.\.\."\}/);
  // and the honesty floor is untouched
  assert.match(PROTOCOL_PREAMBLE, /Never invent tool results/);
});

// ── the why contract, live against a scripted brain and the REAL loop ────────

function v046Buddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

function v046Router(script, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

const FS_WRITE_NO_WHY = () => JSON.stringify({ tool: 'fs_write', args: { path: 'note.txt', content: 'v46' } });
const FS_WRITE_WHY = () => JSON.stringify({ tool: 'fs_write', args: { path: 'note.txt', content: 'v46' }, why: 'the task needs the file' });

test('v046 why contract DEFAULT: the in-band note rides the next observation, no extra model round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v46a-'));
  const { tools, harness } = v046Buddy(root);
  const events = [];
  const calls = [];
  const router = v046Router([FS_WRITE_NO_WHY(), '{"tool":"say","message":"done"}'], calls);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  await chat.turn('write note.txt');
  const ev = events.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  assert.ok(ev, 'fs_write executed');
  assert.ok(!ev.whyBounced, 'default teaches — never bounces');
  const nextMessages = calls[1]?.messages || [];
  const note = nextMessages.some((m) => String(m.content || '').includes('NOTE (why contract)'));
  assert.ok(note, 'the why note reached the model before its next call');
  assert.equal(calls.length, 2, 'no extra round-trip');
});

test('v046 why contract BOUNCE: a why-less decision call is bounced once and comes back carrying the why', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v46b-'));
  const { tools, harness } = v046Buddy(root);
  const events = [];
  const calls = [];
  const router = v046Router([FS_WRITE_NO_WHY(), FS_WRITE_WHY(), '{"tool":"say","message":"done"}'], calls);
  const chat = createChat({ router, tools, harness, whyContract: true, onEvent: (e) => events.push(e) });
  await chat.turn('write note.txt');
  const ev = events.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  assert.ok(ev, 'fs_write executed exactly once');
  assert.equal(ev.why, 'the task needs the file', 'the why is the MODEL\u2019s sentence, not a fabrication');
  assert.equal(ev.whyBounced, true, 'the bounce is a recorded fact');
  assert.equal(calls.length, 3, 'write + bounce round + say');
  const demand = calls[1]?.messages?.some((m) => String(m.content || '').includes('WHY CONTRACT: every decision carries a why'));
  assert.ok(demand, 'the bounce demand reached the model');
});

test('v046 why contract BOUNCE is bounded: a stubborn model still executes exactly once, un-bounced but never fabricated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v46c-'));
  const { tools, harness } = v046Buddy(root);
  const events = [];
  const theCalls = [];
  const router = v046Router([FS_WRITE_NO_WHY(), FS_WRITE_NO_WHY(), '{"tool":"say","message":"stubborn"}'], theCalls);
  const chat = createChat({ router, tools, harness, whyContract: true, onEvent: (e) => events.push(e) });
  await chat.turn('write note.txt');
  const ev = events.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  assert.ok(ev, 'fs_write executed exactly once — the bounce never blocks the work');
  assert.equal(ev.whyBounced, true);
  assert.equal(ev.why, undefined, 'no why on disk means no why is claimed — never fabricated');
  assert.equal(theCalls.length, 3);
});

test('v046 why contract: a brain blip during the bounce degrades to the original call, the turn survives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v46d-'));
  const { tools, harness } = v046Buddy(root);
  const events = [];
  let n = 0;
  const router = {
    order: ['fake'],
    chat: async () => {
      n++;
      if (n === 2) throw new Error('rate-limited (60s)'); // the bounce round dies
      if (n === 1) return { text: FS_WRITE_NO_WHY(), model: 'fake-model', gateway: 'fake', latencyMs: 1 };
      return { text: '{"tool":"say","message":"survived"}', model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
  const chat = createChat({ router, tools, harness, whyContract: true, onEvent: (e) => events.push(e) });
  await chat.turn('write note.txt');
  const ev = events.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  assert.ok(ev, 'the original call still executed');
  assert.equal(ev.whyBounced, true, 'the bounce attempt is still a recorded fact');
  const say = events.find((e) => e.type === 'say');
  assert.equal(say?.text, 'survived', 'the turn completed normally');
});

test('v046 brainOffline: the mid-run outage reads as SKIP material, a recovered run never does', () => {
  const offline = [{ type: 'error', text: 'brain offline: all gateways failed after 2 round-trips — kilo: rate-limited' }];
  assert.match(brainOffline(offline), /rate-limited/);
  // recovered: an error early, but the run reached an ok result — NOT offline
  const recovered = [...offline, { type: 'result', status: 'ok', said: 'fine' }];
  assert.equal(brainOffline(recovered), null);
  // unrelated errors are not outages
  assert.equal(brainOffline([{ type: 'error', text: 'tool exploded' }]), null);
  assert.equal(brainOffline([]), null);
  assert.equal(brainOffline(null), null);
  assert.equal(brainOffline('junk'), null);
  assert.equal(brainOffline([{ type: 'error' }]), null);
});
