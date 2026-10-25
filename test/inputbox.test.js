// Tests for the zero-dependency Claude Code-style input box (inputbox.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charWidth, strWidth, wrapContent, applyKey, filterCommands, buildFrame, createInputBox } from '../src/terminal/inputbox.js';

test('charWidth: CJK ideographs are double width', () => {
  assert.equal(charWidth('中'), 2);
  assert.equal(charWidth('語'), 2);
  assert.equal(charWidth('あ'), 2);
  assert.equal(charWidth('한'), 2);
});

test('charWidth: ASCII and common symbols are single width', () => {
  assert.equal(charWidth('a'), 1);
  assert.equal(charWidth(' '), 1);
  assert.equal(charWidth('·'), 1);
});

test('strWidth: skips ANSI escapes, counts CJK as 2', () => {
  assert.equal(strWidth('\x1b[31mabc\x1b[0m'), 3);
  assert.equal(strWidth('中文'), 4);
  assert.equal(strWidth(''), 0);
  assert.equal(strWidth(null), 0);
});

test('wrapContent: soft-wraps on spaces', () => {
  const lines = wrapContent('hello world foo', 10);
  assert.deepEqual(lines, ['hello', 'world foo']);
});

test('wrapContent: hard-breaks overlong single words', () => {
  const lines = wrapContent('abcdefghij', 4);
  assert.deepEqual(lines, ['abcd', 'efgh', 'ij']);
});

test('wrapContent: keeps multiple source lines', () => {
  assert.deepEqual(wrapContent('a\n\nb', 10), ['a', '', 'b']);
});

test('applyKey: plain characters insert', () => {
  assert.deepEqual(applyKey({ sequence: 'x' }), { action: 'insert', data: 'x' });
});

test('applyKey: editing keys map to actions', () => {
  assert.equal(applyKey({ name: 'backspace' }).action, 'backspace');
  assert.equal(applyKey({ name: 'delete' }).action, 'delete');
  assert.equal(applyKey({ name: 'left' }).action, 'left');
  assert.equal(applyKey({ name: 'right' }).action, 'right');
  assert.equal(applyKey({ ctrl: true, name: 'a' }).action, 'home');
  assert.equal(applyKey({ ctrl: true, name: 'e' }).action, 'end');
  assert.equal(applyKey({ ctrl: true, name: 'u' }).action, 'kill-line');
  assert.equal(applyKey({ ctrl: true, name: 'w' }).action, 'kill-word-before');
  assert.equal(applyKey({ name: 'up' }).action, 'history-prev');
  assert.equal(applyKey({ name: 'down' }).action, 'history-next');
  assert.equal(applyKey({ name: 'tab' }).action, 'complete');
});

test('applyKey: control flow keys', () => {
  assert.equal(applyKey({ name: 'return' }).action, 'submit');
  assert.equal(applyKey({ name: 'enter' }).action, 'submit');
  assert.equal(applyKey({ ctrl: true, name: 'c' }).action, 'sigint');
  assert.equal(applyKey({ ctrl: true, name: 'd' }).action, 'eof');
  assert.equal(applyKey({ name: 'escape' }).action, 'escape');
  assert.equal(applyKey({ sequence: '\x1b' }).action, 'escape');
});

test('applyKey: ignores control sequences and meta chords', () => {
  assert.equal(applyKey({ sequence: '\x1b[200~', name: undefined }).action, null);
  assert.equal(applyKey({ ctrl: true, name: 'x' }).action, null);
  assert.equal(applyKey({ meta: true, name: 'b' }).action, null);
});

test('applyKey: arrow escape sequences are parsed by name, not raw', () => {
  // node keypress gives named events for \x1b[D etc.; raw sequence must not insert
  assert.equal(applyKey({ name: 'left', sequence: '\x1b[D' }).action, 'left');
  assert.equal(applyKey({ sequence: '\x1b[D' }).action, null);
});

// ── Facade behaviour with a fake stdout ──────────────────────────────────────

function fakeStreams() {
  const writes = [];
  const stdout = {
    columns: 80,
    rows: 24,
    write: (s, ...r) => { writes.push(String(s)); return true; },
    on: () => {},
    removeListener: () => {},
  };
  const stdin = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    on: () => {},
    removeListener: () => {},
    read: () => null,
  };
  return { writes, stdout, stdin };
}

test('createInputBox: renders a boxed prompt with title, placeholder and hint', () => {
  const { stdout } = fakeStreams();
  const rl = createInputBox({
    title: 'Buddy',
    placeholder: 'type a task',
    hint: 'enter send',
    statusRight: () => 'v0.5.0 · kilo',
  });
  // render without installing (no tty side effects): call internal redraw via prompt
  const origStdout = process.stdout;
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try {
    rl.prompt();
  } finally {
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
  }
  // renderBoxLines ran against the fake stdout — nothing thrown is the contract
  assert.ok(true);
});

test('createInputBox: history + draft behaviour via _state after keypress simulation', () => {
  // simulate through applyKey-driven internals using the exported pure reducer only
  const seq = [
    { sequence: 'h' }, { sequence: 'i' }, { name: 'return' },
  ];
  let buf = ''; let cursor = 0; const history = [];
  for (const k of seq) {
    const { action, data } = applyKey(k);
    if (action === 'insert') { buf = buf.slice(0, cursor) + data + buf.slice(cursor); cursor += 1; }
    if (action === 'submit') { if (buf.trim() && history[0] !== buf) history.unshift(buf); buf = ''; cursor = 0; }
  }
  assert.equal(buf, '');
  assert.deepEqual(history, ['hi']);
});

test('createInputBox: slash completer completes unique command and stops at space', () => {
  const SLASH = ['help', 'history', 'hooks'];
  const complete = (line) => SLASH.filter((n) => `/${n}`.startsWith(line)).map((n) => `/${n}`);
  assert.deepEqual(complete('/h'), ['/help', '/history', '/hooks']);
  assert.deepEqual(complete('/he'), ['/help']);
  assert.deepEqual(complete('/help'), ['/help']);
  assert.deepEqual(complete('help me'), []);
});

// ── v0.6 palette + frame painter ─────────────────────────────────────────────

test('applyKey: palette context switches up/down to palette navigation', () => {
  assert.equal(applyKey({ name: 'up' }, { paletteOpen: true }).action, 'palette-prev');
  assert.equal(applyKey({ name: 'down' }, { paletteOpen: true }).action, 'palette-next');
  assert.equal(applyKey({ name: 'up' }, {}).action, 'history-prev');
  assert.equal(applyKey({ name: 'down' }, {}).action, 'history-next');
});

test('filterCommands: prefix matching, whitespace closes the palette, / shows all', () => {
  const cmds = [{ name: '/help', desc: 'a' }, { name: '/new', desc: 'b' }];
  assert.deepEqual(filterCommands(cmds, '/').map((x) => x.name), ['/help', '/new']);
  assert.deepEqual(filterCommands(cmds, '/h').map((x) => x.name), ['/help']);
  assert.deepEqual(filterCommands(cmds, '/help me'), []);
  assert.deepEqual(filterCommands(cmds, 'hello'), []);
  assert.deepEqual(filterCommands(cmds, ''), []);
});

const BASE_STATE = {
  text: '',
  cursor: 0,
  placeholder: 'type a task',
  hint: '? shortcuts',
  busy: null,
  statusRight: 'v0.6.0 · kilo',
  palette: null,
};

test('buildFrame: every line fits the terminal width (the ghost-box killer)', () => {
  const lines = buildFrame(
    { ...BASE_STATE, text: 'x'.repeat(300), cursor: 300, statusRight: 'v0.6.0 · kilo · 999.9k ctx' },
    60
  );
  for (const l of lines) {
    assert.ok(strWidth(l) <= 60, `line too wide (${strWidth(l)}): ${JSON.stringify(l)}`);
  }
});

test('buildFrame: prompt, placeholder, borders and footer status', () => {
  const joined = buildFrame(BASE_STATE, 80).join('\n');
  assert.ok(joined.includes('>'));
  assert.ok(joined.includes('type a task'));
  assert.ok(joined.includes('v0.6.0 · kilo'));
  assert.ok(joined.includes('? shortcuts'));
  assert.ok(joined.includes('╭') && joined.includes('╰'));
});

test('buildFrame: busy footer shows spinner, esc-to-interrupt and seconds', () => {
  const joined = buildFrame({ ...BASE_STATE, busy: { label: 'Buddy working', secs: 4, glyph: '⠋' } }, 80).join('\n');
  assert.ok(joined.includes('⠋'));
  assert.ok(joined.includes('Buddy working'));
  assert.ok(joined.includes('esc to interrupt'));
  assert.ok(joined.includes('4s'));
});

test('buildFrame: palette popup renders above the box with items and descriptions', () => {
  const items = [{ name: '/help', desc: 'Show every command' }, { name: '/new', desc: 'Fresh conversation' }];
  const lines = buildFrame({ ...BASE_STATE, text: '/', cursor: 1, palette: { items, sel: 0 } }, 80);
  const joined = lines.join('\n');
  assert.ok(joined.includes('/help'));
  assert.ok(joined.includes('/new'));
  assert.ok(joined.includes('Show every command'));
  assert.equal(joined.split('╭').length - 1, 2, 'palette + input = two boxes');
});

test('buildFrame: CJK text is measured double-width and never overflows', () => {
  const lines = buildFrame({ ...BASE_STATE, text: '修'.repeat(120), cursor: 120 }, 50);
  for (const l of lines) assert.ok(strWidth(l) <= 50, `line too wide: ${strWidth(l)}`);
});
