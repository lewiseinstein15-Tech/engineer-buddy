// v0.57.0 — WINDOWS HARDENING (§11, the last open item): CI matrix on
// windows-latest + official install docs + the cross-platform spawn env.
// Tests run against the pure helpers in src/util.js (homeFallback,
// baseSpawnEnv), the REAL Windows-honest surfaces (voice probeRecorders,
// sandbox detectSandboxCapability) and the REAL wave artifacts (ci.yml,
// README.md — the matrix and the docs ARE deliverables, so they are pinned).
// Pins that carry the house rules:
//   - HOME → USERPROFILE → os.tmpdir() is the ONE fallback chain; the
//     historic `HOME || '/tmp'` POSIX lie is dead on every spawn site;
//   - a hostile env object can never crash a spawn-path helper;
//   - honest absences stay honest: win32 skips voice shapes and the sandbox
//     by NAME, never a fabricated "recording" or "sandboxed";
//   - the CI matrix + the fixed push filter + the Install docs are pinned —
//     a regression to a single-OS matrix or missing docs fails the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeFallback, baseSpawnEnv } from '../src/util.js';
import { probeRecorders } from '../src/voice.js';
import { detectSandboxCapability } from '../src/tools/sandbox.js';
import { runBash } from '../src/tools/local.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Part A: homeFallback — the ONE cross-platform fallback chain ────────────

test('homeFallback: HOME wins when set (byte-for-byte POSIX behavior preserved)', () => {
  assert.equal(homeFallback({ HOME: '/home/lewis' }), '/home/lewis');
});

test('homeFallback: USERPROFILE is the native Windows answer when HOME is absent', () => {
  assert.equal(homeFallback({ USERPROFILE: 'C:\\Users\\lewis' }), 'C:\\Users\\lewis');
});

test('homeFallback: whitespace-only values are lies and are skipped (trim rule)', () => {
  assert.equal(homeFallback({ HOME: '   ', USERPROFILE: 'C:\\u' }), 'C:\\u');
  assert.equal(homeFallback({ HOME: '' }), homeFallback({}));
});

test('homeFallback: tmp option is the third rung; a junk tmp falls through to os.tmpdir()', () => {
  assert.equal(homeFallback({}, { tmp: '/sandbox-home' }), '/sandbox-home');
  assert.equal(homeFallback({}, { tmp: '   ' }), os.tmpdir());
  assert.equal(homeFallback({}, { tmp: 42 }), os.tmpdir());
});

test('homeFallback: NEVER returns an empty or non-string value across the whole chain', () => {
  for (const env of [{}, { HOME: '' }, { HOME: null }, { USERPROFILE: null }, { HOME: 0 }, { HOME: false }]) {
    const v = homeFallback(env);
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0);
  }
});

test('homeFallback: hostile env objects are survived, never thrown from (spawn path)', () => {
  const throwing = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(homeFallback(throwing), os.tmpdir());
  const nullProto = Object.create(null);
  nullProto.HOME = '/real/home';
  assert.equal(homeFallback(nullProto), '/real/home'); // own-key reads stay DATA
  assert.equal(homeFallback(undefined), homeFallback()); // explicit undefined = the default (the real env), never a crash
});

// ── Part B: baseSpawnEnv — the ONE base env, six duplicated sites collapsed ─

test('baseSpawnEnv: PATH verbatim, HOME via the fallback chain, locale + NO_COLOR fixed', () => {
  const e = baseSpawnEnv({ PATH: '/usr/bin:/bin', HOME: '/h', USERPROFILE: 'C:\\u' });
  assert.equal(e.PATH, '/usr/bin:/bin'); // verbatim — never invented, never trimmed
  assert.equal(e.HOME, '/h');
  assert.equal(e.LANG, 'C.UTF-8');
  assert.equal(e.NO_COLOR, '1');
  assert.equal(Object.keys(e).length, 4, 'exactly the four base keys');
});

test('baseSpawnEnv: Windows-only env (no HOME) gets USERPROFILE, not a POSIX path', () => {
  const e = baseSpawnEnv({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\lewis' });
  assert.equal(e.HOME, 'C:\\Users\\lewis');
  assert.ok(!String(e.HOME).startsWith('/tmp'), 'the /tmp lie is dead');
});

test('baseSpawnEnv: caller spreads land ON TOP — sandbox/caller overrides still win', () => {
  const merged = { ...baseSpawnEnv({ HOME: '/h' }), ...{ HOME: '/sandbox-home', SANDBOX: '1' } };
  assert.equal(merged.HOME, '/sandbox-home');
  assert.equal(merged.SANDBOX, '1');
});

test('baseSpawnEnv: hostile env cannot crash it (it sits on every spawn site)', () => {
  const throwing = new Proxy({}, { get() { throw new Error('boom'); } });
  const e = baseSpawnEnv(throwing);
  assert.equal(e.NO_COLOR, '1');
  assert.equal(typeof e.HOME, 'string');
});

// ── Part C: honest absences stay honest on win32 (pins, they must not drift) ─

test('voice on win32: every recorder shape is skipped BY NAME — nothing fabricated', () => {
  const probes = probeRecorders({ run: () => { throw new Error('must not probe on win32'); }, platform: 'win32' });
  assert.ok(probes.length > 0);
  for (const p of probes) {
    assert.equal(p.found, false);
    assert.match(p.skipped, /not on this OS/);
  }
});

test('sandbox on win32: the namespace sandbox degrades honestly (Linux-only, named)', () => {
  const cap = detectSandboxCapability({ platform: 'win32' });
  assert.equal(cap.ok, false);
  assert.equal(cap.kind, 'none');
  assert.match(cap.detail, /Linux-only/);
  assert.match(cap.detail, /win32/);
});

// ── Part D: the wave's own artifacts are deliverables — pin them ─────────────

test('ci.yml: the windows matrix exists and the test job rides it', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /matrix:\s*\n\s*os: \[ubuntu-latest, windows-latest\]/);
  assert.match(yml, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(yml, /fail-fast: false/, 'one OS failing must not hide the other leg');
});

test('ci.yml: the push filter is the real main branch (regression pin)', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /branches: \[main\]/);
});

test('ci.yml: every matrix leg beacons its result to the ci-log branch (git-transport visibility)', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /ci-log/);
  assert.match(yml, /if: always\(\)/, 'a FAILED leg must still beacon — silence is the one dishonest state');
});

test('README: official install docs exist with a real Windows section', () => {
  const md = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.match(md, /## Install/);
  assert.match(md, /### Windows 10 \/ 11/);
  assert.match(md, /\*\*>= 20\*\*/, 'the engines floor is documented, not guessed');
  assert.match(md, /windows-latest/);
  assert.match(md, /Honest absences:/, 'the docs keep the no-fake-claims rule');
});

// ── Part E: the wire proof — a REAL spawn carries the hardened env ───────────

test('runBash wire: the child sees the real HOME through baseSpawnEnv (live, POSIX shells)', { skip: process.platform === 'win32' ? 'POSIX-only wire proof; windows leg is proven by CI' : false }, async () => {
  const r = await runBash('printenv HOME', { cwd: os.tmpdir() });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), process.env.HOME);
  const noColor = await runBash('printenv NO_COLOR', { cwd: os.tmpdir() });
  assert.equal(noColor.stdout.trim(), '1');
});
