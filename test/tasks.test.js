// Tests for background turns (v0.34.0) — tasks.js pure half + the input box's
// ctrl+b dual-duty binding + the repl wiring tripwire (the REPL needs a TTY —
// source checks are the pattern the rewind/transcript suites established).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BG, createBgTurn, bgBufferEvent, bgBytes, bgFinish, resolveBgId, parseBgArgs, renderBgList, renderBgView, renderBgNote } from '../src/terminal/tasks.js';
import { applyKey, buildFrame, createInputBox } from '../src/terminal/inputbox.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const here = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const rec = (over = {}) => ({
  ...createBgTurn({ id: 1, task: 'fix the discount bug in cart.js', startedAt: 1_000, detachedAt: 1_500 }),
  ...over,
});

// ── records: creation + event folding ────────────────────────────────────────

test('createBgTurn: normalized task, running status, zeroed counters', () => {
  const r = createBgTurn({ id: '3', task: '  multi\nspace   task  ', startedAt: 5, detachedAt: 9 });
  assert.equal(r.id, 3);
  assert.equal(r.task, 'multi space task');
  assert.equal(r.status, 'running');
  assert.equal(r.reattached, false);
  assert.equal(r.tools, 0);
  assert.deepEqual(r.buffer, []);
  assert.equal(r.truncated, false);
});

test('bgBufferEvent: tool / denied / say / error / interrupted / compaction lines', () => {
  const r = rec();
  bgBufferEvent(r, { type: 'tool', tool: 'bash', argText: 'npm test' });
  bgBufferEvent(r, { type: 'tool', tool: 'fs_write', argText: 'x.js', denied: true });
  bgBufferEvent(r, { type: 'say', text: 'All green.' });
  bgBufferEvent(r, { type: 'error', text: 'brain offline: boom' });
  bgBufferEvent(r, { type: 'interrupted', at: 3 });
  bgBufferEvent(r, { type: 'compaction', kept: 4, dropped: 9 });
  assert.equal(r.tools, 2);
  assert.equal(r.denied, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.said, 'All green.');
  const flat = r.buffer.map(strip);
  assert.match(flat[0], /▸ npm test/);
  assert.match(flat[1], /⊗ fs_write \(denied\)/);
  assert.match(flat[2], /✻ All green\./);
  assert.match(flat[3], /✗ brain offline/);
  assert.match(flat[4], /⏸ interrupted/);
  assert.match(flat[5], /⌁ compacted — kept 4, dropped 9/);
});

test('bgBufferEvent: buffer caps at BG.BUFFER_CAP and flags truncation (head drops)', () => {
  const r = rec();
  for (let i = 0; i < BG.BUFFER_CAP + 10; i++) bgBufferEvent(r, { type: 'tool', tool: `t${i}`, argText: `call ${i}` });
  assert.equal(r.buffer.length, BG.BUFFER_CAP);
  assert.equal(r.truncated, true);
  assert.match(strip(r.buffer[0]), /call 10/); // head (calls 0..9) dropped
  assert.match(strip(r.buffer.at(-1)), /call 409/);
});

test('bgBytes accumulates; bgFinish closes with done / stopped / failed and is one-way', () => {
  const r = rec();
  bgBytes(r, 10); bgBytes(r, '5'); bgBytes(r, -3);
  assert.equal(r.bytes, 15);
  bgFinish(r, { at: 61_000, steps: 4, said: 'done!' });
  assert.equal(r.status, 'done');
  assert.equal(r.endedAt, 61_000);
  assert.equal(r.steps, 4);
  assert.equal(r.said, 'done!');
  bgFinish(r, { aborted: true }); // one-way: a finished record never re-finishes
  assert.equal(r.status, 'done');

  const s = rec();
  bgFinish(s, { aborted: true });
  assert.equal(s.status, 'stopped');
  const f = rec();
  bgFinish(f, { failed: true });
  assert.equal(f.status, 'failed');
});

// ── ids + /tasks arg parsing ────────────────────────────────────────────────

test('resolveBgId: accepts 3 and t3 (case-insensitive), rejects junk and unknown ids', () => {
  const list = [rec({ id: 1 }), rec({ id: 2 })];
  assert.equal(resolveBgId(list, 't2')?.id, 2);
  assert.equal(resolveBgId(list, 'T1')?.id, 1);
  assert.equal(resolveBgId(list, ' 1 ')?.id, 1);
  assert.equal(resolveBgId(list, '3'), null);
  assert.equal(resolveBgId(list, 't'), null);
  assert.equal(resolveBgId(list, '-1'), null);
  assert.equal(resolveBgId(list, ''), null);
});

test('parseBgArgs: list / subcommands / missing id / bare-id fast path', () => {
  assert.deepEqual(parseBgArgs(''), { sub: 'list', id: null });
  assert.deepEqual(parseBgArgs('list'), { sub: 'list', id: null });
  assert.deepEqual(parseBgArgs('view t1'), { sub: 'view', id: 't1' });
  assert.deepEqual(parseBgArgs('STOP 2'), { sub: 'stop', id: '2' });
  assert.deepEqual(parseBgArgs('attach  t3 '), { sub: 'attach', id: 't3' });
  assert.deepEqual(parseBgArgs('view'), { sub: 'view', id: null }); // usage case
  assert.deepEqual(parseBgArgs('t1'), { sub: 'view', id: 't1' });  // bare id = view
  assert.deepEqual(parseBgArgs('7'), { sub: 'view', id: '7' });
});

// ── rendering ───────────────────────────────────────────────────────────────

test('renderBgList: empty state teaches ctrl+b; sections render turns + shells', () => {
  const empty = strip(renderBgList({ turns: [], shells: [] }));
  assert.match(empty, /nothing in the background/);
  assert.match(empty, /ctrl\+b detaches/);

  const t = rec({ status: 'done', endedAt: 61_500, steps: 3, tools: 4 });
  const both = strip(renderBgList({ turns: [t], shells: [{ id: 2, status: 'running', durationMs: 3400, command: 'npm run dev', bytes: 99 }] }));
  assert.match(both, /Background tasks/);
  assert.match(both, /✓ t1 · done/);
  assert.match(both, /4 tools/);
  assert.match(both, /fix the discount bug/);
  assert.match(both, /shells/);
  assert.match(both, /#2 · running 3\.4s/);
  assert.match(both, /bash_output/);

  const turnsOnly = strip(renderBgList({ turns: [rec()], shells: [] }));
  assert.match(turnsOnly, /● t1 · running/);
  assert.match(turnsOnly, /muted/);
  assert.doesNotMatch(turnsOnly, /shells/);
});

test('renderBgView: header, stats, tail cap, truncation banner, empty state', () => {
  const empty = strip(renderBgView(rec()));
  assert.match(empty, /Task t1/);
  assert.match(empty, /running/);
  assert.match(empty, /no output yet/);

  const r = rec();
  for (let i = 0; i < BG.VIEW_TAIL + 5; i++) bgBufferEvent(r, { type: 'tool', tool: 'bash', argText: `cmd ${i}` });
  const view = strip(renderBgView(r, { tail: 10 }));
  const lines = view.split('\n').filter((l) => l.includes('cmd '));
  assert.equal(lines.length, 10);
  assert.match(strip(lines.at(-1)), /cmd 28/); // newest survives (i ran 0..28)
  assert.match(view, /earlier lines? — the full flow stays in the ctrl\+r transcript/);

  const big = rec();
  for (let i = 0; i < BG.BUFFER_CAP + 1; i++) bgBufferEvent(big, { type: 'tool', tool: 'bash', argText: `x${i}` });
  assert.match(strip(renderBgView(big)), /buffer capped at 400 lines/);
  assert.equal(renderBgView(null), null);
});

test('renderBgNote: outcome marks per status, stats line, view pointer', () => {
  const done = rec({ status: 'done', endedAt: 61_500, steps: 5, tools: 6, bytes: 1500 });
  const note = strip(renderBgNote(done));
  assert.match(note, /✓ bg t1 done/);
  assert.match(note, /5 steps · 6 tools · 1m01s/); // fmtDur renders minute-scale durations
  assert.match(note, /\/tasks view 1 for output/);

  const stopped = strip(renderBgNote(rec({ status: 'stopped', endedAt: 3_000, tools: 1 })));
  assert.match(stopped, /⏸ bg t1 stopped/);
  const failed = strip(renderBgNote(rec({ status: 'failed', endedAt: 3_000 })));
  assert.match(failed, /✗ bg t1 failed/);
  const denied = strip(renderBgNote(rec({ status: 'done', endedAt: 3_000, denied: 2, errors: 1 })));
  assert.match(denied, /2 denied · 1 error/);
  assert.equal(renderBgNote(null), null);
});

// ── the box: ctrl+b is dual-duty at the busy boundary ───────────────────────

test('applyKey: ctrl+b detaches while busy, moves left while idle, left in questions', () => {
  assert.equal(applyKey({ name: 'b', ctrl: true }, { busy: true }).action, 'detach');
  assert.equal(applyKey({ name: 'b', ctrl: true }, {}).action, 'left');
  // question mode at the call site computes busy=false — approval prompts
  // keep emacs bindings even mid-turn (ctrl+b never detaches under a question)
  assert.equal(applyKey({ name: 'b', ctrl: true }, { busy: true, questionMode: true }).action, 'detach');
});

test('input box: busy ctrl+b fires handlers.detach and keeps the draft; idle ctrl+b moves the caret', () => {
  let detached = 0;
  const box = createInputBox({ title: 'T', hint: '', record: null });
  try {
    box.on('detach', () => { detached += 1; });
    box._handleKeypress({ name: 'h', sequence: 'h' }); // idle: insert
    box._handleKeypress({ name: 'b', ctrl: true });    // idle: caret left, no detach
    assert.equal(detached, 0);
    assert.equal(box._state().cursor, 0); // left from 1 clamps at 0
    box._handleKeypress({ name: 'x', sequence: 'x' }); // inserts at the caret (moved to 0 by idle ctrl+b)
    assert.equal(box._state().cursor, 1);
    assert.equal(box._state().text, 'xh');
    box.setBusy('Buddy working…');
    box._handleKeypress({ name: 'b', ctrl: true });
    assert.equal(detached, 1);
    assert.equal(box._state().text, 'xh'); // draft untouched by the detach
    assert.equal(box._state().busy, 'Buddy working…'); // the repl releases the footer, not the box
  } finally {
    box.setBusy(null); // stop the spin timer — the test process must exit
  }
});

test('input box: ctrl+b inert while the transcript viewer or rewind menu is open', () => {
  let detached = 0;
  const box = createInputBox({ title: 'T', hint: '', record: null });
  try {
    box.on('detach', () => { detached += 1; });
    box.setBusy('working');
    box._capture('  hello scrollback\n'); // open the viewer
    box._handleKeypress({ name: 'r', ctrl: true });
    assert.ok(box._state().viewer, 'viewer open');
    box._handleKeypress({ name: 'b', ctrl: true }); // viewer owns every key
    assert.equal(detached, 0);
    assert.ok(box._state().viewer, 'viewer still open');
    box._handleKeypress({ name: 'escape' }); // close
    assert.equal(box._state().viewer, null);
    box._handleKeypress({ name: 'b', ctrl: true }); // now it detaches
    assert.equal(detached, 1);
  } finally {
    box.setBusy(null); // stop the spin timer
  }
});

// ── buildFrame: the statusRight bg marker has room and never wraps ──────────

test('buildFrame: bg marker in statusRight stays inside W at 34..100 cols', () => {
  for (const cols of [34, 50, 80, 100]) {
    const frame = buildFrame({
      text: '', cursor: 0, placeholder: '', hint: 'h', question: null,
      busy: null, statusRight: 'v0.34.0 · kilo · 1.2k ctx · bg t1▶', palette: null,
      viewer: null, menu: null, tick: 0,
    }, cols);
    for (const line of frame) assert.ok(strWidth(line) <= Math.min(Math.max(cols, 34), 100), `over ${cols}: ${line}`);
  }
});

// ── repl wiring tripwire (source checks — the REPL needs a TTY) ─────────────

test('repl wiring: mute branch, guards, queue note, completion note, exit guard all present', () => {
  const src = here('../src/terminal/repl.js');
  // onEvent mute: the record folds the event, nothing paints
  assert.match(src, /if \(bg\) \{\s*\n\s*bgBufferEvent\(bg, ev\);/);
  assert.match(src, /return; \/\/ muted: no render, no footer, no strip/);
  // stream mute: bytes still count, no strip
  assert.match(src, /if \(bg\) \{ bg\.bytes = turnStreamBytes; return; \}/);
  // esc + ctrl+c never kill a detached turn
  assert.match(src, /busy && aborter && !bg/);
  // approval auto-reattach
  assert.match(src, /needs approval — reattached/);
  // detach wiring + attach wiring
  assert.match(src, /rl\.on\('detach', \(\) => \{\s*\n\s*detachTurn\(\);/);
  assert.match(src, /function attachTurn\(rec\)/);
  // queue note names the task when detached, and never repaints a busy footer
  assert.match(src, /runs after task t\$\{bg\.id\} finishes/);
  // detached completion prints the note instead of the ribbon
  assert.match(src, /bgFinish\(bg, \{ at: Date\.now\(\), steps: out\.steps \|\| 0, said: out\.said, aborted: !!out\.aborted \}\)/);
  assert.match(src, /renderBgNote\(bg\)/);
  // the re-attached-then-finished record still closes (and drops bg on throw)
  assert.match(src, /if \(bg === turnBgRecord\) bg = null;/);
  // /tasks subcommands + exit guard
  assert.match(src, /case 'tasks': \{[\s\S]*?parseBgArgs\(args\)[\s\S]*?resolveBgId\(bgList/);
  assert.match(src, /still running in the background/);
  // safe-while-busy command allowlist exists
  assert.match(src, /const BUSY_OK = new Set\(/);
  // THE MUTEX RULE (v0.34.0 review catch): `!` and slash paths SAVE/RESTORE
  // busy — they run while a turn is in flight and must never release the
  // mutex a running turn holds.
  assert.match(src, /const wasBusy = busy;\s*\n\s*busy = true;/g);
  assert.match(src, /busy = wasBusy;/g);
  // statusRight shows the bg marker
  assert.match(src, /bg t\$\{bg\.id\}▶/);
});

test('inputbox wiring: busy ctx rides into applyKey; detach case routes to handlers', () => {
  const src = here('../src/terminal/inputbox.js');
  assert.match(src, /busy: Boolean\(busyLabel\) && mode === 'input'/);
  assert.match(src, /if \(ctx\.busy\) return \{ action: 'detach' \};/);
  assert.match(src, /if \(key\.ctrl && key\.name === 'b' && busyLabel && mode === 'input'/);
  assert.match(src, /case 'detach':/);
});

test('tasks.js: SEM painters only — no c.time-style phantom methods (import hygiene)', () => {
  const src = here('../src/terminal/tasks.js');
  assert.doesNotMatch(src, /\bc\.time\(/);
  assert.match(src, /import \{ c \} from '\.\/ui\.js';/);
  assert.match(src, /import \{ SEM, fmtDur, fmtTok, truncateVisible \} from '\.\/theme\.js';/);
});

// strWidth is imported for the buildFrame width assertion
import { strWidth } from '../src/terminal/text.js';
