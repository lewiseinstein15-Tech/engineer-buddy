// v063.test.js — the cut-off reply (v0.62 live-test lesson, § protocol).
// The live task test died twice on `fs_write test/store.test.js`: a 4.4KB
// payload at the default 1500-token budget was cut mid-JSON by the relay,
// and the old repair asked AGAIN at the same budget — the model wrote the
// same big payload, was cut at the same byte, and the turn died with the
// todo stalled. Covers: the shape heuristic, the wire's finish_reason
// witness (buffered + SSE), the chat ladder (boosted gear + split-payload
// teaching, generic sneezes keep the single-repair contract), the one-shot
// agent ladder, and the preamble's up-front prevention line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksTruncatedJson } from '../src/util.js';
import { openAIStreamOrBuffer } from '../src/brain/sse.js';
import { createChat, PROTOCOL_PREAMBLE } from '../src/agent/chat.js';
import { runAgent } from '../src/agent/agent.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v063-'));

// The live shape: a fs_write tool call whose content string never closes.
const cutReply = (pathName = 'test/store.test.js') =>
  `{"tool":"fs_write","args":{"path":"${pathName}","content":"line one\\nline two\\nline three\\nconst x = { a: 1, b: [2, 3],` +
  'c: `template literal`, d: { e: 4 }';

// ── looksTruncatedJson: the shape heuristic ─────────────────────────────────

test('looksTruncatedJson: an unbalanced fs_write tool call is a cut-off', () => {
  assert.equal(looksTruncatedJson(cutReply()), true);
  assert.equal(
    looksTruncatedJson('{"tool":"fs_write","args":{"content":"still inside the string'),
    true
  );
  // cut mid-escape (the backslash dangles)
  assert.equal(looksTruncatedJson('{"tool":"fs_write","args":{"content":"abc\\'), true);
});

test('looksTruncatedJson: balanced JSON is never a cut-off (even sloppy)', () => {
  assert.equal(looksTruncatedJson('{"tool":"say","message":"done"}'), false);
  // raw newlines inside the string = invalid JSON, but BALANCED — tryRepairJson's job, not truncation
  assert.equal(looksTruncatedJson('{"tool":"say","message":"line1\nline2"}'), false);
  assert.equal(looksTruncatedJson('{"tool":"bash","args":{"command":"echo {\\"a\\":1}"}}'), false);
});

test('looksTruncatedJson: prose and junk are never diagnosed', () => {
  assert.equal(looksTruncatedJson('I think we should look at the files first.'), false);
  assert.equal(looksTruncatedJson('a { brace in prose that never closes'), false);
  assert.equal(looksTruncatedJson('{"unrelated":"object","that":"never closes too'), false); // no "tool" key in head
  assert.equal(looksTruncatedJson(''), false);
  assert.equal(looksTruncatedJson(null), false);
  assert.equal(looksTruncatedJson(undefined), false);
});

// ── the wire witness: openAIStreamOrBuffer maps finish_reason ──────────────

function wireRes(body, ctype = 'application/json') {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ctype : null) },
    json: async () => JSON.parse(body),
  };
}

test('openAIStreamOrBuffer: finish_reason length → truncated:true (buffered)', async () => {
  const cut = { choices: [{ message: { content: cutReply() }, finish_reason: 'length' }], usage: { total_tokens: 1500 } };
  const out = await openAIStreamOrBuffer(wireRes(JSON.stringify(cut)), null);
  assert.equal(out.truncated, true);
  assert.match(out.text, /fs_write/);
});

test('openAIStreamOrBuffer: finish_reason stop → truncated:false (buffered)', async () => {
  const ok = { choices: [{ message: { content: '{"tool":"say","message":"done"}' }, finish_reason: 'stop' }] };
  const out = await openAIStreamOrBuffer(wireRes(JSON.stringify(ok)), null);
  assert.equal(out.truncated, false);
});

test('openAIStreamOrBuffer: SSE stream carrying a length finish is truncated', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: cutReply().slice(0, 40) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: cutReply().slice(40) }, finish_reason: 'length' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const sse = {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: (async function* () {
      for (const f of frames) yield Buffer.from(f);
    })(),
  };
  const deltas = [];
  const out = await openAIStreamOrBuffer(sse, (d) => deltas.push(d), { idleMs: 5000, totalMs: 5000 });
  assert.equal(out.truncated, true);
  assert.equal(out.streamed, true);
  assert.equal(deltas.length, 2);
});

test('openAIStreamOrBuffer: SSE stream with a stop finish is not truncated', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"tool":"say"' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: ',"message":"done"}' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const sse = {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: (async function* () {
      for (const f of frames) yield Buffer.from(f);
    })(),
  };
  const out = await openAIStreamOrBuffer(sse, null, { idleMs: 5000, totalMs: 5000 });
  assert.equal(out.truncated, false);
  assert.equal(JSON.parse(out.text).tool, 'say');
});

// ── harness for the chat + agent ladders ────────────────────────────────────

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
    calls,
    chat: async (messages, opts = {}) => {
      // SNAPSHOT the wire state at call time — runAgent hands the router the
      // live history array, and the ladder's clean-history splice would
      // otherwise erase the violation exchange from the capture before the
      // assertions read it (the wire during the call DID carry it).
      calls.push({ messages: messages.map((m) => ({ ...m })), opts: { ...opts } });
      const r = script.length ? script.shift() : { text: '{"tool":"say","message":"(script exhausted)"}' };
      return typeof r === 'string'
        ? { text: r, model: 'fake-model', gateway: 'fake', latencyMs: 1 }
        : { text: r.text, model: 'fake-model', gateway: 'fake', latencyMs: 1, ...(r.truncated ? { truncated: true } : {}) };
    },
  };
}

const lastUserMsg = (call) => call.messages[call.messages.length - 1].content;

// ── the chat ladder ─────────────────────────────────────────────────────────

test('v063 chat: a wire-witnessed cut-off gets the SPLIT teaching at a DOUBLED budget, and the split write runs', async () => {
  const root = mkRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = fakeRouter(
    [
      { text: cutReply(), truncated: true }, // the relay cut the big fs_write
      '{"tool":"fs_write","args":{"path":"part1.txt","content":"first part"},"why":"split the write"}',
      '{"tool":"fs_append","args":{"path":"part1.txt","content":"\\nsecond part"},"why":"finish the split file"}',
      '{"tool":"say","message":"wrote it in two parts"}',
    ],
    calls
  );
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('write the big file');
  assert.equal(out.said, 'wrote it in two parts');
  assert.equal(calls.length, 4); // first + repair + fs_append step + say step
  // repair gear: medium effort = 1500 base → the boosted ask is 3000
  assert.equal(calls[1].opts.maxTokens, 3000);
  // the repair ask NAMES the cut-off and teaches the split — not "you did not format"
  assert.match(lastUserMsg(calls[1]), /CUT OFF by the output token limit/);
  assert.match(lastUserMsg(calls[1]), /fs_append/);
  // the file REALLY landed, both parts, byte order intact (fs_append inserts
  // a separator newline when the file does not end with one — its contract)
  assert.equal(fs.readFileSync(path.join(root, 'part1.txt'), 'utf8'), 'first part\n\nsecond part');
  // the violation exchange stays out of history: user + 2×(tool-call +
  // observation) + say remain
  assert.equal(chat.messages.length, 6);
});

test('v063 chat: a silent relay (no finish_reason) is still diagnosed by the SHAPE heuristic', async () => {
  const { tools, harness } = makeBuddy(mkRoot());
  const calls = [];
  // the reply is cut AND the gateway carries no truncated flag — the shape speaks
  const router = fakeRouter([cutReply(), '{"tool":"say","message":"recovered"}'], calls);
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('go');
  assert.equal(out.said, 'recovered');
  assert.equal(calls[1].opts.maxTokens, 3000);
  assert.match(lastUserMsg(calls[1]), /CUT OFF by the output token limit/);
});

test('v063 chat: the SECOND cut reply earns a third ask (two-gear ladder) at the boosted budget', async () => {
  const root = mkRoot();
  const { tools, harness } = makeBuddy(root);
  const calls = [];
  const router = fakeRouter(
    [
      { text: cutReply(), truncated: true },
      { text: cutReply('other.js'), truncated: true }, // the retry wrote big again — cut again
      '{"tool":"fs_write","args":{"path":"small.txt","content":"short body"},"why":"small step"}',
      '{"tool":"say","message":"done with the small step"}',
    ],
    calls
  );
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('try again');
  assert.equal(out.said, 'done with the small step');
  assert.equal(calls.length, 4); // first + two repairs + say
  assert.equal(calls[1].opts.maxTokens, 3000);
  assert.equal(calls[2].opts.maxTokens, 3000); // second gear rides the boost too
  assert.match(lastUserMsg(calls[2]), /CUT OFF/);
  assert.equal(fs.readFileSync(path.join(root, 'small.txt'), 'utf8'), 'short body');
  assert.equal(chat.messages.length, 4); // both violation exchanges spliced out
});

test('v063 chat: an unrepairable cut-off is NAMED as one — the error event teaches the split', async () => {
  const { tools, harness } = makeBuddy(mkRoot());
  const events = [];
  const router = fakeRouter([
    { text: cutReply(), truncated: true },
    { text: cutReply('a.js'), truncated: true },
    { text: cutReply('b.js'), truncated: true },
  ]);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('go');
  assert.equal(out.said, null);
  assert.ok(out.error);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).text, /cut off by the output token limit/);
  assert.match(events.at(-1).text, /fs_write \+ fs_append/);
  assert.match(events.at(-1).text, /First: \{"tool":"fs_write"/); // the original attempt, not the last retry
  assert.equal(chat.messages.length, 1); // all violation exchanges spliced out, user remains
});

test('v063 chat: a generic sneeze keeps the historical contract — ONE repair, SAME budget, GENERIC message', async () => {
  const { tools, harness } = makeBuddy(mkRoot());
  const calls = [];
  const router = fakeRouter(['I think we should look first.', '{"tool":"say","message":"repaired"}'], calls);
  const chat = createChat({ router, tools, harness });
  const out = await chat.turn('go');
  assert.equal(out.said, 'repaired');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.maxTokens, 1500); // medium effort base, NOT boosted
  assert.match(lastUserMsg(calls[1]), /was not a single JSON object/); // the old teaching
  assert.doesNotMatch(lastUserMsg(calls[1]), /CUT OFF/);
});

test('v063 chat: generic violations still die after ONE repair (no third ask)', async () => {
  const { tools, harness } = makeBuddy(mkRoot());
  const events = [];
  const router = fakeRouter(['nope', 'still nope', '{"tool":"say","message":"should never be reached"}']);
  const chat = createChat({ router, tools, harness, onEvent: (e) => events.push(e) });
  const out = await chat.turn('go');
  assert.equal(out.said, null);
  assert.ok(out.error);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).text, /protocol violation\)\./); // NOT the cut-off diagnosis
  assert.equal(router.calls.length, 2); // only two brain calls — the third reply is unreached
});

// ── the one-shot agent ladder ───────────────────────────────────────────────

test('v063 agent: a wire-witnessed cut-off repair rides the doubled budget', async () => {
  const { tools } = makeBuddy(mkRoot());
  const calls = [];
  const router = fakeRouter(
    [
      { text: cutReply(), truncated: true },
      '{"tool":"finish","result":"finished after repair"}',
    ],
    calls
  );
  const out = await runAgent({ router, tools, systemPrompt: 'sys', messages: [{ role: 'user', content: 'go' }], maxSteps: 4, maxTokens: 1200 });
  assert.equal(out.finished, true);
  assert.equal(out.result, 'finished after repair');
  assert.equal(calls[1].opts.maxTokens, 2400); // 1200 × 2
  assert.match(lastUserMsg(calls[1]), /CUT OFF by the output token limit/);
});

test('v063 agent: the second cut earns the second gear; a generic sneeze keeps one repair', async () => {
  const { tools } = makeBuddy(mkRoot());
  const calls = [];
  const router = fakeRouter(
    [
      { text: cutReply(), truncated: true },
      { text: cutReply('a.js'), truncated: true },
      '{"tool":"finish","result":"third gear paid off"}',
    ],
    calls
  );
  const out = await runAgent({ router, tools, systemPrompt: 'sys', messages: [{ role: 'user', content: 'go' }], maxSteps: 4, maxTokens: 1200 });
  assert.equal(out.finished, true);
  assert.equal(out.result, 'third gear paid off');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].opts.maxTokens, 2400);
  assert.equal(calls[2].opts.maxTokens, 2400);
  assert.match(lastUserMsg(calls[2]), /CUT OFF/);

  // the generic two-strike failure is unchanged: 2 calls, no boost
  const calls2 = [];
  const router2 = fakeRouter(['nope', 'still nope'], calls2);
  const out2 = await runAgent({ router: router2, tools, systemPrompt: 'sys', messages: [{ role: 'user', content: 'go' }], maxSteps: 4, maxTokens: 1200 });
  assert.equal(out2.finished, false);
  // every brain call stays at the base budget — a generic sneeze never earns
  // the boost (the wrap-up legs after the break are the historical shape)
  assert.ok(calls2.every((c) => c.opts.maxTokens === 1200));
  assert.equal(calls2[1].opts.maxTokens, 1200);
});

// ── prevention up front: the preamble carries the split lesson ─────────────

test('v063 preamble: large payloads are taught to split BEFORE the first cut', () => {
  assert.match(PROTOCOL_PREAMBLE, /fs_write a short first part, then fs_append the rest/);
  assert.match(PROTOCOL_PREAMBLE, /output token limit/);
  // the protocol-first pin still holds
  assert.ok(PROTOCOL_PREAMBLE.startsWith('You are Engineer Buddy'));
});
