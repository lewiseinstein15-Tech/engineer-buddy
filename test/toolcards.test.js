// toolcards.test.js — v0.33.0 better tool cards: collapse policy, OSC 52
// clipboard, /copy register. The v0.29 card hid the TAIL of long outputs —
// exactly where test runners and compilers print their verdict. These tests
// pin the head+tail policy, the hint contract the painter prints, and the
// clipboard wire format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLines, collapseHint, osc52, copyFits, fmtBytes, formatCopyTable, resolveCopyRef, CARDS } from '../src/terminal/toolcards.js';
import { renderObservation, renderToolEvent } from '../src/terminal/ui.js';

test('pickLines: short observations show whole', () => {
  const lines = ['a', 'b', 'c'];
  const p = pickLines(lines);
  assert.equal(p.kind, 'all');
  assert.deepEqual(p.shown, lines);
  assert.equal(p.hidden, 0);
});

test('pickLines: medium (6-10 lines) keeps the v0.29 head window', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line${i}`);
  const p = pickLines(lines);
  assert.equal(p.kind, 'head');
  assert.equal(p.shown.length, CARDS.SHOW_ALL);
  assert.equal(p.hidden, 3);
});

test('pickLines: long observations keep head AND tail — the verdict lines', () => {
  const lines = [
    '> npm test', 'suite A', '... runs', 'more', 'even more',
    '... 30 more lines ...', 'filler', 'filler2',
    'failing test 3', 'summary: 3 of 31 failed', 'exit 1', 'note: run with `npm test`',
  ];
  const p = pickLines(lines);
  assert.equal(p.kind, 'headtail');
  assert.deepEqual(p.shown[0], '> npm test');           // head kept
  assert.deepEqual(p.shown.at(-1), 'note: run with `npm test`'); // tail kept
  assert.equal(p.shown.at(-2), 'exit 1');
  assert.equal(p.hidden, lines.length - CARDS.HEAD - CARDS.TAIL);
});

test('pickLines: head/tail options are honored and clamped', () => {
  const p = pickLines(['a', 'b', 'c', 'd'], { showAll: 2, headOnlyMax: 2, head: 9, tail: 9 });
  assert.equal(p.kind, 'headtail');
  assert.deepEqual(p.shown, ['a', 'b', 'c', 'd']); // clamped to the whole input
  assert.equal(p.hidden, 0);
});

test('collapseHint: head window keeps the classic shape, /copy when indexed', () => {
  assert.equal(collapseHint(3, 'head'), '… +3 more lines');
  assert.equal(collapseHint(3, 'head', 4), '… +3 more lines · /copy 4 for the full output');
});

test('collapseHint: head+tail explains WHY the tail is there', () => {
  const h = collapseHint(27, 'headtail', 1);
  assert.match(h, /\+27 hidden lines/);
  assert.match(h, /tail is kept/);
  assert.match(h, /\/copy 1 for all/);
  assert.match(h, /ctrl\+o expands/);
  assert.equal(collapseHint(0, 'all'), '');
});

test('osc52: exact wire shape — ESC ] 52 ; c ; base64 BEL', () => {
  const esc = osc52('hello clipboard');
  assert.equal(esc, '\x1b]52;c;aGVsbG8gY2xpcGJvYXJk\x07');
  // round-trip: decode the payload back
  const b64 = esc.slice('\x1b]52;c;'.length, -1);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'hello clipboard');
});

test('osc52: utf8 payloads survive (CJK, emoji-free but multibyte)', () => {
  const esc = osc52('中文测试 ✓');
  const b64 = esc.slice('\x1b]52;c;'.length, -1);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '中文测试 ✓');
});

test('osc52 refuses oversized payloads; copyFits gates honestly', () => {
  const big = 'x'.repeat(CARDS.COPY_MAX + 1);
  assert.equal(copyFits(big), false);
  assert.equal(copyFits('x'.repeat(CARDS.COPY_MAX)), true);
  assert.throws(() => osc52(big), /too large/);
});

test('fmtBytes: human sizes', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(850), '850 B');
  assert.equal(fmtBytes(2400), '2.4 kB');
  assert.equal(fmtBytes(1_200_000), '1.2 MB');
});

test('formatCopyTable: newest-first rows with size + first line preview', () => {
  const reg = [
    { n: 1, tool: 'bash', text: 'npm test\nFAIL a\nFAIL b', denied: false },
    { n: 2, tool: 'fs_replace', text: 'ok — replaced 1 hunk', denied: false },
    { n: 3, tool: 'bash', text: 'denied by policy', denied: true },
  ];
  const rows = formatCopyTable(reg);
  assert.equal(rows[0][0], '1');
  assert.equal(rows[0][1], 'bash');
  assert.match(rows[0][4], /^npm test FAIL a FAIL b/);
  assert.equal(rows[2][3], 'denied');
});

test('resolveCopyRef: newest = 1, /rewind numbering; reply alias; honest errors', () => {
  const reg = [
    { tool: 'bash', text: 'newest' },
    { tool: 'say', text: 'the answer' },
    { tool: 'fs_read', text: 'oldest' },
  ];
  assert.equal(resolveCopyRef(reg, '1').entry.text, 'newest');
  assert.equal(resolveCopyRef(reg, '1').n, 1);
  assert.equal(resolveCopyRef(reg, '3').entry.text, 'oldest');
  assert.equal(resolveCopyRef(reg, 'reply').entry.tool, 'say');
  assert.match(resolveCopyRef(reg, '9').error, /holds 1-3/);
  assert.match(resolveCopyRef([], '1').error, /register is empty/);
  assert.equal(resolveCopyRef(reg, 'reply').n, 2);
});

// ── The painter keeps its verdict contract while the policy changed ─────────

test('renderObservation: verdict marks survive the new policy', () => {
  const ok = renderObservation('all good\nline2');
  assert.match(ok, /✓/);
  const bad = renderObservation('ERROR: kaboom\nat line 2', { denied: false });
  assert.match(bad, /✗/);
  const denied = renderObservation('fine text', { denied: true });
  assert.match(denied, /✗/);
  assert.match(renderObservation(''), /no output/);
});

test('renderObservation: long output shows head + tail + /copy hint (the fix)', () => {
  const lines = ['> npm test', ...Array.from({ length: 20 }, (_, i) => `pass ${i}`), 'failing: cart.test.js', 'exit 1'];
  const out = renderObservation(lines.join('\n'), { obsIndex: 1 });
  const outLines = out.split('\n');
  assert.match(outLines[0], /> npm test/); // head line 1 (with verdict mark)
  assert.match(outLines.at(-1), /\/copy 1 for all/);
  assert.match(outLines.at(-1), /tail is kept/);
  // THE REGRESSION v0.33.0 FIXES: the tail verdict lines must be visible
  assert.match(out, /exit 1/);
  assert.match(out, /failing: cart\.test\.js/);
});

test('renderObservation: verbose never shows less than its collapsed twin', () => {
  const obs = Array.from({ length: 31 }, (_, i) => `row${i}`).join('\n');
  const collapsed = renderObservation(obs, {});
  const verbose = renderObservation(obs, { maxLines: 24, maxChars: 1200, headOnlyMax: CARDS.VERBOSE_SHOW, head: CARDS.VERBOSE_HEAD, tail: CARDS.VERBOSE_TAIL });
  const visLines = (s) => s.split('\n').length;
  assert.ok(visLines(verbose) > visLines(collapsed), 'verbose card must be taller than collapsed');
  assert.match(verbose, /row0/);  // head kept
  assert.match(verbose, /row30/); // tail kept
});

test('renderToolEvent passes obsIndex to the hint', () => {
  const ev = { tool: 'bash', argText: 'npm test', observation: Array.from({ length: 15 }, (_, i) => `l${i}`).join('\n'), denied: false };
  const out = renderToolEvent(ev, { obsIndex: 2 });
  assert.match(out, /\/copy 2 for all/);
});
