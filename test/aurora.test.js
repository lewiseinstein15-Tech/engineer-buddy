// aurora.test.js — the semantic stream language (v0.29.0).
//
// Aurora contract: hue = what, glyph = what happened, mark = how it ended.
// Every painter must degrade: 256 → 16 → mono identity, and NO_COLOR /
// non-TTY / /theme mono must silence the whole layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colorLevel,
  setLevel,
  getLevel,
  hue,
  SEM,
  toolStyle,
  pickVerb,
  VERBS,
  fmtDur,
  fmtTok,
  buildAuroraStrip,
  wrapWords,
  renderDoneRibbon,
  truncateVisible,
} from '../src/terminal/theme.js';
import { renderToolCall, renderObservation, renderToolEvent, setTheme } from '../src/terminal/ui.js';
import { applyKey, buildFrame, createInputBox } from '../src/terminal/inputbox.js';
import { stripAnsi, strWidth } from '../src/terminal/text.js';

// ── capability detection ─────────────────────────────────────────────────────

test('colorLevel: NO_COLOR, COLORTERM, TERM and non-TTY degrade correctly', () => {
  const tty = true;
  assert.equal(colorLevel({ NO_COLOR: '1', TERM: 'xterm-256color' }, tty), 'none');
  assert.equal(colorLevel({ TERM: 'xterm-256color' }, false), 'none');
  assert.equal(colorLevel({ COLORTERM: 'truecolor', TERM: 'xterm' }, tty), 'true');
  assert.equal(colorLevel({ TERM: 'xterm-256color' }, tty), '256');
  assert.equal(colorLevel({ TERM: 'vt100' }, tty), '16');
  assert.equal(colorLevel({}, tty), '16');
});

test('setLevel/getLevel: only known levels accepted, invalid falls back', () => {
  setLevel('256');
  assert.equal(getLevel(), '256');
  setLevel('bogus');
  assert.equal(['none', '16', '256', 'true'].includes(getLevel()), true);
  setLevel('none');
  assert.equal(getLevel(), 'none');
});

// ── painters degrade ─────────────────────────────────────────────────────────

test('hue: 256 wraps in 38;5 codes, 16 uses the fallback, none is identity', () => {
  setLevel('256');
  assert.match(hue(114, 32)('x'), /\x1b\[38;5;114mx\x1b\[0m/);
  setLevel('16');
  assert.match(hue(114, 32)('x'), /\x1b\[32mx\x1b\[0m/);
  setLevel('none');
  assert.equal(hue(114, 32)('x'), 'x');
});

test('SEM painters at level none are pure identity (mono contract)', () => {
  setLevel('none');
  for (const [name, paint] of Object.entries(SEM)) {
    assert.equal(paint('hello'), 'hello', `SEM.${name} must be identity at level none`);
  }
});

// ── tool families ────────────────────────────────────────────────────────────

test('toolStyle: every family maps to a glyph, unknown tools fall to teal mcp', () => {
  setLevel('none');
  assert.equal(toolStyle('bash').family, 'shell');
  assert.equal(toolStyle('bash').glyph, '▸');
  assert.equal(toolStyle('fs_read').family, 'read');
  assert.equal(toolStyle('fs_write').glyph, '✎');
  assert.equal(toolStyle('git_write').family, 'git');
  assert.equal(toolStyle('web_search').family, 'web');
  assert.equal(toolStyle('todo').family, 'plan');
  assert.equal(toolStyle('task').family, 'agent');
  assert.equal(toolStyle('test').family, 'test');
  assert.equal(toolStyle('mcp__docs_search').family, 'mcp');
  assert.equal(toolStyle('totally_unknown').family, 'mcp');
  assert.equal(toolStyle(null).glyph, '⇄');
});

test('toolStyle painters carry family hue at 256', () => {
  setLevel('256');
  const painted = toolStyle('bash').paint('▸');
  assert.match(painted, /\x1b\[38;5;114m▸\x1b\[0m/);
  setLevel('none');
});

// ── verb state machine ───────────────────────────────────────────────────────

test('pickVerb: thinking → forming → streaming → verifying (pure)', () => {
  assert.equal(pickVerb(null), VERBS.thinking);
  assert.equal(pickVerb({ tool: null, message: '', messageClosed: false }), VERBS.thinking);
  assert.equal(pickVerb({ tool: 'bash', message: '', messageClosed: false }), VERBS.forming);
  assert.equal(pickVerb({ tool: null, message: 'words are landing', messageClosed: false }), VERBS.streaming);
  assert.equal(pickVerb({ tool: null, message: 'done', messageClosed: true }), VERBS.verifying);
  // tool wins over message (a call being formed is the stronger signal)
  assert.equal(pickVerb({ tool: 'bash', message: 'say words', messageClosed: false }), VERBS.forming);
});

// ── formatters ───────────────────────────────────────────────────────────────

test('fmtDur: ms / s / m+s shapes', () => {
  assert.equal(fmtDur(850), '850ms');
  assert.equal(fmtDur(4200), '4.2s');
  assert.equal(fmtDur(66000), '1m06s');
  assert.equal(fmtDur(0), '0ms');
  assert.equal(fmtDur(-5), '0ms');
  assert.equal(fmtDur('nonsense'), '0ms');
});

test('fmtTok: bytes → tokens estimate with k/M units', () => {
  assert.equal(fmtTok(0), '0');
  assert.equal(fmtTok(400), '100');
  assert.equal(fmtTok(5600), '1.4k');
  assert.equal(fmtTok(4800000), '1.2M');
  assert.equal(fmtTok(undefined), '0');
});

// ── aurora strip ─────────────────────────────────────────────────────────────

test('buildAuroraStrip: 3 lines when narrating + forming; telemetry last', () => {
  setLevel('none');
  const lines = buildAuroraStrip({
    snap: { tool: 'bash', message: 'researching kimi 3.1', messageClosed: false, raw: '{"tool":"bash","args":{"command":"npm te' },
    ms: 46000, bytes: 5600, cols: 80, tick: 2, toolCalls: 3,
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /✻ forming/); // tool present → forming wins
  assert.match(lines[0], /researching kimi 3\.1/);
  assert.match(lines[1], /bash/);
  assert.match(lines[2], /↓ 1\.4k tok · 3 tool calls · 46\.0s/);
});

test('buildAuroraStrip: quiet on raw JSON prefix with no decodable signal', () => {
  setLevel('none');
  assert.deepEqual(buildAuroraStrip({ snap: { tool: null, message: '', messageClosed: false, raw: '{"too' } }), []);
});

test('buildAuroraStrip: no snap → no strip; say-only stream drops the tool line', () => {
  setLevel('none');
  assert.deepEqual(buildAuroraStrip({}), []);
  const lines = buildAuroraStrip({ snap: { tool: null, message: 'wrapping up', messageClosed: false, raw: '' }, ms: 1200, bytes: 400, cols: 80, tick: 0, toolCalls: 1 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /✻ streaming/);
  assert.match(lines[1], /↓ 100 tok/);
});

test('buildAuroraStrip: every line fits the width (ghost-box killer)', () => {
  setLevel('none');
  const lines = buildAuroraStrip({
    snap: { tool: 'web_search', message: 'x'.repeat(400), messageClosed: false, raw: '{"tool":"web_search","args":{"query":"' + 'y'.repeat(200) },
    ms: 12000, bytes: 90000, cols: 40, tick: 0, toolCalls: 9,
  });
  for (const l of lines) assert.ok(l.length <= 40, `line too wide: ${l.length}`);
});

test('buildAuroraStrip: gradient edge is ANSI-painted at 256 and plain at none', () => {
  setLevel('256');
  const [painted] = buildAuroraStrip({ snap: { tool: null, message: 'hi', messageClosed: false, raw: '' }, ms: 0, bytes: 0, cols: 80, tick: 3, toolCalls: 0 });
  assert.match(painted, /\x1b\[38;5;\d+m▐/);
  setLevel('none');
  const [plain] = buildAuroraStrip({ snap: { tool: null, message: 'hi', messageClosed: false, raw: '' }, ms: 0, bytes: 0, cols: 80, tick: 3, toolCalls: 0 });
  assert.ok(plain.startsWith('▐'));
});

test('truncateVisible: preserves ANSI codes, counts visible width only', () => {
  setLevel('none');
  const styled = `\x1b[38;5;114m${'ab'}\x1b[0m`;
  assert.equal(stripAnsi(truncateVisible(styled, 2)), 'ab');
  const long = `\x1b[38;5;114m${'abcdef'}\x1b[0m`;
  const cut = truncateVisible(long, 3);
  assert.ok(stripAnsi(cut).startsWith('ab'));
  assert.ok(cut.endsWith('…'));
});

// ── done ribbon ──────────────────────────────────────────────────────────────

test('renderDoneRibbon: green when clean, amber on denial, red on errors', () => {
  setLevel('none');
  const clean = renderDoneRibbon({ steps: 3, tools: 4, ms: 12400, bytes: 8400 });
  assert.match(clean, /● Done — 3 steps · 4 tool calls · 12\.4s · ↓ 2\.1k tok/);
  const denied = renderDoneRibbon({ steps: 4, tools: 2, ms: 8100, denied: 1 });
  assert.match(denied, /1 denied/);
  const failed = renderDoneRibbon({ steps: 2, tools: 1, ms: 3300, errors: 1 });
  assert.match(failed, /1 failed/);
  // singular forms
  assert.match(renderDoneRibbon({ steps: 1, tools: 1, ms: 100 }), /1 step · 1 tool call/);
});

// ── ui.js integration (Aurora skin) ─────────────────────────────────────────

test('renderToolCall: family glyph + dotted leader + right-aligned duration', () => {
  setLevel('none');
  const line = renderToolCall({ tool: 'bash', argText: 'npm test', durationMs: 420, cols: 60 });
  assert.match(line, /^▸ bash npm test ·+ 420ms$/);
  const violet = renderToolCall({ tool: 'fs_write', argText: 'src/auth.js', durationMs: 1200, cols: 60 });
  assert.match(violet, /^✎ fs_write src\/auth\.js ·+ 1\.2s$/);
});

test('renderToolCall: no duration → classic compact shape; denied keeps (denied)', () => {
  setLevel('none');
  assert.equal(stripAnsi(renderToolCall({ tool: 'bash', argText: 'npm test' })), '▸ bash npm test');
  assert.match(renderToolCall({ tool: 'fs_write', denied: true }), /✗|denied/);
  assert.match(renderToolCall({ tool: 'fs_write', denied: true }), /denied/);
});

test('renderToolCall: narrow terminal degrades to no leader (never wraps)', () => {
  setLevel('none');
  const line = renderToolCall({ tool: 'bash', argText: 'a'.repeat(200), durationMs: 5000, cols: 40 });
  assert.ok(!line.includes('····'), 'no leader when the args already fill the line');
});

test('renderObservation: ✓ on clean output, ✗ on ERROR/BLOCKED/denied', () => {
  setLevel('none');
  assert.match(renderObservation('exit 0 (0.0s)\nhi'), /⎿ ✓ exit 0/);
  assert.match(renderObservation('ERROR: file not found'), /⎿ ✗ ERROR: file not found/);
  assert.match(renderObservation('BLOCKED by hook: nope'), /✗/);
  assert.match(renderObservation('some output', { denied: true }), /✗ some output/);
  assert.match(renderObservation(''), /no output/);
  // multi-line: mark only on the first line
  const multi = renderObservation('line1\nline2\nline3');
  assert.match(multi, /⎿ ✓ line1\n  ⎿ line2\n  ⎿ line3/);
});

test('renderToolEvent: duration + denial flow through the card', () => {
  setLevel('none');
  const card = renderToolEvent({ tool: 'git', argText: 'commit -m x', observation: 'committed abc123', denied: false, durationMs: 310 });
  assert.match(card, /^⎇ git commit -m x ·+ 310ms\n  ⎿ ✓ committed abc123$/);
  const denied = renderToolEvent({ tool: 'bash', argText: 'rm -rf /', observation: 'DENIED by the user: the action did NOT run.', denied: true, durationMs: 5 });
  assert.match(denied, /✗ DENIED by the user/);
});

// ── /theme mono silences Aurora (the mono contract) ──────────────────────────

test('setTheme(mono) forces the semantic layer to identity, others re-arm it', () => {
  setLevel('256');
  assert.equal(setTheme('mono'), 'mono');
  assert.equal(getLevel(), 'none');
  assert.equal(toolStyle('bash').paint('▸'), '▸');
  assert.equal(setTheme('dark'), 'dark');
  // re-arms from the terminal's real capability — under `node --test` stdout
  // is NOT a TTY, so the honest level here is 'none' (not a hard-coded value)
  assert.equal(getLevel(), colorLevel());
  // restore for other tests in the process
  setLevel('none');
});

// ── expand / collapse — collapsible thinking (v0.30.0, ctrl+o) ───────────────

test('wrapWords: word wrap to width, overlong word kept intact', () => {
  assert.deepEqual(wrapWords('one two three four five', 8), ['one two', 'three', 'four', 'five']);
  assert.deepEqual(wrapWords('one two three four five', 9), ['one two', 'three', 'four five']);
  assert.deepEqual(wrapWords('supercalifragilistic', 8), ['supercalifragilistic']); // intact — painter truncates
  assert.deepEqual(wrapWords('', 40), []);
  assert.deepEqual(wrapWords('a', 0), ['a']); // degenerate width still yields the word
});

test('buildAuroraStrip collapsed: long narration stays ONE row, oldest words kept, newest lost behind …', () => {
  setLevel('none');
  const words = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' ');
  const [row] = buildAuroraStrip({ snap: { tool: null, message: words, messageClosed: false, raw: '' }, ms: 1000, bytes: 400, cols: 80, tick: 0, toolCalls: 1 });
  assert.match(row, /w00/);          // head survives
  assert.ok(!row.includes('w39'));   // newest words truncated away — THE loss ctrl+o fixes
  assert.ok(row.endsWith('…"'));     // truncation inside the closing quote
});

test('buildAuroraStrip verbose: narration expands to 3 tail rows — newest words visible', () => {
  setLevel('none');
  const words = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' ');
  const lines = buildAuroraStrip({ snap: { tool: 'bash', message: words, messageClosed: false, raw: '{"tool":"bash"' }, ms: 46000, bytes: 5600, cols: 80, tick: 2, toolCalls: 3, verbose: true });
  assert.equal(lines.length, 5); // 3 narration + tool + telemetry
  assert.match(lines[0], /✻ forming/); // tool present → forming wins (pickVerb)
  assert.match(lines[0], /"/);
  assert.match(lines[1], /⌄/);
  assert.match(lines[2], /⌄/);
  assert.match(stripAnsi(lines[2]), /w39/);  // the NEWEST words are on screen
  assert.ok(!stripAnsi(lines.join('\n')).includes('w00 ')); // oldest dropped instead
  assert.match(lines[3], /bash/);            // tool line shifted, intact
  assert.match(lines[4], /↓ 1\.4k tok · 3 tool calls · 46\.0s/);
});

test('buildAuroraStrip verbose: every row fits the width (ghost-box killer holds expanded)', () => {
  setLevel('none');
  const lines = buildAuroraStrip({
    snap: { tool: 'web_search', message: ('x '.repeat(200)).trim(), messageClosed: false, raw: '{"tool":"web_search"' },
    ms: 12000, bytes: 90000, cols: 40, tick: 0, toolCalls: 9, verbose: true,
  });
  for (const l of lines) assert.ok(strWidth(l) <= 40, `row too wide: ${strWidth(l)}`);
});

test('buildAuroraStrip verbose: closing quote lands on the last row when the message completes', () => {
  setLevel('none');
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const lines = buildAuroraStrip({ snap: { tool: null, message: words, messageClosed: true, raw: '' }, ms: 3000, bytes: 1200, cols: 60, tick: 1, toolCalls: 2, verbose: true });
  const narr = lines.filter((l) => l.includes('✻') || l.includes('⌄'));
  assert.equal(narr.length, 3);
  assert.ok(stripAnsi(narr[2]).endsWith('"'));
  // open stream (not closed) has no trailing quote
  const open = buildAuroraStrip({ snap: { tool: null, message: words, messageClosed: false, raw: '' }, ms: 3000, bytes: 1200, cols: 60, tick: 1, toolCalls: 2, verbose: true });
  const openNarr = open.filter((l) => l.includes('⌄'));
  assert.ok(!stripAnsi(openNarr[openNarr.length - 1]).endsWith('"'));
});

test('buildAuroraStrip verbose: short message keeps the collapsed shape (one row)', () => {
  setLevel('none');
  const lines = buildAuroraStrip({ snap: { tool: null, message: 'wrapping up', messageClosed: false, raw: '' }, ms: 1200, bytes: 400, cols: 80, tick: 0, toolCalls: 1, verbose: true });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /✻ streaming · "wrapping up/);
  assert.match(lines[1], /↓ 100 tok/);
});

test('applyKey: ctrl+o is the verbose-toggle; plain o still inserts', () => {
  assert.deepEqual(applyKey({ ctrl: true, name: 'o' }), { action: 'verbose-toggle' });
  assert.deepEqual(applyKey({ sequence: 'o' }), { action: 'insert', data: 'o' });
});

test('buildFrame: verbose state expands the strip inside the frame, collapsed does not', () => {
  setLevel('none');
  const words = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' ');
  const busy = { label: 'Buddy working…', secs: 5, glyph: '⠋' };
  const snap = { tool: null, message: words, messageClosed: false, raw: '' };
  const expanded = buildFrame({ text: '', cursor: 0, busy, thought: snap, toolCalls: 2, tick: 3, verbose: true, hint: '' }, 80);
  assert.equal(expanded.filter((l) => l.includes('✻')).length, 1);
  assert.equal(expanded.filter((l) => l.includes('⌄')).length, 2);
  for (const l of expanded) assert.ok(strWidth(l) <= 80, 'frame row overflow');
  const collapsed = buildFrame({ text: '', cursor: 0, busy, thought: snap, toolCalls: 2, tick: 3, hint: '' }, 80);
  assert.equal(collapsed.filter((l) => l.includes('⌄')).length, 0);
});

test('box: ctrl+o toggles verbose state and notifies the repl (twice = back to collapsed)', () => {
  setLevel('none');
  const writes = [];
  const fakeStdout = { isTTY: true, columns: 100, write: (s) => { writes.push(s); }, on: () => {}, removeListener: () => {} };
  const seen = [];
  const rl = createInputBox({ title: 'Buddy', placeholder: '', hint: '' });
  rl.on('verbose', (on) => seen.push(on));
  const origStdout = process.stdout;
  Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });
  try {
    assert.equal(rl._state().verbose, false);
    rl._handleKeypress({ ctrl: true, name: 'o' });
    assert.equal(rl._state().verbose, true);
    rl._handleKeypress({ ctrl: true, name: 'o' });
    assert.equal(rl._state().verbose, false);
  } finally {
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  }
  assert.deepEqual(seen, [true, false]);
});

test('renderToolEvent verbose: observation keeps more than the collapsed 5-line cap', () => {
  setLevel('none');
  const obs = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
  const collapsed = renderToolEvent({ tool: 'bash', argText: 'node cart.test.js', observation: obs, durationMs: 900 });
  assert.match(collapsed, /… \+3 more lines/);
  const expanded = renderToolEvent({ tool: 'bash', argText: 'node cart.test.js', observation: obs, durationMs: 900 }, { verbose: true });
  assert.match(expanded, /line 8/);
  assert.ok(!expanded.includes('more lines'));
  // collapsed still caps — the default is the compact card
  assert.ok(!collapsed.includes('line 8'));
});
