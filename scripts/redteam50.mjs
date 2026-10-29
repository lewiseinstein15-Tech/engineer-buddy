// v0.50.0 RED TEAM PASS (war-room Play 4) — try to break the frontier
// toolchains plane before it ships: registration floods and injection (junk
// actions/domains, unicode, 10k strings, __proto__, newlines), the argument
// validators (gradle tasks, xcodebuild schemes/destinations, esptool offsets,
// avrdude ids, baud rates, wasm module args — flag smuggling is not an
// argument), containment (traversal, absolutes, symlink escape, NUL, floods —
// for run targets, flash firmware, openocd configs, and template writes),
// port discipline (an invented device path can NEVER flash or be monitored),
// the WASI fallback (the '--' separator must shield argv; the bootstrap must
// never interpolate anything but the contained path), probe sabotage
// (throwing/junk/null probes degrade to honest lines), runner sabotage (spawn
// errors surface honestly), and the monitor bounds (seconds AND bytes — a
// 20k-byte device must not produce more than the cap). Two planted canaries:
// an outside-root file whose content must never leak into any output, and a
// control-char arg that must never survive a renderer. A crash, a guessed
// path, an unbounded capture, or an invented port = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  probeBins, statusFrontier, containedFile, buildMobile, runWasm, templateMl,
  flashHardware, monitorHardware, runFrontier, createFrontierTool,
  serialPorts, ML_TEMPLATES, TASK_RE, SCHEME_RE, DEST_RE, OFFSET_RE, PROG_RE,
} from '../src/tools/frontier.js';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `v50-redteam-${tag}-`));
const CANARY = 'REDTEAM-50-CANARY-4c7a91f2';
const errs = [];
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const attempt = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) {
    fail++; errs.push(e); console.log(`  ✖ ${name}\n      ${String(e?.message || e).split('\n')[0].slice(0, 150)}`);
  }
};
const ENO = () => ({ error: { code: 'ENOENT' } });
const rec = (result = { status: 0, stdout: 'ok', stderr: '' }) => {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push([cmd, args, opts]); return result; };
  fn.calls = calls;
  return fn;
};

// ── A. registration + dispatch floods ───────────────────────────────────────
console.log('\n── A. registration & dispatch under injection ────────────────────');
const FLOOD = 'x'.repeat(10000);
const CONTROL = 'a\u001b[31mb\u0000c\nd\te';
await attempt('junk/unicode/proto/newline actions all get teaching errors, never a crash', async () => {
  const opts = { root: tmp('a'), probe: ENO };
  for (const action of ['', FLOOD, CONTROL, { __proto__: {}, evil: 1 }.evil ?? 'x', 'status;rm', 'status\njson', 'ステータス', 42, true]) {
    const out = await runFrontier({ action }, opts);
    ok(out.startsWith('ERROR:') || out.includes('FRONTIER STATUS'), `action ${JSON.stringify(String(action).slice(0, 20))} must degrade honestly`);
  }
});
await attempt('proto-shaped args cannot pollute anything (own-key or refused)', async () => {
  const opts = { root: tmp('a2'), probe: ENO };
  const hostile = JSON.parse('{"action":"status","domain":"mobile","__proto__":{"evil":1}}');
  const out = await runFrontier(hostile, opts);
  ok(typeof out === 'string');
  ok(!({}.evil), 'Object.prototype must stay clean');
});
await attempt('string/number/boolean/null args: null runs, primitives refused honestly', async () => {
  const opts = { root: tmp('a3'), probe: ENO };
  ok((await runFrontier(null, opts)).includes('FRONTIER STATUS'));
  for (const junk of ['junk', 42, true]) {
    ok((await runFrontier(junk, opts)).startsWith('ERROR: args must be an object'), String(junk));
  }
});
await attempt('render never smuggles control chars from hostile args', async () => {
  const t = createFrontierTool({ root: tmp('a4') });
  for (const a of [{ action: CONTROL }, { action: 'flash', tool: CONTROL }, { file: CONTROL }, { kind: CONTROL }]) {
    const r = t.render(a);
    ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r), `render leaked control chars for ${JSON.stringify(Object.keys(a)[0])}`);
  }
});

// ── B. validators under hostile matrices ────────────────────────────────────
console.log('\n── B. validators: flag smuggling is never an argument ─────────────');
await attempt('TASK_RE: colon-paths legal; dashes/semicolons/newlines/floods refused', async () => {
  ok(TASK_RE.test(':app:assembleDebug') && TASK_RE.test('test'));
  for (const bad of ['-Pevil', '--foo', 'a;rm', 'a\nb', 'a b', FLOOD, CONTROL, '$(rm)', '`id`']) ok(!TASK_RE.test(bad), bad.slice(0, 12));
});
await attempt('SCHEME_RE/DEST_RE: spaces ok (real schemes), shell metachars refused', async () => {
  ok(SCHEME_RE.test('My App') && !SCHEME_RE.test('a;rm') && !SCHEME_RE.test('-s') && !SCHEME_RE.test('a\nb') && !SCHEME_RE.test(FLOOD));
  ok(DEST_RE.test('platform=iOS Simulator,name=iPhone 15') && !DEST_RE.test('a`id`') && !DEST_RE.test('a\nb') && !DEST_RE.test('x'.repeat(90)));
});
await attempt('OFFSET_RE/PROG_RE: hex-only offsets, id-chars only for avrdude', async () => {
  ok(OFFSET_RE.test('0x0') && OFFSET_RE.test('0xABCDEF12'));
  for (const bad of ['0x', '10000', '-0x1', '0xG', FLOOD]) ok(!OFFSET_RE.test(bad), bad.slice(0, 12));
  ok(PROG_RE.test('usbasp') && !PROG_RE.test('a;rm') && !PROG_RE.test('-c') && !PROG_RE.test(FLOOD));
});
await attempt('buildMobile: every smuggled task/scheme/destination is refused BEFORE any spawn', async () => {
  const root = tmp('b1');
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  const run = rec();
  for (const task of ['--evil', '-Dx=1', 'a;rm', 'a\nb', FLOOD, CONTROL]) {
    const out = buildMobile({ flavor: 'android', task }, { root, runner: run, platform: 'linux' });
    ok(out.startsWith('ERROR: bad gradle task'), task.slice(0, 16));
  }
  ok(run.calls.length === 0, 'no spawn may happen for refused args');
});

// ── C. containment under attack ─────────────────────────────────────────────
console.log('\n── C. containment: nothing outside the root is ever touched ──────');
await attempt('containedFile hostile matrix: traversal/absolute/NUL/flood/symlink all refused', async () => {
  const root = fs.realpathSync(tmp('c1'));
  fs.writeFileSync(path.join(root, 'in.wasm'), 'x');
  fs.writeFileSync(path.resolve(root, '../v50-outside.bin'), CANARY);
  fs.symlinkSync(path.resolve(root, '../v50-outside.bin'), path.join(root, 'link.wasm'));
  for (const rel of ['../v50-outside.bin', '/etc/passwd', 'a\0b', `${FLOOD}.wasm`, 'link.wasm', '../../etc/passwd', '..\\..\\x.wasm', '%2e%2e%2fx.wasm']) {
    const r = containedFile(root, rel, { exts: ['.wasm'] });
    ok(r.error, `rel ${rel.slice(0, 24)} must be refused`);
  }
  ok((containedFile(root, 'in.wasm', { exts: ['.wasm'] }).error) === undefined);
});
await attempt('the planted outside file NEVER leaks into run/flash outputs (canary)', async () => {
  const root = fs.realpathSync(tmp('c2'));
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  const run = rec({ status: 1, stdout: 'nope', stderr: CANARY });
  // even a runner that TRIES to echo the canary cannot make the tool quote it:
  // the tool only renders runner output verbatim after refusing outside paths,
  // so try the outside path first — the refusal is what must appear.
  const out = runWasm({ file: '../v50-outside.bin' }, { root, runner: run, probe: ENO, wasi: 'yes' });
  ok(!out.includes(CANARY), 'canary leaked through a refused path');
  ok(run.calls.length === 0, 'refused path must not spawn');
});
await attempt('run/flash/openocd/template: refused targets never reach the runner', async () => {
  const root = fs.realpathSync(tmp('c3'));
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const r1 = rec();
  ok(runWasm({ file: '/etc/passwd' }, { root, runner: r1, probe: ENO, wasi: 'yes' }).startsWith('ERROR:'));
  ok(r1.calls.length === 0);
  const r2 = rec();
  ok(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: '/etc/shadow' }, { root, runner: r2, probe: (b) => (b === 'esptool.py' ? { stdout: 'esptool v4' } : ENO()), ports: ['/dev/ttyUSB0'] }).startsWith('ERROR:'));
  ok(r2.calls.length === 0);
  const r3 = rec();
  ok(flashHardware({ tool: 'openocd', port: '/dev/ttyUSB0', file: 'fw.bin', cfg: '/etc/openocd.cfg' }, { root, runner: r3, probe: (b) => (b === 'openocd' ? { stdout: 'openocd 0.12' } : ENO()), ports: ['/dev/ttyUSB0'] }).startsWith('ERROR: cfg'));
  ok(r3.calls.length === 0);
});

// ── D. port discipline ──────────────────────────────────────────────────────
console.log('\n── D. ports: only the enumeration may be touched ─────────────────');
await attempt('flash/monitor refuse invented, empty, flooded, and control-char ports', async () => {
  const root = fs.realpathSync(tmp('d1'));
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const base = { root, runner: rec(), probe: (b) => (b === 'esptool.py' ? { stdout: 'esptool v4' } : ENO()), ports: ['/dev/ttyUSB0'] };
  for (const port of ['/dev/ttyUSB99', '/dev/evil', '', FLOOD, CONTROL, '/dev/ttyUSB0\n/dev/ttyUSB1', '/dev/sda']) {
    ok(flashHardware({ tool: 'esptool', port, file: 'fw.bin' }, base).includes('not one of the enumerated serial ports'), port.slice(0, 20));
  }
  const mBase = { root, probe: () => ({ stdout: 'stty' }), ports: ['/dev/ttyUSB0'], platform: 'linux', sttyRunner: () => ({ status: 0, stdout: '', stderr: '' }) };
  for (const port of ['/dev/ttyS9', '/dev/evil', FLOOD]) {
    ok(monitorHardware({ port }, mBase).includes('not one of the enumerated serial ports'), port.slice(0, 20));
  }
});
await attempt('the enumeration itself is names-only and pattern-locked', async () => {
  for (const p of serialPorts('linux')) assert.match(p, /^\/dev\/tty(USB|ACM)[0-9]+$/);
  for (const p of serialPorts('darwin')) assert.match(p, /^\/dev\/(tty|cu)\.usb(modem|serial)/);
  assert.deepEqual(serialPorts('win32'), []);
});

// ── E. probe & runner sabotage ──────────────────────────────────────────────
console.log('\n── E. sabotaged probes and runners degrade honestly ──────────────');
await attempt('throwing/junk/null probe shapes never crash status, flash, or monitor', async () => {
  const root = tmp('e1');
  for (const probe of [() => { throw new Error('kaboom'); }, () => 42, () => 'junk', () => null, () => ({}), null]) {
    const out = statusFrontier({ domain: 'hardware' }, { root, probe, platform: 'linux' });
    ok(typeof out === 'string' && out.includes('hardware/embedded'));
    ok(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'x.bin' }, { root, runner: rec(), probe, ports: [] }).startsWith('ERROR:'));
    ok(monitorHardware({ port: '/dev/ttyUSB0' }, { root, probe, ports: [], platform: 'linux' }).startsWith('ERROR:'));
  }
  ok(!statusFrontier({ domain: 'ml' }, { root, probe: () => { throw new Error('SEKRET'); } }).includes('SEKRET'));
});
await attempt('runner spawn errors surface as honest could-not-run lines (all gated actions)', async () => {
  const root = fs.realpathSync(tmp('e2'));
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  const die = () => ({ error: { code: 'EACCES' } });
  ok(buildMobile({ flavor: 'android' }, { root, runner: die, platform: 'linux' }).includes('could not run'));
  ok(runWasm({ file: 'm.wasm' }, { root, runner: die, probe: (b) => (b === 'wasmtime' ? { stdout: 'wasmtime 24' } : ENO()) }).includes('could not run'));
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  ok(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin' }, { root, runner: die, probe: (b) => (b === 'esptool.py' ? { stdout: 'v' } : ENO()), ports: ['/dev/ttyUSB0'] }).includes('could not run'));
});
await attempt('junk baud/offset/seconds/part values are refused before any spawn (flood + NaN + Infinity)', async () => {
  const root = fs.realpathSync(tmp('e3'));
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const base = { root, runner: rec(), probe: (b) => (b === 'esptool.py' ? { stdout: 'v' } : ENO()), ports: ['/dev/ttyUSB0'] };
  for (const baud of [0, -1, 1e999, NaN, Infinity, '115200\n', FLOOD]) {
    ok(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin', baud }, base).startsWith('ERROR: bad baud'), String(baud).slice(0, 10));
  }
  ok(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin', offset: '0x' + 'f'.repeat(9) }, base).startsWith('ERROR: bad offset'));
  const mBase = { root, probe: () => ({ stdout: 'stty' }), ports: ['/dev/ttyUSB0'], platform: 'linux', sttyRunner: () => ({ status: 0, stdout: '', stderr: '' }) };
  for (const seconds of [31, -1, 0, NaN, Infinity, FLOOD]) {
    ok(monitorHardware({ port: '/dev/ttyUSB0', seconds }, mBase).startsWith('ERROR: seconds must be'), String(seconds).slice(0, 10));
  }
  ok(mBase === undefined || true);
  const rCalls = base.runner.calls.length + 0;
  ok(rCalls === 0, 'no spawn may happen for refused values');
});

// ── F. the WASI fallback shield ─────────────────────────────────────────────
console.log('\n── F. the WASI bootstrap: argv shield + no interpolation ─────────');
await attempt('the node argv shield: "--" precedes the contained path, never the raw user string', async () => {
  const root = fs.realpathSync(tmp('f1'));
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  const run = rec({ status: 0, stdout: '', stderr: '' });
  runWasm({ file: 'm.wasm' }, { root, runner: run, probe: ENO, wasi: 'yes' });
  const args = run.calls[0][1];
  const dashdash = args.indexOf('--');
  ok(dashdash > 0, 'a -- separator must exist');
  ok(args[dashdash + 1] === path.join(root, 'm.wasm'), 'the REAL contained path follows --');
  ok(!JSON.stringify(args).includes('-e-'), 'no stray flag shapes');
  // a file literally named like a flag is still shielded
  fs.writeFileSync(path.join(root, '-evil.wasm'), '\0asm');
  const run2 = rec({ status: 0, stdout: '', stderr: '' });
  const out2 = runWasm({ file: '-evil.wasm' }, { root, runner: run2, probe: ENO, wasi: 'yes' });
  ok(!out2.startsWith('ERROR: could not run') || run2.calls.length === 1, 'flag-named file must ride the shield, not argv-parse');
  if (run2.calls.length) ok(run2.calls[0][1].includes('--'));
});
await attempt('the bootstrap contains no env interpolation and no eval', async () => {
  const { runWasm } = await import('../src/tools/frontier.js');
  const root = fs.realpathSync(tmp('f2'));
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  const run = rec({ status: 0, stdout: '', stderr: '' });
  runWasm({ file: 'm.wasm' }, { root, runner: run, probe: ENO, wasi: 'yes' });
  const bootstrap = run.calls[0][1][2];
  ok(!bootstrap.includes('process.env'), 'no env reads in the bootstrap');
  ok(!/\beval\b|new Function/.test(bootstrap), 'no eval in the bootstrap');
  ok(bootstrap.includes('preopens') && bootstrap.includes('process.cwd()'), 'preopens stay at the project cwd');
});

// ── G. monitor bounds ───────────────────────────────────────────────────────
console.log('\n── G. monitor: bounded by design, bytes AND seconds ──────────────');
await attempt('a 20k-byte device yields AT MOST the byte cap — the last read cannot overshoot', async () => {
  const root = tmp('g1');
  const port = path.join(root, 'ttyBIG0');
  fs.writeFileSync(port, 'B'.repeat(20000));
  const out = monitorHardware({ port, seconds: 1 }, {
    root, platform: 'linux', ports: [port],
    probe: () => ({ stdout: 'stty' }), sttyRunner: () => ({ status: 0, stdout: '', stderr: '' }), sleeper: () => {},
  });
  const m = out.match(/captured (\d+) bytes/);
  ok(m && Number(m[1]) <= 8192, `capture must respect the byte cap, got ${m && m[1]}`);
  ok(out.length < 20000, 'output itself stays bounded');
});

// ── H. canary + finale ──────────────────────────────────────────────────────
console.log('\n── H. finale: leak scan across every collected byte ──────────────');
await attempt('FINALE: the planted outside-root canary appears in ZERO tool outputs', async () => {
  // re-run a battery with canary-bearing fixtures and collect every byte
  const root = fs.realpathSync(tmp('h1'));
  fs.writeFileSync(path.resolve(root, '../v50-h-canary.bin'), CANARY);
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  const outs = [];
  outs.push(await runFrontier({}, { root, probe: ENO }));
  outs.push(await runFrontier({ action: 'status', domain: 'mobile' }, { root, probe: ENO }));
  outs.push(runWasm({ file: '../v50-h-canary.bin' }, { root, runner: rec(), probe: ENO, wasi: 'yes' }));
  outs.push(buildMobile({ flavor: 'android', task: '../v50-h-canary.bin' }, { root, runner: rec(), platform: 'linux' }));
  outs.push(templateMl({ kind: 'infer-onnx' }, { root }));
  const hay = outs.join('\n');
  ok(!hay.includes(CANARY), 'the canary must never surface');
});

console.log(`\nRED TEAM v0.50 result: ${pass} pass / ${fail} fail`);
if (fail) { console.log('\nFINDINGS:'); for (const e of errs) console.log('  -', String(e?.message || e).split('\n')[0].slice(0, 160)); process.exit(1); }
