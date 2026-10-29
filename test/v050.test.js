// v0.50.0 — FRONTIER TOOLCHAINS (checklist §10 −4: mobile / wasm-edge / ml /
// hardware-embedded). Tests run OFFLINE against src/tools/frontier.js with
// injected probes/runners/ports — no machine toolchain is required for a
// deterministic verdict, and the honest-absence pins are exactly as important
// as the happy paths. Pins that carry the house rules:
//   - tri-state probes: "slow" is never reported as "absent" (cloud rule);
//   - "not on PATH" is only ever said when the probe saw ENOENT;
//   - flash/monitor only ever target a port the ENUMERATION produced —
//     an invented device path is refused, nothing is guessed;
//   - every file the tool touches resolves INSIDE the project root
//     (containment + realpath — a symlink pointing out is refused);
//   - the gradle task/scheme/avrdude-ids validators refuse flag smuggling;
//   - the WASI fallback is capability-probed, never assumed;
//   - template writes never clobber silently and carry fixed honest content;
//   - monitor captures are bounded (seconds AND bytes) by design;
//   - junk/throwing/null probes degrade to honest lines, never a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  probeBins, wasiCapability, serialPorts, statusFrontier, containedFile,
  buildMobile, runWasm, templateMl, ML_TEMPLATES, flashHardware,
  monitorHardware, runFrontier, createFrontierTool,
  TASK_RE, SCHEME_RE, OFFSET_RE, PROG_RE, BAUDS, TEMPLATE_KINDS, FLASH_TOOLS,
} from '../src/tools/frontier.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v050-'));
const okProbe = (map) => () => ({ stdout: '' });
const pr = (stdout) => ({ stdout });
const REC = () => { const calls = []; calls.push = calls.push; return calls; };
const runnerRec = (result = { status: 0, stdout: 'ok', stderr: '' }) => {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push([cmd, args, opts]); return result; };
  fn.calls = calls;
  return fn;
};

// ── probeBins tri-state ─────────────────────────────────────────────────────

test('probeBins: version line / PROBE_FAILED / ENOENT-null is exactly tri-state', () => {
  const m = probeBins([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], (bin) => {
    if (bin === 'a') return pr('tool 1.2.3\nmore');
    if (bin === 'b') return { error: { code: 'ENOENT' } };
    if (bin === 'c') return { error: { code: 'ETIMEDOUT' } };
    return pr(''); // answered with nothing — not a version line
  });
  assert.equal(m.a, 'tool 1.2.3');
  assert.equal(m.b, null);
  assert.equal(m.c, 'PROBE_FAILED');
  assert.equal(m.d, 'PROBE_FAILED');
});

test('probeBins: a THROWING probe degrades to PROBE_FAILED, never a crash', () => {
  const m = probeBins(['x'], () => { throw new Error('boom'); });
  assert.equal(m.x, 'PROBE_FAILED');
});

test('probeBins: java-style stderr version lines are captured (stderr:true)', () => {
  const m = probeBins([{ name: 'java', args: ['-version'], stderr: true }], (bin) => ({ stderr: 'openjdk version "21.0.2"\n' }));
  assert.match(m.java, /openjdk version/);
});

test('wasiCapability: honest member of yes/no/PROBE_FAILED (cached second call)', () => {
  const a = wasiCapability(true);
  assert.ok(['yes', 'no', 'PROBE_FAILED'].includes(a));
  assert.equal(wasiCapability(), a);
});

test('serialPorts: names only, POSIX patterns, win32 is an honest empty list', () => {
  assert.deepEqual(serialPorts('win32'), []);
  for (const p of serialPorts('linux')) assert.match(p, /^\/dev\/tty(USB|ACM)[0-9]+$/);
  for (const p of serialPorts('darwin')) assert.match(p, /^\/dev\/(tty|cu)\.usb(modem|serial)/);
});

// ── status (gate-free) ──────────────────────────────────────────────────────

test('status: absent toolchains say "not on PATH … nothing fake is reported" — and only ENOENT may say it', () => {
  const out = statusFrontier({ domain: 'mobile' }, {
    root: tmp(),
    probe: (bin) => (bin === 'adb' ? pr('Android Debug Bridge version 1.0.41') : { error: { code: 'ENOENT' } }),
  });
  assert.match(out, /adb: Android Debug Bridge version 1.0\.41/);
  assert.match(out, /xcodebuild: not on PATH — iOS builds \(macOS only\); nothing fake is reported/);
  assert.match(out, /gradle: not on PATH/);
  assert.match(out, /java: not on PATH/);
  assert.doesNotMatch(out, /PROBE_FAILED/);
});

test('status: probe-failed toolchains are reported PRESENT-but-slow, never absent (cloud rule)', () => {
  const out = statusFrontier({ domain: 'wasm' }, {
    root: tmp(),
    probe: (bin) => (bin === 'wasmtime' ? { error: { code: 'ETIMEDOUT' } } : { error: { code: 'ENOENT' } }),
  });
  assert.match(out, /wasmtime: ON PATH but the --version probe failed or timed out \(cold start\?\) — reported honestly, not guessed/);
  assert.match(out, /not on PATH — run \.wasm outside the browser/);
});

test('status: all four domains at once, project shapes detected from the real temp tree', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  fs.writeFileSync(path.join(root, 'mod.wasm'), 'fake-but-detected');
  fs.mkdirSync(path.join(root, '.venv'));
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'numpy\n');
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const out = statusFrontier({}, { root, probe: () => ({ error: { code: 'ENOENT' } }), wasi: 'yes', platform: 'linux' });
  assert.match(out, /gradlew wrapper present — build uses IT, not system gradle/);
  assert.match(out, /\.wasm modules: mod\.wasm/);
  assert.match(out, /python venv: \.venv\//);
  assert.match(out, /python project manifest present/);
  assert.match(out, /firmware candidates: fw\.bin/);
  assert.match(out, /no serial ports detected \(nothing is invented\)/);
  assert.match(out, /node WASI \(zero-dep fallback for "run"\): AVAILABLE/);
  assert.match(out, /keyless inference can also ride Buddy's own brain gateways/);
});

test('status: junk domain refused with the teaching error; null/junk args never crash', () => {
  assert.match(statusFrontier({ domain: 'cloud' }, { root: tmp(), probe: okProbe() }), /ERROR: domain must be one of/);
  assert.match(statusFrontier({ domain: { evil: true } }, { root: tmp(), probe: okProbe() }), /ERROR: domain must be one of/);
  const out = statusFrontier({}, { root: tmp(), probe: () => { throw new Error('boom'); } });
  assert.match(out, /probe failed or timed out \(cold start\?\) — reported honestly, not guessed/); // the RENDERED honest line
  assert.doesNotMatch(out, /boom/); // and never the exception text
});

// ── containedFile ───────────────────────────────────────────────────────────

test('containedFile: traversal, absolutes outside root, NUL, and symlink escapes are all refused', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'in.bin'), 'x');
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'evil.bin'), 'x');
  fs.writeFileSync(path.resolve(root, '../v050-sibling.bin'), 'x'); // exists OUTSIDE root (a real traversal target)
  fs.symlinkSync(path.join(outside, 'evil.bin'), path.join(root, 'link.bin'));

  assert.match(containedFile(root, '../v050-sibling.bin', {}).error, /resolves OUTSIDE the project root/);
  assert.match(containedFile(root, path.join(outside, 'evil.bin'), {}).error, /OUTSIDE the project root/);
  assert.match(containedFile(root, 'a\0b', {}).error, /NUL byte/);
  assert.match(containedFile(root, 'missing.bin', { mustExist: true }).error, /cannot resolve/);
  const ok = containedFile(root, 'in.bin', {});
  assert.equal(ok.error, undefined);
  assert.equal(fs.realpathSync(ok.real), fs.realpathSync(path.join(root, 'in.bin')));
  assert.match(containedFile(root, 'link.bin', {}).error, /OUTSIDE the project root/);
});

test('containedFile: extension whitelist is exact — nothing is guessed about types', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'not-wasm.txt'), 'x');
  assert.match(containedFile(root, 'not-wasm.txt', { exts: ['.wasm'] }).error, /must be one of \.wasm/);
  assert.equal(containedFile(root, 'not-wasm.txt', { exts: ['.wasm'] }).error.includes('nothing is guessed'), true);
});

// ── mobile build (gated) ────────────────────────────────────────────────────

test('build: android uses the PROJECT\'s OWN gradlew — argv captured, not guessed', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  const run = runnerRec({ status: 0, stdout: 'BUILD SUCCESSFUL', stderr: '' });
  const out = buildMobile({ task: 'testDebugUnitTest' }, { root, runner: run, platform: 'linux' });
  assert.equal(run.calls[0][0], path.join(root, 'gradlew'));
  assert.deepEqual(run.calls[0][1], ['testDebugUnitTest']);
  assert.match(out, /gradlew testDebugUnitTest → exit 0/);
  assert.match(out, /BUILD SUCCESSFUL/);
});

test('build: system gradle fallback only when no wrapper exists (and it says which was used)', () => {
  const root = tmp(); // no gradlew
  const run = runnerRec({ status: 0, stdout: 'ok', stderr: '' });
  const out = buildMobile({ flavor: 'android' }, { root, runner: run, platform: 'linux', probe: () => pr('gradle 8.5') });
  assert.equal(run.calls[0][0], 'gradle');
  assert.deepEqual(run.calls[0][1], ['assembleDebug']);
  assert.match(out, /gradle assembleDebug → exit 0/);
});

test('build: no wrapper + gradle absent = honest refusal naming both fixes', () => {
  const out = buildMobile({ flavor: 'android' }, { root: tmp(), runner: runnerRec(), platform: 'linux', probe: () => ({ error: { code: 'ENOENT' } }) });
  assert.match(out, /no gradlew wrapper in this project and gradle is not on PATH/);
  assert.match(out, /nothing fake is reported/);
});

test('build: flavor is RESOLVED from project shapes — ambiguous projects are refused, not guessed', () => {
  const bare = buildMobile({}, { root: tmp(), runner: runnerRec(), platform: 'linux' });
  assert.match(bare, /flavor is required.*does not guess/s);
  const both = tmp();
  fs.writeFileSync(path.join(both, 'gradlew'), 'x'); fs.chmodSync(path.join(both, 'gradlew'), 0o755);
  fs.mkdirSync(path.join(both, 'App.xcodeproj'));
  assert.match(buildMobile({}, { root: both, runner: runnerRec(), platform: 'linux' }), /flavor is required/);
  const androidRoot = tmp();
  fs.writeFileSync(path.join(androidRoot, 'build.gradle'), 'x');
  const run = runnerRec({ status: 0, stdout: 'ok', stderr: '' });
  buildMobile({}, { root: androidRoot, runner: run, platform: 'linux', probe: () => pr('gradle 8.5') });
  assert.equal(run.calls[0][0], 'gradle'); // resolved android from build.gradle
});

test('build: gradle task validator refuses flag smuggling and junk — the dash is not a task', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'gradlew'), 'x'); fs.chmodSync(path.join(root, 'gradlew'), 0o755);
  for (const bad of ['--evil-flag', '-Dryun=true', 'task;rm -rf /', 'a\nb', 'x'.repeat(70)]) {
    const out = buildMobile({ flavor: 'android', task: bad }, { root, runner: runnerRec(), platform: 'linux' });
    assert.match(out, /ERROR: bad gradle task/, `task ${JSON.stringify(bad)} must be refused`);
  }
  const run = runnerRec();
  buildMobile({ flavor: 'android', task: ':app:testDebug' }, { root, runner: run, platform: 'linux' }); // colon paths are legal
  assert.deepEqual(run.calls[0][1], [':app:testDebug']);
});

test('build: ios on linux is macOS-honest; scheme/destination validators hold; argv captured on darwin', () => {
  const linux = buildMobile({ flavor: 'ios', scheme: 'App' }, { root: tmp(), runner: runnerRec(), platform: 'linux' });
  assert.match(linux, /xcodebuild only exists on macOS/);
  assert.match(linux, /nothing fake is reported/);
  assert.match(buildMobile({ flavor: 'ios', scheme: '-evil' }, { root: tmp(), runner: runnerRec(), platform: 'darwin' }), /ERROR: bad scheme/);
  assert.match(buildMobile({ flavor: 'ios', scheme: 'App', destination: 'a\nb' }, { root: tmp(), runner: runnerRec(), platform: 'darwin' }), /ERROR: bad destination/);
  assert.match(buildMobile({ flavor: 'ios', scheme: 'App', action: 'deploy' }, { root: tmp(), runner: runnerRec(), platform: 'darwin' }), /ERROR: ios action must be build or test/);
  const run = runnerRec({ status: 0, stdout: '** BUILD SUCCEEDED **', stderr: '' });
  const out = buildMobile({ flavor: 'ios', scheme: 'My App', destination: 'platform=iOS Simulator,name=iPhone 15', action: 'build' }, { root: tmp(), runner: run, platform: 'darwin' });
  assert.deepEqual(run.calls[0][1], ['-scheme', 'My App', 'build', '-destination', 'platform=iOS Simulator,name=iPhone 15']);
  assert.match(out, /BUILD SUCCEEDED/);
});

// ── wasm run (gated) ────────────────────────────────────────────────────────

test('run: wasmtime preferred, wasmer second, node-WASI fallback argv exactly pinned', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  const r1 = runnerRec({ status: 0, stdout: 'hello', stderr: '' });
  runWasm({ file: 'm.wasm', args: ['a', 'b'] }, { root, runner: r1, probe: (b) => (b === 'wasmtime' ? pr('wasmtime 24') : { error: { code: 'ENOENT' } }) });
  assert.equal(r1.calls[0][0], 'wasmtime');
  assert.deepEqual(r1.calls[0][1], [path.join(root, 'm.wasm'), 'a', 'b']);

  const r2 = runnerRec({ status: 0, stdout: 'hi', stderr: '' });
  runWasm({ file: 'm.wasm' }, { root, runner: r2, probe: (b) => (b === 'wasmer' ? pr('wasmer 4') : { error: { code: 'ENOENT' } }) });
  assert.equal(r2.calls[0][0], 'wasmer');
  assert.deepEqual(r2.calls[0][1], ['run', path.join(root, 'm.wasm')]);

  const r3 = runnerRec({ status: 0, stdout: 'wasi!', stderr: '' });
  const out3 = runWasm({ file: 'm.wasm', args: ['x'] }, { root, runner: r3, probe: () => ({ error: { code: 'ENOENT' } }), wasi: 'yes' });
  assert.equal(r3.calls[0][0], process.execPath);
  assert.deepEqual(r3.calls[0][1].slice(0, 2), ['--input-type=module', '-e']);
  assert.match(r3.calls[0][1][2], /node:wasi/);
  assert.match(r3.calls[0][1][2], /preopens/);
  assert.deepEqual(r3.calls[0][1].slice(3), ['--', path.join(root, 'm.wasm'), 'x']);
  assert.match(out3, /node WASI \(zero-dep fallback\)/);
});

test('run: nothing available = honest refusal naming the install; wasi probe-failure says so too', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  const opts = { root, runner: runnerRec(), probe: () => ({ error: { code: 'ENOENT' } }) };
  assert.match(runWasm({ file: 'm.wasm' }, { ...opts, wasi: 'no' }), /no wasm runtime available.*install wasmtime.*nothing fake is reported/s);
  assert.match(runWasm({ file: 'm.wasm' }, { ...opts, wasi: 'PROBE_FAILED' }), /capability probe failed \(reported honestly\)/);
});

test('run: the file must be a project .wasm inside the root; module args are printable-ASCII ≤ 8', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'm.txt'), 'x');
  fs.writeFileSync(path.join(root, 'm.wasm'), '\0asm');
  fs.writeFileSync(path.resolve(root, '../v050-x.wasm'), 'x'); // exists OUTSIDE root — a real traversal target
  const base = { root, runner: runnerRec(), probe: () => ({ error: { code: 'ENOENT' } }), wasi: 'yes' };
  assert.match(runWasm({ file: 'm.txt' }, base), /must be one of \.wasm/);
  assert.match(runWasm({ file: '../v050-x.wasm' }, base), /OUTSIDE the project root/);
  assert.match(runWasm({ file: 'nope.wasm' }, base), /cannot resolve/);
  assert.match(runWasm({ file: 'm.wasm', args: ['a\nb'] }, base), /printable ASCII/);
  assert.match(runWasm({ file: 'm.wasm', args: Array(9).fill('x') }, base), /at most 8 module args/);
});

// ── ml templates (gated write) ──────────────────────────────────────────────

test('template: kinds are whitelisted; each template lands at its fixed path with fixed content', () => {
  for (const kind of TEMPLATE_KINDS) {
    const root = tmp();
    const out = templateMl({ kind }, { root });
    const f = ML_TEMPLATES[kind].file;
    assert.match(out, new RegExp(`template written: ${f.replace(/[/.]/g, '\\$&')}`));
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    assert.equal(body, ML_TEMPLATES[kind].text);
    assert.ok(body.length > 200, `${kind} template is substantive`);
  }
});

test('template: silent clobber is refused; overwrite:true is explicit; junk kinds are refused', () => {
  const root = tmp();
  templateMl({ kind: 'infer-ollama' }, { root });
  assert.match(templateMl({ kind: 'infer-ollama' }, { root }), /already exists — pass overwrite:true/);
  assert.match(templateMl({ kind: 'infer-ollama', overwrite: true }, { root }), /template written/);
  assert.match(templateMl({ kind: 'train-sentient' }, { root }), /ERROR: kind must be one of/);
  assert.match(templateMl({ kind: 'infer-onnx;evil' }, { root }), /ERROR: kind must be one of/); // junk refused (a trailing newline is normalized — whitespace is not junk)
});

test('template: the ollama starter carries the keyless story and never a literal credential', () => {
  const t = ML_TEMPLATES['infer-ollama'].text;
  assert.match(t, /127\.0\.0\.1:11434/);
  assert.match(t, /OLLAMA_HOST/);
  assert.doesNotMatch(t, /(api[_-]?key|bearer|password)\s*[:=]\s*["'][^"']+["']/i);
});

// ── hardware flash (gated; enumerated ports only) ───────────────────────────

test('flash: the port MUST come from the enumeration — an invented device path is refused', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const opts = { root, runner: runnerRec({ status: 0, stdout: '', stderr: '' }), probe: (b) => (b === 'esptool.py' ? pr('esptool.py v4.7') : { error: { code: 'ENOENT' } }), ports: ['/dev/ttyUSB0'] };
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB9', file: 'fw.bin' }, opts), /is not one of the enumerated serial ports/);
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/evil', file: 'fw.bin' }, opts), /not one of the enumerated/);
  assert.match(flashHardware({ tool: 'esptool', port: '', file: 'fw.bin' }, opts), /not one of the enumerated/);
  const r = runnerRec({ status: 0, stdout: 'Hash of data verified.', stderr: '' });
  const out = flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin', baud: 921600, offset: '0x10000' }, { ...opts, runner: r });
  assert.equal(r.calls[0][0], 'esptool.py');
  assert.deepEqual(r.calls[0][1], ['--port', '/dev/ttyUSB0', '--baud', '921600', 'write_flash', '0x10000', path.join(root, 'fw.bin')]);
  assert.match(out, /Hash of data verified/);
});

test('flash: absent flasher = honest refusal; junk tool/baud/offset/part refused; file containment holds', () => {
  const root = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'fw.bin'), 'FW');
  const absent = { root, runner: runnerRec(), probe: () => ({ error: { code: 'ENOENT' } }), ports: ['/dev/ttyUSB0'] };
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin' }, absent), /esptool is not on PATH — install it and retry; nothing fake is reported/);
  const opts = { root, runner: runnerRec({ status: 0, stdout: '', stderr: '' }), probe: (b) => (b === 'esptool.py' ? pr('esptool.py v4.7') : { error: { code: 'ENOENT' } }), ports: ['/dev/ttyUSB0'] };
  assert.match(flashHardware({ tool: 'jtag-master', port: '/dev/ttyUSB0', file: 'fw.bin' }, opts), /ERROR: tool must be one of/);
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin', baud: 12345 }, opts), /ERROR: bad baud/);
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.bin', offset: '10000' }, opts), /ERROR: bad offset/);
  fs.writeFileSync(path.resolve(root, '../v050-fw-out.bin'), 'FW'); // exists OUTSIDE root
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: '../v050-fw-out.bin' }, opts), /OUTSIDE the project root/);
  fs.writeFileSync(path.join(root, 'fw.exe'), 'FW'); // real file, wrong extension
  assert.match(flashHardware({ tool: 'esptool', port: '/dev/ttyUSB0', file: 'fw.exe' }, opts), /must be one of \.bin \/ \.hex/);
  // avrdude: the -U string is BUILT by the tool, never passed through
  fs.writeFileSync(path.join(root, 'fw.hex'), ':hex');
  const ravd = runnerRec({ status: 0, stdout: 'avrdude done.', stderr: '' });
  flashHardware({ tool: 'avrdude', port: '/dev/ttyACM0', file: 'fw.hex', programmer: 'usbasp', part: 'atmega328p' }, { ...opts, runner: ravd, probe: (b) => (b === 'avrdude' ? pr('avrdude 7.1') : { error: { code: 'ENOENT' } }), ports: ['/dev/ttyACM0'] });
  assert.equal(ravd.calls[0][0], 'avrdude');
  assert.deepEqual(ravd.calls[0][1], ['-c', 'usbasp', '-p', 'atmega328p', '-P', '/dev/ttyACM0', '-U', `flash:w:${path.join(root, 'fw.hex')}:i`]);
  assert.match(flashHardware({ tool: 'avrdude', port: '/dev/ttyACM0', file: 'fw.hex', programmer: 'usbasp;evil' }, { ...opts, runner: runnerRec(), probe: (b) => (b === 'avrdude' ? pr('7') : { error: { code: 'ENOENT' } }), ports: ['/dev/ttyACM0'] }), /programmer\/part must be/);
  // openocd: cfg must be a contained project file
  fs.writeFileSync(path.join(root, 'board.cfg'), 'source [find interface/jlink.cfg]');
  const roo = runnerRec({ status: 0, stdout: 'programming done', stderr: '' });
  flashHardware({ tool: 'openocd', port: '/dev/ttyUSB0', file: 'fw.bin', cfg: 'board.cfg' }, { ...opts, runner: roo, probe: (b) => (b === 'openocd' ? pr('openocd 0.12') : { error: { code: 'ENOENT' } }) });
  assert.equal(roo.calls[0][0], 'openocd');
  assert.deepEqual(roo.calls[0][1].slice(0, 2), ['-f', path.join(root, 'board.cfg')]);
  assert.match(roo.calls[0][1][3], /^program .*fw\.bin verify reset exit$/);
  assert.match(flashHardware({ tool: 'openocd', port: '/dev/ttyUSB0', file: 'fw.bin', cfg: '../evil.cfg' }, { ...opts, probe: (b) => (b === 'openocd' ? pr('openocd 0.12') : { error: { code: 'ENOENT' } }) }), /ERROR: cfg/);
  // picotool flags strictly opt-in
  fs.writeFileSync(path.join(root, 'fw.uf2'), 'UF2');
  const rpic = runnerRec({ status: 0, stdout: '', stderr: '' });
  flashHardware({ tool: 'picotool', port: '/dev/ttyACM0', file: 'fw.uf2', execute: true, force: true }, { ...opts, runner: rpic, probe: (b) => (b === 'picotool' ? pr('picotool 2.0') : { error: { code: 'ENOENT' } }), ports: ['/dev/ttyACM0'] });
  assert.deepEqual(rpic.calls[0][1], ['load', path.join(root, 'fw.uf2'), '-x', '-f']);
});

// ── hardware serial monitor (gated; bounded) ────────────────────────────────

test('monitor: win32 is honest; port must be enumerated; baud/seconds are whitelisted/bounded', () => {
  const base = { root: tmp(), probe: () => pr('stty'), ports: ['/dev/ttyUSB0'], platform: 'linux', sttyRunner: () => ({ status: 0, stdout: '', stderr: '' }) };
  assert.match(monitorHardware({}, { ...base, platform: 'win32' }), /serial monitor needs POSIX/);
  assert.match(monitorHardware({ port: '/dev/ttyS9' }, base), /not one of the enumerated serial ports/);
  assert.match(monitorHardware({ port: '/dev/ttyUSB0', baud: 7 }, base), /ERROR: bad baud/);
  assert.match(monitorHardware({ port: '/dev/ttyUSB0', seconds: 999 }, base), /seconds must be 1–30/);
  assert.match(monitorHardware({ port: '/dev/ttyUSB0', seconds: 'x' }, base), /seconds must be 1–30/);
});

test('monitor: the happy path captures real bytes through a bounded loop and closes the port', () => {
  const root = tmp();
  const port = path.join(root, 'ttyFAKE0'); // a regular file stands in for the device; enumeration is injected
  fs.writeFileSync(port, 'hello from the serial line\r\n');
  const out = monitorHardware({ port, seconds: 1, baud: 115200 }, {
    root, platform: 'linux', ports: [port],
    probe: () => pr('stty (GNU coreutils)'),
    sttyRunner: (c, a) => { assert.deepEqual(a, ['-F', port, '115200', 'raw', '-echo']); return { status: 0, stdout: '', stderr: '' }; },
    sleeper: () => {},
  });
  assert.match(out, /captured 28 bytes from/);
  assert.match(out, /hello from the serial line/);
  assert.match(out, /bounded capture; port closed/);
});

test('monitor: stty refusal and open failure are honest, teaching errors', () => {
  const root = tmp();
  const port = path.join(root, 'ttyFAKE0');
  fs.writeFileSync(port, 'x');
  const base = { root, platform: 'linux', ports: [port], probe: () => pr('stty'), sttyRunner: () => ({ status: 1, stdout: '', stderr: 'permission denied' }) };
  assert.match(monitorHardware({ port }, base), /stty refused the port.*permission denied.*dialout\/uucp/s);
  fs.rmSync(port); // now the open must fail honestly
  const base2 = { ...base, sttyRunner: () => ({ status: 0, stdout: '', stderr: '' }) };
  const out2 = monitorHardware({ port }, base2);
  assert.match(out2, /cannot open .* \(ENOENT\) — check permissions/);
});

// ── dispatch, gating, registration shape ────────────────────────────────────

test('dispatch: unknown actions, wrong-domain actions, and junk args all get teaching errors', async () => {
  const opts = { root: tmp(), probe: () => ({ error: { code: 'ENOENT' } }) };
  assert.match(await runFrontier({ action: 'deploy' }, opts), /ERROR: unknown action "deploy" — known: /);
  assert.match(await runFrontier({ action: 'build', domain: 'wasm' }, opts), /belongs to domain "mobile"/);
  assert.match(await runFrontier({ action: 'flash', domain: 'ml' }, opts), /belongs to domain "hardware"/);
  assert.match(await runFrontier({ action: 'run', domain: 'hardware' }, opts), /belongs to domain "wasm"/);
  assert.match(await runFrontier(null, opts), /FRONTIER STATUS/);
  assert.match(await runFrontier('junk', opts), /args must be an object/);
  assert.match(await runFrontier({ action: 'status', domain: null }, opts), /FRONTIER STATUS/);
});

test('gating: status is gate-free; build/run/template/flash/monitor all ask (riskyWhen)', () => {
  const t = createFrontierTool({ root: tmp() });
  assert.equal(t.riskyWhen({ action: 'status' }), false);
  assert.equal(t.riskyWhen({}), false);
  for (const a of ['build', 'run', 'template', 'flash', 'monitor']) assert.equal(t.riskyWhen({ action: a }), true, `${a} must be gated`);
  assert.equal(t.riskyWhen({ action: 'STATUS' }), false); // case-insensitive, same as run
});

test('registration: the frontier tool exposes the house shape (name/description/args/render/run)', async () => {
  const t = createFrontierTool({ root: tmp() });
  assert.equal(t.name, 'frontier');
  assert.ok(t.description.length > 300);
  assert.match(t.description, /never bundled/);
  assert.match(t.description, /nothing fake is ever reported/i);
  assert.ok(t.args.length > 100);
  assert.match(t.render({ action: 'flash', domain: 'hardware', tool: 'esptool', port: '/dev/ttyUSB0' }), /frontier flash hardware esptool → \/dev\/ttyUSB0/);
  assert.match(t.render({}), /^frontier status/);
  const out = await t.run({ action: 'status', domain: 'hardware' }, { probe: () => ({ error: { code: 'ENOENT' } }) });
  assert.match(out, /hardware\/embedded — flashers, debuggers, serial:/);
});

test('validators export their shapes (pinned for the red team)', () => {
  assert.ok(TASK_RE.test(':app:assembleDebug'));
  assert.ok(!TASK_RE.test('-Pevil'));
  assert.ok(SCHEME_RE.test('My App'));
  assert.ok(!SCHEME_RE.test('a;rm'));
  assert.ok(OFFSET_RE.test('0x10000'));
  assert.ok(!OFFSET_RE.test('0x'));
  assert.ok(PROG_RE.test('usbasp'));
  assert.ok(!PROG_RE.test('a b'));
  assert.ok(BAUDS.has(115200));
  assert.ok(FLASH_TOOLS.has('esptool') && FLASH_TOOLS.has('picotool'));
});
