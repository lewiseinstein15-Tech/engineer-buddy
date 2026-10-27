// v0.37.0 — decision rationale per step + replayable narration.
// Part A: the protocol's optional `why` key rides every surface — event,
// session JSONL, event log, tool card, exports — and is NOT persisted into
// the model's history (rationale is for humans, not token burn).
// Part B: the replay player — pure timeline math + the playback seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat, buildSystemPrompt, PROTOCOL_PREAMBLE, extractWhy, WHY_MAX } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';
import { projectEvent } from '../src/eventslog.js';
import { renderToolEvent } from '../src/terminal/ui.js';
import { exportMarkdown } from '../src/session.js';
import {
  PACING, loadEvents, buildTimeline, clampGap, replaySummary, frameText, runPlayback, nearestSpeed, timelineMs,
} from '../src/terminal/replay.js';
import { formatMs } from '../src/terminal/ui.js';

// ── harness ──────────────────────────────────────────────────────────────────

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v037-'));
}

// ── Part A: the why protocol ─────────────────────────────────────────────────

test('rationale: the protocol documents the optional why key', () => {
  assert.match(PROTOCOL_PREAMBLE, /"why"/);
  assert.match(PROTOCOL_PREAMBLE, /ONE short sentence/);
  assert.match(buildSystemPrompt({ harness: { systemprompt: '', memory: '', toolGuidance: '', guardrails: '' }, tools: [] }), /"why"/);
});

test('rationale: extractWhy trims, caps at WHY_MAX, and refuses junk', () => {
  assert.equal(extractWhy({ why: '  fix the fenced-heading bug in toc.js  ' }), 'fix the fenced-heading bug in toc.js');
  assert.equal(extractWhy({}), undefined);
  assert.equal(extractWhy({ why: 42 }), undefined);
  assert.equal(extractWhy({ why: '   ' }), undefined);
  assert.equal(extractWhy(null), undefined);
  const long = extractWhy({ why: 'x'.repeat(WHY_MAX + 50) });
  assert.equal(long.length <= WHY_MAX, true);
  assert.equal(long.endsWith('…') || long.length === WHY_MAX, true);
});

test('rationale: the loop attaches why to tool events; history keeps only {tool,args}', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const calls = [];
  const events = [];
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"fs_list","args":{},"why":"see what lives here"}',
      '{"tool":"say","message":"done"}',
    ], calls),
    tools,
    harness,
    onEvent: (e) => events.push(e),
  });
  const out = await chat.turn('go');
  assert.equal(out.said, 'done');
  const toolEv = events.find((e) => e.type === 'tool');
  assert.equal(toolEv.why, 'see what lives here');
  // The model's history must NOT carry the why back: the assistant message
  // is the bare {tool,args} shape (rationale is display-only).
  const assistant = calls[0].messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.length, 0); // nothing persisted before the say
  assert.equal(events.find((e) => e.type === 'say').text, 'done');
});

test('rationale: steps without a why carry no why key (v0.36 shape intact)', async () => {
  const { tools, harness } = makeBuddy(tmpRoot());
  const events = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"fs_list","args":{}}', '{"tool":"say","message":"ok"}']),
    tools,
    harness,
    onEvent: (e) => events.push(e),
  });
  await chat.turn('go');
  const toolEv = events.find((e) => e.type === 'tool');
  assert.equal('why' in toolEv, false);
});

test('rationale: projectEvent keeps why for tools, never invents it', () => {
  assert.equal(projectEvent({ type: 'tool', tool: 'fs_replace', why: 'fix the bug' }).why, 'fix the bug');
  assert.equal('why' in projectEvent({ type: 'tool', tool: 'fs_replace' }), false);
  assert.equal(projectEvent({ type: 'tool', tool: 'fs_replace', why: '' }).why, undefined);
});

test('rationale: the card renders the why line; without it the card is unchanged', () => {
  const ev = { type: 'tool', tool: 'fs_replace', args: {}, argText: 'fs_replace src/x.js', observation: 'ok\nline2' };
  const plain = renderToolEvent(ev);
  const withWhy = renderToolEvent({ ...ev, why: 'the table of contents must skip code fences' });
  assert.match(withWhy, /why: the table of contents must skip code fences/);
  // Dropping the why (or why:false) returns the exact v0.36 bytes.
  assert.equal(renderToolEvent({ ...ev, why: 'x' }, { why: false }), plain);
  assert.equal(renderToolEvent(ev), plain);
});

test('rationale: the markdown export lists whys under the tool tally, in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v037-exp-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', text: 'fix it', at: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'tool', tool: 'fs_read', args: {}, observation: 'ok', why: 'reproduce the bug', at: '2026-01-01T00:00:01Z' }),
    JSON.stringify({ type: 'tool', tool: 'fs_replace', args: {}, observation: 'ok', why: 'skip fenced headings', at: '2026-01-01T00:00:02Z' }),
    JSON.stringify({ type: 'tool', tool: 'bash', args: {}, observation: 'ok', at: '2026-01-01T00:00:03Z' }),
    JSON.stringify({ type: 'say', text: 'fixed', at: '2026-01-01T00:00:04Z' }),
  ].join('\n'));
  const md = exportMarkdown(file);
  assert.match(md, /\(3 tool calls: fs_read, fs_replace, bash\)/);
  const iRead = md.indexOf('why: reproduce the bug');
  const iRep = md.indexOf('why: skip fenced headings');
  assert.ok(iRead > 0 && iRep > iRead, 'whys listed in call order');
  assert.ok(md.indexOf('**bash**') === -1, 'unexplained tools get no why line');
  // The tally-only shape still holds for turns with no rationale.
  const file2 = path.join(dir, 's2.jsonl');
  fs.writeFileSync(file2, [
    JSON.stringify({ type: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'tool', tool: 'fs_list', args: {}, observation: 'ok', at: '2026-01-01T00:00:01Z' }),
    JSON.stringify({ type: 'say', text: 'hey', at: '2026-01-01T00:00:02Z' }),
  ].join('\n'));
  assert.equal(exportMarkdown(file2).includes('why:'), false);
});

test('rationale: the recorder wiring persists why on both live and detached paths', () => {
  const src = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  const sites = src.split("recorder?.append({ type: 'tool'").length - 1;
  assert.equal(sites, 2, 'live + detached recorder append sites');
  const withWhy = src.split("...(ev.why ? { why: ev.why } : {}) }").length - 1;
  assert.equal(withWhy, 2, 'both append sites carry the why spread');
});

// ── Part B: replayable narration ─────────────────────────────────────────────

function writeSession(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-01-01T00-00-00-wish.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

test('replay: loadEvents is tolerant — junk lines skipped, unreadable/empty honest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v037-rep-'));
  const file = writeSession(dir, [
    { type: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' },
  ]);
  fs.appendFileSync(file, '\n{torn json\n');
  const { events, error } = loadEvents(file);
  assert.equal(error, null);
  assert.equal(events.length, 1, 'the torn line is skipped, the good line survives');
  const missing = loadEvents(path.join(dir, 'nope.jsonl'));
  assert.match(missing.error, /cannot read/);
  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  assert.match(loadEvents(empty).error, /no replayable events/);
});

test('replay: buildTimeline — first frame free, gaps paced from the session clock, clamped', () => {
  const frames = buildTimeline([
    { type: 'user', text: 'go', at: '2026-01-01T00:00:00.000Z' },
    { type: 'tool', tool: 'fs_read', at: '2026-01-01T00:00:02.000Z' },      // 2s  → 700ms
    { type: 'say', text: 'done', at: '2026-01-01T00:01:40.000Z' },           // 98s → 4000ms cap
    { type: 'tool', tool: 'bash', at: '2026-01-01T00:01:39.500Z' },          // skew → 150ms floor
    { type: 'error', text: 'x' },                                            // no stamp → 150ms
    { type: 'metadata', junk: true },                                        // unknown → skipped
  ]);
  assert.equal(frames.length, 5);
  assert.deepEqual(frames.map((f) => f.delayMs), [0, 700, 4000, 150, 150]);
  assert.deepEqual(frames.map((f) => f.ev.type), ['user', 'tool', 'say', 'tool', 'error']);
});

test('replay: clampGap honors injectable pacing (opts flow through buildTimeline)', () => {
  const frames = buildTimeline(
    [
      { type: 'user', at: '2026-01-01T00:00:00.000Z' },
      { type: 'tool', at: '2026-01-01T00:00:10.000Z' },
    ],
    { pace: 1, maxGapMs: 2000, minGapMs: 100 }
  );
  assert.equal(frames[1].delayMs, 2000, '10s at pace 1, capped at 2s');
  assert.equal(clampGap(-5, { minGapMs: 40 }), 40);
});

test('replay: replaySummary counts the film, not the noise', () => {
  const sum = replaySummary([
    { type: 'user', at: '2026-01-01T00:00:00.000Z' },
    { type: 'tool', at: '2026-01-01T00:00:02.000Z' },
    { type: 'tool', denied: true, at: '2026-01-01T00:00:03.000Z' },
    { type: 'error', text: 'x', at: '2026-01-01T00:00:04.000Z' },
    { type: 'say', at: '2026-01-01T00:00:30.000Z' },
    { type: 'compaction', at: '2026-01-01T00:00:31.000Z' },
  ]);
  assert.deepEqual({ turns: sum.turns, tools: sum.tools, denied: sum.denied, says: sum.says, errors: sum.errors, wallMs: sum.wallMs }, {
    turns: 1, tools: 2, denied: 1, says: 1, errors: 1, wallMs: 31000,
  });
});

test('replay: frameText paints the live shapes — cards with why, says, system notes', () => {
  const card = frameText({ type: 'tool', tool: 'fs_read', args: {}, argText: 'fs_read src/a.js', observation: 'x', why: 'find the bug' });
  assert.match(card, /fs_read/);
  assert.match(card, /why: find the bug/);
  assert.match(frameText({ type: 'user', text: 'hello' }), /You/);
  assert.match(frameText({ type: 'say', text: 'hello' }), /Buddy/);
  assert.match(frameText({ type: 'error', text: 'boom' }), /boom/);
  assert.match(frameText({ type: 'interrupted', at: 2 }), /interrupted/);
  assert.match(frameText({ type: 'shell', command: 'npm test', code: 0 }), /npm test/);
  assert.match(frameText({ type: 'compaction', dropped: 9, auto: true }), /9 messages summarized/);
});

test('replay: runPlayback paints in order, waits the paced delays, honors stop and speed', async () => {
  const frames = [
    { ev: { type: 'user', text: 'a' }, delayMs: 0 },
    { ev: { type: 'tool', tool: 'fs_read' }, delayMs: 300 },
    { ev: { type: 'say', text: 'b' }, delayMs: 600 },
  ];
  const painted = [];
  const waits = [];
  let stopped = false;
  let out = await runPlayback(frames, {
    paint: (text, meta) => painted.push(`${meta.index}/${meta.total}:${meta.kind}`),
    wait: async (ms) => waits.push(ms),
    shouldStop: () => stopped,
    getSpeed: () => 2,
  });
  assert.deepEqual(painted, ['1/3:user', '2/3:tool', '3/3:say']);
  assert.deepEqual(waits, [150, 300], 'delays divided by speed 2');
  assert.deepEqual(out, { played: 3, total: 3, waitedMs: 0 });

  stopped = true; // flip before the run: nothing paints
  out = await runPlayback(frames, { paint: () => painted.push('x'), wait: async () => {}, shouldStop: () => stopped });
  assert.equal(out.played, 0);

  // Mid-flight stop: the film halts where it is, played stays honest.
  const paints = [];
  stopped = false;
  let n = 0;
  out = await runPlayback(frames, {
    paint: () => paints.push(n++),
    wait: async () => {},
    shouldStop: () => n >= 2,
  });
  assert.equal(out.played, 2);
  assert.equal(paints.length, 2);
});

test('replay: nearestSpeed snaps to the supported ladder', () => {
  assert.deepEqual([0.2, 0.5, 0.9, 3, 10, 'x', -1].map(nearestSpeed), [0.5, 0.5, 1, 2, 8, 1, 1]);
});

test('replay: timelineMs hands fmtClock raw ms — the drill pinned the 0s-label unit bug', () => {
  // The first live drill printed `0s timeline` for a 2.8s film: the status
  // label divided ms→s, then fmtClock divided AGAIN. timelineMs is the seam.
  const frames = [
    { ev: { type: 'user' }, delayMs: 0 },
    { ev: { type: 'tool' }, delayMs: 244 },
    { ev: { type: 'say' }, delayMs: 194 },
  ];
  assert.equal(timelineMs(frames), 438);
  assert.equal(timelineMs([]), 0);
  assert.equal(timelineMs(null), 0);
  // and the label round-trips: 2786ms of timeline reads as 3s, never 0s
  assert.equal(formatMs(timelineMs([{ delayMs: 2786 }])), '2.8s');
});

test('replay: PACING keeps the documentary short — every gap lands inside the clamp', () => {
  assert.ok(PACING.PACE > 0 && PACING.PACE < 1);
  assert.ok(PACING.MIN_GAP_MS < PACING.MAX_GAP_MS);
  for (const gap of [0, 1, 500, 2000, 120000, 3600000]) {
    const d = clampGap(gap);
    assert.ok(d >= PACING.MIN_GAP_MS && d <= PACING.MAX_GAP_MS, `gap ${gap} → ${d} inside clamp`);
  }
});

test('replay: CLI + help wiring', () => {
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(idx, /replay: \{ type: 'boolean', default: false \}/);
  assert.match(idx, /values\.replay/);
  assert.match(idx, /playReplay/);
  assert.ok(idx.indexOf('values.replay') < idx.indexOf('values.worktree'), 'replay runs before worktree isolation (read-only)');
  const usage = idx.match(/usage\(\) \{[\s\S]*?^\}/m)[0];
  assert.match(usage, /--replay \[name\]/);
  const repl = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(repl, /case 'replay'/);
  assert.match(repl, /buddy --replay/);
});
