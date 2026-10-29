#!/usr/bin/env node
// v0.54 drill — "notebook support" (§11). Readable 80-col frames into
// download/aurora-evidence/v54-readable/. Every leg drives the REAL CLI
// (real notebook files, real spawns) or the REAL agent tool layer
// (LocalScope + the registered nb_read/nb_edit tools) — module-function
// calls are declared on camera (the v0.45/v0.49/v0.52/v0.53 precedent).
// No brain is needed anywhere: notebooks are deterministic local data,
// which is exactly why the whole plane can be drilled honestly offline.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v54-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v54-drill-'));
const buddy = (args, opts = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: opts.cwd || root, encoding: 'utf8', timeout: 60000, input: opts.input,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) },
  });

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};

// ── seed a REAL notebook through the REAL module API (declared on camera) ───
const { serializeNotebook } = await import(path.join(REPO, 'src', 'notebook.js'));
const nbFile = 'analysis.ipynb';
const abs = path.join(root, nbFile);
fs.writeFileSync(abs, serializeNotebook({
  cells: [
    { cell_type: 'markdown', source: ['# Sales analysis\n', 'Quarterly revenue deep-dive.'], metadata: {}, id: 'intro' },
    { cell_type: 'code', source: ['import csv\n', 'rows = list(csv.reader(open("sales.csv")))\n', 'print(f"{len(rows)} rows")'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['42 rows\n'] }], execution_count: 1, metadata: {}, id: 'load' },
    { cell_type: 'code', source: ['total = sum(float(r[1]) for r in rows[1:])\n', 'print(round(total, 2))'], outputs: [], execution_count: null, metadata: {}, id: 'sum' },
    { cell_type: 'code', source: ['avg = total / (len(rows) - 1)\n', 'print(round(avg, 2))'], outputs: [], execution_count: null, metadata: {}, id: 'avg' },
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
  nbformat: 4, nbformat_minor: 5,
}));
fs.writeFileSync(path.join(root, 'sales.csv'), 'month,revenue\nJan,100\nFeb,140\n');
const readNb = () => JSON.parse(fs.readFileSync(abs, 'utf8'));

const frames = [];
function cap(title, sections) {
  const bar = '-'.repeat(78);
  let t = `${bar}\n${title}\n${bar}\n`;
  for (const s of sections) {
    if (s.cmd) t += `\n$ buddy ${s.cmd}\n`;
    const r = s.run;
    if (r?.stdout?.trim()) t += r.stdout.trimEnd() + '\n';
    if (r?.stderr?.trim()) t += r.stderr.trimEnd() + '\n';
    if (s.text) t += s.text.trimEnd() + '\n';
  }
  return t;
}

// ── frame-01: the read — the cell map over the real file ────────────────────
const f1 = buddy(['nb', 'read', '-f', nbFile]);
ok(f1.status === 0, `frame-01: read exits 0 (got ${f1.status})`);
ok(/nbformat 4\.5 · 4 cells/.test(f1.stderr), 'frame-01: four cells counted');
ok(/kernel: python3/.test(f1.stderr), 'frame-01: the kernel surfaces');
ok(/\[  1\] code · outputs 1 · exec 1 · 3L · import csv/.test(f1.stderr), 'frame-01: outputs + execution_count attributed per cell');
ok(/\[  2\] code · outputs 0 · 2L · total = sum/.test(f1.stderr), 'frame-01: the empty-output cell is honest');
frames.push(['frame-01-the-read.txt', cap('frame-01 — THE READ (real CLI over a real .ipynb seeded through the real module)', [
  { cmd: `nb read -f ${nbFile}`, run: f1 },
])]);

// ── frame-02: the insert — a markdown cell lands with a full receipt ────────
const f2 = buddy(['nb', 'insert', '-f', nbFile, '--type', 'markdown', '--source', '## Caveats\nFX rates are spot values.']);
ok(f2.status === 0, `frame-02: insert exits 0 (got ${f2.status})`);
ok(/OK insert cell \[4\] markdown 4→5 cells/.test(f2.stderr), 'frame-02: the receipt counts cells before/after');
ok(/\d+→\d+ bytes/.test(f2.stderr), 'frame-02: the receipt counts bytes before/after');
const f2b = buddy(['nb', 'read', '-f', nbFile]);
ok(/\[  4\] markdown · 2L · ## Caveats/.test(f2b.stderr), 'frame-02: the new cell is on the map');
frames.push(['frame-02-the-insert.txt', cap('frame-02 — THE INSERT (a markdown cell lands; the receipt is bounded and honest)', [
  { cmd: `nb insert -f ${nbFile} --type markdown --source "## Caveats\\nFX rates are spot values."`, run: f2 },
  { cmd: `nb read -f ${nbFile}`, run: f2b },
])]);

// ── frame-03: the guarded replace — staleness caught on camera ──────────────
const f3a = buddy(['nb', 'replace', '-f', nbFile, '--index', '3', '--source', 'avg = total / (len(rows) - 1)\n', 'print(f"avg {avg:.2f}")\n', '--expect', 'avg = total']);
ok(f3a.status === 0, `frame-03: guarded replace exits 0 (got ${f3a.status})`);
ok(/OK replace cell \[3\] code/.test(f3a.stderr), 'frame-03: the guard passed and the edit landed');
// an OUT-OF-BAND tamper: this drill plays the concurrent editor (declared)
const tampered = readNb();
tampered.cells[3].source = ['# TAMPERED BY ANOTHER PROCESS\n'];
fs.writeFileSync(abs, serializeNotebook(tampered));
const f3b = buddy(['nb', 'replace', '-f', nbFile, '--index', '3', '--source', 'x = 1\n', '--expect', 'avg = total']);
ok(f3b.status === 2, `frame-03: stale expect refuses (exit ${f3b.status})`);
ok(/stale/.test(f3b.stderr), 'frame-03: the refusal says STALE, not guessed');
ok(/TAMPERED/.test(fs.readFileSync(abs, 'utf8')), 'frame-03: the refused write touched NOTHING (tamper still on disk)');
const f3c = buddy(['nb', 'replace', '-f', nbFile, '--index', '3', '--source', 'avg = total / (len(rows) - 1)\n', '--expect', '# TAMPERED BY ANOTHER PROCESS']);
ok(f3c.status === 0, 'frame-03: a fresh expect (from a fresh read) lands');
frames.push(['frame-03-the-guard.txt', cap('frame-03 — THE GUARDED REPLACE (an out-of-band tamper — this drill playing the concurrent editor, declared — is CAUGHT, not overwritten)', [
  { cmd: `nb replace -f ${nbFile} --index 3 --source ... --expect "avg = total"`, run: f3a },
  { text: `--> out-of-band: another process rewrites cell 3 on disk (the drill, declared, plays that process)\n--> the on-disk cell now starts with "# TAMPERED BY ANOTHER PROCESS"` },
  { cmd: `nb replace -f ${nbFile} --index 3 --source "x = 1" --expect "avg = total"   # the stale guard`, run: f3b },
  { cmd: `nb replace -f ${nbFile} --index 3 --source ... --expect "# TAMPERED BY ANOTHER PROCESS"   # fresh`, run: f3c },
])]);

// ── frame-04: outputs discipline — kept-stale, cleared, dropped ─────────────
const f4a = buddy(['nb', 'replace', '-f', nbFile, '--index', '1', '--source', 'import csv\nrows = list(csv.reader(open("sales.csv")))\nprint(f"{len(rows)} rows (v2)")\n']);
ok(f4a.status === 0 && /outputs: kept \(stale/.test(f4a.stderr), 'frame-04: replace keeps outputs and says STALE in plain English');
ok(/WARNING: outputs kept|warning: outputs kept/.test(f4a.stderr), 'frame-04: the warning rides the receipt');
const f4b = buddy(['nb', 'clear', '-f', nbFile, '--index', '1']);
ok(f4b.status === 0 && /cleared 1 output record/.test(f4b.stderr), 'frame-04: clear_outputs wipes the stale records');
const f4c = buddy(['nb', 'delete', '-f', nbFile, '--index', '2']);
ok(f4c.status === 0 && /cells/.test(f4c.stderr), 'frame-04: delete lands (outputs ride with the cell)');
frames.push(['frame-04-outputs.txt', cap('frame-04 — OUTPUTS DISCIPLINE (outputs belong to the code that made them)', [
  { cmd: `nb replace -f ${nbFile} --index 1 --source ...   # outputs kept by default`, run: f4a },
  { cmd: `nb clear -f ${nbFile} --index 1`, run: f4b },
  { cmd: `nb delete -f ${nbFile} --index 2`, run: f4c },
])]);

// ── frame-05: the refusals — five honest exit-2s ────────────────────────────
fs.writeFileSync(path.join(root, 'notes.md'), 'not a notebook\n');
fs.writeFileSync(path.join(root, 'torn.ipynb'), '{"cells":[{"cell_type":"code"');
const refusals = [
  ['not a .ipynb', buddy(['nb', 'read', '-f', 'notes.md']), /not a \.ipynb/],
  ['torn JSON', buddy(['nb', 'read', '-f', 'torn.ipynb']), /not valid JSON/],
  ['index out of range', buddy(['nb', 'replace', '-f', nbFile, '--index', '99', '--source', 'x']), /out of range/],
  ['float index', buddy(['nb', 'replace', '-f', nbFile, '--index', '1.5', '--source', 'x']), /0-based integer/],
  ['bad cell type', buddy(['nb', 'insert', '-f', nbFile, '--type', 'raw', '--source', 'x']), /"code" or "markdown"/],
];
let refOk = true;
for (const [name, r, re] of refusals) {
  const good = r.status === 2 && re.test(r.stderr);
  if (!good) { refOk = false; problems.push(`frame-05: ${name} did not refuse honestly (exit ${r.status})`); }
  asserted += 1; passed += good ? 1 : 0;
}
ok(refOk, 'frame-05: all five refusals honest');
ok(!fs.readFileSync(abs, 'utf8').includes('x = '), 'frame-05: the refused writes touched nothing');
frames.push(['frame-05-the-refusals.txt', cap('frame-05 — THE REFUSALS (broken input is a refusal, never a mangle)', [
  { cmd: 'nb read -f notes.md', run: refusals[0][1] },
  { cmd: 'nb read -f torn.ipynb', run: refusals[1][1] },
  { cmd: 'nb replace -f analysis.ipynb --index 99 --source x', run: refusals[2][1] },
  { cmd: 'nb replace -f analysis.ipynb --index 1.5 --source x', run: refusals[3][1] },
  { cmd: 'nb insert -f analysis.ipynb --type raw --source x', run: refusals[4][1] },
])]);

// ── frame-06: move + integrity — metadata survives, JSON re-parses ──────────
const f6 = buddy(['nb', 'move', '-f', nbFile, '--index', '3', '--to', '1']);
ok(f6.status === 0 && /→ \[1\]/.test(f6.stderr), 'frame-06: the move lands with a receipt');
const { loadNotebook } = await import(path.join(REPO, 'src', 'notebook.js'));
const { nb: reloaded } = loadNotebook(abs); // REAL module re-parse (declared)
ok(reloaded.cells[1].cell_type === 'markdown', 'frame-06: the moved cell sits at [1]');
ok(reloaded.metadata.kernelspec?.name === 'python3', 'frame-06: the kernelspec survived every op');
ok(reloaded.nbformat === 4 && reloaded.nbformat_minor === 5, 'frame-06: nbformat fields survived');
ok(reloaded.cells.length === 4, 'frame-06: the cell count reflects insert+delete (5→4)');
frames.push(['frame-06-move-integrity.txt', cap('frame-06 — MOVE + INTEGRITY (the notebook re-parses; untouched fields untouched)', [
  { cmd: `nb move -f ${nbFile} --index 3 --to 1`, run: f6 },
  { text: `--> real module re-parse (declared: loadNotebook from src/notebook.js)\n    cells[1] = markdown (the moved cell) · kernelspec python3 · nbformat 4.5 · 4 cells` },
])]);

// ── frame-07: the agent tools — nb_read + nb_edit through the REAL layer ────
// (declared: the drill calls the registered tool run() functions exactly as
// the live chat loop would — LocalScope on the drill's own workspace)
const { LocalScope, buildLocalTools } = await import(path.join(REPO, 'src', 'tools', 'local.js'));
const scope = new LocalScope(root);
const tools = buildLocalTools({ scope });
const nbRead = tools.find((t) => t.name === 'nb_read');
const nbEditT = tools.find((t) => t.name === 'nb_edit');
ok(Boolean(nbRead && nbEditT), 'frame-07: nb_read + nb_edit are registered in the chat toolset');
const t1 = await nbRead.run({ path: nbFile });
ok(/NOTEBOOK .*analysis\.ipynb/.test(t1), 'frame-07: nb_read lists the workspace notebook');
const t2 = await nbEditT.run({ op: 'insert', path: nbFile, cellType: 'code', source: 'print("from the agent tool")\n', why: 'demo the tool surface' });
ok(/OK insert cell \[4\] code 4→5 cells/.test(t2), 'frame-07: nb_edit insert returns the honest receipt');
const outT = readNb();
outT.cells[0].source = ['# OUT-OF-BAND (the drill plays another process)\n'];
fs.writeFileSync(abs, serializeNotebook(outT));
const t3 = await nbEditT.run({ op: 'replace', path: nbFile, index: 0, source: '# x\n', why: 'blind edit after an out-of-band change' });
ok(/changed since you last read it/.test(t3), 'frame-07: the freshness guard refuses the blind edit');
const t4 = await nbRead.run({ path: nbFile });
const t5 = await nbEditT.run({ op: 'replace', path: nbFile, index: 0, source: '# Sales analysis (revisited)\n', why: 'informed edit after a fresh read' });
ok(/OK replace/.test(t5), 'frame-07: after the fresh read, the edit lands');
frames.push(['frame-07-the-tools.txt', cap('frame-07 — THE AGENT TOOLS (nb_read + nb_edit through the REAL chat toolset, declared)', [
  { text: `--> declared: nb_read.run / nb_edit.run from buildLocalTools({ scope: LocalScope(root) })\n    — the exact objects the live chat loop hands the model` },
  { text: `> nb_read  {"path":"analysis.ipynb"}\n${t1.split('\n').slice(0, 6).join('\n')}` },
  { text: `> nb_edit  {"op":"insert","path":"analysis.ipynb","cellType":"code","source":"print(\\"from the agent tool\\")"}\n${t2}` },
  { text: `--> out-of-band: the drill (declared) rewrites cell 0, THEN the tool edits blind` },
  { text: `> nb_edit  {"op":"replace","path":"analysis.ipynb","index":0,"source":"# x"}\nERROR: ${t3.replace('ERROR: ', '')}` },
  { text: `> nb_read (fresh baseline) … then nb_edit replace\n${t5}` },
])]);

// ── verdict + evidence pack ─────────────────────────────────────────────────
for (const [name, body] of frames) {
  fs.writeFileSync(path.join(OUT, name), body);
}
const groundtruth = {
  wave: 'v0.54.0 — notebook support (§11 nb_edit tool for .ipynb cells)',
  date: new Date().toISOString(),
  assertions: asserted, passed, failed: problems.length,
  frames: frames.map(([n]) => n),
  verdict: problems.length === 0 ? 'DRILL: PASS' : 'DRILL: FAIL',
  probe_notebook: 'analysis.ipynb — seeded through the REAL module API (serializeNotebook), driven by the REAL CLI and the REAL agent tool layer',
};
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2) + '\n');
console.log(`\nDRILL v0.54: ${passed}/${asserted} — ${groundtruth.verdict}`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log(`frames → ${OUT}`);
process.exit(0);
