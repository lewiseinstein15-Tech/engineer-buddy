// forcecolor-cursor.mjs — test fixture: buildFrame cursor mapping with the
// inverse cursor VISIBLE (FORCE_COLOR=1 in a fresh process — the painters
// freeze their color level at module load, so this must be a child process).
// Invoked by vim.test.js with a mode argument. When the node test runner
// scans this file as a "test" (it lives under test/), no mode is passed and
// the module exits cleanly — assertions only run on a direct invocation.
import assert from 'node:assert/strict';
import { buildFrame } from '../../src/terminal/inputbox.js';

const mode = process.argv[2];
if (!mode) {
  console.log('# fixture: pass a mode (drift|end) to assert; no-op under the test runner');
} else {

const state =
  mode === 'drift'
    ? {
        text: 'line-one\nline-two\nline-three',
        cursor: 'line-one\n'.length, // start of line 1
      }
    : mode === 'cjk'
      ? {
          // wide chars make CHAR col ≠ VISUAL col: the caret at char 3 of the
          // second line (on 测) must land on that row
          text: 'ascii\n中文测试行二\nthird',
          cursor: 'ascii\n'.length + 3,
        }
      : {
          text: 'one\ntwo',
          cursor: 'one\ntwo'.length, // end of line 1
        };

const frame = buildFrame({ placeholder: '', hint: '', busy: null, statusRight: '', palette: null, viewer: null, menu: null, ...state }, 80);
const visible = frame.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
const caretRows = frame.map((l, i) => (l.includes('\x1b[7m') ? i : -1)).filter((i) => i >= 0);
const needle = mode === 'drift' ? 'line-two' : mode === 'cjk' ? '中文测试行二' : 'two';
const target = visible.findIndex((l) => l.includes(needle));

assert.ok(target > 0, `row with "${needle}" exists`);
assert.equal(caretRows.length, 1, 'exactly one caret row');
assert.equal(caretRows[0], target, `caret block must sit on the ${needle} row`);
console.log(`OK caret on ${needle} row`);
}
