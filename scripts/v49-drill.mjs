#!/usr/bin/env node
// v0.49 drill — "goals & scheduled runs" (§11). Readable 80-col frames into
// download/aurora-evidence/v49-readable/. Leg A/B drive the REAL CLI; leg C
// drives the REAL loop (store, locks, history, nextDue on disk) with a
// SCRIPTED brain — declared on camera, the v0.45 drill precedent. The only
// faked thing is the brain call itself, and the frames say so.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v49-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync('/tmp/v49-drill-');
const buddy = (args) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NO_COLOR: '1', BUDDY_DRILL: '1' },
  });

const frames = [];
function cap(title, sections) {
  const bar = '-'.repeat(78);
  let t = `${bar}\n${title}\n${bar}\n`;
  for (const s of sections) {
    t += `\n$ buddy ${s.cmd}\n`;
    const r = s.run;
    if (r.stdout.trim()) t += r.stdout.trimEnd() + '\n';
    if (r.stderr.trim()) t += r.stderr.trimEnd() + '\n';
    if (s.note) t += `--> ${s.note}\n`;
  }
  return t;
}

// ── Leg A: the lifecycle, real CLI ──────────────────────────────────────────
const at = new Date(Date.now() + 90 * 60000).toISOString().slice(0, 16).replace('T', ' ');
buddy(['goal', 'add', 'nightly repo sweep', '--cron', '30 3 * * *', '--prompt', 'sweep the issue tracker and summarize']);
buddy(['goal', 'add', 'one-shot memo', '--at', at, '--prompt', 'write the Friday memo']);
buddy(['goal', 'add', 'held example', '--every', '60', '--prompt', 'p']);
const listA = buddy(['goal', 'list']);
const nextA = buddy(['goal', 'next']);
const dryA = buddy(['goal', 'run', '--dry']);
frames.push(['frame-01-lifecycle.txt', cap('frame-01 — GOAL LIFECYCLE (real CLI, temp repo)', [
  { cmd: 'goal list', run: listA, note: 'three goals: cron (UTC), one-shot --at, every-60m; honest state suffixes' },
  { cmd: 'goal next', run: nextA, note: 'the wake list is COMPUTED, the clock stays external (OS cron / GH Actions cron)' },
  { cmd: 'goal run --dry', run: dryA, note: 'dry view: nothing due yet — the tick would be honestly idle, no runner was called' },
])]);

const dis = buddy(['goal', 'disable', 'nightly repo sweep']);
const listB = buddy(['goal', 'list']);
frames.push(['frame-02-disable.txt', cap('frame-02 — DISABLE, ON THE RECORD (real CLI)', [
  { cmd: 'goal disable "nightly repo sweep"', run: dis },
  { cmd: 'goal list', run: listB, note: 'disabled goals stay listed, honestly labeled — never silently dropped' },
])]);

// ── Leg B: registration refuses junk (the two NEW fixes on camera) ─────────
const atJunk1 = buddy(['goal', 'add', 'x', '--at', '2026-01-01', '--prompt', 'p']);
const atJunk2 = buddy(['goal', 'add', 'x', '--at', 'tomorrow', '--prompt', 'p']);
const cronJunk = buddy(['goal', 'add', 'x', '--cron', '30 3 *', '--prompt', 'p']);
frames.push(['frame-03-refusals.txt', cap('frame-03 — REFUSALS ON CAMERA (real CLI; RED TEAM v0.49 fixes)', [
  { cmd: 'goal add x --at "2026-01-01" …', run: atJunk1, note: 'FIX: a date with NO time part used to slip through Date.parse as UTC midnight — now refused' },
  { cmd: 'goal add x --at "tomorrow" …', run: atJunk2, note: 'prose is not a moment — refused' },
  { cmd: 'goal add x --cron "30 3 *" …', run: cronJunk, note: 'a 3-field cron lies — refused' },
])]);

// ── Leg C: the REAL loop with a SCRIPTED brain (declared) ───────────────────
const legC = [];
for (const [name, body] of frames) fs.writeFileSync(path.join(OUT, name), body.endsWith('\n') ? body : body + '\n');
const G = await import(path.join(REPO, 'src', 'goals.js'));
G.addGoal(root, { name: 'due now', prompt: 'do the sweep', everyMinutes: 1 });
legC.push('$ (module) runDueGoals(root, { force:true, probe:{ok:true,reason:"scripted"}, runPrompt: scripted })');
try {
  const out = await G.runDueGoals(root, {
    probe: { ok: true, reason: 'drill-scripted brain (declared)' },
    runPrompt: async ({ goal }) => ({ status: 'ok', said: `${goal.name}: sweeped 3 issues, summarized` }),
    force: true,
  });
  legC.push(G.runSummaryText(out));
  for (const p of out.problems) legC.push(`! ${p}`);
} catch (e) { legC.push(`honest rejection: ${e.message}`); }
legC.push('');
legC.push('$ buddy goal history');
const hist = buddy(['goal', 'history']);
legC.push(hist.stderr.trim() || hist.stdout.trim());
legC.push('');
legC.push('--> the run row landed in .buddy/goals/history.jsonl (append-only) BEFORE the CLI read it back');
fs.writeFileSync(path.join(OUT, 'frame-04-real-tick.txt'), cap('frame-04 — A REAL TICK: store, locks, history are REAL; the brain call is SCRIPTED (declared)', legC.map((l) => ({ cmd: l, run: { stdout: '', stderr: '' }, note: null }))).replace(/\$ (.*?)(?=\n\$ |\n--> |\n-|$)/gs, (m) => m.replace(/^\$ /, '')) + '\n');

// hold contract on camera: hand-set hold in the store, then force BY NAME
const storePath = path.join(root, '.buddy', 'goals', 'goals.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const held = store.goals.find((g) => g.name === 'held example');
held.hold = 'hand-set by the drill — a held goal is never scheduled';
fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
const legE = [];
legE.push('$ (store edit) goal.hold = "hand-set by the drill — a held goal is never scheduled"');
legE.push('');
legE.push('$ buddy goal run --all "held example"   [a NAMED force — the CLI form of force-by-name]');
const rForce = buddy(['goal', 'run', '--all', 'held example']);
legE.push(`exit=${rForce.status}`);
legE.push((rForce.stderr.trim() || rForce.stdout.trim()));
legE.push('');
legE.push('--> FIX ON CAMERA: a named force used to pierce the hold (RED TEAM v0.49 finding #3).');
legE.push('--> Hold means NEVER scheduled by run — not by the tick, not by --all, not even by name.');
fs.writeFileSync(path.join(OUT, 'frame-05-hold-contract.txt'), legE.join('\n') + '\n');

// busy lock on camera
const lock = G.acquireRunLock(root, {});
const legF = [];
legF.push('$ (module) acquireRunLock(root)  → a live lock now exists (pid ' + process.pid + ')');
legF.push('');
legF.push('$ buddy goal run --all   [while the lock is live]');
const rBusy = buddy(['goal', 'run', '--all']);
legF.push(`exit=${rBusy.status}`);
legF.push(rBusy.stderr.trim() || rBusy.stdout.trim());
legF.push('');
legF.push('--> exit 3: the double-fire refusal is the LAST problem, the runner was never called.');
legF.push('--> The tick lock is O_EXCL with loud stale-steal: a dead holder is stolen and SAID so.');
G.releaseRunLock(root, {});
fs.writeFileSync(path.join(OUT, 'frame-06-busy-lock.txt'), legF.join('\n') + '\n');

// ground truth
const { createHash } = await import('node:crypto');
const gt = { at: new Date().toISOString(), version: '0.49.0', repo: REPO, drillRoot: root,
  frames: fs.readdirSync(OUT).filter((f) => f.startsWith('frame-')).sort(),
  sha256: {} };
for (const f of gt.frames) gt.sha256[f] = createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex');
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(gt, null, 2) + '\n');
console.log('drill done:', gt.frames.join(', '));
console.log('drill temp root:', root);
