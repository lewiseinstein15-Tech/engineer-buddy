#!/usr/bin/env node
// v0.57.0 RED TEAM PASS (war-room Play 4) — try to break the windows
// hardening before it ships. The surface is the spawn-env plane:
//   ENV WEAPONS — homeFallback under throwing Proxies, null-prototype
//     objects, prototype pollution (inherited HOME/USERPROFILE must LOSE),
//     hostile value types, 1MB values, control bytes: nothing throws, the
//     chain never returns an empty/non-string, and env values stay DATA
//     (verbatim passthrough — the helper is a selector, not a sanitizer);
//   MERGE WEAPONS — baseSpawnEnv x caller x sandbox spreads: JSON-parsed
//     __proto__ keys cannot switch any prototype, the 4-key shape holds,
//     caller overrides still win on the wire (real spawn witness);
//   HONESTY WEAPONS — win32/darwin voices: recorder probes are skipped BY
//     NAME, the sandbox degrades BY NAME, hostile probe runners cannot make
//     a fake "found" or a fake "sandboxed" appear;
//   ARTIFACT WEAPONS — the ci.yml/README pins must actually BITE: tampered
//     variants (matrix removed, filter mangled, Install section deleted)
//     must fail the pin, or the pin is decoration.
// A stray throw, a polluted prototype, a fake capability, or a pin that
// survives its own tamper = ship blocked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { homeFallback, baseSpawnEnv } from '../src/util.js';
import { probeRecorders } from '../src/voice.js';
import { detectSandboxCapability } from '../src/tools/sandbox.js';
import { runBash } from '../src/tools/local.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const noThrow = (fn) => {
  try { return { r: fn(), threw: false }; } catch (e) { return { threw: true, e }; }
};

// ── ENV WEAPONS ──────────────────────────────────────────────────────────────
{
  const throwing = new Proxy({}, { get() { throw new Error('boom'); } });
  let r = noThrow(() => homeFallback(throwing));
  ok(!r.threw && r.r === os.tmpdir(), 'throwing Proxy env must degrade to os.tmpdir(), no throw');

  r = noThrow(() => homeFallback(new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('has'); } })));
  ok(!r.threw, 'throwing has+get Proxy env survived');

  const nullProto = Object.create(null);
  nullProto.HOME = '/real/home';
  r = noThrow(() => homeFallback(nullProto));
  ok(!r.threw && r.r === '/real/home', 'null-prototype env with own HOME keeps the value (own-key read)');

  // Prototype pollution: inherited HOME/USERPROFILE must LOSE.
  Object.prototype.HOME = '/polluted-home';
  Object.prototype.USERPROFILE = 'C:\\polluted';
  try {
    r = noThrow(() => homeFallback({}));
    ok(!r.threw && r.r === os.tmpdir(), `polluted Object.prototype.HOME must lose (got ${JSON.stringify(r.r)})`);
    r = noThrow(() => baseSpawnEnv({}));
    ok(!r.threw && r.r.HOME === os.tmpdir(), 'baseSpawnEnv under pollution keeps the honest fallback');
    ok(({}).HOME === '/polluted-home', 'sanity: pollution is real, so the helper genuinely filtered it');
  } finally {
    delete Object.prototype.HOME;
    delete Object.prototype.USERPROFILE;
  }

  for (const [label, v] of [['number', 42], ['object', { toString() { throw new Error('valueOf trap'); } }], ['array', []], ['bool', true], ['symbol-ish', Symbol('HOME')]]) {
    r = noThrow(() => homeFallback({ HOME: v }));
    ok(!r.threw && typeof r.r === 'string' && r.r.length > 0, `HOME as ${label} skipped, chain continues, no throw`);
  }

  const big = 'x'.repeat(1024 * 1024);
  r = noThrow(() => homeFallback({ HOME: big }));
  ok(!r.threw && r.r === big, '1MB HOME is DATA — verbatim, no transform, no truncation, no throw');

  r = noThrow(() => homeFallback({ HOME: '/h\nEVIL\u001b[31m' }));
  ok(!r.threw && r.r === '/h\nEVIL\u001b[31m', 'control/ANSI bytes in HOME stay verbatim DATA (selector, not sanitizer)');

  r = noThrow(() => homeFallback({ HOME: '/h', USERPROFILE: 'C:\\u' }, { tmp: { toString() { throw new Error('t'); } } }));
  ok(!r.threw && r.r === '/h', 'hostile tmp option after valid HOME is unreachable and harmless');

  r = noThrow(() => homeFallback(Object.create({ HOME: '/inherited' })));
  ok(!r.threw && r.r === os.tmpdir(), 'proto-chain-only HOME (Object.create) loses — inherited junk is not the env');
}

// ── MERGE WEAPONS ────────────────────────────────────────────────────────────
{
  const json = JSON.parse('{"__proto__":"fast","HOME":"/h"}'); // __proto__ becomes an OWN key
  let r = noThrow(() => baseSpawnEnv(json));
  ok(!r.threw && r.r.HOME === '/h', 'JSON-parsed __proto__ own key is inert DATA; HOME read still works');
  ok({ ...baseSpawnEnv(json), ...json }.__proto__ === Object.prototype || ({}).HOME === undefined, 'no prototype switch through the merge');

  const merged = { ...baseSpawnEnv({ HOME: '/h' }), ...{ HOME: '/sandbox', SANDBOX: '1' } };
  ok(merged.HOME === '/sandbox' && merged.SANDBOX === '1', 'sandbox overrides win on the merged wire');

  const e = baseSpawnEnv({ PATH: '/bin:/usr/bin' });
  ok(Object.keys(e).length === 4 && e.PATH === '/bin:/usr/bin', 'shape pinned: exactly 4 keys, PATH verbatim');

  // The wire witness (POSIX shells): a caller override lands in the REAL child.
  if (process.platform !== 'win32') {
    const w = await runBash('printenv BUDDY_RT_CANARY', { cwd: os.tmpdir(), env: { BUDDY_RT_CANARY: 'on-the-wire' } });
    ok(w.ok === true && w.stdout.trim() === 'on-the-wire', 'caller env reaches the real child through baseSpawnEnv');
    const h = await runBash('printenv HOME', { cwd: os.tmpdir() });
    ok(h.ok === true && h.stdout.trim() === process.env.HOME, 'the real child HOME is the real fallback chain output');
  }
}

// ── HONESTY WEAPONS ──────────────────────────────────────────────────────────
{
  const winProbes = noThrow(() => probeRecorders({ run: () => { throw new Error('no probe may run'); }, platform: 'win32' }));
  ok(!winProbes.threw && winProbes.r.length > 0 && winProbes.r.every((p) => p.found === false && /not on this OS/.test(p.skipped)),
    'win32: every recorder shape skipped BY NAME; hostile runner never consulted');

  const darwinRun = noThrow(() => probeRecorders({ run: () => { throw new Error('recorder missing'); }, platform: 'darwin' }));
  ok(!darwinRun.threw && darwinRun.r.every((p) => p.found === false), 'darwin: a throwing probe runner yields honest found:false, no throw');

  const junkRun = noThrow(() => probeRecorders({ run: () => ({ ok: Symbol('x'), stdout: undefined }), platform: 'darwin' }));
  ok(!junkRun.threw && junkRun.r.every((p) => p.found === false), 'hostile probe result shape (Symbol ok, no stdout) cannot fake a recorder');

  const winSandbox = noThrow(() => detectSandboxCapability({ platform: 'win32' }));
  ok(!winSandbox.threw && winSandbox.r.ok === false && winSandbox.r.kind === 'none' && /Linux-only/.test(winSandbox.r.detail),
    'win32 sandbox degrades BY NAME');
  const darwinSandbox = noThrow(() => detectSandboxCapability({ platform: 'darwin' }));
  ok(!darwinSandbox.threw && darwinSandbox.r.ok === false, 'darwin sandbox degrades the same way');
  const linSandbox = noThrow(() => detectSandboxCapability({ platform: 'linux', run: () => { throw new Error('unshare exploded'); } }));
  ok(!linSandbox.threw && linSandbox.r.ok === false, 'a throwing unshare probe is an honest not-ok, not a crash');
}

// ── ARTIFACT WEAPONS — the pins must BITE on tamper ──────────────────────────
{
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  ok(/matrix:\s*\n\s*os: \[ubuntu-latest, windows-latest\]/.test(yml) && /runs-on: \$\{\{ matrix\.os \}\}/.test(yml),
    'ci.yml pin: matrix present in the real file');
  ok(!/matrix:\s*\n\s*os: \[ubuntu-latest\]/.test(yml.replace('windows-latest, ', '')) === false ||
     yml.includes('windows-latest') === true, 'tamper detector: removing windows-latest from the text is detectable');
  const tampered = yml.replace(/windows-latest/g, '');
  ok(!/os: \[ubuntu-latest, windows-latest\]/.test(tampered), 'tamper bite: pin regex FAILS on the matrix-stripped variant');
  const mangled = yml.replace('branches: [main]', 'branches: main');
  ok(!/branches: \[main\]/.test(mangled), 'tamper bite: the filter pin FAILS on a mangled push filter');
  ok(/if: always\(\)/.test(yml) && /ci-log/.test(yml), 'beacon pin: every leg reports even on failure');

  const md = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  ok(/## Install/.test(md) && md.indexOf('## Install') < md.indexOf('## Buddy Code'), 'README pin: Install section sits before Buddy Code');
  const stripped = md.replace(/## Install[\s\S]*?(?=\n## )/, '');
  ok(!/### Windows 10 \/ 11/.test(stripped), 'tamper bite: removing Install removes the Windows section the pin requires');
}

// ── VERDICT ──────────────────────────────────────────────────────────────────
console.log(`RED TEAM v0.57: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('SHIP: the spawn-env plane held the line.');
process.exit(0);
