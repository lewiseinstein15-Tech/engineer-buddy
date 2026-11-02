// Tests for the v0.66 wave: the workspace half of `doctor` (git-state ECC —
// the exact failure class that froze a user's laptop: untracked files
// colliding with incoming commits, dirty overlaps, missing upstream, corrupt
// configs) and the REPL /retry command (Hermes parity).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runDoctorChecks, renderDoctorChecks } from '../src/doctor.js';

const REPL_SRC = await readFile(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');

function sh(cmd, cwd) {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 20000 });
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v066-'));
}

/** Build a real remote + clone so upstream/behind/collision checks are real git. */
function makeGitFixture() {
  const base = tmp();
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  sh(`git init --bare -b main "${origin}"`);
  sh(`git clone -q "${origin}" "${seed}"`);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  sh('git add README.md && git -c user.email=t@t -c user.name=t commit -qm seed && git push -q -u origin main', seed);
  sh(`git clone -q "${origin}" "${work}"`);
  sh('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m marker', work);
  return { base, origin, seed, work };
}

describe('doctor: workspace ECC checks', () => {
  test('clean repo → every git check ok', async () => {
    const { work } = makeGitFixture();
    const checks = await runDoctorChecks(work);
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by['settings.json'].level, 'info');
    assert.equal(by.git.level, 'ok');
    assert.equal(by.upstream.level, 'ok');
    assert.equal(by.sync.level, 'info'); // 1 local empty commit ahead
    assert.equal(by['untracked-collision'].level, 'ok');
    assert.equal(by['dirty-collision'].level, 'ok');
    assert.equal(by.stash.level, 'ok');
    assert.ok(!checks.some((c) => c.level === 'fail'), JSON.stringify(checks));
  });

  test('untracked file that exists upstream → FAIL naming the file (the laptop lesson)', async () => {
    const { seed, work } = makeGitFixture();
    fs.writeFileSync(path.join(seed, 'shipped.txt'), 'shipped remotely\n');
    sh('git add shipped.txt && git -c user.email=t@t -c user.name=t commit -qm add-shipped && git push -q', seed);
    fs.writeFileSync(path.join(work, 'shipped.txt'), 'local draft\n'); // untracked collision
    sh('git fetch -q', work); // the doctor reads the LOCAL upstream ref — fetch like a real user would before a pull
    const checks = await runDoctorChecks(work);
    const c = checks.find((x) => x.name === 'untracked-collision');
    assert.equal(c.level, 'fail');
    assert.match(c.detail, /shipped\.txt/);
    assert.match(c.detail, /git stash push -u/);
    const sync = checks.find((x) => x.name === 'sync');
    assert.equal(sync.level, 'warn');
    assert.match(sync.detail, /behind/);
  });

  test('dirty tracked file also changed upstream → WARN with stash hint', async () => {
    const { seed, work } = makeGitFixture();
    fs.writeFileSync(path.join(work, 'README.md'), 'dirty local edit\n');
    fs.writeFileSync(path.join(seed, 'README.md'), 'changed upstream too\n');
    sh('git add README.md && git -c user.email=t@t -c user.name=t commit -qm upstream-change && git push -q', seed);
    sh('git fetch -q', work);
    const checks = await runDoctorChecks(work);
    const c = checks.find((x) => x.name === 'dirty-collision');
    assert.equal(c.level, 'warn');
    assert.match(c.detail, /README\.md/);
  });

  test('corrupt settings.json → FAIL naming the file; corrupt config.json → FAIL with IGNORED warning', async () => {
    const { work } = makeGitFixture();
    fs.mkdirSync(path.join(work, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(work, '.buddy', 'settings.json'), '{ "hooks": [broken');
    fs.writeFileSync(path.join(work, 'buddy.config.json'), '{ "gatewayOrder": ');
    const checks = await runDoctorChecks(work);
    const s = checks.find((x) => x.name === 'settings.json');
    const c = checks.find((x) => x.name === 'buddy.config.json');
    assert.equal(s.level, 'fail');
    assert.match(s.detail, /settings\.json/);
    assert.equal(c.level, 'fail');
    assert.match(c.detail, /IGNORED/);
  });

  test('stashes parked → info with the review command; ollama enabled but dead → warn, chain survives', async () => {
    const { work } = makeGitFixture();
    fs.writeFileSync(path.join(work, 'wip.txt'), 'wip\n');
    sh('git add wip.txt && git stash push -q -u -m "laptop drafts"', work);
    const checks = await runDoctorChecks(work, { ollamaEnabled: true, ollamaUrl: 'http://127.0.0.1:59999' });
    const st = checks.find((x) => x.name === 'stash');
    const ol = checks.find((x) => x.name === 'ollama');
    assert.equal(st.level, 'info');
    assert.match(st.detail, /git stash list/);
    assert.equal(ol.level, 'warn');
    assert.match(ol.detail, /fails over to the cloud chain/);
  });

  test('renderDoctorChecks: levels render, verdict line counts', async () => {
    const checks = await runDoctorChecks(tmp(), { ollamaEnabled: true, ollamaUrl: 'http://127.0.0.1:59999' });
    const text = renderDoctorChecks(checks);
    assert.match(text, /\[info\]/);
    assert.match(text, /\[warn\]/);
    assert.match(text, /workspace: \d+ ok · \d+ info · \d+ warn · \d+ fail/);
  });
});

describe('repl: /retry (Hermes parity)', () => {
  test('command registered, captures the RAW prompt, resubmits through runTask', () => {
    assert.match(REPL_SRC, /case 'retry': \{/);
    assert.match(REPL_SRC, /lastPrompt = inputText; \/\/ \/retry/);
    assert.match(REPL_SRC, /await runTask\(lastPrompt\)/);
    assert.match(REPL_SRC, /nothing to retry/);
    assert.match(REPL_SRC, /'stream', 'retry',/); // SLASH_COMMANDS registration
    assert.match(REPL_SRC, /\['\/retry', 'resubmit the last prompt verbatim/); // help entry
  });
});
