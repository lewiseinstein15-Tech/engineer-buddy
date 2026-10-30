// Tests for renderer.js — the mini-Ink static/dynamic region renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/terminal/renderer.js';
import { rowCount } from '../src/terminal/text.js';

function fakeOut() {
  const writes = [];
  return {
    columns: 80,
    writes,
    write(s) { writes.push(String(s)); return true; },
    on() {},
    removeListener() {},
  };
}

test('rowCount: wrap-aware, CJK-aware screen-row counting', () => {
  assert.equal(rowCount('hello', 80), 1);
  assert.equal(rowCount('x'.repeat(80), 80), 1);   // exactly full width = 1 row (deferred wrap)
  assert.equal(rowCount('x'.repeat(81), 80), 2);
  assert.equal(rowCount('a\nb', 80), 2);
  assert.equal(rowCount('中'.repeat(45), 80), 2);   // 90 visual columns
  assert.equal(rowCount('', 80), 1);
});

test('renderer: first render writes the frame with no erase', () => {
  const out = fakeOut();
  const r = createRenderer({ out, frame: () => ['one', 'two'] });
  r.render();
  assert.equal(out.writes.join(''), 'one\ntwo');
  assert.equal(r.rows, 2);
});

test('renderer: second render erases exactly the previous frame rows first (v0.64: ONE write, and an unchanged frame paints nothing)', () => {
  const out = fakeOut();
  let lines = ['a', 'b', 'c'];
  const r = createRenderer({ out, frame: () => lines });
  r.render();
  // v0.64.0 contract: an UNCHANGED frame costs zero bytes (the spinner tick of
  // a static box no longer repaints the region 8×/second — the blink fix).
  r.render();
  assert.equal(out.writes.length, 1, 'unchanged frame → no write at all');
  // a CHANGED frame repaints: erase of exactly the previous rows + new frame, ONE write
  lines = ['a', 'b', 'c!'];
  r.render();
  const seq = out.writes[1];
  assert.ok(seq.startsWith('\r\x1b[2A\x1b[J'), `got: ${JSON.stringify(seq)}`);
  assert.ok(seq.endsWith('a\nb\nc!'));
  assert.equal(r.rows, 3);
});

test('renderer: print goes above the frame and re-anchors the frame below', () => {
  const out = fakeOut();
  const r = createRenderer({ out, frame: () => ['box'] });
  r.render();
  const before = out.writes.length;
  r.print('hello\n');
  const seq = out.writes.slice(before).join('');
  assert.ok(seq.startsWith('\r\x1b[J'), 'print must erase the frame first');
  assert.ok(seq.includes('hello\n'));
  assert.ok(seq.endsWith('box'), 'frame must be re-anchored after static content');
});

test('renderer: partial lines are held until a newline arrives', () => {
  const out = fakeOut();
  const r = createRenderer({ out, frame: () => ['box'] });
  r.render();
  const before = out.writes.length;
  r.print('half');
  assert.equal(out.writes.length, before, 'partial line must not touch the screen');
  r.print(' line\n');
  const seq = out.writes.slice(before).join('');
  assert.ok(seq.includes('half line\n'));
});

test('renderer: close erases the frame and restores the cursor; renders after are no-ops', () => {
  const out = fakeOut();
  const r = createRenderer({ out, frame: () => ['box'] });
  r.render();
  r.close();
  assert.ok(out.writes.join('').endsWith('\x1b[?25h'));
  const n = out.writes.length;
  r.render();
  r.print('ignored\n');
  assert.equal(out.writes.length, n);
});

test('renderer: erase math matches wrapped multi-row frames (v0.64: coalesced into ONE write)', () => {
  const out = fakeOut();
  const long = 'y'.repeat(200); // 3 rows at 80 cols
  let tail = 'z'.repeat(90); // 2 rows
  const r = createRenderer({ out, frame: () => [long, tail] }); // 3 + 2 = 5 rows
  r.render();
  assert.equal(r.rows, 5);
  tail += '!'; // change → repaint
  r.render();
  assert.equal(out.writes.length, 2, 'repaint is exactly one write (no blank flash between erase and frame)');
  const seq = out.writes[1];
  assert.ok(seq.startsWith('\r\x1b[4A\x1b[J'), `got: ${JSON.stringify(seq)}`);
  assert.ok(seq.endsWith(long + '\n' + tail), 'the frame rides the same write as the erase');
});
