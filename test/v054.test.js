// v0.54.0 — NOTEBOOK SUPPORT (§11): the nb_read/nb_edit tools over .ipynb
// cells. Tests run against the pure engine (src/notebook.js), the REAL CLI
// (index.js notebook …), and the REAL agent tool layer (LocalScope + the
// registered nb_read/nb_edit tools).
// Pins that carry the house rules:
//   - BROKEN INPUT IS A REFUSAL: torn JSON, JSON without a cells array, a
//     directory named *.ipynb, oversized notebooks/cells — all refused with
//     ZERO bytes written (atomic tmp+rename discipline, no torn hybrids);
//   - indices are canonical-or-refused: "1.5", -1, 1e2, NaN, "" are teaching
//     errors (the v0.50/v0.51 knob lessons), never coerced into a guess;
//   - OUTPUTS BELONG TO THE CODE THAT MADE THEM: replace keeps outputs but
//     says STALE in plain English; clear_outputs / clearOutputs:true drops
//     them; delete takes them with the cell;
//   - the freshness guard rides nb_edit exactly like fs_replace: a notebook
//     changed outside the agent's hands is refused until re-read;
//   - views are sanitized (ANSI/control bytes stripped), disk bytes are not;
//   - integrity: metadata/kernelspec/nbformat survive every op and the file
//     always re-parses; __proto__ in the notebook stays DATA (no pollution);
//   - .ipynb-only path policy in the tool layer; the freshness baseline is
//     established by nb_read (and every successful mutation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadNotebook, nbEdit, notebookReadText, normalizeSource, sourceText,
  parseIndex, sanitizeView, isNotebookPath, serializeNotebook,
  MAX_CELL_BYTES, MAX_CELLS,
} from '../src/notebook.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { BuddyError } from '../src/util.js';

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO, 'src', 'index.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-nb54-'));
}

function seedNb(dir, name = 'demo.ipynb', cells) {
  const nb = {
    cells: cells ?? [
      { cell_type: 'code', source: ['x = 1\n', 'print(x)\n'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }], execution_count: 1, metadata: {}, id: 'c0' },
      { cell_type: 'markdown', source: ['# Title\n', 'notes'], outputs: [], execution_count: null, metadata: {}, id: 'c1' },
      { cell_type: 'code', source: ['y = 2\n'], outputs: [], execution_count: null, metadata: {}, id: 'c2' },
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, serializeNotebook(nb));
  return abs;
}

const nb = (abs) => JSON.parse(fs.readFileSync(abs, 'utf8'));

// ── engine: load + read ──────────────────────────────────────────────────────

test('loadNotebook: honest refusals (missing, dir, torn JSON, not a notebook)', () => {
  const dir = tmp();
  assert.throws(() => loadNotebook(path.join(dir, 'nope.ipynb')), /NO_FILE|not found/);
  fs.mkdirSync(path.join(dir, 'dir.ipynb'));
  assert.throws(() => loadNotebook(path.join(dir, 'dir.ipynb')), /IS_DIR|directory/);
  const torn = path.join(dir, 'torn.ipynb');
  fs.writeFileSync(torn, '{"cells":[{"cell_type":"code","source":');
  assert.throws(() => loadNotebook(torn), /BAD_JSON|not valid JSON/);
  const notNb = path.join(dir, 'plain.ipynb');
  fs.writeFileSync(notNb, '{"a":1}\n');
  assert.throws(() => loadNotebook(notNb), /NOT_NOTEBOOK|no cells array/);
  // after all three refusals, nothing new was written anywhere
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.nbtmp')).length, 0);
});

test('loadNotebook: size cap refuses a giant notebook before parsing', () => {
  const dir = tmp();
  const abs = path.join(dir, 'big.ipynb');
  fs.writeFileSync(abs, JSON.stringify({ cells: [], metadata: {}, nbformat: 4 }) + ' '.repeat(17 * 1024 * 1024));
  assert.throws(() => loadNotebook(abs), /TOO_LARGE|read cap/);
});

test('notebookReadText: bounded, honest listing with counts and kernel', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const t = notebookReadText(abs);
  assert.match(t, /nbformat 4\.5 · 3 cells/);
  assert.match(t, /kernel: python3/);
  assert.match(t, /\[  0\] code · outputs 1 · exec 1 · 2L · x = 1/);
  assert.match(t, /\[  1\] markdown · 2L · # Title/);
  assert.match(t, /\[  2\] code · outputs 0 · 1L · y = 2/);
});

test('view sanitization: ANSI/control bytes are stripped from the VIEW, never from disk', () => {
  const dir = tmp();
  const abs = seedNb(dir, 'ansi.ipynb', [
    { cell_type: 'code', source: ['print("\u001B[31mred\u001B[0m")\n'], outputs: [], execution_count: null, metadata: {}, id: 'a' },
  ]);
  const t = notebookReadText(abs);
  assert.doesNotMatch(t, /\u001B/); // the view is clean
  const onDisk = fs.readFileSync(abs, 'utf8');
  // JSON.stringify escapes ESC as the 6-char sequence \u001b — the DATA is
  // still there, byte-faithfully encoded (the v0.52 display-renderer ghost:
  // the Bash tool EATS [31m in DISPLAYED output; disk bytes are the truth)
  assert.match(onDisk, /\\u001b\[31m/);
  assert.match(JSON.parse(onDisk).cells[0].source[0], /\u001B\[31m/); // parse restores the real bytes
  assert.equal(sanitizeView('\u001B]0;title\u0007x\u0007y\u0008z'), 'xyz');
});

// ── engine: source normalization ─────────────────────────────────────────────

test('normalizeSource: nbformat line semantics (trailing newline implicit)', () => {
  assert.deepEqual(normalizeSource('a\nb'), ['a\n', 'b']);
  assert.deepEqual(normalizeSource('a\n'), ['a\n']);
  assert.deepEqual(normalizeSource('a'), ['a']);
  assert.deepEqual(normalizeSource(''), []);
  assert.deepEqual(normalizeSource('a\r\nb'), ['a\r\n', 'b']); // \r stays data
  assert.equal(sourceText(['a\n', 'b']), 'a\nb');
  assert.equal(sourceText('plain'), 'plain');
});

// ── engine: index canonicality ───────────────────────────────────────────────

test('parseIndex: canonical-or-refused — junk is a teaching error, never a guess', () => {
  assert.equal(parseIndex(0), 0);
  assert.equal(parseIndex('12'), 12);
  for (const junk of ['1.5', '-1', '1e2', 'NaN', '', '0x10', ' 1 ', '+1', '1\n', null, undefined, {}, 1.5]) {
    assert.throws(() => parseIndex(junk), /BAD_INDEX|0-based integer/, `index ${JSON.stringify(junk)} must refuse`);
  }
});

// ── engine: insert ───────────────────────────────────────────────────────────

test('insert: appends at the end by default, honors after, generates ids only when siblings have them', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const r1 = nbEdit(abs, 'insert', { cellType: 'markdown', source: '## Analysis' });
  assert.equal(r1.index, 3);
  assert.equal(r1.cellsAfter, 4);
  const n1 = nb(abs);
  assert.equal(n1.cells[3].cell_type, 'markdown');
  assert.deepEqual(n1.cells[3].source, ['## Analysis']);
  assert.ok(!('outputs' in n1.cells[3]) || n1.cells[3].outputs === undefined, 'markdown cells carry no outputs');
  const r2 = nbEdit(abs, 'insert', { cellType: 'code', source: 'z = 3\nprint(z)', after: 0 });
  assert.equal(r2.index, 1);
  const n2 = nb(abs);
  assert.deepEqual(sourceText(n2.cells[1].source), 'z = 3\nprint(z)');
  assert.ok(typeof n2.cells[1].id === 'string' && n2.cells[1].id, 'id added when all siblings carry ids');
  assert.deepEqual(n2.cells[1].outputs, []);
  assert.equal(n2.cells[1].execution_count, null);
  // a legacy notebook without ids gets no invented ids
  const legacy = path.join(dir, 'legacy.ipynb');
  fs.writeFileSync(legacy, serializeNotebook({ cells: [{ cell_type: 'code', source: 'a\n', outputs: [], execution_count: null, metadata: {} }], metadata: {}, nbformat: 4, nbformat_minor: 1 }));
  nbEdit(legacy, 'insert', { cellType: 'code', source: 'b\n' });
  assert.ok(!('id' in nb(legacy).cells[1]), 'no id invented for legacy notebooks');
});

test('insert: bad type, empty source, giant source, cell cap — all refused with zero bytes', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const before = fs.readFileSync(abs, 'utf8');
  for (const [args, re] of [
    [{ cellType: 'raw', source: 'x' }, /BAD_TYPE|"code" or "markdown"/],
    [{ cellType: 'code', source: '' }, /BAD_SOURCE|non-empty/],
    [{ cellType: 'code' }, /non-empty/],
    [{ cellType: 'code', source: 'x'.repeat(MAX_CELL_BYTES + 1) }, /CELL_TOO_BIG|per-cell cap/],
    [{ cellType: 'code', source: 'x', after: '99' }, /BAD_INDEX|out of range/],
  ]) {
    assert.throws(() => nbEdit(abs, 'insert', args), re, JSON.stringify(args).slice(0, 60));
  }
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'every failed insert left the file byte-identical');
  // the cap: MAX_CELLS cells refuse one more
  const full = path.join(dir, 'full.ipynb');
  fs.writeFileSync(full, serializeNotebook({ cells: Array.from({ length: MAX_CELLS }, () => ({ cell_type: 'code', source: '1\n', outputs: [], execution_count: null, metadata: {} })), metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  assert.throws(() => nbEdit(full, 'insert', { cellType: 'code', source: 'x' }), /CELL_CAP|cap/);
});

// ── engine: replace + outputs discipline ─────────────────────────────────────

test('replace: works by index, keeps outputs with the STALE warning, clearOutputs drops them', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const r1 = nbEdit(abs, 'replace', { index: 0, source: 'x = 42\nprint(x)\n' });
  assert.equal(r1.outputs, 'kept (stale — they belong to the previous source)');
  assert.ok(r1.warnings.some((w) => /outputs kept/.test(w)));
  let n = nb(abs);
  assert.deepEqual(sourceText(n.cells[0].source), 'x = 42\nprint(x)\n');
  assert.equal(n.cells[0].outputs.length, 1, 'outputs kept by default (Jupyter semantics)');
  const r2 = nbEdit(abs, 'replace', { index: 0, source: 'x = 43\n', clearOutputs: true });
  assert.equal(r2.outputs, 'cleared');
  n = nb(abs);
  assert.deepEqual(n.cells[0].outputs, []);
  assert.equal(n.cells[0].execution_count, null);
  // replacing a markdown cell that never had outputs reports none
  const r3 = nbEdit(abs, 'replace', { index: 1, source: '# New title' });
  assert.equal(r3.outputs, undefined);
});

test('replace: type-flip refused, out-of-range refused, expect guard (STALE_CELL)', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const before = fs.readFileSync(abs, 'utf8');
  assert.throws(() => nbEdit(abs, 'replace', { index: 0, source: 'x', cellType: 'markdown' }), /BAD_TYPE|flip/);
  assert.throws(() => nbEdit(abs, 'replace', { index: 9, source: 'x' }), /BAD_INDEX|out of range/);
  assert.throws(() => nbEdit(abs, 'replace', { index: 0, source: 'x', expect: 'y = ' }), /STALE_CELL|stale/);
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'refused replaces wrote nothing');
  const ok = nbEdit(abs, 'replace', { index: 0, source: 'x = 7\n', expect: 'x = 1' });
  assert.equal(ok.index, 0);
  assert.equal(sourceText(nb(abs).cells[0].source), 'x = 7\n');
});

// ── engine: delete / move / clear_outputs ────────────────────────────────────

test('delete: removes the cell and its outputs ride along', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const r = nbEdit(abs, 'delete', { index: 0 });
  assert.equal(r.cellsAfter, 2);
  assert.match(r.outputs, /dropped 1 output record/);
  const n = nb(abs);
  assert.equal(n.cells.length, 2);
  assert.equal(sourceText(n.cells[0].source), '# Title\nnotes');
  assert.throws(() => nbEdit(abs, 'delete', { index: '5' }), /BAD_INDEX|out of range/);
});

test('move: forward, backward, same-index honest no-op (no write), bounds refused', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const before = fs.readFileSync(abs, 'utf8');
  const noop = nbEdit(abs, 'move', { index: 1, to: 1 });
  assert.equal(noop.moved, false);
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'a no-op move wrote nothing');
  const fwd = nbEdit(abs, 'move', { index: 0, to: 2 });
  assert.equal(fwd.moved, true);
  let n = nb(abs);
  assert.equal(sourceText(n.cells[2].source), 'x = 1\nprint(x)\n');
  const back = nbEdit(abs, 'move', { index: 2, to: 0 });
  assert.equal(back.moved, true);
  n = nb(abs);
  assert.equal(sourceText(n.cells[0].source), 'x = 1\nprint(x)\n');
  assert.throws(() => nbEdit(abs, 'move', { index: 0, to: '9' }), /out of range/);
  assert.throws(() => nbEdit(abs, 'move', { index: '99', to: 0 }), /out of range/);
});

test('clear_outputs: one cell, all cells, markdown refusal, honest already-empty', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  assert.throws(() => nbEdit(abs, 'clear_outputs', { index: 1 }), /NO_OUTPUTS|markdown/);
  const r1 = nbEdit(abs, 'clear_outputs', { index: 0 });
  assert.match(r1.outputs, /cleared 1 output record/);
  const r2 = nbEdit(abs, 'clear_outputs', { index: 0 });
  assert.match(r2.outputs, /already empty/);
  const r3 = nbEdit(abs, 'clear_outputs', { all: true });
  assert.match(r3.outputs, /cleared 0 code cells|cleared 0/);
  // seed outputs on two code cells, then all
  nbEdit(abs, 'replace', { index: 2, source: 'y = 2\n', clearOutputs: false });
  const n = nb(abs);
  n.cells[0].outputs = [{ output_type: 'stream', text: ['a'] }];
  n.cells[2].outputs = [{ output_type: 'stream', text: ['b'] }];
  fs.writeFileSync(abs, serializeNotebook(n));
  const r4 = nbEdit(abs, 'clear_outputs', { all: true });
  assert.match(r4.outputs, /cleared 2 code cells/);
  const after = nb(abs);
  assert.deepEqual(after.cells[0].outputs, []);
  assert.deepEqual(after.cells[2].outputs, []);
});

// ── integrity + prototype safety ─────────────────────────────────────────────

test('integrity: metadata/kernelspec/nbformat survive every op; the file always re-parses', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  nbEdit(abs, 'insert', { cellType: 'markdown', source: 'm' });
  nbEdit(abs, 'replace', { index: 0, source: 'x = 9\n', clearOutputs: true });
  nbEdit(abs, 'delete', { index: 2 });
  nbEdit(abs, 'move', { index: 0, to: 1 });
  nbEdit(abs, 'clear_outputs', { all: true });
  const n = nb(abs); // would throw if torn
  assert.deepEqual(n.metadata.kernelspec, { name: 'python3', display_name: 'Python 3' });
  assert.equal(n.nbformat, 4);
  assert.equal(n.nbformat_minor, 5);
  assert.ok(Array.isArray(n.cells));
});

test('prototype safety: __proto__/constructor keys in the notebook stay DATA', () => {
  const dir = tmp();
  const abs = path.join(dir, 'evil.ipynb');
  fs.writeFileSync(abs, JSON.stringify({
    cells: [{ cell_type: 'code', source: '1\n', outputs: [], execution_count: null, metadata: { [`__proto__`]: { injected: true } } }],
    metadata: { [`constructor`]: { prototype: { polluted: true } } },
    nbformat: 4, nbformat_minor: 5,
  }));
  nbEdit(abs, 'insert', { cellType: 'markdown', source: 'after evil' });
  nbEdit(abs, 'replace', { index: 0, source: '2\n' });
  assert.equal(({}).injected, undefined, 'Object.prototype untouched');
  assert.equal(({}).polluted, undefined, 'Object.prototype untouched (constructor route)');
  const back = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const m = back.cells[0].metadata;
  assert.ok(Object.prototype.hasOwnProperty.call(m, '__proto__'), '__proto__ stays an own data key');
  assert.ok(back.metadata.constructor && typeof back.metadata.constructor === 'object');
});

// ── the REAL agent tool layer (LocalScope + buildLocalTools) ─────────────────

function scopeWith() {
  const dir = tmp();
  const abs = seedNb(dir);
  const scope = new LocalScope(dir);
  const tools = buildLocalTools({ scope });
  const read = tools.find((t) => t.name === 'nb_read');
  const edit = tools.find((t) => t.name === 'nb_edit');
  assert.ok(read && edit, 'nb_read + nb_edit are registered in the chat toolset');
  return { dir, abs, scope, read, edit };
}

test('tool layer: nb_read lists + establishes the freshness baseline', async () => {
  const { abs, read } = scopeWith();
  const out = await read.run({ path: 'demo.ipynb' });
  assert.match(out, /NOTEBOOK .*demo\.ipynb/);
  assert.match(out, /3 cells/);
  // absolute paths are refused by the tool layer (the house _guard — the
  // workspace addresses files relatively, extra roots via alias)
  const out2 = await read.run({ path: abs });
  assert.match(out2, /ERROR: .*unsafe path/);
});

test('tool layer: .ipynb-only policy — other extensions are teaching refusals', async () => {
  const { dir, read, edit } = scopeWith();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'nb.ipynb.bak'), '{}\n');
  assert.match(await read.run({ path: 'notes.txt' }), /not a \.ipynb/);
  assert.match(await edit.run({ op: 'replace', path: 'nb.ipynb.bak', index: 0, source: 'x' }), /not a \.ipynb/);
  assert.match(await read.run({ path: '../outside.ipynb' }), /unsafe path/);
  assert.match(await read.run({ path: '/etc/passwd.ipynb' }), /unsafe path/);
  assert.match(await read.run({}), /path required/);
});

test('tool layer: nb_edit insert/replace/move receipts are bounded and honest', async () => {
  const { abs, edit } = scopeWith();
  const ins = await edit.run({ op: 'insert', path: 'demo.ipynb', cellType: 'code', source: 'z = 9\n', why: 'add a demo cell' });
  assert.match(ins, /OK insert cell \[3\] code 3→4 cells/);
  const rep = await edit.run({ op: 'replace', path: 'demo.ipynb', index: 0, source: 'x = 100\n', why: 'update the demo' });
  assert.match(rep, /OK replace cell \[0\] code 4→4 cells/);
  assert.match(rep, /outputs: kept \(stale/);
  const mv = await edit.run({ op: 'move', path: 'demo.ipynb', index: 3, to: 0, why: 'reorder' });
  assert.match(mv, /OK move cell \[3\] → \[0\]/);
  assert.equal(nb(abs).cells[0].cell_type, 'code');
});

test('tool layer: the freshness guard refuses edits after an OUT-OF-BAND change', async () => {
  const { dir, abs, read, edit } = scopeWith();
  assert.match(await read.run({ path: 'demo.ipynb' }), /3 cells/); // baseline
  // out-of-band mutation (not via our tools)
  const n = nb(abs);
  n.cells.push({ cell_type: 'markdown', source: 'sneaky', metadata: {} });
  fs.writeFileSync(abs, serializeNotebook(n));
  const refused = await edit.run({ op: 'replace', path: 'demo.ipynb', index: 0, source: 'x = 5\n', why: 'blind edit' });
  assert.match(refused, /ERROR: .*changed since you last read it/);
  // re-read clears the staleness; the edit then lands
  assert.match(await read.run({ path: 'demo.ipynb' }), /4 cells/);
  const ok = await edit.run({ op: 'replace', path: 'demo.ipynb', index: 0, source: 'x = 5\n', why: 'informed edit' });
  assert.match(ok, /OK replace/);
});

test('tool layer: broken op names and broken notebooks come back as errors, not crashes', async () => {
  const { dir, edit } = scopeWith();
  assert.match(await edit.run({ op: 'explode', path: 'demo.ipynb' }), /op must be one of/);
  assert.match(await edit.run({}), /path required/);
  const tornPath = path.join(dir, 'torn.ipynb');
  fs.writeFileSync(tornPath, '{"cells": [');
  const out = await edit.run({ op: 'read', path: 'torn.ipynb' });
  assert.match(out, /not valid JSON/);
  const dirAsNb = path.join(dir, 'folder.ipynb');
  fs.mkdirSync(dirAsNb);
  assert.match(await edit.run({ op: 'read', path: 'folder.ipynb' }), /is a directory/);
});

// ── the REAL CLI ─────────────────────────────────────────────────────────────

function cli(args, input) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 60000, input, env: { ...process.env, NO_COLOR: '1' } });
}

test('CLI: notebook read / insert / replace / move / clear drive the real engine', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const r1 = cli(['nb', 'read', '-f', abs]);
  assert.equal(r1.status, 0);
  assert.match(r1.stderr, /3 cells/);
  const r2 = cli(['notebook', 'insert', '-f', abs, '--type', 'markdown', '--source', '## hello']);
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /OK insert cell \[3\] markdown 3→4 cells/);
  const r3 = cli(['nb', 'replace', '-f', abs, '--index', '0', '--source', 'x = 5\nprint(x)\n', '--clear-outputs']);
  assert.equal(r3.status, 0);
  assert.match(r3.stderr, /outputs: cleared/);
  const r4 = cli(['nb', 'move', '-f', abs, '--index', '3', '--to', '0']);
  assert.equal(r4.status, 0);
  const r5 = cli(['nb', 'clear', '-f', abs, '--all']);
  assert.equal(r5.status, 0);
  assert.match(r5.stderr, /cleared 0 code cells/);
  const n = nb(abs);
  assert.equal(n.cells[0].cell_type, 'markdown');
  assert.equal(sourceText(n.cells[1].source), 'x = 5\nprint(x)\n');
});

test('CLI: --source-file and --stdin feed big sources; refusals exit 2', () => {
  const dir = tmp();
  const abs = seedNb(dir);
  const srcFile = path.join(dir, 'cell.py');
  fs.writeFileSync(srcFile, 'import os\nprint(os.getcwd())\n');
  const r1 = cli(['nb', 'replace', '-f', abs, '--index', '0', '--source-file', srcFile]);
  assert.equal(r1.status, 0);
  assert.match(sourceText(nb(abs).cells[0].source), /import os/);
  const r2 = cli(['nb', 'insert', '-f', abs, '--type', 'code', '--stdin'], 'from stdin\n');
  assert.equal(r2.status, 0);
  assert.match(sourceText(nb(abs).cells.at(-1).source), /from stdin/);
  // refusals: unknown sub, missing file, non-notebook, bad index, junk expect
  assert.equal(cli(['nb', 'frobnicate', '-f', abs]).status, 2);
  assert.equal(cli(['nb', 'read', '-f', path.join(dir, 'nope.ipynb')]).status, 2);
  assert.equal(cli(['nb', 'read', '-f', srcFile]).status, 2);
  assert.equal(cli(['nb', 'replace', '-f', abs, '--index', '42', '--source', 'x']).status, 2);
  const rBad = cli(['nb', 'replace', '-f', abs, '--index', '0', '--source', 'x', '--expect', 'WRONG']);
  assert.equal(rBad.status, 2);
  assert.match(rBad.stderr, /stale/);
  assert.equal(cli(['nb', 'read', '-f', '../escape.ipynb']).status, 2);
});

test('CLI: a torn notebook is refused honestly and nothing is written', () => {
  const dir = tmp();
  const torn = path.join(dir, 'torn.ipynb');
  fs.writeFileSync(torn, '{"cells":[{"cell_type":"code"');
  const r = cli(['nb', 'insert', '-f', torn, '--type', 'code', '--source', 'x = 1\n']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not valid JSON|refused/);
  assert.equal(fs.readFileSync(torn, 'utf8'), '{"cells":[{"cell_type":"code"');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.nbtmp')).length, 0, 'no temp litter');
});

test('isNotebookPath + receipt shape sanity', () => {
  assert.equal(isNotebookPath('a/b.ipynb'), true);
  assert.equal(isNotebookPath('a/b.IPYNB'), true);
  assert.equal(isNotebookPath('a/b.txt'), false);
  assert.equal(isNotebookPath('a/b.ipynb.bak'), false);
  const r = nbEdit(seedNb(tmp()), 'move', { index: 0, to: 1 });
  for (const k of ['op', 'path', 'cellsBefore', 'cellsAfter', 'bytesBefore', 'bytesAfter', 'moved']) assert.ok(k in r, `receipt has ${k}`);
});
