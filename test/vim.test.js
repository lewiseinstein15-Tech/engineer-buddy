// vim.test.js — v0.33.0 vim mode: the pure reducer + word motions + box
// integration. The reducer contract: { op:'edit', text, cursor } for edits,
// { op:'inert' } for consumed keys, { action } for passthroughs the box's
// own switch owns (submit/escape/sigint/history/newline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVimState, applyVimKey, wordRight, wordBack, wordEnd } from '../src/terminal/vim.js';
import { createInputBox, buildFrame } from '../src/terminal/inputbox.js';

const edit = (key, st, text, cursor) => {
  const r = applyVimKey(key, st, text, cursor);
  assert.equal(r.op, 'edit', `expected an edit, got ${JSON.stringify(r)}`);
  return r;
};
const K = (name, extra = {}) => ({ name, sequence: name, ctrl: false, meta: false, shift: false, ...extra });

// ── Word motions ─────────────────────────────────────────────────────────────

test('wordRight/b/End: vim word classes across words and punctuation', () => {
  const s = 'const answer = 42;';
  assert.equal(wordRight(s, 0), 6);   // const → answer
  assert.equal(wordRight(s, 6), 13);  // answer → =
  assert.equal(wordRight(s, 13), 15); // = → 42
  assert.equal(wordRight(s, 15), 17); // 42 → ; (punct is its own word)
  assert.equal(wordBack(s, 6), 0);
  assert.equal(wordBack(s, 15), 13);
  assert.equal(wordEnd(s, 0), 4);     // const → t
  assert.equal(wordEnd(s, 6), 11);    // answer → r
});

test('wordRight: crosses whitespace runs and lands on punct runs', () => {
  assert.equal(wordRight('a   ,,,b', 0), 4); // a → the comma run
  assert.equal(wordRight('a   ,,,b', 4), 7); // ,,, → b
  assert.equal(wordBack('a   ,,,b', 7), 4);
});

// ── Normal mode motions ──────────────────────────────────────────────────────

test('normal: h/l move by count; motion never leaves the line bounds', () => {
  let st = createVimState();
  let r = edit(K('l'), st, 'abcd', 0);
  assert.equal(r.cursor, 1);
  st = createVimState();
  r = applyVimKey({ ...K('3'), sequence: '3' }, st, 'abcd', 0); // count 3 (inert — not an edit)
  assert.equal(r.op, 'inert');
  r = edit(K('l'), r.st, 'abcd', 0); // 3l
  assert.equal(r.cursor, 3);
  st = createVimState();
  r = edit(K('h'), st, 'abcd', 2);
  assert.equal(r.cursor, 1);
});

test('normal: 0/$/^ and gg/G', () => {
  let st = createVimState();
  let r = edit(K('0'), st, '  hi', 3);
  assert.equal(r.cursor, 0);
  st = createVimState();
  r = edit(K('^'), st, '  hi', 3);
  assert.equal(r.cursor, 2); // first non-blank
  st = createVimState();
  r = edit(K('$'), st, 'hi', 0);
  assert.equal(r.cursor, 1); // last char, not length
  st = createVimState();
  r = edit(K('G'), st, 'hello', 1);
  assert.equal(r.cursor, 5);
  st = createVimState();
  st = applyVimKey(K('g'), st, 'hello', 3); // pending
  assert.equal(st.st.pending, 'g');
  r = edit(K('g'), st.st, 'hello', 3);
  assert.equal(r.cursor, 0);
});

test('normal: w/b/e word motions with counts', () => {
  let st = createVimState();
  let r = edit(K('w'), st, 'one two three', 0);
  assert.equal(r.cursor, 4);
  st = createVimState();
  st = applyVimKey({ ...K('2'), sequence: '2' }, st, 'one two three', 0);
  r = edit(K('w'), st.st, 'one two three', 0); // 2w
  assert.equal(r.cursor, 8);
});

test('normal: j/k move across draft lines and return history actions at the edges', () => {
  const draft = 'first line\nsecond line\nthird';
  let st = createVimState();
  let r = edit(K('j'), st, draft, 3); // middle of line 0 → same col line 1
  assert.equal(r.cursor, 'first line\n'.length + 3);
  st = createVimState();
  r = edit(K('k'), st, draft, 'first line\n'.length + 3);
  assert.equal(r.cursor, 3);
  st = createVimState();
  r = applyVimKey(K('k'), st, draft, 2); // already on the first line
  assert.equal(r.op, 'action');
  assert.equal(r.action, 'history-prev');
  st = createVimState();
  r = applyVimKey(K('j'), st, draft, draft.length); // last line
  assert.equal(r.op, 'action');
  assert.equal(r.action, 'history-next');
});

test('normal: i/a/I/A enter insert at the right spot; o/O open lines', () => {
  let st = createVimState();
  let r = edit(K('i'), st, 'abc', 1);
  assert.equal(r.st.mode, 'insert');
  assert.equal(r.cursor, 1);
  st = createVimState();
  r = edit(K('a'), st, 'abc', 1);
  assert.equal(r.st.mode, 'insert');
  assert.equal(r.cursor, 2);
  st = createVimState();
  r = edit(K('A'), st, 'abc', 0);
  assert.equal(r.cursor, 3);
  st = createVimState();
  r = edit(K('I'), st, '  abc', 3);
  assert.equal(r.cursor, 2);
  st = createVimState();
  r = edit(K('o'), st, 'one\ntwo', 1);
  assert.equal(r.text, 'one\n\ntwo');
  assert.equal(r.cursor, 4);
  assert.equal(r.st.mode, 'insert');
  st = createVimState();
  r = edit(K('O'), st, 'one\ntwo', 2);
  assert.equal(r.text, '\none\ntwo');
  assert.equal(r.cursor, 1);
});

// ── Operators ────────────────────────────────────────────────────────────────

test('normal: x deletes at the cursor (count-aware), X before', () => {
  let st = createVimState();
  let r = edit(K('x'), st, 'abcd', 1);
  assert.equal(r.text, 'acd');
  assert.equal(r.cursor, 1);
  st = createVimState();
  st = applyVimKey({ ...K('3'), sequence: '3' }, st, 'abcd', 1);
  r = edit(K('x'), st.st, 'abcd', 1); // 3x deletes 'bcd'
  assert.equal(r.text, 'a');
  st = createVimState();
  r = edit(K('X'), st, 'abcd', 2);
  assert.equal(r.text, 'acd');
  assert.equal(r.cursor, 1);
});

test('normal: dd deletes the whole line into a linewise register; multi-dd with counts', () => {
  const draft = 'alpha\nbeta\ngamma';
  let st = createVimState();
  st = applyVimKey(K('d'), st, draft, 2); // pending d
  assert.equal(st.st.pending, 'd');
  let r = edit(K('d'), st.st, draft, 2);
  assert.equal(r.text, 'beta\ngamma');
  assert.equal(r.cursor, 0);
  assert.deepEqual(r.st.reg, { text: 'alpha', linewise: true });
  // 2dd on line 0
  st = createVimState();
  st = applyVimKey({ ...K('2'), sequence: '2' }, st, draft, 0);
  st = applyVimKey(K('d'), st.st, draft, 0);
  r = edit(K('d'), st.st, draft, 0);
  assert.equal(r.text, 'gamma');
  assert.deepEqual(r.st.reg, { text: 'alpha\nbeta', linewise: true });
});

test('normal: dd on a single-line draft empties it', () => {
  let st = createVimState();
  st = applyVimKey(K('d'), st, 'only', 2);
  const r = edit(K('d'), st.st, 'only', 2);
  assert.equal(r.text, '');
  assert.equal(r.cursor, 0);
});

test('normal: yy yanks, p puts linewise below, P above; charwise p after cursor', () => {
  const draft = 'one\ntwo';
  let st = createVimState();
  st = applyVimKey(K('y'), st, draft, 0);
  let r = edit(K('y'), st.st, draft, 0);
  assert.deepEqual(r.st.reg, { text: 'one', linewise: true });
  assert.equal(r.text, draft); // yy never edits
  // p → new line below the current one
  st = r.st;
  r = edit(K('p'), st, draft, 1);
  assert.equal(r.text, 'one\none\ntwo');
  assert.equal(r.cursor, 'one\n'.length);
  // charwise register: p inserts AFTER the cursor
  st = createVimState();
  st.reg = { text: 'ins', linewise: false };
  r = edit(K('p'), st, 'abc', 0);
  assert.equal(r.text, 'ainsbc');
  assert.equal(r.cursor, 3); // on the last pasted char
  // P charwise before cursor
  st = createVimState();
  st.reg = { text: 'ins', linewise: false };
  r = edit(K('P'), st, 'abc', 0);
  assert.equal(r.text, 'insabc');
});

test('normal: D/C truncate to line end; cc clears the line and enters insert', () => {
  const draft = 'keep this\nsecond';
  let st = createVimState();
  let r = edit(K('D'), st, draft, 2);
  assert.equal(r.text, 'ke\nsecond');
  st = createVimState();
  r = edit(K('C'), st, draft, 2);
  assert.equal(r.text, 'ke\nsecond');
  assert.equal(r.st.mode, 'insert');
  st = createVimState();
  st = applyVimKey(K('c'), st, draft, 0);
  r = edit(K('c'), st.st, draft, 0);
  assert.equal(r.text, '\nsecond');
  assert.equal(r.st.mode, 'insert');
});

test('normal: passthrough actions — enter submits, esc escapes, ctrl chords survive', () => {
  let st = createVimState();
  let r = applyVimKey(K('return'), st, 'hi', 2);
  assert.deepEqual({ op: r.op, action: r.action }, { op: 'action', action: 'submit' });
  st = createVimState();
  r = applyVimKey({ name: 'escape', sequence: '\x1b' }, st, 'hi', 1);
  assert.equal(r.action, 'escape');
  st = createVimState();
  r = applyVimKey({ name: 'c', ctrl: true, sequence: '\x03' }, st, 'hi', 1);
  assert.equal(r.action, 'sigint');
  st = createVimState();
  r = applyVimKey({ name: 'o', ctrl: true, sequence: '\x0f' }, st, 'hi', 1);
  assert.equal(r.action, 'verbose-toggle'); // ctrl+o survives vim
  st = createVimState();
  r = applyVimKey({ name: 'r', ctrl: true, sequence: '\x12' }, st, 'hi', 1);
  assert.equal(r.action, 'transcript'); // ctrl+r survives vim
});

test('normal: ctrl+j inserts a newline (multi-line editing works in normal mode)', () => {
  let st = createVimState();
  const r = edit({ name: 'j', ctrl: true, sequence: '\n' }, st, 'ab', 1);
  assert.equal(r.text, 'a\nb');
  assert.equal(r.cursor, 2);
});

test('normal: / on an empty draft seeds the palette and switches to insert', () => {
  let st = createVimState();
  const r = edit(K('/'), st, '', 0);
  assert.equal(r.text, '/');
  assert.equal(r.cursor, 1);
  assert.equal(r.st.mode, 'insert');
});

test('normal: unknown keys are inert and cancel pending operators', () => {
  let st = createVimState();
  st = applyVimKey(K('d'), st, 'abc', 0); // pending d
  const r = applyVimKey(K('z'), st.st, 'abc', 0);
  assert.equal(r.op, 'inert');
  assert.equal(r.st.pending, null);
});

// ── Box integration ──────────────────────────────────────────────────────────

function makeBox(commands = []) {
  const box = createInputBox({ commands, placeholder: '' });
  return box;
}

test('box: /vim enables normal mode — hjkl edit the draft, esc exits insert', () => {
  const box = makeBox();
  box.setVim(true);
  assert.deepEqual(box._state().vim, { mode: 'normal', pending: null, count: '' });
  box._handleKeypress(K('i'));
  assert.equal(box._state().vim.mode, 'insert');
  box._handleKeypress(K('h'));
  box._handleKeypress(K('i'));
  assert.equal(box._state().text, 'hi');
  box._handleKeypress({ name: 'escape', sequence: '\x1b' }); // insert → normal, caret parks one left
  assert.equal(box._state().vim.mode, 'normal');
  assert.equal(box._state().cursor, 1); // ON the last typed char (vim semantics)
  box._handleKeypress(K('l')); // normal motion — cursor moves, text intact
  assert.equal(box._state().text, 'hi');
  box._handleKeypress(K('h')); // back onto 'i'
  box._handleKeypress(K('x')); // normal edit — deletes the char under the caret
  assert.equal(box._state().text, 'h');
});

test('box: setVim(false) returns to classic editing and resets state', () => {
  const box = makeBox();
  box.setVim(true);
  box._handleKeypress(K('i'));
  box.setVim(false);
  assert.equal(box._state().vim, null);
  box._handleKeypress(K('d')); // classic insert — the letter lands
  assert.equal(box._state().text, 'd');
});

test('box: vim insert typing then esc then p pastes the dd register', () => {
  const box = makeBox();
  box.setVim(true);
  box._handleKeypress(K('i')); // insert mode: plain letters land
  for (const ch of 'hold') box._handleKeypress(K(ch));
  assert.equal(box._state().text, 'hold');
  box._handleKeypress({ name: 'escape', sequence: '\x1b' }); // → normal
  box._handleKeypress(K('0')); // line start
  box._handleKeypress(K('d'));
  box._handleKeypress(K('d')); // dd → register 'hold', text ''
  assert.equal(box._state().text, '');
  box._handleKeypress(K('p')); // linewise put below line 0
  assert.equal(box._state().text, 'hold');
});

test('box: palette bypasses vim — / from an empty normal draft opens commands', () => {
  const box = makeBox([{ name: '/help', desc: 'x' }]);
  box.setVim(true);
  box._handleKeypress(K('/')); // seeds '/' + insert mode
  assert.deepEqual(box._state().palette, ['/help']);
  assert.equal(box._state().vim.mode, 'insert');
  box._handleKeypress({ name: 'down' }); // palette navigation, not vim j
  assert.equal(box._state().text, '/'); // palette is open: vim untouched
});

test('box: question mode bypasses vim entirely', () => {
  const box = makeBox();
  box.setVim(true);
  box.question('approve?', (ans) => {});
  box._handleKeypress(K('d')); // must INSERT the letter, not run the dd pending
  box._handleKeypress(K('d'));
  assert.equal(box._state().text, 'dd');
});

test('box: newline action inserts \\n; submit sends the multi-line draft as one task', async () => {
  const box = makeBox();
  let got = null;
  box.on('line', (l) => { got = l; });
  box._handleKeypress(K('a'));
  box._handleKeypress(K('b'));
  box._handleKeypress({ name: 'enter', sequence: '\n' }); // ctrl+j / taught shift+enter
  box._handleKeypress(K('c'));
  assert.equal(box._state().text, 'ab\nc');
  box._handleKeypress({ name: 'return', sequence: '\r' }); // the real Enter
  assert.equal(got, 'ab\nc');
  assert.equal(box._state().text, '');
});

test('box: alt+enter (coalesced ESC-CR chord) inserts a newline, never submits', () => {
  const box = makeBox();
  let got = null;
  box.on('line', (l) => { got = l; });
  box._handleKeypress(K('x'));
  box._handleKeypress({ name: 'return', sequence: '\x1b\r', meta: true });
  assert.equal(box._state().text, 'x\n');
  assert.equal(got, null); // nothing submitted
});

test('box: up/down navigate a multi-line draft; history only at the edges', () => {
  const box = makeBox();
  box._handleKeypress(K('a'));
  box._handleKeypress(K('b'));
  box._handleKeypress({ name: 'enter', sequence: '\n' });
  box._handleKeypress(K('c'));
  assert.equal(box._state().text, 'ab\nc');
  assert.equal(box._state().cursor, 'ab\nc'.length);
  box._handleKeypress({ name: 'up' }); // → line 0, column preserved (col 1)
  assert.equal(box._state().cursor, 1);
  box._handleKeypress({ name: 'down' }); // back to line 1, same column
  assert.equal(box._state().cursor, 4);
  box._handleKeypress({ name: 'down' }); // last line → history-next (none)
  assert.equal(box._state().cursor, 4);
});

const COLOR_ENV = { ...process.env, NO_COLOR: '', FORCE_COLOR: '1' }; // sandbox NO_COLOR=1 must not win — the caret block needs color

test('box: buildFrame maps the cursor across newlines (the drift bug regression)', () => {
  // The painters freeze their color level at module load, so the inverse
  // caret block only exists in a fresh FORCE_COLOR=1 process (fixture).
  execFileSync(process.execPath, [new URL('./fixtures/forcecolor-cursor.mjs', import.meta.url).pathname, 'drift'], { stdio: 'inherit', env: COLOR_ENV });
});

test('box: buildFrame cursor at line end after \\n sits on that row, not the next', () => {
  execFileSync(process.execPath, [new URL('./fixtures/forcecolor-cursor.mjs', import.meta.url).pathname, 'end'], { stdio: 'inherit', env: COLOR_ENV });
});

test('box: buildFrame caret on a CJK multi-line row (char col ≠ visual col)', () => {
  execFileSync(process.execPath, [new URL('./fixtures/forcecolor-cursor.mjs', import.meta.url).pathname, 'cjk'], { stdio: 'inherit', env: COLOR_ENV });
});

test('box: ctrl+u / ctrl+k / home / end are LINE-scoped on a multi-line draft', () => {
  const box = makeBox();
  const type = (s) => { for (const ch of s) box._handleKeypress(K(ch)); };
  type('keep-a');
  box._handleKeypress({ name: 'enter', sequence: '\n' });
  type('edit-me-here');
  box._handleKeypress({ name: 'enter', sequence: '\n' });
  type('tail');
  assert.equal(box._state().text, 'keep-a\nedit-me-here\ntail');
  assert.equal(box._state().cursor, 24); // end of line 3
  box._handleKeypress({ name: 'left' }); // 23: between 'i' and 'l' of tail
  box._handleKeypress({ ctrl: true, name: 'k' }); // kills ONLY line 3's tail
  assert.equal(box._state().text, 'keep-a\nedit-me-here\ntai'); // lines 1 and 2 untouched
  box._handleKeypress({ ctrl: true, name: 'u' }); // line 3 start — lines 1-2 survive
  assert.equal(box._state().text, 'keep-a\nedit-me-here\n');
  assert.equal(box._state().cursor, 20);
  box._handleKeypress({ name: 'home' }); // line-scoped: stays on line 3 start
  assert.equal(box._state().cursor, 20);
  box._handleKeypress({ name: 'end' }); // line 3 is empty → same spot
  assert.equal(box._state().cursor, box._state().text.length);
  box._handleKeypress({ name: 'up' }); // → line 2, column preserved (col 0)
  assert.equal(box._state().cursor, 7);
  box._handleKeypress({ name: 'end' }); // line 2 end (before its \n)
  assert.equal(box._state().cursor, 19);
});
