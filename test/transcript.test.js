// Tests for the ctrl+r transcript viewer (v0.31.0) — transcript.js pure half
// + the input box's capture buffer and viewer key routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAnsi, sanitizeChunk, applyViewerKey, buildTranscriptPanel, viewerBodyRows, VIEWER } from '../src/terminal/transcript.js';
import { strWidth } from '../src/terminal/text.js';
import { applyKey, buildFrame, createInputBox } from '../src/terminal/inputbox.js';

// ── sanitize: keep the color, drop the corruption ───────────────────────────

test('sanitizeAnsi: keeps SGR color, strips cursor moves / OSC / lone ESC / bare CR', () => {
  const in1 = '\x1b[38;5;177mcard\x1b[0m rest';
  assert.equal(sanitizeAnsi(in1), '\x1b[38;5;177mcard\x1b[0m rest');
  assert.equal(sanitizeAnsi('\x1b[2Aup\x1b[J'), 'up');               // cursor CSI
  assert.equal(sanitizeAnsi('\x1b]0;title\x07hello'), 'hello');      // OSC … BEL
  assert.equal(sanitizeAnsi('\x1b]8;;url\x1b\\link'), 'link');       // OSC … ST
  assert.equal(sanitizeAnsi('a\x1bb'), 'ab');                        // lone ESC
  assert.equal(sanitizeAnsi('\x1b[?25lcur'), 'cur');                 // private mode
  assert.equal(sanitizeAnsi('prog\rmore'), 'progmore');              // bare \r redraw
  assert.equal(sanitizeAnsi('a\r\nb'), 'a\nb');                      // CRLF normalized
});

test('sanitizeChunk: splits lines, drops trailing blanks, keeps interior ones', () => {
  assert.deepEqual(sanitizeChunk('a\nb\n'), ['a', 'b']);
  assert.deepEqual(sanitizeChunk('a\n\nb\n\n'), ['a', '', 'b']);
  assert.deepEqual(sanitizeChunk(''), []);
  assert.deepEqual(sanitizeChunk('\n\n'), []);
  const colored = sanitizeChunk('\x1b[32mok\x1b[0m\n');
  assert.equal(colored[0], '\x1b[32mok\x1b[0m');
});

// ── the viewer's key reducer: the pager owns every key while open ───────────

test('applyViewerKey: esc / ctrl+r / ctrl+c / q all close — never interrupt, never quit', () => {
  assert.equal(applyViewerKey({ name: 'escape' }).action, 'close');
  assert.equal(applyViewerKey({ sequence: '\x1b' }).action, 'close');
  assert.equal(applyViewerKey({ ctrl: true, name: 'r' }).action, 'close');
  assert.equal(applyViewerKey({ ctrl: true, name: 'c' }).action, 'close'); // pager-first
  assert.equal(applyViewerKey({ name: 'q', sequence: 'q' }).action, 'close');
});

test('applyViewerKey: scroll by line and page, jump to top/bottom', () => {
  assert.equal(applyViewerKey({ name: 'up' }).action, 'up');
  assert.equal(applyViewerKey({ name: 'down' }).action, 'down');
  assert.equal(applyViewerKey({ name: 'pageup' }).action, 'pageup');
  assert.equal(applyViewerKey({ name: 'pagedown' }).action, 'pagedown');
  assert.equal(applyViewerKey({ name: 'home' }).action, 'top');
  assert.equal(applyViewerKey({ name: 'end' }).action, 'bottom');
  assert.equal(applyViewerKey({ sequence: 'g' }).action, 'top');
  assert.equal(applyViewerKey({ sequence: 'G' }).action, 'bottom');
  assert.equal(applyViewerKey({ name: 'g', shift: true, sequence: 'G' }).action, 'bottom');
});

test('applyViewerKey: every other key is inert — the draft is untouchable', () => {
  assert.equal(applyViewerKey({ sequence: 'x' }).action, null);
  assert.equal(applyViewerKey({ name: 'backspace' }).action, null);
  assert.equal(applyViewerKey({ name: 'return' }).action, null);
  assert.equal(applyViewerKey({ name: 'tab' }).action, null);
  assert.equal(applyViewerKey({ name: 'up', ctrl: true }).action, null);
});

// ── the panel painter ────────────────────────────────────────────────────────

test('buildTranscriptPanel: live tail by default — the newest lines win', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
  const panel = buildTranscriptPanel({ lines, cols: 80, rows: 8, scroll: 0 });
  const joined = panel.join('\n');
  assert.ok(joined.includes('✦ transcript'), 'header title');
  assert.ok(joined.includes('40 lines'), 'header count');
  assert.ok(joined.includes('live tail'), 'tail marker');
  assert.ok(joined.includes('line 39'), 'newest line visible');
  assert.ok(!joined.includes('line 00'), 'oldest line culled');
  assert.ok(joined.includes('esc close'), 'footer hint');
});

test('buildTranscriptPanel: scrolling up reveals older lines and says how far', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
  const top = buildTranscriptPanel({ lines, cols: 80, rows: 8, scroll: 1e9 });
  const topJoined = top.join('\n');
  assert.ok(topJoined.includes('line 00'), 'top of the transcript visible');
  assert.ok(!topJoined.includes('line 39'), 'tail pushed out');
  assert.ok(topJoined.includes('↑ '), 'scroll marker');
  const mid = buildTranscriptPanel({ lines, cols: 80, rows: 8, scroll: 10 });
  assert.ok(mid.join('\n').includes('line 29') && !mid.join('\n').includes('line 39'));
});

test('buildTranscriptPanel: clamps scroll past the top and at zero', () => {
  const lines = ['a', 'b', 'c'];
  const panel = buildTranscriptPanel({ lines, cols: 80, rows: 8, scroll: 1e9 }).join('\n');
  assert.ok(panel.includes('a') && panel.includes('c'), 'short transcript fully visible, no over-scroll');
  assert.ok(panel.includes('empty') === false && panel.includes('live tail'), 'short + scrolled to top = tail again');
  const z = buildTranscriptPanel({ lines, cols: 80, rows: 8, scroll: -5 }).join('\n');
  assert.ok(z.includes('live tail'));
});

test('buildTranscriptPanel: empty transcript says so honestly', () => {
  const panel = buildTranscriptPanel({ lines: [], cols: 80, rows: 8, scroll: 0 });
  const joined = panel.join('\n');
  assert.ok(joined.includes('nothing yet'), 'honest empty state');
  assert.ok(joined.includes('empty'), 'range marker');
});

test('buildTranscriptPanel: every line is width-capped — the ghost-box killer holds', () => {
  const long = 'x'.repeat(400);
  const cjk = '中'.repeat(80); // 160 columns wide
  const panel = buildTranscriptPanel({ lines: [long, cjk, 'short'], cols: 100, rows: 10, scroll: 0 });
  for (const l of panel) assert.ok(strWidth(l) <= 100, `line too wide: ${strWidth(l)}`);
  assert.ok(panel.length >= 13, 'header + body viewport + border + footer');
});

test('buildTranscriptPanel: busy note shows the turn keeps running', () => {
  const panel = buildTranscriptPanel({ lines: ['card'], cols: 80, rows: 8, scroll: 0, busy: { label: 'working · 1 tool call', secs: 4, glyph: '⠋' } });
  assert.ok(panel.join('\n').includes('turn still running'));
});

test('viewerBodyRows: fits the terminal minus chrome, clamped both ways', () => {
  assert.equal(viewerBodyRows(24), 17);   // 24 - 7
  assert.equal(viewerBodyRows(8), VIEWER.MIN_BODY);
  assert.equal(viewerBodyRows(200), VIEWER.MAX_BODY);
  assert.equal(viewerBodyRows(undefined), 17); // sane default
});

// ── the box: capture buffer + key routing ───────────────────────────────────

test('applyKey: ctrl+r opens the transcript viewer', () => {
  assert.equal(applyKey({ ctrl: true, name: 'r' }).action, 'transcript');
});

function fakeStreams() {
  const writes = [];
  const stdout = {
    columns: 100,
    rows: 24,
    write: (s, ...r) => { writes.push(String(s)); return true; },
    on: () => {},
    removeListener: () => {},
  };
  return { writes, stdout };
}

function withFakeStdout(fn) {
  const { writes, stdout } = fakeStreams();
  const orig = process.stdout;
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try { return fn(writes); } finally {
    Object.defineProperty(process, 'stdout', { value: orig, configurable: true });
  }
}

test('createInputBox: ctrl+r opens the viewer over the box; the panel renders the captured session', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    rl._capture('  \x1b[38;5;177m❯\x1b[0m fix the cart bug\n');
    rl._capture('  ▸ bash \x1b[38;5;245mnode cart.test.js\x1b[0m ····· 6ms\n');
    rl._capture('  ⎿ ✓ exit 0\n');
    rl._handleKeypress({ ctrl: true, name: 'r' });
    assert.ok(rl._state().viewer, 'viewer open');
    assert.equal(rl._state().transcriptLines, 3);
    rl.prompt();
    assert.ok(rl._state().text === '');
  });
});

test('createInputBox: capture keeps SGR color and counts lines', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    rl._capture('\x1b[38;5;114mok\x1b[0m\nplain\n');
    assert.equal(rl._state().transcriptLines, 2);
  });
});

test('createInputBox: the viewer is a pager — esc closes, the draft survives, letters are inert', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    for (const k of [{ sequence: 'h' }, { sequence: 'i' }]) rl._handleKeypress(k);
    assert.equal(rl._state().text, 'hi');
    rl._handleKeypress({ ctrl: true, name: 'r' });
    rl._handleKeypress({ sequence: 'X' });   // inert while open
    rl._handleKeypress({ name: 'backspace' }); // inert while open
    assert.equal(rl._state().text, 'hi', 'editor untouched while browsing');
    rl._handleKeypress({ name: 'escape' });
    assert.equal(rl._state().viewer, null, 'esc closed the viewer');
    assert.equal(rl._state().text, 'hi', 'draft intact after close');
    rl._handleKeypress({ sequence: '!' }); // editor lives again
    assert.equal(rl._state().text, 'hi!');
  });
});

test('createInputBox: ctrl+r toggles; scrolling updates; G returns to the live tail', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    for (let i = 0; i < 60; i++) rl._capture(`row ${i}\n`);
    rl._handleKeypress({ ctrl: true, name: 'r' });
    rl._handleKeypress({ name: 'up' });
    rl._handleKeypress({ name: 'up' });
    assert.equal(rl._state().viewer.scroll, 2);
    rl._handleKeypress({ name: 'pageup' });
    assert.ok(rl._state().viewer.scroll > 10, 'pageup jumped a body-page');
    rl._handleKeypress({ sequence: 'G' });
    assert.equal(rl._state().viewer.scroll, 0, 'back to the tail');
    rl._handleKeypress({ ctrl: true, name: 'r' }); // toggle closed
    assert.equal(rl._state().viewer, null);
  });
});

test('createInputBox: the buffer is capped — old lines fall off the top', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    for (let i = 0; i < VIEWER.MAX_BUFFER + 120; i++) rl._capture(`line ${i}\n`);
    assert.equal(rl._state().transcriptLines, VIEWER.MAX_BUFFER);
  });
});

test('buildFrame: viewer state renders the panel instead of the box', () => {
  const lines = ['  ❯ fix the bug', '  ▸ bash npm test ··· 1.2s'];
  const frame = buildFrame({
    text: 'draft', cursor: 5,
    viewer: { open: true, rows: 6, scroll: 0 },
    transcript: lines,
  }, 100);
  const joined = frame.join('\n');
  assert.ok(joined.includes('✦ transcript'));
  assert.ok(joined.includes('fix the bug'));
  assert.ok(!joined.includes('draft'), 'the box is replaced, not stacked');
  for (const l of frame) assert.ok(strWidth(l) <= 100);
});

test('buildFrame: no viewer state → the classic box frame is untouched', () => {
  const frame = buildFrame({ text: 'draft', cursor: 5, transcript: null, viewer: null }, 100);
  const joined = frame.join('\n');
  assert.ok(joined.includes('draft'));
  assert.ok(!joined.includes('✦ transcript'));
});

test('regression (v0.31.0 drill catch): the prompt echo flushes as its own line — the next print can never glue onto it', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    // submit a prompt, then let the app print a tool card with NO leading newline —
    // exactly what the live todo card does right after the echo. Pre-fix, the
    // unterminated echo sat in the renderer's pending buffer and the card
    // fused onto it: one capture line, one wrapped row on the live screen.
    rl._handleKeypress({ sequence: 'h' });
    rl._handleKeypress({ sequence: 'i' });
    rl._handleKeypress({ name: 'return' });
    rl._capture('☑ todo 4 items\n');
    assert.equal(rl._state().transcriptLines, 2, 'echo + card are two separate lines');
  });
});

test('regression: an unterminated print followed by another print stays two lines in the capture', () => {
  withFakeStdout(() => {
    const rl = createInputBox({ title: 'Buddy', hint: 'h' });
    // simulate the pre-fix byte pattern directly through the capture seam:
    // sanitizeChunk must split what the renderer flushes; the renderer now
    // receives the echo pre-terminated, so a fused line can only appear if
    // someone removes the \n again — this pins the capture-side contract.
    rl._capture('  ❯ hello\n');
    rl._capture('☑ todo 4 items\n');
    assert.equal(rl._state().transcriptLines, 2);
  });
});
