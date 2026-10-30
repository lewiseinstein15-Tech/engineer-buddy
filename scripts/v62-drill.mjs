#!/usr/bin/env node
// v0.62.0 DRILL — the capability audit's gap #6: LSP default-on, the knob
// becomes REAL. Eight frames, every leg through the REAL makeScopeAndTools
// (the one assembly point the REPL and one-shot share) over a real temp
// workspace with a real .buddy/settings.json:
//   1  default-on: no settings → lsp_* tools registered, diagnostics flow
//      over REAL stdio JSON-RPC to the committed mock server, and the
//      SERVER'S OWN WITNESS LOG proves what actually arrived on the wire
//      (the client's word is not evidence; the other end is the witness).
//   2  chat.lsp:false → every lsp_* tool REMOVED from the registry, and
//      the witness file is never created (zero spawn attempts).
//   3  chat.lsp:'off' → same removal, same zero-spawn proof.
//   4  chat.lsp:42 (junk) → NAMED in the assembly notes, default holds,
//      the wire still works (witness proves it).
//   5  chat.lsp.servers override steers a NEW extension (.rs) to the mock:
//      diagnostics AND a definition round-trip land on the server's
//      witness log — the override is honored on the real wire.
//   6  junk server shapes → NAMED per-entry (not an array, not an
//      extension, falls back to the missing default) with honest absence.
//   7  a hostile settings file with __proto__ inside chat.lsp.servers →
//      pollution refused through the REAL settings path, the good entry
//      survives, Object.prototype stays clean (asserted on camera).
//   8  the notes ledger: every named note from legs 4/6/7 in one place —
//      the honest startup surface the REPL prints.
// The gate re-reads every frame from disk (the v0.58 lesson: evidence must
// prove it ran) and checks groundtruth.json's must_contain per frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScopeAndTools } from '../src/terminal/repl.js';
import { getChatSetting } from '../src/settings.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK_LSP = path.join(REPO, 'examples', 'mock-lsp.js');
const DRILL_DIR = path.join(REPO, 'scripts', 'v62-frames');
const framesDir = path.join(DRILL_DIR, 'frames');
fs.rmSync(DRILL_DIR, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v62-drill-'));
let leg = 0;
const mkWs = () => fs.mkdtempSync(path.join(tmp, `ws${++leg}-`));
const setSettings = (ws, chatPatch) => {
  fs.mkdirSync(path.join(ws, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.buddy', 'settings.json'), JSON.stringify({ chat: chatPatch }, null, 2), 'utf8');
};
const writeRs = (ws) => fs.writeFileSync(path.join(ws, 'main.rs'), 'fn main() { let x = 1; }\n', 'utf8');
const toolMap = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
const readWitness = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : []);
const mockCmd = (witnessPath, extra = []) => ['node', MOCK_LSP, '--witness', witnessPath, '--ttl', '120', ...extra];
const names = (tools) => tools.map((t) => t.name);
const frame = (name, obj) => {
  const f = path.join(framesDir, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return f;
};
const cleanup = (asm, hubConns) => {
  try { asm?.shells?.stopAll?.(); } catch { /* best effort */ }
  try { asm?.mcp?.close?.(); } catch { /* best effort */ }
};

let failures = 0;
const step = (cond, msg) => { console.log(`   ${cond ? '✔' : '✗'} ${msg}`); if (!cond) failures += 1; };

// ── frame 1: default-on — tools registered by default; the DEFAULT server is
// absent in this sandbox → honest absence on a default-map extension (the
// real-wire proof lives in frame 5 through a servers override) ───────────────
{
  console.log('frame 1: default-on — registered with no settings; honest absence when the default binary is missing');
  const ws = mkWs();
  fs.writeFileSync(path.join(ws, 'app.js'), 'let x = 1;\n', 'utf8');
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  const lspNames = ['lsp_diagnostics', 'lsp_goto_def', 'lsp_refs'].filter((n) => t[n]);
  const out = await t.lsp_diagnostics.run({ path: 'app.js' }); // js IS in the default map; typescript-language-server is absent here
  frame('01-default-on.json', {
    lsp: asm.lsp,
    lsp_tools_registered: lspNames,
    diagnostics_output: out,
    note: 'no settings file at all — LSP is ON by default; the default server binary is absent in this sandbox, so the leg degrades to honest absence (never a crash)',
  });
  step(asm.lsp.on === true && asm.lsp.notes.length === 0, 'assembly: LSP on, zero notes');
  step(lspNames.length === 3, `assembly: all three lsp_* tools registered (${lspNames.join(', ')})`);
  step(/no diagnostics for app\.js/.test(out), 'honest absence: the default server (typescript-language-server, absent) degrades to honest empty');
  step(!/LSP disabled/.test(out) && !/crash/i.test(out), 'honesty: no disabled-door text, no crash');
  cleanup(asm);
}

// ── frame 2: chat.lsp:false removes the tools, zero spawn ───────────────────
{
  console.log('frame 2: chat.lsp:false — removal from the registry, zero spawn attempts');
  const ws = mkWs();
  writeRs(ws);
  const witness = path.join(tmp, 'w2.jsonl');
  setSettings(ws, { lsp: false });
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  frame('02-lsp-false.json', {
    lsp: { on: asm.lsp.on, notes: asm.lsp.notes },
    lsp_tools_registered: ['lsp_diagnostics', 'lsp_goto_def', 'lsp_refs'].filter((n) => t[n]),
    rest_of_kit: { fs_write: !!t.fs_write, bash: !!t.bash },
    witness_file_created: fs.existsSync(witness),
    settings_read_back: getChatSetting(ws, 'lsp'),
  });
  step(asm.lsp.on === false && asm.lsp.notes.length === 0, 'knob: chat.lsp:false resolves off, cleanly');
  step(!t.lsp_diagnostics && !t.lsp_goto_def && !t.lsp_refs, 'knob: every lsp_* tool REMOVED from the registry');
  step(!!t.fs_write && !!t.bash, 'knob: the rest of the kit untouched');
  step(!fs.existsSync(witness), 'zero-spawn: the witness file was never created — nothing ever spawned');
  cleanup(asm);
}

// ── frame 3: chat.lsp:'off' matches false ───────────────────────────────────
{
  console.log("frame 3: chat.lsp:'off' — the same removal");
  const ws = mkWs();
  writeRs(ws);
  const witness = path.join(tmp, 'w3.jsonl');
  setSettings(ws, { lsp: 'off' });
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  frame('03-lsp-off.json', {
    lsp: { on: asm.lsp.on, notes: asm.lsp.notes },
    lsp_tools_registered: ['lsp_diagnostics', 'lsp_goto_def', 'lsp_refs'].filter((n) => t[n]),
    witness_file_created: fs.existsSync(witness),
  });
  step(asm.lsp.on === false, "knob: 'off' resolves off");
  step(!t.lsp_diagnostics, "knob: 'off' removes the tools");
  step(!fs.existsSync(witness), "zero-spawn: 'off' never spawns");
  cleanup(asm);
}

// ── frame 4: junk is NAMED, the default holds (default map behavior intact) ─
{
  console.log('frame 4: junk chat.lsp — NAMED, not applied, default holds');
  const ws = mkWs();
  writeRs(ws);
  fs.writeFileSync(path.join(ws, 'app.js'), 'let x = 1;\n', 'utf8');
  setSettings(ws, { lsp: 42 });
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  const outRs = await t.lsp_diagnostics.run({ path: 'main.rs' }); // default map has no rs → teaching refusal naming the override door
  const outJs = await t.lsp_diagnostics.run({ path: 'app.js' }); // default map js + absent tsserver → honest absence
  frame('04-junk-named.json', {
    lsp: asm.lsp,
    rs_output: outRs,
    js_output: outJs,
  });
  step(asm.lsp.on === true, 'knob: junk keeps LSP on (the default holds)');
  step(asm.lsp.notes.some((n) => n.includes('chat.lsp: "42" is junk — NAMED, not applied')), `knob: the junk is NAMED (${asm.lsp.notes[0]})`);
  step(/no language server support for main\.rs/.test(outRs) && /chat\.lsp\.servers/.test(outRs), 'default map intact: .rs names the override door (no override was set — junk does not invent one)');
  step(/no diagnostics for app\.js/.test(outJs), 'default map intact: a default-map file degrades to honest absence (tsserver absent), never a crash');
  cleanup(asm);
}

// ── frame 5: a servers override steers a NEW extension over the wire ────────
{
  console.log('frame 5: chat.lsp.servers — a NEW extension (.rs) steered to the mock');
  const ws = mkWs();
  writeRs(ws);
  const witness = path.join(tmp, 'w5.jsonl');
  setSettings(ws, { lsp: { servers: { rs: mockCmd(witness) } } });
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  const diag = await t.lsp_diagnostics.run({ path: 'main.rs' });
  const def = await t.lsp_goto_def.run({ path: 'main.rs', line: 1, column: 5 });
  await new Promise((r) => setTimeout(r, 150));
  const rows = readWitness(witness);
  const methods = rows.map((r) => r.method).filter(Boolean);
  frame('05-servers-override.json', {
    lsp: { on: asm.lsp.on, notes: asm.lsp.notes, servers: asm.lsp.servers },
    diagnostics_output: diag,
    definition_output: def,
    server_witness_methods: methods,
  });
  step(asm.lsp.on === true && asm.lsp.servers && asm.lsp.servers.rs, 'override: the validated override reached the assembly');
  step(/2 diagnostics for main\.rs/.test(diag), 'override: diagnostics flow through the steered server');
  step(/\/mock\/target\.ext:10:5/.test(def), `override: the definition round-trip landed (${def.split('\n')[0]})`);
  step(methods.includes('textDocument/definition') && methods.includes('initialize') && methods.some((m) => m.startsWith('textDocument/')), `witness: definition + initialize on the server log (${methods.join(', ')})`);
  cleanup(asm);
}

// ── frame 6: junk server shapes — NAMED per-entry, defaults hold ────────────
{
  console.log('frame 6: junk server shapes — per-entry naming, honest absence');
  const ws = mkWs();
  writeRs(ws);
  setSettings(ws, { lsp: { servers: { rs: 'not-an-array', UPPER: ['x'], 'a-b': ['x'], go: ['gopls'] } } });
  const asm = await makeScopeAndTools({ root: ws });
  const t = toolMap(asm.tools);
  const outRs = await t.lsp_diagnostics.run({ path: 'main.rs' }); // junk refused → rs has NO server → teaching refusal
  const outGo = await t.lsp_diagnostics.run({ path: 'x.go' }); // go IS valid (gopls) but absent here → honest absence
  fs.writeFileSync(path.join(ws, 'x.go'), 'package main\n', 'utf8');
  const outGo2 = await t.lsp_diagnostics.run({ path: 'x.go' });
  frame('06-junk-servers.json', {
    lsp: { on: asm.lsp.on, notes: asm.lsp.notes, servers: asm.lsp.servers },
    rs_after_refusal_output: outRs,
    gopls_absence_output: outGo2,
  });
  step(asm.lsp.notes.length >= 3, `validator: every junk entry NAMED (${asm.lsp.notes.length} notes)`);
  step(asm.lsp.notes.some((n) => n.includes('rs: command must be a non-empty array')), 'validator: the non-array entry named');
  step(asm.lsp.notes.some((n) => n.includes('UPPER: not a file extension')), 'validator: the bad extension key named');
  step(asm.lsp.on === true && !asm.lsp.servers?.UPPER && !asm.lsp.servers?.rs, 'validator: no junk entry reached the merged map');
  step(/no language server support for main\.rs/.test(outRs) && /chat\.lsp\.servers/.test(outRs), 'honest refusal: after the junk entry was refused, .rs names the override door');
  step(/no diagnostics for x\.go/.test(outGo2), 'honest absence: a VALID default server that is missing (gopls) degrades to honest empty');
  cleanup(asm);
}

// ── frame 7: hostile settings file — pollution refused end-to-end ───────────
{
  console.log('frame 7: __proto__ inside chat.lsp.servers — refused through the REAL settings path');
  const ws = mkWs();
  writeRs(ws);
  const hostile = JSON.parse('{"lsp":{"servers":{"__proto__":{"js":["evil"]},"rs":["node","' + MOCK_LSP.replace(/\\/g, '\\\\') + '","--ttl","120"]}}}');
  setSettings(ws, hostile);
  const asm = await makeScopeAndTools({ root: ws });
  const probe = {};
  const t = toolMap(asm.tools);
  const out = await t.lsp_diagnostics.run({ path: 'main.rs' });
  frame('07-proto-refused.json', {
    lsp: { on: asm.lsp.on, notes: asm.lsp.notes, servers: asm.lsp.servers },
    pollution_probe: { probeJs: probe.js ?? null, probeRs: probe.rs ?? null },
    diagnostics_output: out,
    object_prototype_clean: !Object.prototype.js,
  });
  step(asm.lsp.notes.some((n) => n.includes('__proto__')), 'pollution: the __proto__ entry is NAMED through the real settings path');
  step(probe.js === undefined && !Object.prototype.js, 'pollution: Object.prototype is clean (asserted on camera)');
  step(asm.lsp.servers?.rs && asm.lsp.servers.rs[0] === 'node', 'pollution: the good override survived next to the hostile key');
  step(/2 diagnostics for main\.rs/.test(out), 'pollution: the wire still works after the hostile key');
  cleanup(asm);
}

// ── frame 8: the honest notes ledger ────────────────────────────────────────
{
  console.log('frame 8: the notes ledger — every named note in one place');
  const ledger = [];
  const probeNotes = async (chatPatch, label) => {
    const ws = mkWs();
    if (chatPatch) setSettings(ws, chatPatch);
    writeRs(ws);
    const asm = await makeScopeAndTools({ root: ws });
    ledger.push({ label, on: asm.lsp.on, notes: asm.lsp.notes });
    cleanup(asm);
  };
  await probeNotes({ lsp: 42 }, 'junk number');
  await probeNotes({ lsp: 'yes' }, 'junk string');
  await probeNotes({ lsp: { servers: 'not-an-object' } }, 'junk servers shape');
  await probeNotes({ lsp: { servers: { 'a-b': ['x'], py: 'pylsp', go: ['gopls', 42] } } }, 'junk server entries');
  await probeNotes(null, 'default (no settings)');
  await probeNotes({ lsp: false }, 'clean off');
  frame('08-notes-ledger.json', { ledger });
  step(ledger[0].notes.some((n) => n.includes('is junk — NAMED')) && !/[\u001B]/.test(ledger.map((l) => l.notes.join('')).join('')), 'ledger: junk named, zero control bytes in any note');
  step(ledger[4].on === true && ledger[4].notes.length === 0 && ledger[5].on === false, 'ledger: default on / clean off read back honestly');
}

// ── gate: re-read every frame from disk ─────────────────────────────────────
const groundtruth = {
  wave: 'v0.62.0 — LSP default-on (audit gap #6)',
  gate: 're-reads every frame from disk; every must_contain string must appear in the frame file',
  frames: [
    { file: '01-default-on.json', must_contain: ['"on": true', 'lsp_diagnostics', 'no diagnostics for app.js', 'clean as far as the language server sees'] },
    { file: '02-lsp-false.json', must_contain: ['"on": false', '"lsp_tools_registered": []', '"witness_file_created": false', '"fs_write": true'] },
    { file: '03-lsp-off.json', must_contain: ['"on": false', '"witness_file_created": false'] },
    { file: '04-junk-named.json', must_contain: ['chat.lsp: \\"42\\" is junk — NAMED, not applied', 'no language server support for main.rs', 'no diagnostics for app.js'] },
    { file: '05-servers-override.json', must_contain: ['"rs"', '/mock/target.ext:10:5', 'textDocument/definition', 'initialize'] },
    { file: '06-junk-servers.json', must_contain: ['not a file extension', 'non-empty array', 'no language server support for main.rs', 'no diagnostics for x.go'] },
    { file: '07-proto-refused.json', must_contain: ['__proto__', '"probeJs": null', '"object_prototype_clean": true', '2 diagnostics for main.rs'] },
    { file: '08-notes-ledger.json', must_contain: ['is junk — NAMED', 'not an object', '"on": false'] },
  ],
};
fs.writeFileSync(path.join(DRILL_DIR, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2), 'utf8');

let checked = 0, okCount = 0;
console.log('\ngate: re-reading every frame from disk');
for (const f of groundtruth.frames) {
  const p = path.join(framesDir, f.file);
  const body = fs.readFileSync(p, 'utf8');
  for (const needle of f.must_contain) {
    checked += 1;
    if (body.includes(needle)) okCount += 1;
    else { failures += 1; console.log(`   ✗ ${f.file}: missing ${JSON.stringify(needle)}`); }
  }
}
console.log(`gate: ${okCount}/${checked} must_contain checks passed against the on-disk frames`);

fs.rmSync(tmp, { recursive: true, force: true });
const total = 8 + checked;
const passedCount = total - failures;
console.log(`\nDRILL v0.62: ${passedCount}/${total} checks PASS`);
if (failures) {
  console.log('DRILL: FAIL');
  process.exit(1);
}
console.log('DRILL: PASS — the gate re-read the evidence and it holds.');
process.exit(0);
