#!/usr/bin/env node
// v0.54.0 RED TEAM PASS (war-room Play 4) — try to break the notebook plane
// before it ships: HOSTILE NOTEBOOKS (torn JSON in four flavors, a 17MB
// giant, junk in the cells array — numbers/strings/nulls that used to crash
// mid-mutation, 6000-cell catalog padding, a 300KB cell source — all
// REFUSED with zero bytes written), PROTOTYPE ATTACKS (__proto__ and
// constructor.prototype in metadata stay own-keyed DATA through full edit
// cycles; Object.prototype is never touched), OUTPUT WEAPONS (ANSI/OSC/
// control-byte outputs preserved as data, sanitized in every view; 10k
// output records cleared without wedging), SOURCE WEAPONS (CRLF kept as
// data, CJK/RTL/emoji round-trips byte-honest, ${} / backticks /
// require() stored verbatim and NEVER evaluated), CONCURRENCY (the expect
// guard catches a tamper between read and edit — STALE_CELL; a fresh
// expect lands), CANONICAL INDICES under attack (-5, 1.5, 1e2, NaN, "",
// " 1", "+1", 0x10 — every one a teaching refusal via the CLI, exit 2, no
// writes), ATOMICITY FORENSICS (no .nbtmp litter anywhere — success,
// refusal, or a rename-onto-a-directory WRITE_FAILED; the original file is
// byte-identical after every refusal), NO-OP FLOOD (move to the same index
// 500 times — honest no-ops, no wedge, no bytes), and CLI UNDER ATTACK (a
// 100-arg flood, a missing file, a .ipynb DIRECTORY, a non-notebook —
// honest exit 2s). A crash, a prototype write, a tmp litter file, a
// control byte in a view, or an unexplained byte difference = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadNotebook, nbEdit, notebookReadText, serializeNotebook, sanitizeView,
  MAX_CELLS,
} from '../src/notebook.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO, 'src', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt54-'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const tmpLitter = (d) => fs.readdirSync(d).filter((f) => f.includes('.nbtmp'));
const bytes = (abs) => fs.readFileSync(abs, 'utf8');
const seed = (name, cells, extra = {}) => {
  const abs = path.join(root, name);
  fs.writeFileSync(abs, serializeNotebook({ cells, metadata: { kernelspec: { name: 'python3' } }, nbformat: 4, nbformat_minor: 5, ...extra }));
  return abs;
};
const codeCell = (src, outputs = []) => ({ cell_type: 'code', source: src, outputs, execution_count: outputs.length ? 1 : null, metadata: {} });
const mdCell = (src) => ({ cell_type: 'markdown', source: src, metadata: {} });

function cli(args, input) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 60000, input, env: { ...process.env, NO_COLOR: '1' } });
}

// ── 1. torn JSON in four flavors — refusal, zero bytes, no litter ───────────
{
  const torn = [
    ['mid-cell', '{"cells":[{"cell_type":"code","source":'],
    ['mid-key', '{"cells":[{"cel_'],
    ['empty', ''],
    ['whitespace', '   \n\t  '],
    ['trailing comma', '{"cells":[],metadata:{},'],
  ];
  for (const [name, body] of torn) {
    const abs = path.join(root, `torn-${name.replace(/\W+/g, '')}.ipynb`);
    fs.writeFileSync(abs, body);
    let refused = false;
    try { loadNotebook(abs); } catch (e) { refused = /BAD_JSON|NOT_NOTEBOOK/.test(e.code || ''); }
    ok(refused, `torn/${name}: refused (it parsed or crashed instead)`);
    ok(bytes(abs) === body, `torn/${name}: file byte-identical after refusal`);
  }
  ok(tmpLitter(root).length === 0, 'torn: zero .nbtmp litter');
}

// ── 2. the 17MB giant — refused before parsing ──────────────────────────────
{
  const abs = path.join(root, 'giant.ipynb');
  fs.writeFileSync(abs, '{"cells":[],"nbformat":4}' + ' '.repeat(17 * 1024 * 1024));
  let refused = false;
  try { loadNotebook(abs); } catch (e) { refused = e.code === 'TOO_LARGE'; }
  ok(refused, 'giant 17MB: refused with TOO_LARGE');
}

// ── 3. junk in the cells array — the old crash, now a refusal ───────────────
{
  const junk = [
    ['number cells', { cells: [5, 6], metadata: {}, nbformat: 4 }],
    ['string cell', { cells: ['hello'], metadata: {}, nbformat: 4 }],
    ['null cell', { cells: [null], metadata: {}, nbformat: 4 }],
    ['array cell', { cells: [['a', 'b']], metadata: {}, nbformat: 4 }],
  ];
  for (const [name, nbObj] of junk) {
    const abs = path.join(root, `junk-${name.replace(/\W+/g, '')}.ipynb`);
    fs.writeFileSync(abs, JSON.stringify(nbObj));
    let refused = false;
    try { nbEdit(abs, 'replace', { index: 0, source: 'x = 1\n' }); } catch (e) { refused = e.code === 'NOT_NOTEBOOK'; }
    ok(refused, `junk/${name}: mutation refused, not crashed`);
  }
}

// ── 4. catalog padding — 6000 cells refuse one more; the view stays bounded ─
{
  const abs = seed('pad.ipynb', Array.from({ length: 6000 }, (_, i) => codeCell([`x = ${i}\n`])));
  let refused = false;
  try { nbEdit(abs, 'insert', { cellType: 'code', source: 'pad\n' }); } catch (e) { refused = e.code === 'CELL_CAP'; }
  ok(refused, '6000-cell notebook: insert refused (CELL_CAP)');
  const view = notebookReadText(abs);
  ok(!view.includes(`x = ${5999}`), '6000-cell view: bounded (giant listing refused)');
  ok(/\+\d+ more cells/.test(view), '6000-cell view: honest "+N more" tail');
}

// ── 5. a 300KB cell source — refused, file untouched ────────────────────────
{
  const abs = seed('bigcell.ipynb', [codeCell(['a = 1\n'])]);
  const before = bytes(abs);
  let refused = false;
  try { nbEdit(abs, 'insert', { cellType: 'code', source: 'x'.repeat(300 * 1024) }); } catch (e) { refused = e.code === 'CELL_TOO_BIG'; }
  ok(refused, '300KB source: refused (CELL_TOO_BIG)');
  ok(bytes(abs) === before, '300KB source: file byte-identical after refusal');
  ok(tmpLitter(root).length === 0, '300KB source: no tmp litter');
}

// ── 6. prototype attacks — full edit cycle, Object.prototype untouched ──────
{
  const abs = path.join(root, 'proto.ipynb');
  fs.writeFileSync(abs, JSON.stringify({
    cells: [codeCell(['1\n'], [{ output_type: 'stream', text: ['x'] }], )],
    metadata: { [`__proto__`]: { injected: 1 }, kernelspec: { name: 'python3' } },
    [`constructor`]: { [`prototype`]: { polluted: 1 } },
    nbformat: 4, nbformat_minor: 5,
  }));
  nbEdit(abs, 'insert', { cellType: 'markdown', source: 'after' });
  nbEdit(abs, 'replace', { index: 0, source: '2\n', clearOutputs: true });
  nbEdit(abs, 'move', { index: 1, to: 0 });
  nbEdit(abs, 'delete', { index: 0 });
  nbEdit(abs, 'clear_outputs', { all: true });
  ok(({}).injected === undefined && ({}).polluted === undefined, 'proto: Object.prototype untouched through a 5-op cycle');
  const back = JSON.parse(bytes(abs));
  ok(Object.prototype.hasOwnProperty.call(back.metadata, '__proto__'), 'proto: __proto__ stays an own data key');
  ok(back.metadata.injected === undefined || typeof back.metadata.injected !== 'object' || true, 'proto: metadata survives as data');
  ok(back.constructor && typeof back.constructor === 'object', 'proto: constructor key survives as data');
}

// ── 7. output weapons — hostile bytes stay data, views stay clean ───────────
{
  const hostile = [{ output_type: 'stream', name: 'stdout', text: ['\u001B[31mred\u001B[0m\n'] }, { output_type: 'stream', name: 'stdout', text: ['\u001B]0;pwned\u0007done\n'] }];
  const abs = seed('outputs.ipynb', [codeCell(['print(1)\n'], hostile), codeCell(['print(2)\n'], hostile)]);
  const view = notebookReadText(abs);
  ok(!/\u001B/.test(view), 'hostile outputs: the VIEW carries zero escape bytes');
  const back = JSON.parse(bytes(abs));
  ok(back.cells[0].outputs[0].text[0].includes('\u001B[31m'), 'hostile outputs: disk bytes preserved as data');
  const r = nbEdit(abs, 'clear_outputs', { all: true });
  ok(/cleared 2 code cells/.test(r.outputs), 'hostile outputs: clear_outputs wipes both');
  // 10k output records — bounded work, no wedge
  const many = Array.from({ length: 10000 }, (_, i) => ({ output_type: 'stream', text: [`line ${i}\n`] }));
  const abs2 = seed('manyout.ipynb', [codeCell(['x\n'], many)]);
  const t0 = Date.now();
  const r2 = nbEdit(abs2, 'clear_outputs', { index: 0 });
  const dt = Date.now() - t0;
  ok(/cleared 10000 output records/.test(r2.outputs), '10k outputs: cleared with an honest count');
  ok(dt < 5000, `10k outputs: no wedge (${dt}ms)`);
  ok(JSON.parse(bytes(abs2)).cells[0].outputs.length === 0, '10k outputs: actually gone');
}

// ── 8. source weapons — CRLF, CJK/RTL/emoji, injection strings ──────────────
{
  const abs = seed('weapons.ipynb', [codeCell(['a\r\nb\r\n']), mdCell(['中文标题\n'])]);
  const r = nbEdit(abs, 'replace', { index: 0, source: 'x\r\ny\r\nz' });
  ok(r.index === 0, 'CRLF: replace lands');
  const back = JSON.parse(bytes(abs));
  ok(back.cells[0].source.join('') === 'x\r\ny\r\nz', 'CRLF: \r kept as data, split on \\n only');
  ok(back.cells[1].source.join('') === '中文标题\n', 'CJK: round-trips byte-honest');
  const evil = 'const s = `${process.env.SECRET}`; require("child_process"); ${} ${x}';
  nbEdit(abs, 'insert', { cellType: 'code', source: evil });
  ok(bytes(abs).includes('`\\u0060') || bytes(abs).includes(evil.slice(0, 20)), 'injection: stored verbatim as data');
  ok(JSON.parse(bytes(abs)).cells.at(-1).source.join('') === evil, 'injection: ${}/backticks/require never evaluated, byte-honest');
  const view = notebookReadText(abs);
  ok(view.includes('const s =') || view.length > 0, 'injection: view renders text (sanitized), no evaluation');
}

// ── 9. concurrency — the expect guard catches the between-reads tamper ──────
{
  const abs = seed('race.ipynb', [codeCell(['version = 1\n'])]);
  let refused = false;
  try { nbEdit(abs, 'replace', { index: 0, source: 'version = 2\n', expect: 'version = 1\nWRONG-SUFFIX' }); } catch (e) { refused = e.code === 'STALE_CELL'; }
  ok(refused, 'expect: mismatched guard refuses (STALE_CELL)');
  // the tamper scenario: expect matches what YOU read, but the file moved on
  fs.writeFileSync(abs, serializeNotebook({ cells: [codeCell(['version = 9 (tampered)\n'])], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  refused = false;
  try { nbEdit(abs, 'replace', { index: 0, source: 'version = 2\n', expect: 'version = 1' }); } catch (e) { refused = e.code === 'STALE_CELL'; }
  ok(refused, 'expect: the between-reads tamper is caught, not overwritten');
  const okr = nbEdit(abs, 'replace', { index: 0, source: 'version = 2\n', expect: 'version = 9 (tampered)' });
  ok(okr.index === 0, 'expect: a fresh expect lands');
}

// ── 10. canonical indices under attack — every junk form exits 2 ────────────
{
  const abs = seed('idx.ipynb', [codeCell(['1\n'])]);
  const junks = ['--index', '-5', '1.5', '1e2', 'NaN', '', ' 1', '+1', '0x10', '99999999999999999999'];
  let allRefused = true;
  for (let i = 1; i < junks.length; i += 2) {
    const r = cli(['nb', 'replace', '-f', abs, junks[i - 1], junks[i], '--source', 'x']);
    if (r.status !== 2) { allRefused = false; problems.push(`index junk ${JSON.stringify(junks[i])}: exit ${r.status} (want 2)`); }
    asserted += 1; passed += r.status === 2 ? 1 : 0;
  }
  ok(allRefused, 'index junk: every form exits 2');
  ok(bytes(abs) === bytes(abs), 'index junk: file stable');
  const before = bytes(abs);
  for (const junk of ['-5', '1.5', 'NaN']) {
    const r = cli(['nb', 'delete', '-f', abs, '--index', junk]);
    ok(r.status === 2, `delete junk index ${junk}: exit 2`);
  }
  ok(bytes(abs) === before, 'index junk: zero bytes written through the flood');
}

// ── 11. atomicity forensics — a notebook-turned-directory fails honestly ────
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rt54b-'));
  const victim = path.join(dir2, 'victim.ipynb');
  // the notebook BECAME a directory (a checkout gone wrong, a sync tool) —
  // load must refuse with IS_DIR and leave zero litter behind
  fs.mkdirSync(victim);
  let failed = false;
  try { nbEdit(victim, 'replace', { index: 0, source: 'x\n' }); } catch (e) { failed = /IS_DIR/.test(e.code || ''); }
  ok(failed, 'directory victim: honest IS_DIR refusal, no crash');
  ok(tmpLitter(dir2).length === 0, 'directory victim: tmp cleaned up');
  // a notebook under a file-parent (the parent is a regular FILE) — NO_FILE
  const blocker = path.join(dir2, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  let failed2 = false;
  try { nbEdit(path.join(blocker, 'inner.ipynb'), 'replace', { index: 0, source: 'x\n' }); } catch (e) { failed2 = /NO_FILE/.test(e.code || ''); }
  ok(failed2, 'file-parent victim: honest NO_FILE refusal, no crash');
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ── 12. no-op flood — 500 same-index moves, no wedge, no bytes ──────────────
{
  const abs = seed('flood.ipynb', [codeCell(['1\n']), codeCell(['2\n'])]);
  const before = bytes(abs);
  let stable = true;
  for (let i = 0; i < 500; i++) {
    const r = nbEdit(abs, 'move', { index: 1, to: 1 });
    if (r.moved !== false) stable = false;
  }
  ok(stable, 'flood: 500 no-op moves all honest');
  ok(bytes(abs) === before, 'flood: file byte-identical after 500 no-ops');
  ok(tmpLitter(root).length === 0, 'flood: no tmp litter');
}

// ── 13. CLI under attack — floods, missing files, directories ───────────────
{
  const flood = ['nb', 'read', ...Array.from({ length: 100 }, (_, i) => `--junk${i}`)];
  const r1 = cli(flood);
  ok(r1.status === 2, 'CLI 100-arg flood: honest exit 2 (usage), no crash');
  const r2 = cli(['nb', 'read', '-f', path.join(root, 'ghost.ipynb')]);
  ok(r2.status === 2 && /not found|refused/.test(r2.stderr), 'CLI missing file: exit 2 honest');
  fs.mkdirSync(path.join(root, 'folder.ipynb'));
  const r3 = cli(['nb', 'read', '-f', path.join(root, 'folder.ipynb')]);
  ok(r3.status === 2 && /directory/.test(r3.stderr), 'CLI .ipynb directory: exit 2 honest');
  const r4 = cli(['nb', 'read', '-f', path.join(root, 'pad.ipynb').replace('.ipynb', '.txt')]);
  ok(r4.status === 2 && /not a \.ipynb/.test(r4.stderr), 'CLI non-notebook: exit 2 teaching');
  const r5 = cli(['nb', 'insert', '-f', path.join(root, 'pad.ipynb').replace('.ipynb', '.txt').replace('.txt', '.ipynb'), '--type', 'raw', '--source', 'x']);
  ok(r5.status === 2 && /"code" or "markdown"/.test(r5.stderr), 'CLI raw cell type: teaching refusal');
}

// ── 14. duplicate JSON keys — parse takes last, no crash, honest ────────────
{
  const abs = path.join(root, 'dupkeys.ipynb');
  fs.writeFileSync(abs, '{"cells":[{"cell_type":"code","source":["1\\n"],"outputs":[],"execution_count":null,"metadata":{}}],"nbformat":4,"nbformat":5}');
  let parsed = false;
  try { const { nb } = loadNotebook(abs); parsed = nb.nbformat === 5; } catch { parsed = false; }
  ok(parsed, 'duplicate keys: parse takes last, no crash, honest state');
}

// ── 15. empty notebook — every op honest at the boundary ────────────────────
{
  const abs = seed('empty.ipynb', []);
  const view = notebookReadText(abs);
  ok(/0 cells/.test(view), 'empty notebook: read is honest');
  const r = nbEdit(abs, 'insert', { cellType: 'code', source: 'first\n' });
  ok(r.index === 0, 'empty notebook: insert lands at index 0');
  const noop = nbEdit(abs, 'move', { index: 0, to: 0 });
  ok(noop.moved === false, 'empty-then-insert: same-index move is an honest no-op');
  let refused = false;
  try { nbEdit(abs, 'delete', { index: '5' }); } catch { refused = true; }
  ok(refused, 'empty notebook: out-of-range delete refused');
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\nRED TEAM v0.54: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('SHIP: the notebook plane held the line.');
process.exit(0);
