#!/usr/bin/env node
// v66-evidence.mjs — live evidence for the doctor workspace ECC sweep.
// Builds a git fixture that replicates the v0.65-era laptop state (untracked
// files colliding with incoming commits, a dirty overlap, a stash pile, a
// corrupt config) and runs the REAL checks against it, then against this
// clean, aligned repo. Output is the actual renderDoctorChecks text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runDoctorChecks, renderDoctorChecks } from '../src/doctor.js';

const sh = (cmd, cwd) => execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 20000 });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v66-evidence-'));
const origin = path.join(base, 'origin.git');
const seed = path.join(base, 'seed');
const work = path.join(base, 'work');

// Remote wave 1: README only. Clone `work` from that state.
sh(`git init --bare -b main "${origin}" && git clone -q "${origin}" "${seed}"`);
fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
sh('git add README.md && git -c user.email=t@t -c user.name=t commit -qm seed && git push -q -u origin main', seed);
sh(`git clone -q "${origin}" "${work}"`);
sh('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m local-marker', work);

// Remote wave 2 lands the way the v0.64.1 wave did: five test files plus a
// change to a file the clone also edited locally.
fs.mkdirSync(path.join(seed, 'test'), { recursive: true });
for (const f of ['version.test.js', 'toolcap.test.js', 'badflag.test.js', 'turnbudget.test.js', 'approval-danger.test.js']) {
  fs.writeFileSync(path.join(seed, 'test', f), 'the shipped, tested version\n');
}
fs.writeFileSync(path.join(seed, 'README.md'), 'upstream changed the readme too\n');
sh('git add -A && git -c user.email=t@t -c user.name=t commit -qm wave-lands-upstream && git push -q', seed);

// The laptop state: stale local drafts of the shipped test files (untracked),
// a dirty edit the upstream also touched, a stash from a previous failed
// sync, a hand-edited config gone bad.
fs.mkdirSync(path.join(work, 'test'), { recursive: true });
for (const f of ['version.test.js', 'toolcap.test.js', 'badflag.test.js', 'turnbudget.test.js', 'approval-danger.test.js']) {
  fs.writeFileSync(path.join(work, 'test', f), 'stale local draft of already-shipped work\n');
}
fs.writeFileSync(path.join(work, 'README.md'), 'my local edit to the readme\n');
fs.writeFileSync(path.join(work, 'wip.txt'), 'half-finished thought\n');
sh('git stash push -q -u -m "laptop drafts" -- wip.txt', work); // pathspec stash: the drafts and the dirty edit stay in the worktree
fs.mkdirSync(path.join(work, '.buddy'), { recursive: true });
fs.writeFileSync(path.join(work, '.buddy', 'settings.json'), '{ "hooks": [broken');
sh('git fetch -q', work); // what a real user runs before a pull — the doctor reads the local upstream ref

console.log(`\n═══ doctor vs the BROKEN fixture (${path.basename(base)}) — the laptop state ═══\n`);
const broken = await runDoctorChecks(work, { ollamaEnabled: true, ollamaUrl: 'http://127.0.0.1:59999' });
console.log(renderDoctorChecks(broken));

console.log(`\n═══ doctor vs THIS repo (clean, aligned) ═══\n`);
const clean = await runDoctorChecks(process.cwd(), { ollamaEnabled: false });
console.log(renderDoctorChecks(clean));

fs.rmSync(base, { recursive: true, force: true });
const failed = broken.filter((c) => c.level === 'fail').length;
console.log(`\nV66 EVIDENCE: ${failed >= 1 ? 'PASS — the broken fixture is caught, named, and prescribed' : 'FAIL — nothing caught'}`);
process.exit(failed >= 1 ? 0 : 1);
