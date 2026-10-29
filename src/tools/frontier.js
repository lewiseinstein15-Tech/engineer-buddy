// frontier.js — the frontier toolchains tool (v0.50.0, checklist §10):
//   Mobile — iOS/Android build/test tooling detection (xcodebuild, gradle)
//   WASM / edge runtime support — run .wasm targets (wasmtime, wasmer, node WASI)
//   ML model helpers — inference/fine-tune task templates over the machine's python
//   Hardware/embedded — flash, serial monitor wrappers for embedded workflows
//
// Zero-dep by construction: Buddy probes THE MACHINE'S OWN toolchains on PATH
// at call time — nothing bundled, nothing faked. Absent tool → honest refusal
// naming what to install ("nothing fake is reported"). Read/act split mirrors
// cloud/containers/db:
//   status   — gate-free: tri-state probes per domain (version line |
//              PROBE_FAILED — ON PATH but the probe failed/timed out, never
//              collapsed into "absent" | null — genuinely absent, the only
//              case that may say "not on PATH"), project-shape detection,
//              serial-port enumeration (names only), node's WASI capability.
//   build    — mobile: THE PROJECT'S OWN gradlew <task> / xcodebuild -scheme
//              (gated; task/scheme validated; xcodebuild is macOS-honest).
//   run      — wasm: wasmtime/wasmer from PATH, or node's own WASI as the
//              zero-dep fallback (gated; the file must be a contained project
//              .wasm; module args capped).
//   template — ml: write ONE bounded starter file into the project (gated
//              like every write; containment; fixed content per kind).
//   flash    — hardware: ONE whitelisted shape per flasher (esptool,
//              avrdude, openocd, picotool) — gated; the port must be one of
//              the ENUMERATED serial ports (an invented device path is
//              refused); firmware file contained in the project.
//   monitor  — hardware: bounded serial capture via the machine's own stty +
//              a raw fd read (zero-dep, POSIX; seconds/bytes capped; gated).
// Only whitelisted flags are ever passed. No shell interpolation anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { truncate } from '../util.js';

export const READ_ACTIONS = new Set(['status']);
export const ACTIONS = new Set(['status', 'build', 'run', 'template', 'flash', 'monitor']);
export const DOMAINS = new Set(['mobile', 'wasm', 'ml', 'hardware']);

export const TASK_RE = /^:?[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/; // gradle task (colon paths ok), no leading '-'
export const SCHEME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/; // xcodebuild scheme (no shell metachars)
export const DEST_RE = /^[A-Za-z0-9=,._ -]{1,80}$/; // xcodebuild -destination (spaces are real: "platform=iOS Simulator,name=iPhone 15")
export const OFFSET_RE = /^0x[0-9a-fA-F]{1,8}$/; // esptool write_flash offset
export const PROG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/; // avrdude -c programmer / -p part (ids cannot start with '-')
export const WASM_ARG_RE = /^[\x20-\x7E]{1,200}$/; // printable ASCII, no newlines
export const PORT_SHAPE_RE = /^\/dev\/(ttyUSB|ttyACM|ttyS|tty\.usb|cu\.)[A-Za-z0-9._-]{1,32}$/;
export const BAUDS = new Set([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]);
export const TEMPLATE_KINDS = new Set(['infer-onnx', 'infer-ollama', 'finetune-lora']);
export const FLASH_TOOLS = new Set(['esptool', 'avrdude', 'openocd', 'picotool']);

const MAX_WASM_ARGS = 8;
const MAX_STATUS_CHARS = 7000;
const WASM_RUN_TIMEOUT_MS = 30000;
const BUILD_TIMEOUT_MS = 600000;
const MONITOR_MAX_SECONDS = 30;
const MONITOR_MAX_BYTES = 8192;
const PROBE_TIMEOUT_MS = 8000;

// render discipline (v0.49 rule): control chars can never smuggle into any
// rendered card, no matter what the model puts in args.
const clean = (s, n) => truncate(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ''), n);

// The per-domain toolchain catalog: what status probes, what it is for, and
// the version-args quirk (java prints its version to STDERR).
const TOOLCHAINS = {
  mobile: [
    { name: 'xcodebuild', args: ['-version'], note: 'iOS builds (macOS only)' },
    { name: 'gradle', note: 'Android builds (system gradle)' },
    { name: 'adb', note: 'Android device bridge' },
    { name: 'java', args: ['-version'], stderr: true, note: 'JDK underneath gradle' },
  ],
  wasm: [
    { name: 'wasmtime', note: 'run .wasm outside the browser' },
    { name: 'wasmer', note: 'run .wasm outside the browser' },
    { name: 'wasm-pack', note: 'build Rust into .wasm' },
    { name: 'emcc', note: 'Emscripten C/C++ into .wasm' },
    { name: 'workerd', note: 'Cloudflare Workers edge runtime (status only — run supports wasmtime/wasmer/node-WASI)' },
  ],
  ml: [
    { name: 'python3', note: 'ML scripting environment' },
    { name: 'pip3', note: 'python package installer' },
    { name: 'uv', note: 'fast python env manager' },
    { name: 'ollama', note: 'keyless local inference' },
  ],
  hardware: [
    { name: 'esptool.py', note: 'ESP32/ESP8266 flash' },
    { name: 'esptool', note: 'ESP32/ESP8266 flash (v2+ console script)' },
    { name: 'avrdude', note: 'AVR/Arduino flash' },
    { name: 'openocd', note: 'JTAG/SWD flash + debug' },
    { name: 'picotool', note: 'RP2040/RP2350 flash' },
    { name: 'st-flash', note: 'ST-Link flash' },
    { name: 'arduino-cli', note: 'Arduino toolkit (status only)' },
    { name: 'stty', note: 'serial config for monitor (POSIX coreutils)' },
  ],
};

/** Tri-state per binary — honesty demands the difference (cloud probe rule):
 *  version string → present and talking; 'PROBE_FAILED' → ON PATH but the
 *  probe failed/hung/timed out (cold starts are real); null → genuinely
 *  absent (ENOENT) — the only case that may say "not on PATH".
 *  `probe(bin)` is injectable for tests; default is a real spawnSync. */
export function probeBins(bins, probe = null) {
  const out = {};
  for (const t of bins) {
    const name = typeof t === 'string' ? t : t.name;
    const args = (typeof t === 'string' ? [] : t.args) || ['--version'];
    const stderr = typeof t !== 'string' && !!t.stderr;
    if (probe) {
      let r = null;
      try { r = probe(name); } catch { out[name] = 'PROBE_FAILED'; continue; }
      if (r == null) { out[name] = null; continue; }
      if (r.error) { out[name] = r.error.code === 'ENOENT' ? null : 'PROBE_FAILED'; continue; }
      const line = String((stderr ? r.stderr : r.stdout) || '').split('\n')[0].trim();
      out[name] = line.slice(0, 80) || 'PROBE_FAILED';
      continue;
    }
    const r = spawnSync(name, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
    if (r.error?.code === 'ENOENT') out[name] = null;
    else if (r.error) out[name] = 'PROBE_FAILED';
    else {
      const line = String((stderr ? r.stderr : r.stdout) || '').split('\n')[0].trim();
      out[name] = line.slice(0, 80) || 'PROBE_FAILED';
    }
  }
  return out;
}

/** Can this node run WASI modules? 'yes' | 'no' | 'PROBE_FAILED'. Cached. */
let _wasiCap;
export function wasiCapability(force = false) {
  if (!force && _wasiCap !== undefined) return _wasiCap;
  try {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'import("node:wasi").then(()=>process.exit(0)).catch(()=>process.exit(3))'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
    );
    _wasiCap = r.status === 0 ? 'yes' : r.status === 3 ? 'no' : 'PROBE_FAILED';
  } catch { _wasiCap = 'PROBE_FAILED'; }
  return _wasiCap;
}

/** Enumerate candidate serial ports (NAMES ONLY — nothing is opened here). */
export function serialPorts(platform = process.platform) {
  if (platform === 'win32') return [];
  try {
    const names = fs.readdirSync('/dev');
    const pats = platform === 'darwin'
      ? /^(tty|cu)\.usb(modem|serial)[A-Za-z0-9._-]*$/
      : /^tty(USB|ACM)[0-9]+$/;
    return names.filter((n) => pats.test(n)).sort().map((n) => `/dev/${n}`).slice(0, 32);
  } catch { return []; }
}

const READEXT = (dir, ext, cap = 20) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).slice(0, cap);
  } catch { return []; }
};
const FIRST = (root, names) => names.find((n) => { try { return fs.existsSync(path.join(root, n)); } catch { return false; } });

function projectShapes(root, domain, platform = process.platform) {
  const shapes = [];
  if (domain === 'mobile') {
    if (FIRST(root, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) shapes.push('android project (gradle build file present)');
    if (FIRST(root, ['gradlew'])) shapes.push('android project (gradlew wrapper present — build uses IT, not system gradle)');
    const xcode = READEXT(root, '.xcodeproj').concat(READEXT(root, '.xcworkspace'));
    if (xcode.length) shapes.push(`iOS project (${xcode.slice(0, 3).join(', ')})`);
    if (FIRST(root, ['Podfile'])) shapes.push('iOS project (Podfile)');
  } else if (domain === 'wasm') {
    const wasms = READEXT(root, '.wasm');
    if (wasms.length) shapes.push(`.wasm modules: ${wasms.slice(0, 6).join(', ')}${wasms.length > 6 ? ` … (${wasms.length} total)` : ''}`);
    if (FIRST(root, ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'])) shapes.push('edge target (wrangler config present — deploy through your workerd/wrangler pipeline)');
  } else if (domain === 'ml') {
    if (FIRST(root, ['.venv'])) shapes.push('python venv: .venv/');
    if (FIRST(root, ['venv'])) shapes.push('python venv: venv/');
    if (FIRST(root, ['requirements.txt', 'pyproject.toml', 'environment.yml'])) shapes.push('python project manifest present');
    const py = READEXT(root, '.ipynb', 5);
    if (py.length) shapes.push(`notebooks: ${py.slice(0, 3).join(', ')}`);
  } else if (domain === 'hardware') {
    const bins = ['.bin', '.hex', '.elf', '.uf2', '.img'];
    const fw = [];
    try { for (const f of fs.readdirSync(root)) if (bins.some((e) => f.endsWith(e))) fw.push(f); } catch { /* root unreadable */ }
    if (fw.length) shapes.push(`firmware candidates: ${fw.slice(0, 6).join(', ')}`);
    const cfgs = READEXT(root, '.cfg', 5);
    if (cfgs.length) shapes.push(`openocd configs: ${cfgs.slice(0, 3).join(', ')}`);
    const ports = serialPorts(platform);
    shapes.push(ports.length ? `serial ports: ${ports.join(', ')}` : 'no serial ports detected (nothing is invented)');
  }
  return shapes;
}

function probeLine(map, note) {
  const order = [...TOOLCHAINS[note]];
  const lines = [];
  for (const t of order) {
    const name = typeof t === 'string' ? t : t.name;
    const why = (typeof t === 'string' ? '' : t.note) || '';
    const v = map[name];
    if (v === 'PROBE_FAILED') lines.push(`${name}: ON PATH but the --version probe failed or timed out (cold start?) — reported honestly, not guessed`);
    else if (v == null) lines.push(`${name}: not on PATH${why ? ` — ${why}` : ''}; nothing fake is reported`);
    else lines.push(`${name}: ${v}${why ? ` — ${why}` : ''}`);
  }
  return lines;
}

// ── status (gate-free) ──────────────────────────────────────────────────────
export function statusFrontier(args = {}, { root = process.cwd(), probe = null, platform = process.platform, wasi = null } = {}) {
  const domain = args?.domain ? String(args.domain).trim().toLowerCase() : null;
  if (domain && !DOMAINS.has(domain)) {
    return `ERROR: domain must be one of ${[...DOMAINS].join(', ')} — got "${truncate(String(args.domain), 24)}"`;
  }
  const domains = domain ? [domain] : [...DOMAINS];
  const lines = [`FRONTIER STATUS${domain ? ` — ${domain}` : ' — all domains'} (the machine's own toolchains, probed just now; nothing bundled, nothing faked)`];
  if (domains.includes('mobile')) {
    lines.push('', 'mobile — iOS/Android build/test tooling:');
    lines.push(...probeLine(probeBins(TOOLCHAINS.mobile, probe), 'mobile'));
    lines.push(...projectShapes(root, 'mobile', platform).map((s) => `  · ${s}`));
  }
  if (domains.includes('wasm')) {
    lines.push('', 'wasm / edge — runtimes and build tooling:');
    lines.push(...probeLine(probeBins(TOOLCHAINS.wasm, probe), 'wasm'));
    const cap = wasi ?? wasiCapability();
    lines.push(`node WASI (zero-dep fallback for "run"): ${cap === 'yes' ? 'AVAILABLE on this node runtime' : cap === 'no' ? 'unavailable on this node runtime' : 'probe failed (reported honestly)'}`);
    lines.push(...projectShapes(root, 'wasm', platform).map((s) => `  · ${s}`));
  }
  if (domains.includes('ml')) {
    lines.push('', 'ml — python env + local inference:');
    lines.push(...probeLine(probeBins(TOOLCHAINS.ml, probe), 'ml'));
    lines.push(...projectShapes(root, 'ml', platform).map((s) => `  · ${s}`));
    lines.push('  · keyless inference can also ride Buddy\'s own brain gateways (/compare, /model) — no extra keys needed');
  }
  if (domains.includes('hardware')) {
    lines.push('', 'hardware/embedded — flashers, debuggers, serial:');
    lines.push(...probeLine(probeBins(TOOLCHAINS.hardware, probe), 'hardware'));
    lines.push(...projectShapes(root, 'hardware', platform).map((s) => `  · ${s}`));
  }
  return lines.join('\n').slice(0, MAX_STATUS_CHARS);
}

// ── contained file resolution (cloud-deploy rule: containment AND realpath) ─
export function containedFile(root, rel, { mustExist = true, exts = null } = {}) {
  const raw = String(rel ?? '').trim();
  if (!raw) return { error: 'file path is required' };
  if (raw.includes('\0')) return { error: 'file path contains a NUL byte' };
  const abs = path.resolve(root, raw);
  const rootReal = fs.realpathSync(root);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch (e) {
    if (mustExist || e.code !== 'ENOENT') return { error: `cannot resolve "${truncate(raw, 80)}" (${e.code || 'error'}) — nothing is guessed` };
    // not required to exist yet: verify every existing segment stays inside root
    let cur = abs;
    while (!fs.existsSync(cur)) cur = path.dirname(cur);
    real = fs.realpathSync(cur);
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { error: `"${truncate(raw, 80)}" resolves OUTSIDE the project root — containment refused` };
  }
  if (exts && !exts.some((e) => abs.toLowerCase().endsWith(e))) {
    return { error: `"${truncate(raw, 60)}" must be one of ${exts.join(' / ')} — got that extension? nothing is guessed` };
  }
  return { abs, real };
}

// ── mobile build (gated) ────────────────────────────────────────────────────
export function buildMobile(args = {}, { root = process.cwd(), probe = null, runner = null, platform = process.platform } = {}) {
  let flavor = String(args?.flavor || '').trim().toLowerCase();
  if (!flavor) {
    // flavor is RESOLVED from the project's shapes, never guessed: both or
    // neither shape present → honest refusal telling the caller to decide.
    const androidShape = !!FIRST(root, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew']);
    const iosShape = !!READEXT(root, '.xcodeproj').length || !!READEXT(root, '.xcworkspace').length || !!FIRST(root, ['Podfile']);
    if (androidShape && !iosShape) flavor = 'android';
    else if (iosShape && !androidShape) flavor = 'ios';
    else return 'ERROR: flavor is required — pass flavor:"android" or flavor:"ios" (this project does not clearly look like one or the other, and the tool does not guess)';
  }
  if (flavor !== 'android' && flavor !== 'ios') return `ERROR: flavor must be android or ios — got "${truncate(String(args.flavor), 24)}"`;
  const run = runner || ((cmd, cargs, opts = {}) => spawnSync(cmd, cargs, { cwd: root, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, ...opts }));
  if (flavor === 'ios') {
    if (platform !== 'darwin') return 'ERROR: xcodebuild only exists on macOS — this machine cannot build iOS; nothing fake is reported';
    const scheme = String(args?.scheme ?? '').trim();
    if (!SCHEME_RE.test(scheme)) return `ERROR: bad scheme "${truncate(String(args?.scheme ?? ''), 32)}" — schemes are [A-Za-z0-9 ._-] and cannot start with a dash`;
    const action = String(args?.action || 'build').trim().toLowerCase();
    if (!['build', 'test'].includes(action)) return `ERROR: ios action must be build or test — got "${truncate(String(args?.action ?? ''), 24)}"`;
    const dest = args?.destination == null ? null : String(args.destination).trim();
    if (dest && !DEST_RE.test(dest)) return `ERROR: bad destination "${truncate(dest, 40)}" — destinations look like "platform=iOS Simulator,name=iPhone 15" (validated charset)`;
    const argv = ['xcodebuild', '-scheme', scheme, action === 'test' ? 'test' : 'build'];
    if (dest) argv.push('-destination', dest);
    const r = run(argv[0], argv.slice(1));
    return xcodeResult(r, argv);
  }
  // android — the PROJECT'S OWN wrapper first; system gradle only as fallback
  const hasWrapper = !!FIRST(root, ['gradlew']);
  const task = String(args?.task || 'assembleDebug').trim();
  if (!TASK_RE.test(task)) return `ERROR: bad gradle task "${truncate(String(args?.task ?? ''), 32)}" — tasks are [A-Za-z0-9:._-] and cannot start with a dash (flag smuggling is not a task)`;
  const gradleProbe = probeBins([{ name: 'gradle' }], probe).gradle;
  if (!hasWrapper && gradleProbe == null) {
    return 'ERROR: no gradlew wrapper in this project and gradle is not on PATH — open the project\'s wrapper (`gradle wrapper`) or install gradle; nothing fake is reported';
  }
  const argv = hasWrapper ? [path.join(root, 'gradlew'), task] : ['gradle', task];
  const r = run(argv[0], argv.slice(1));
  const tail = (String((r?.stdout || '') + (r?.stderr || '')).trim().split('\n').slice(-6).join('\n') || '').slice(0, 1200);
  const head = hasWrapper ? `./gradlew ${task}` : `gradle ${task}`;
  if (r?.error) return `ERROR: could not run ${argv[0]} (${r.error.code}) — is it executable?`;
  return `${head} → exit ${r.status ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''}\n${truncate(tail, 1200) || '(no output)'}`;
}
function xcodeResult(r, argv) {
  if (r?.error) return `ERROR: could not run xcodebuild (${r.error.code})`;
  const tail = (String((r?.stdout || '') + (r?.stderr || '')).trim().split('\n').slice(-6).join('\n') || '').slice(0, 1200);
  return `xcodebuild ${argv.slice(1).join(' ')} → exit ${r.status ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''}\n${truncate(tail, 1200) || '(no output)'}`;
}

// ── wasm run (gated) ────────────────────────────────────────────────────────
const WASI_BOOTSTRAP = [
  // node consumes the "--" separator, but a defensive re-check keeps the path
  // right even if a runtime ever passes it through.
  'const rest0 = process.argv[1] === "--" ? process.argv.slice(2) : process.argv.slice(1);',
  'const [wasmPath, ...rest] = rest0;',
  'try {',
  '  const { WASI } = await import("node:wasi");',
  '  const wasi = new WASI({ version: "preview1", preopens: { "/": process.cwd() } });',
  '  const bytes = (await import("node:fs/promises")).readFile(wasmPath);',
  '  const { instance } = await WebAssembly.instantiate(await bytes, wasi.getImportObject());',
  '  const rc = wasi.start(instance);',
  '  if (typeof rc === "number" && Number.isInteger(rc) && rc !== 0) process.exit(rc);',
  '} catch (e) { console.error("wasi run failed:", e && e.message ? e.message : String(e)); process.exit(1); }',
].join('\n');

export function runWasm(args = {}, { root = process.cwd(), probe = null, runner = null, wasi = null } = {}) {
  const f = containedFile(root, args?.file, { exts: ['.wasm'] });
  if (f.error) return `ERROR: ${f.error}`;
  let extra = Array.isArray(args?.args) ? args.args : [];
  if (extra.length > MAX_WASM_ARGS) return `ERROR: at most ${MAX_WASM_ARGS} module args — got ${extra.length}`;
  extra = extra.map((a) => String(a ?? ''));
  for (const a of extra) if (!WASM_ARG_RE.test(a)) return `ERROR: module args must be printable ASCII ≤ 200 chars — got one that isn't (control chars and newlines are refused)`;
  const run = runner || ((cmd, cargs, opts = {}) => spawnSync(cmd, cargs, { cwd: root, encoding: 'utf8', timeout: WASM_RUN_TIMEOUT_MS, ...opts }));
  const bins = probeBins([{ name: 'wasmtime' }, { name: 'wasmer' }], probe);
  let argv = null, label = '';
  if (bins.wasmtime != null && bins.wasmtime !== 'PROBE_FAILED') { argv = ['wasmtime', f.real, ...extra]; label = 'wasmtime'; }
  else if (bins.wasmer != null && bins.wasmer !== 'PROBE_FAILED') { argv = ['wasmer', 'run', f.real, ...extra]; label = 'wasmer'; }
  else {
    const cap = wasi ?? wasiCapability();
    if (cap === 'yes') { argv = [process.execPath, '--input-type=module', '-e', WASI_BOOTSTRAP, '--', f.real, ...extra]; label = 'node WASI (zero-dep fallback)'; }
    else if (cap === 'no') return 'ERROR: no wasm runtime available — wasmtime/wasmer are not on PATH and this node runtime lacks node:wasi; install wasmtime (`curl https://wasmtime.dev/install.sh -sSf | bash`) and retry; nothing fake is reported';
    else return 'ERROR: the node WASI capability probe failed (reported honestly) and no wasmtime/wasmer is on PATH — install wasmtime and retry; nothing fake is reported';
  }
  const r = run(argv[0], argv.slice(1));
  if (r?.error) return `ERROR: could not run ${label} (${r.error.code})`;
  const out = String(r.stdout || '').slice(0, 4000);
  const err = String(r.stderr || '').split('\n').filter((l) => !l.includes('ExperimentalWarning') && !l.includes('trace-warnings')).join('\n').slice(0, 1500);
  return `${label} ran ${truncate(String(args?.file), 60)} → exit ${r.status ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''}\n${out || '(no stdout)'}${err ? `\n[stderr] ${err}` : ''}`;
}

// ── ml templates (gated write, fixed content per kind) ─────────────────────
export const ML_TEMPLATES = {
  'infer-onnx': {
    file: 'ml/infer_onnx.py',
    text: `# starter: onnxruntime inference (Buddy frontier template — a starting point, not magic)\n# install: pip3 install onnxruntime numpy\nimport sys, numpy as np\n\ndef main():\n    try:\n        import onnxruntime as ort\n    except ImportError:\n        sys.exit("onnxruntime is not installed in this python env — pip3 install onnxruntime (honest failure, nothing faked)")\n    model_path = sys.argv[1] if len(sys.argv) > 1 else "model.onnx"\n    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])\n    feeds = {}\n    for inp in sess.get_inputs():\n        shape = [d if isinstance(d, int) and d > 0 else 1 for d in inp.shape]\n        feeds[inp.name] = np.zeros(shape, dtype=np.float32)\n    out = sess.run(None, feeds)\n    for name, tensor in zip([o.name for o in sess.get_outputs()], out):\n        print(name, tensor.shape, tensor.dtype)\n\nif __name__ == "__main__":\n    main()\n`,
  },
  'infer-ollama': {
    file: 'ml/infer_ollama.py',
    text: `# starter: keyless LOCAL inference via ollama's HTTP API (Buddy frontier template)\n# ollama serves http://127.0.0.1:11434 with NO API key — the keyless story that\n# pairs with Buddy's own brain gateways. Standard library only.\nimport json, os, sys, urllib.request\n\ndef main():\n    host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")\n    model = sys.argv[1] if len(sys.argv) > 1 else "llama3.2"\n    prompt = sys.argv[2] if len(sys.argv) > 2 else "Say hello in one sentence."\n    req = urllib.request.Request(\n        host.rstrip("/") + "/api/generate",\n        data=json.dumps({"model": model, "prompt": prompt, "stream": False}).encode(),\n        headers={"Content-Type": "application/json"},\n    )\n    try:\n        with urllib.request.urlopen(req, timeout=120) as resp:\n            body = json.load(resp)\n    except Exception as e:\n        sys.exit(f"ollama call failed ({e}) — is ollama installed and 'ollama serve' running? nothing is faked")\n    print(body.get("response", ""))\n\nif __name__ == "__main__":\n    main()\n`,
  },
  'finetune-lora': {
    file: 'ml/finetune_lora.md',
    text: `# LoRA fine-tune starter (Buddy frontier template — a plan, not magic)\n\n## 0. Honest prerequisites\n- a GPU or a patient CPU; \`pip3 install torch transformers peft datasets\`\n- the base model name and a dataset with a FIXED shape (jsonl: {"text": ...} rows)\n\n## 1. Plan before you train\n- [ ] dataset rows counted, train/val split written to disk\n- [ ] base model + dtype decided (fp16 on GPU, fp32 CPU)\n- [ ] LoRA config: r=8..16, alpha=16..32, target_modules listed explicitly\n\n## 2. Minimal peft loop (fill the TODOs — never guess shapes)\n\`\`\`python\nfrom peft import LoraConfig, get_peft_model\nfrom transformers import AutoModelForCausalLM, AutoTokenizer\nbase = AutoModelForCausalLM.from_pretrained("TODO_BASE_MODEL")\nmodel = get_peft_model(base, LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05,\n                                        target_modules=["TODO"]))\nmodel.print_trainable_parameters()  # <= the honest number: usually <1%\n\`\`\`\n\n## 3. Verify before you ship\n- [ ] val loss DECREASED\n- [ ] adapter saved (peft save_pretrained) and a smoke inference ran\n- [ ] the base model license allows this use\n`,
  },
};

export function templateMl(args = {}, { root = process.cwd(), platform = process.platform } = {}) {
  const kind = String(args?.kind ?? '').trim().toLowerCase();
  if (!TEMPLATE_KINDS.has(kind)) {
    return `ERROR: kind must be one of ${[...TEMPLATE_KINDS].join(', ')} — got "${truncate(String(args?.kind ?? ''), 32)}"`;
  }
  const t = ML_TEMPLATES[kind];
  const f = containedFile(root, t.file, { mustExist: false });
  if (f.error) return `ERROR: ${f.error}`;
  if (fs.existsSync(f.abs) && !args?.overwrite) {
    return `ERROR: ${t.file} already exists — pass overwrite:true to replace it (the tool never clobbers silently)`;
  }
  fs.mkdirSync(path.dirname(f.abs), { recursive: true });
  fs.writeFileSync(f.abs, t.text, 'utf8');
  const py = probeBins([{ name: 'python3' }], null).python3;
  return `template written: ${t.file} (${t.text.length} bytes) — a STARTING POINT, not magic\npython3 on this machine: ${py == null ? 'not on PATH — install python3 to run it; nothing fake is reported' : py}`;
}

// ── hardware flash (gated; enumerated ports only; one shape per flasher) ────
export function flashHardware(args = {}, { root = process.cwd(), probe = null, runner = null, ports = null, platform = process.platform } = {}) {
  const tool = String(args?.tool ?? '').trim().toLowerCase();
  if (!FLASH_TOOLS.has(tool)) return `ERROR: tool must be one of ${[...FLASH_TOOLS].join(', ')} — got "${truncate(String(args?.tool ?? ''), 24)}"`;
  const catalog = { esptool: ['esptool.py', 'esptool'], avrdude: ['avrdude'], openocd: ['openocd'], picotool: ['picotool'] };
  const bins = probeBins(catalog[tool].map((name) => ({ name })), probe);
  const present = catalog[tool].find((name) => bins[name] != null && bins[name] !== 'PROBE_FAILED');
  if (!present) return `ERROR: ${tool} is not on PATH — install it and retry; nothing fake is reported`;
  const portsNow = ports ?? serialPorts(platform);
  const port = String(args?.port ?? '').trim();
  if (!portsNow.includes(port)) {
    return `ERROR: port "${truncate(port, 40)}" is not one of the enumerated serial ports (${portsNow.length ? portsNow.join(', ') : 'none detected'}) — flash only goes to a device the machine can SEE; nothing is invented`;
  }
  const f = containedFile(root, args?.file, { exts: ['.bin', '.hex', '.elf', '.img', '.uf2'] });
  if (f.error) return `ERROR: ${f.error}`;
  const run = runner || ((cmd, cargs, opts = {}) => spawnSync(cmd, cargs, { cwd: root, encoding: 'utf8', timeout: 600000, ...opts }));
  let argv, label;
  if (tool === 'esptool') {
    const rawBaud = args?.baud;
    const baud = rawBaud == null ? 115200 : Number(rawBaud);
    const canonical = rawBaud == null || ((typeof rawBaud === 'number' ? Number.isFinite(rawBaud) : /^\d+$/.test(String(rawBaud))) && BAUDS.has(baud));
    if (!canonical) return `ERROR: bad baud ${truncate(String(rawBaud ?? ''), 16)} — allowed: ${[...BAUDS].join(', ')} (a bare number, nothing that coerces sneaky)`;
    const offset = String(args?.offset ?? '0x0').trim();
    if (!OFFSET_RE.test(offset)) return `ERROR: bad offset "${truncate(String(args?.offset ?? ''), 16)}" — offsets look like 0x0 / 0x10000`;
    argv = [present, '--port', port, '--baud', String(baud), 'write_flash', offset, f.real];
    label = 'esptool write_flash';
  } else if (tool === 'avrdude') {
    const prog = String(args?.programmer ?? 'arduino').trim();
    const part = String(args?.part ?? 'atmega328p').trim();
    if (!PROG_RE.test(prog) || !PROG_RE.test(part)) return `ERROR: programmer/part must be [A-Za-z0-9_-] (they are avrdude config ids, not free text)`;
    argv = [present, '-c', prog, '-p', part, '-P', port, '-U', `flash:w:${f.real}:i`];
    label = 'avrdude -U flash';
  } else if (tool === 'openocd') {
    const cfg = containedFile(root, args?.cfg, { exts: ['.cfg'] });
    if (cfg.error) return `ERROR: cfg ${cfg.error}`;
    argv = [present, '-f', cfg.real, '-c', `program ${f.real} verify reset exit`];
    label = 'openocd program';
  } else {
    argv = [present, 'load', f.real];
    if (args?.execute) argv.push('-x');
    if (args?.force) argv.push('-f');
    label = 'picotool load';
  }
  const r = run(argv[0], argv.slice(1));
  if (r?.error) return `ERROR: could not run ${present} (${r.error.code})`;
  const tail = (String((r?.stdout || '') + (r?.stderr || '')).trim().split('\n').slice(-6).join('\n') || '').slice(0, 1200);
  return `${label} → exit ${r.status ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''} on ${port}\n${truncate(tail, 1200) || '(no output)'}`;
}

// ── hardware serial monitor (gated; bounded capture; zero-dep POSIX) ───────
export function monitorHardware(args = {}, { root = process.cwd(), probe = null, ports = null, platform = process.platform, sleeper = null, sttyRunner = null } = {}) {
  if (platform === 'win32') return 'ERROR: serial monitor needs POSIX (macOS/Linux) — on Windows use the flasher\'s own console; nothing fake is reported';
  const stty = probeBins([{ name: 'stty' }], probe).stty;
  if (stty == null) return 'ERROR: stty is not on PATH (it ships with coreutils) — the monitor configures the port with it; nothing fake is reported';
  const portsNow = ports ?? serialPorts(platform);
  const port = String(args?.port ?? '').trim();
  if (!portsNow.includes(port)) {
    return `ERROR: port "${truncate(port, 40)}" is not one of the enumerated serial ports (${portsNow.length ? portsNow.join(', ') : 'none detected'}) — the monitor only opens a device the machine can SEE`;
  }
  const rawBaud = args?.baud;
  const baud = rawBaud == null ? 115200 : Number(rawBaud);
  const canonical = rawBaud == null || ((typeof rawBaud === 'number' ? Number.isFinite(rawBaud) : /^\d+$/.test(String(rawBaud))) && BAUDS.has(baud));
  if (!canonical) return `ERROR: bad baud ${truncate(String(rawBaud ?? ''), 16)} — allowed: ${[...BAUDS].join(', ')} (a bare number, nothing that coerces sneaky)`;
  let seconds = args?.seconds == null ? 3 : Number(args.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MONITOR_MAX_SECONDS) {
    return `ERROR: seconds must be 1–${MONITOR_MAX_SECONDS} (the capture is bounded by design) — got "${truncate(String(args?.seconds ?? ''), 16)}"`;
  }
  const flag = platform === 'darwin' ? '-f' : '-F';
  const st = (sttyRunner || ((c, a) => spawnSync(c, a, { encoding: 'utf8', timeout: 8000 })))('stty', [flag, port, String(baud), 'raw', '-echo']);
  if (st.error) return `ERROR: could not run stty (${st.error.code})`;
  if (st.status !== 0) return `ERROR: stty refused the port (${truncate(String(st.stderr || '').trim(), 160)}) — check the device exists and you have permissions (dialout/uucp group on Linux)`;
  let fd;
  try { fd = fs.openSync(port, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch (e) {
    return `ERROR: cannot open ${port} (${e.code}) — check permissions (dialout/uucp group on Linux); nothing is faked`;
  }
  const sleep = sleeper || ((ms) => spawnSync('sleep', [String(ms / 1000)]));
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + seconds * 1000;
  try {
    while (total < MONITOR_MAX_BYTES && Date.now() < deadline) {
      const buf = Buffer.alloc(1024);
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, Math.min(buf.length, MONITOR_MAX_BYTES - total), null); } catch { n = 0; }
      if (n > 0) { chunks.push(buf.subarray(0, n)); total += n; }
      else sleep(100);
    }
  } finally { try { fs.closeSync(fd); } catch { /* already gone */ } }
  const text = Buffer.concat(chunks).toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, '.').slice(0, MONITOR_MAX_BYTES);
  return `captured ${total} bytes from ${port} @ ${baud} baud over ${seconds}s (bounded capture; port closed):\n${text || '(silence — nothing arrived)'}`;
}

// ── dispatch ────────────────────────────────────────────────────────────────
export async function runFrontier(args = {}, opts = {}) {
  if (args != null && typeof args !== 'object') {
    return `ERROR: args must be an object like {"action":"status","domain":"mobile"} — got ${typeof args}`;
  }
  const action = String(args?.action || 'status').trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    return `ERROR: unknown action "${truncate(String(args?.action || ''), 24)}" — known: ${[...ACTIONS].join(', ')}`;
  }
  const domain = String(args?.domain || '').trim().toLowerCase();
  const byAction = { status: null, build: 'mobile', run: 'wasm', template: 'ml', flash: 'hardware', monitor: 'hardware' };
  const need = byAction[action];
  if (need && domain !== need) {
    return `ERROR: action "${action}" belongs to domain "${need}" — pass domain:"${need}" (got "${truncate(domain || '(none)', 24)}")`;
  }
  switch (action) {
    case 'status': return statusFrontier(args, opts);
    case 'build': return buildMobile(args, opts);
    case 'run': return runWasm(args, opts);
    case 'template': return templateMl(args, opts);
    case 'flash': return flashHardware(args, opts);
    case 'monitor': return monitorHardware(args, opts);
    default: return `ERROR: unreachable action "${action}"`;
  }
}

export function createFrontierTool({ root } = {}) {
  return {
    name: 'frontier',
    description:
      'Frontier toolchains through the MACHINE\'S OWN tools (probed on PATH at call time, never bundled; absent = honest refusal "nothing fake is reported"). Four domains: mobile (xcodebuild/gradle/adb detection; build via the project\'s OWN gradlew or xcodebuild -scheme — gated), wasm/edge (wasmtime/wasmer/workerd/wasm-pack/emcc detection; run .wasm via wasmtime/wasmer or node\'s own WASI as the zero-dep fallback — gated), ml (python3/pip/uv/ollama detection; write ONE inference/fine-tune starter template into the project — gated write, fixed honest content), hardware/embedded (esptool/avrdude/openocd/picotool/serial detection; flash via ONE whitelisted shape per flasher — gated, port must be ENUMERATED; bounded serial monitor via stty + raw fd read — gated). action:"status" is gate-free; every action is gated like every mutation. Nothing fake is ever reported.',
    args: '{"action":"status","domain":"mobile"} · {"action":"status"} (all four) · {"action":"build","domain":"mobile","task":"testDebug"} · {"action":"run","domain":"wasm","file":"module.wasm","args":["hi"]} · {"action":"template","domain":"ml","kind":"infer-ollama"} · {"action":"flash","domain":"hardware","tool":"esptool","port":"/dev/ttyUSB0","file":"fw.bin"} · {"action":"monitor","domain":"hardware","port":"/dev/ttyUSB0","seconds":3}',
    riskyWhen: (a) => !READ_ACTIONS.has(String(a?.action || 'status').trim().toLowerCase()),
    render: (a) => `frontier ${clean(a?.action || 'status', 16)}${a?.domain ? ` ${clean(a.domain, 12)}` : ''}${a?.tool ? ` ${clean(a.tool, 16)}` : ''}${a?.file ? ` ${clean(a.file, 28)}` : ''}${a?.port ? ` → ${clean(a.port, 24)}` : ''}${a?.kind ? ` → ${clean(a.kind, 16)}` : ''}`,
    run: async (args) => runFrontier(args, { root }),
  };
}
