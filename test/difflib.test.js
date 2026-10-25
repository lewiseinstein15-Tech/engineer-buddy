import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, renderDiff, renderTextDiff, diffStats } from '../src/terminal/difflib.js';

test('diffLines: identical input is all context', () => {
  const d = diffLines('a\nb\nc', 'a\nb\nc');
  assert.ok(d.every((x) => x.t === ' '));
  assert.equal(d.length, 3);
});

test('diffLines: replace marks - and +', () => {
  const d = diffLines('a\nold\nb', 'a\nnew\nb');
  const minus = d.filter((x) => x.t === '-');
  const plus = d.filter((x) => x.t === '+');
  assert.deepEqual(minus.map((x) => x.s), ['old']);
  assert.deepEqual(plus.map((x) => x.s), ['new']);
});

test('diffLines: insertion and deletion', () => {
  const ins = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(ins.filter((x) => x.t === '+').map((x) => x.s), ['b']);
  const del = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(del.filter((x) => x.t === '-').map((x) => x.s), ['b']);
});

test('diffLines: common prefix/suffix preserved as context', () => {
  const d = diffLines('keep1\nX\nkeep2', 'keep1\nY\nkeep2');
  assert.equal(d[0].t, ' ');
  assert.equal(d[0].s, 'keep1');
  assert.equal(d.at(-1).s, 'keep2');
});

test('diffLines: empty to content is all additions', () => {
  const d = diffLines('', 'a\nb');
  assert.deepEqual(d.filter((x) => x.t === '+').map((x) => x.s), ['a', 'b']);
});

test('diffLines: oversized sides degrade to a summary, never hang', () => {
  const bigA = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n');
  const bigB = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n');
  const d = diffLines(bigA, bigB);
  assert.ok(d.some((x) => /removed lines/.test(x.s)));
  assert.ok(d.some((x) => /added lines/.test(x.s)));
});

test('renderDiff: caps long diffs with an omitted marker', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ t: '+', s: `line ${i}` });
  const out = renderDiff(rows, { maxLines: 5 });
  assert.match(out, /\+35 more diff lines/);
  assert.match(out, /line 0/);
  assert.doesNotMatch(out, /line 39 /);
});

test('renderTextDiff: end-to-end convenience never throws', () => {
  const out = renderTextDiff('a\nb', 'a\nc');
  assert.ok(typeof out === 'string' && out.includes('b') && out.includes('c'));
  assert.equal(typeof renderTextDiff(null, undefined), 'string');
});

test('diffStats: counts added/removed/context', () => {
  const stats = diffStats(diffLines('a\nb\nc', 'a\nB\nc\nd'));
  assert.equal(stats.added, 2); // B and d
  assert.equal(stats.removed, 1); // b
});
