// Tests for the double-esc rewind menu (v0.32.0) — rewind.js pure half
// + the input box's chord detection, menu key routing and frame swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REWIND, isDoubleEscape, applyRewindMenuKey, buildRewindMenu } from '../src/terminal/rewind.js';
import { strWidth } from '../src/terminal/text.js';
import { applyKey, buildFrame, createInputBox } from '../src/terminal/inputbox.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const ENTRIES = [
  { file: 'a.json', time: '2026-10-27T09:14:03.221Z', tool: 'fs_replace', files: [{ path: 'src/cart.js' }] },
  { file: 'b.json', time: '2026-10-27T09:13:58.100Z', tool: 'fs_write', files: [{ path: 'cart.test.js' }, { path: 'docs/notes.md' }] },
  { file: 'c.json', time: '2026-10-27T09:13:41.004Z', tool: 'fs_append', files: [{ path: 'src/cart.js' }] },
];

// ── the chord: two consecutive escapes inside the window ────────────────────

test('isDoubleEscape: inside the window only, and only after a real first escape', () => {
  assert.equal(isDoubleEscape(1000, 1500), true);
  assert.equal(isDoubleEscape(1000, 2000), true);   // exactly DOUBLE_ESC_MS → still inside
  assert.equal(isDoubleEscape(1000, 2001), false);  // one ms past the window
  assert.equal(isDoubleEscape(0, 100), false);      // never armed
  assert.equal(isDoubleEscape(null, 100), false);
  assert.equal(isDoubleEscape(1500, 1000), false);  // clock went backwards: never
  assert.equal(isDoubleEscape(1000, 1000 + REWIND.DOUBLE_ESC_MS + 500, 2000), true); // custom window
});

test('applyKey: escape alone is escape; a second escape inside the window is rewind', () => {
  assert.equal(applyKey({ name: 'escape' }, {}).action, 'escape');
  assert.equal(applyKey({ name: 'escape' }, { lastEscapeAt: 1000, now: 1400 }).action, 'rewind');
  assert.equal(applyKey({ sequence: '\x1b' }, { lastEscapeAt: 1000, now: 1400 }).action, 'rewind');
  assert.equal(applyKey({ name: 'escape' }, { lastEscapeAt: 1000, now: 2400 }).action, 'escape');
});

test('applyKey: palette and question escapes are functional — they never arm rewind', () => {
  assert.equal(applyKey({ name: 'escape' }, { paletteOpen: true, lastEscapeAt: 1000, now: 1400 }).action, 'escape');
  assert.equal(applyKey({ name: 'escape' }, { questionMode: true, lastEscapeAt: 1000, now: 1400 }).action, 'escape');
});

test('applyKey: THE REAL WIRE FORMAT — a fast double-press arrives as ONE coalesced keypress', () => {
  // Caught live by the v0.32.0 drill: through a PTY, two ESC bytes 150ms apart
  // never reach the app as two escapes — readline coalesces them into
  // {name:'escape', meta:true, sequence:'\x1b\x1b'}. That key IS the chord.
  const coalesced = { name: 'escape', meta: true, sequence: '\x1b\x1b' };
  assert.equal(applyKey(coalesced, {}).action, 'rewind'); // no arming needed
  assert.equal(applyKey(coalesced, { paletteOpen: true }).action, 'escape', 'palette still wins');
  assert.equal(applyKey(coalesced, { questionMode: true }).action, 'escape', 'questions still win');
  assert.equal(applyKey({ name: 'escape', meta: true, sequence: '\x1b' }, {}).action, 'escape', 'a lone escape (this PTY flags meta) is still one press');
});

test('applyKey: the rest of the map is untouched by the new ctx fields', () => {
  assert.equal(applyKey({ sequence: 'a' }, { lastEscapeAt: 1000, now: 1100 }).action, 'insert');
  assert.equal(applyKey({ name: 'return' }, { lastEscapeAt: 1000, now: 1100 }).action, 'submit');
  assert.equal(applyKey({ name: 'up' }, {}).action, 'history-prev');
});

// ── the menu's key reducer: the menu owns every key while open ──────────────

test('applyRewindMenuKey: esc / ctrl+c / q close — never quit, never interrupt', () => {
  assert.equal(applyRewindMenuKey({ name: 'escape' }).action, 'close');
  assert.equal(applyRewindMenuKey({ sequence: '\x1b' }).action, 'close');
  assert.equal(applyRewindMenuKey({ ctrl: true, name: 'c' }).action, 'close');
  assert.equal(applyRewindMenuKey({ name: 'q', sequence: 'q' }).action, 'close');
});

test('applyRewindMenuKey: up/down move, k/j for vim taste, enter confirms', () => {
  assert.equal(applyRewindMenuKey({ name: 'up' }).action, 'up');
  assert.equal(applyRewindMenuKey({ name: 'down' }).action, 'down');
  assert.equal(applyRewindMenuKey({ sequence: 'k' }).action, 'up');
  assert.equal(applyRewindMenuKey({ sequence: 'j' }).action, 'down');
  assert.equal(applyRewindMenuKey({ name: 'return' }).action, 'confirm');
  assert.equal(applyRewindMenuKey({ name: 'enter' }).action, 'confirm');
});

test('applyRewindMenuKey: every other key is inert — modifier chords included', () => {
  assert.equal(applyRewindMenuKey({ sequence: 'x' }).action, null);
  assert.equal(applyRewindMenuKey({ name: 'tab' }).action, null);
  assert.equal(applyRewindMenuKey({ name: 'backspace' }).action, null);
  assert.equal(applyRewindMenuKey({ ctrl: true, name: 'r' }).action, null);  // no viewer stack under the menu
  assert.equal(applyRewindMenuKey({ name: 'up', ctrl: true }).action, null);
  assert.equal(applyRewindMenuKey({ name: 'j', meta: true }).action, null);
});

// ── the panel painter ────────────────────────────────────────────────────────

test('buildRewindMenu: every chrome row is exactly W, the footer hint fits', () => {
  for (const cols of [34, 50, 60, 80, 100]) {
    const rows = buildRewindMenu({ entries: ENTRIES, sel: 1, cols });
    for (const r of rows.slice(0, -1)) assert.equal(strWidth(r), cols, `chrome row at cols=${cols}: ${strip(r)}`);
    assert.ok(strWidth(rows[rows.length - 1]) <= cols, 'footer never wraps');
  }
});

test('buildRewindMenu: header carries the brand, the count and the safety note', () => {
  const head = strip(buildRewindMenu({ entries: ENTRIES, sel: 0, cols: 80 })[0]);
  assert.ok(head.includes('✦ rewind'), 'brand');
  assert.ok(head.includes('3 checkpoints'), 'count');
  assert.ok(head.includes('files only · chat stays'), 'safety note');
  const one = strip(buildRewindMenu({ entries: [ENTRIES[0]], sel: 0, cols: 80 })[0]);
  assert.ok(one.includes('1 checkpoint'), 'singular');
});

test('buildRewindMenu: the selected row is the only one marked ❯', () => {
  const rows = buildRewindMenu({ entries: ENTRIES, sel: 1, cols: 80 });
  const plain = rows.map(strip);
  const marked = plain.filter((l) => l.includes('❯'));
  assert.equal(marked.length, 1, 'exactly one marker');
  assert.ok(marked[0].includes(' 2  09:13:58  fs_write'), 'the marker sits on the selected entry');
});

test('buildRewindMenu: rows are 1-based and newest first — /rewind numbering', () => {
  const body = buildRewindMenu({ entries: ENTRIES, sel: 0, cols: 80 }).map(strip);
  assert.ok(body.some((l) => l.includes(' 1  09:14:03  fs_replace')), 'row 1 = newest manifest time + tool');
  assert.ok(body.some((l) => l.includes(' 3  09:13:41  fs_append')), 'row 3 = oldest');
});

test('buildRewindMenu: sliding window caps 7 visible and keeps the selection on screen', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    file: `f${i}.json`, time: `2026-10-27T09:${String(10 + i).padStart(2, '0')}:00.000Z`,
    tool: `tool${i}`, files: [{ path: `p${i}.js` }],
  }));
  const top = buildRewindMenu({ entries: many, sel: 0, cols: 80 }).map(strip);
  assert.ok(top.some((l) => l.includes(' 1  ')), 'first entry visible at sel=0');
  assert.ok(!top.some((l) => l.includes(' 10  ')), 'beyond the window culled');
  const bottom = buildRewindMenu({ entries: many, sel: 9, cols: 80 }).map(strip);
  assert.ok(bottom.some((l) => l.includes(' 10  ') && l.includes('❯')), 'sel=9 visible with marker');
  assert.ok(bottom.some((l) => l.includes(' 4  ')), 'window slid down');
});

test('buildRewindMenu: long file lists truncate, CJK paths never break the width', () => {
  const long = [{ file: 'x', time: '2026-10-27T09:14:03.221Z', tool: 'fs_write', files: [{ path: 'deep/'.repeat(20) + 'file.js' }] }];
  for (const cols of [34, 80, 100]) {
    const rows = buildRewindMenu({ entries: long, sel: 0, cols });
    for (const r of rows.slice(0, -1)) assert.equal(strWidth(r), cols);
  }
  const cjk = [{ file: 'c', time: '2026-10-27T09:14:03.221Z', tool: 'fs_write', files: [{ path: '设计/文档/说明.md' }] }];
  for (const cols of [34, 80]) {
    const rows = buildRewindMenu({ entries: cjk, sel: 0, cols });
    for (const r of rows.slice(0, -1)) assert.equal(strWidth(r), cols);
  }
  assert.ok(buildRewindMenu({ entries: cjk, sel: 0, cols: 80 }).map(strip).some((l) => l.includes('说明.md')), 'full CJK path visible at normal width');
  assert.ok(buildRewindMenu({ entries: cjk, sel: 0, cols: 34 }).map(strip).some((l) => l.includes('设计')), 'compact rows keep real path room even at 34 cols');
});

test('buildRewindMenu: empty list is a defensive note, footer always present', () => {
  const rows = buildRewindMenu({ entries: [], cols: 80 }).map(strip);
  assert.ok(rows.join('\n').includes('no checkpoints yet'), 'empty note');
  assert.ok(rows[rows.length - 1].includes('enter restore'), 'footer hint');
  assert.ok(rows[rows.length - 1].includes('one undo per restore'), 'undo semantics in the footer');
});

// ── the box: chord detection, menu routing, frame swap ─────────────────────

function box() {
  return createInputBox({ placeholder: 'type a task…' });
}

test('box: double-esc opens the menu with the real entries; a single escape never does', () => {
  const b = box();
  b.on('rewindOpen', () => ENTRIES);
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu, null, 'first escape: no menu');
  b._handleKeypress({ sequence: 'x' }); // disarm: the chord needs CONSECUTIVE escapes
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu, null, 'esc x esc is not a chord');
  b._handleKeypress({ name: 'escape' }); // second consecutive escape → rewind
  const st = b._state();
  assert.equal(st.menu?.count, 3, 'menu open with the entries');
  assert.equal(st.menu?.sel, 0, 'selection starts at the newest');
});

test('box: the COALESCED wire keypress opens the menu — the exact shape a real PTY delivers', () => {
  const b = box();
  b.on('rewindOpen', () => ENTRIES);
  // one keypress, not two — the two ESC bytes the driver sent fused in readline
  b._handleKeypress({ name: 'escape', meta: true, sequence: '\x1b\x1b' });
  assert.equal(b._state().menu?.count, 3, 'coalesced chord opens the menu in one keypress');
  b._handleKeypress({ name: 'escape', meta: true, sequence: '\x1b' }); // lone close (meta-flagged on this PTY)
  assert.equal(b._state().menu, null, 'lone escape closes it');
});

test('box: empty checkpoint list → menu stays closed (the repl printed its note)', () => {
  const b = box();
  b.on('rewindOpen', () => []);
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu, null);
});

test('box: while busy both escapes interrupt — the menu is an idle affordance', () => {
  const b = box();
  const seen = [];
  b.on('rewindOpen', () => ENTRIES);
  b.on('escape', () => seen.push('esc'));
  b.setBusy('working');
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  assert.deepEqual(seen, ['esc', 'esc'], 'both escapes reached the interrupt handler');
  assert.equal(b._state().menu, null, 'no menu mid-turn');
  b.setBusy(null);
  b._handleKeypress({ name: 'escape' }); // the interrupt pair stayed armed…
  assert.equal(b._state().menu?.count, 3, '…so the first idle escape opens the menu');
  b._handleKeypress({ name: 'escape' }); // close it
  assert.equal(b._state().menu, null);
  b._handleKeypress({ sequence: 'x' }); // disarm: a fresh chord starts clean
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu?.count, 3, 'a fresh chord opens it again');
});

test('box: a pending question blocks the chord — approval gates are untouchable', () => {
  const b = box();
  b.on('rewindOpen', () => ENTRIES);
  b.question('allow fs_write? (y/n)', () => {});
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu, null, 'no menu under a pending question');
  assert.equal(b._state().mode, 'question', 'the question survives both escapes');
});

test('box: the menu owns every key — enter restores via the handler with the right index', () => {
  const b = box();
  b.on('rewindOpen', () => ENTRIES);
  const restored = [];
  b.on('rewind', (idx) => restored.push(idx));
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ sequence: 'x' });      // inert under the menu…
  assert.equal(b._state().text, '', '…and the draft is untouchable');
  b._handleKeypress({ name: 'down' });
  b._handleKeypress({ name: 'down' });
  assert.equal(b._state().menu.sel, 2, 'selection moved to the third');
  b._handleKeypress({ name: 'up' });
  assert.equal(b._state().menu.sel, 1);
  b._handleKeypress({ name: 'return' });
  assert.deepEqual(restored, [1], 'the handler got the confirmed index');
  assert.equal(b._state().menu, null, 'menu closed after the restore');
});

test('box: esc closes the menu and editing resumes; ctrl+r is inert under the menu', () => {
  const b = box();
  b.on('rewindOpen', () => ENTRIES);
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ name: 'escape' });
  b._handleKeypress({ ctrl: true, name: 'r' }); // no viewer stack under the menu
  assert.equal(b._state().viewer, null, 'viewer did not open');
  assert.equal(b._state().menu?.count, 3, 'menu still open');
  b._handleKeypress({ name: 'escape' });
  assert.equal(b._state().menu, null, 'menu closed');
  b._handleKeypress({ sequence: 'h' });
  assert.equal(b._state().text, 'h', 'editing works again');
});

test('buildFrame: an open menu swaps the whole frame for the rewind panel', () => {
  const frame = buildFrame({ menu: { open: true, entries: ENTRIES, sel: 0 } }, 80).map(strip);
  const joined = frame.join('\n');
  assert.ok(joined.includes('✦ rewind'), 'menu panel painted');
  assert.ok(!joined.includes('type a task'), 'the input box is replaced, not stacked');
  const idle = buildFrame({ text: '', cursor: 0 }, 80).map(strip).join('\n');
  assert.ok(!idle.includes('✦ rewind'), 'idle frame has no menu');
});

// ── repl wiring tripwire (the REPL needs a TTY — source checks are the pattern) ──

test('repl.js wires both rewind handlers over the real checkpoint store', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/terminal/repl.js', import.meta.url)), 'utf8');
  assert.ok(src.includes("rl.on('rewindOpen'"), 'menu entries come from the box handler');
  assert.ok(src.includes("rl.on('rewind'"), 'confirm routes to the restore handler');
  assert.ok(src.includes('listCheckpoints(root, 10)'), 'real manifests, newest first');
  assert.ok(src.includes('restoreCheckpoint(root, ck.file)'), 'real restore — not a mock');
  assert.ok(src.includes("['double-esc', 'open the rewind menu"), 'documented in /help');
});
