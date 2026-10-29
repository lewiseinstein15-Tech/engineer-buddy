#!/usr/bin/env node
// v0.53 drill — "telemetry export" (§11). Readable 80-col frames into
// download/aurora-evidence/v53-readable/. Every leg drives the REAL CLI (real
// stores, real spawns, a REAL loopback collector on a real port) or the REAL
// module functions — declared on camera when a frame calls the module
// directly (the v0.45/v0.49/v0.52 precedent). No brain is needed anywhere:
// metrics are deterministic local machinery plus one local HTTP POST, which
// is exactly why the whole plane can be drilled honestly offline.
//
// Port discipline (learned the hard way THIS drill): the collector's bind is
// verified on camera (the "listening" line must appear before any export);
// a stale imposter on the port is a FAIL, not a mystery 401.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v53-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v53-drill-'));
const buddy = (args, opts = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: opts.cwd || root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) },
  });

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};

// ── seed a REAL events store: every row written through the REAL modules ────
// (declared: the drill calls appendEvent + projectEvent exactly as the live
// REPL does — no hand-written JSON anywhere)
const { appendEvent, projectEvent } = await import(path.join(REPO, 'src', 'eventslog.js'));
const turn = (over = {}) => projectEvent({ type: 'turn_end', steps: 3, durationMs: 8200, calls: 2, tokIn: 1234, tokOut: 567, said: true, error: false, ...over });
appendEvent(root, projectEvent({ type: 'tool', tool: 'fs_read', denied: false, observation: 'x'.repeat(50) }));
appendEvent(root, projectEvent({ type: 'tool', tool: 'fs_read', denied: false, observation: 'y'.repeat(30) }));
appendEvent(root, projectEvent({ type: 'tool', tool: 'fs_write', denied: true, observation: 'no' }));
appendEvent(root, projectEvent({ type: 'compaction', kept: 5, dropped: 3, auto: true }));
appendEvent(root, turn({ durationMs: 8200 }));
appendEvent(root, turn({ durationMs: 640, calls: 1, tokIn: 210, tokOut: 40 }));
// window totals: turns 2 · calls 3 · tokIn 1444 · tokOut 607 · durations 8200(→b2) + 640(→b0)

const frames = [];
function cap(title, sections) {
  const bar = '-'.repeat(78);
  let t = `${bar}\n${title}\n${bar}\n`;
  for (const s of sections) {
    t += `\n$ buddy ${s.cmd}\n`;
    const r = s.run;
    if (r?.stdout?.trim()) t += r.stdout.trimEnd() + '\n';
    if (r?.stderr?.trim()) t += r.stderr.trimEnd() + '\n';
    if (s.text) t += s.text.trimEnd() + '\n';
    if (s.note) t += `--> ${s.note}\n`;
  }
  return t;
}

// ── frame-01: the view over the real store ──────────────────────────────────
const f1 = buddy(['telemetry']);
ok(f1.status === 0, `frame-01: view exits 0 (got ${f1.status})`);
ok(/turns: 2/.test(f1.stderr), 'frame-01: both turns counted');
ok(/brain calls: 3/.test(f1.stderr), 'frame-01: brain calls aggregated');
ok(/~1_444 in · ~607 out/.test(f1.stderr), 'frame-01: tokens aggregated');
ok(/fs_write\s+ok 0 · denied 1/.test(f1.stderr), 'frame-01: the denial is attributed per tool');
ok(/buckets \[1000, 5000, 15000, 60000, 300000\]ms → \[1, 0, 1, 0, 0, 0\]/.test(f1.stderr), 'frame-01: the duration histogram is on camera');
frames.push(['frame-01-the-view.txt', cap('frame-01 — THE ALL-TIME VIEW (real CLI, real events store)', [
  { cmd: 'telemetry', run: f1, note: 'the source is the SAME .buddy/events.jsonl the live loop writes since v0.25.0 — aggregated, never re-asked' },
])]);

// ── frame-02: the opt-in contract on camera ─────────────────────────────────
ok(!fs.existsSync(path.join(root, '.buddy', 'telemetry')), 'frame-02: zero telemetry bytes exist with the default config');
ok(/enabled    : false/.test(f1.stderr), 'frame-02: the view says auto-flush is OFF (default)');
frames.push(['frame-02-opt-in.txt', cap('frame-02 — THE OPT-IN CONTRACT (the default creates NOTHING)', [
  { cmd: 'telemetry   (fresh project, default settings)', run: f1, note: 'enabled: false — no .buddy/telemetry/ dir exists, no timer ticks, no byte leaves; explicit `telemetry export` is the operator\'s own finger on the trigger' },
])]);

// ── frame-03: dry-run — the plan without the side effects ────────────────────
const f3 = buddy(['telemetry', 'export', '--dry-run']);
ok(f3.status === 0, `frame-03: dry-run exits 0 (got ${f3.status})`);
ok(/dry run — nothing was written/.test(f3.stderr), 'frame-03: the dry-run says what it is');
ok(/would count  : turns 2 · calls 3 · ~1444 tok in · ~607 out/.test(f3.stderr), 'frame-03: the exact plan');
ok(!fs.existsSync(path.join(root, '.buddy', 'telemetry')), 'frame-03: NOT EVEN THE DIRECTORY exists after a dry-run');
frames.push(['frame-03-dry-run.txt', cap('frame-03 — DRY-RUN: THE PLAN, ZERO SIDE EFFECTS (real CLI)', [
  { cmd: 'telemetry export --dry-run', run: f3, note: 'no sink line, no cursor move, no POST — not even the directory is created' },
])]);

// ── frame-04: the real export — sink + cursor ────────────────────────────────
const f4 = buddy(['telemetry', 'export']);
ok(f4.status === 0, `frame-04: export exits 0 (got ${f4.status})`);
ok(/exported one DELTA window/.test(f4.stderr), 'frame-04: the window landed');
ok(/cursor: 0 → \d+/.test(f4.stderr), 'frame-04: the cursor advanced');
const sinkPath = path.join(root, '.buddy', 'telemetry', 'metrics.jsonl');
ok(fs.existsSync(sinkPath), 'frame-04: the JSONL sink exists');
const sinkRec = JSON.parse(fs.readFileSync(sinkPath, 'utf8').trimEnd().split('\n').pop());
ok(sinkRec.turns === 2 && sinkRec.tokIn === 1444 && sinkRec.tokOut === 607, 'frame-04: the sink record holds the exact window');
ok(sinkRec.byTool['fs_read']?.ok === 2 && sinkRec.byTool['fs_write']?.denied === 1, 'frame-04: per-tool attribution in the record');
frames.push(['frame-04-the-export.txt', cap('frame-04 — THE REAL EXPORT: ONE DELTA WINDOW (real CLI)', [
  { cmd: 'telemetry export', run: f4, note: 'one aggregated DELTA record lands in .buddy/telemetry/metrics.jsonl; the cursor advances only past complete lines' },
])]);

// ── frame-05: the honest empty — no double-counting ──────────────────────────
const f5 = buddy(['telemetry', 'export']);
ok(f5.status === 0, `frame-05: re-export exits 0 (got ${f5.status})`);
ok(/no new complete events since the cursor/.test(f5.stderr), 'frame-05: the honest empty');
ok(fs.readFileSync(sinkPath, 'utf8').trimEnd().split('\n').length === 1, 'frame-05: the sink still holds exactly ONE record');
frames.push(['frame-05-honest-empty.txt', cap('frame-05 — NO DOUBLE-COUNTING: THE CURSOR DISCIPLINE (real CLI)', [
  { cmd: 'telemetry export   (again, nothing new happened)', run: f5, note: 'the cursor advanced only over returned complete lines — a second export is an honest empty, never a re-send' },
])]);

// ── frame-06: the REAL wire — a real collector, a real POST, a real 200 ──────
const COLLECTOR_PORT = 4393;
const TOKEN_ENV = 'OTLP_TOKEN';
const DRILL_TOKEN = 'drill-collector-token-7f2a91';
const colLog = path.join(root, 'collector.log');
const col = spawn('node', [path.join(REPO, 'examples', 'otel-collector.js'), '--port', String(COLLECTOR_PORT), '--token-env', TOKEN_ENV], {
  cwd: root, env: { ...process.env, [TOKEN_ENV]: DRILL_TOKEN }, stdio: ['ignore', fs.openSync(colLog, 'a'), fs.openSync(colLog, 'a')],
});
// THE BIND HANDSHAKE: the collector must prove it is listening before any
// export — a stale imposter on the port (this drill's own bug, caught and
// fixed) would answer 401 and the frame would lie by omission.
let bound = false;
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 100));
  if (/listening on/.test(fs.readFileSync(colLog, 'utf8'))) { bound = true; break; }
}
ok(bound, 'frame-06: the collector is verifiably LISTENING (bind handshake on camera)');
try {
  fs.appendFileSync(path.join(root, '.buddy', 'events.jsonl'), JSON.stringify(turn({ durationMs: 1500, calls: 1, tokIn: 99, tokOut: 11 })) + '\n');
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { enabled: true, endpoint: `http://127.0.0.1:${COLLECTOR_PORT}/v1/metrics`, headersEnv: TOKEN_ENV } },
  }));
  const f6 = buddy(['telemetry', 'export'], { env: { [TOKEN_ENV]: DRILL_TOKEN } });
  ok(f6.status === 0, `frame-06: export with the wire exits 0 (got ${f6.status})`);
  ok(/otlp  : sent — collector answered 200/.test(f6.stderr), `frame-06: the collector answered 200 on camera (got: ${(/otlp[^\n]*/.exec(f6.stderr)?.[0] || 'no otlp line').trim()})`);
  await new Promise((res) => setTimeout(res, 400));
  const colOut = fs.readFileSync(colLog, 'utf8');
  ok(/otel-collector ⟳/.test(colOut), 'frame-06: the collector logged the window');
  ok(/buddy\.turns=1/.test(colOut) && /buddy\.tokens=110/.test(colOut), 'frame-06: the received DELTA matches the local window exactly (1 turn, 99+11 tokens)');
  const f6b = buddy(['telemetry'], { env: { [TOKEN_ENV]: DRILL_TOKEN } });
  ok(/last OTLP    : sent \(collector answered 200\)/.test(f6b.stderr), 'frame-06: the status gauge keeps the last attempt');
  ok(!f6.stderr.includes(DRILL_TOKEN) && !f6b.stderr.includes(DRILL_TOKEN) && !colOut.includes(DRILL_TOKEN), 'frame-06: the token VALUE appears in ZERO captured bytes');
  frames.push(['frame-06-the-wire.txt', cap('frame-06 — THE REAL WIRE: BUDDY → OTLP/HTTP-JSON → THE ZERO-DEP COLLECTOR (real port, real POST)', [
    { cmd: `node examples/otel-collector.js --port ${COLLECTOR_PORT} --token-env ${TOKEN_ENV}   (loopback only)`, text: colOut.trimEnd(), note: 'the BIND HANDSHAKE ran first — a stale imposter on the port would be caught, not mistaken for a 401; then a REAL OTLP/HTTP-JSON POST (no SDK, no protobuf): the received DELTA matches the local window exactly (1 turn, 110 tokens) and the token canary appears in ZERO captured bytes' },
    { cmd: `telemetry export   (with $${TOKEN_ENV} set)`, run: f6, note: 'the token lives in the ENVIRONMENT, referenced by NAME — a missing env is an honest skip, a wrong one is the collector\'s 401' },
  ])]);

  // ── frame-07: the refusal wall + the hostile log ──────────────────────────
  // (each refusal leg runs --dry-run on a FRESH settings shape — a refused
  // knob exits 2 and NOTHING moves; the hostile log gets its own root so the
  // legs cannot leak cursor state into each other)
  const refusalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v53-refusals-'));
  fs.mkdirSync(path.join(refusalRoot, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(refusalRoot, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'file:///etc/passwd' } },
  }));
  const f7 = buddy(['telemetry', 'export', '--dry-run'], { cwd: refusalRoot });
  ok(f7.status === 2, `frame-07: a file:// endpoint is REFUSED by the CLI (exit ${f7.status})`);
  ok(/refused/.test(f7.stderr), 'frame-07: the refusal names the reason');
  fs.writeFileSync(path.join(refusalRoot, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'http://user:pass@127.0.0.1/v1/metrics' } },
  }));
  const f7b = buddy(['telemetry', 'export', '--dry-run'], { cwd: refusalRoot });
  ok(f7b.status === 2 && /refused/.test(f7b.stderr), 'frame-07: embedded credentials are refused (the v0.48 rule)');
  ok(!fs.existsSync(path.join(refusalRoot, '.buddy', 'telemetry')), 'frame-07: a refused export leaves ZERO side effects');

  const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v53-hostile-'));
  fs.mkdirSync(path.join(hostileRoot, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(hostileRoot, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: `http://127.0.0.1:${COLLECTOR_PORT}/v1/metrics`, headersEnv: 'MISSING_ENV_VAR' } },
  }));
  appendEvent(hostileRoot, projectEvent({ type: 'tool', tool: '\u001b[31mevil\u0007', denied: false, observation: 'x' }));
  appendEvent(hostileRoot, projectEvent({ type: 'tool', tool: '__proto__', denied: false, observation: 'y' }));
  appendEvent(hostileRoot, projectEvent({ type: 'turn_end', steps: 1, durationMs: 100, calls: 2, tokIn: 10, tokOut: 2, said: true, error: false }));
  fs.appendFileSync(path.join(hostileRoot, '.buddy', 'events.jsonl'), '{torn corpse line\n');
  const f7c = buddy(['telemetry', 'export'], { cwd: hostileRoot });
  ok(f7c.status === 0, 'frame-07: a missing env var degrades honestly (exit 0, sink landed)');
  ok(/env MISSING_ENV_VAR is unset/.test(f7c.stderr), 'frame-07: the skip names the env var, never a value');
  ok(/torn  : 1 corpse line/.test(f7c.stderr), 'frame-07: the corpse line is counted out loud');
  const hostileSink = fs.readFileSync(path.join(hostileRoot, '.buddy', 'telemetry', 'metrics.jsonl'), 'utf8');
  ok(/"evil"/.test(hostileSink) && !/\\u001b/.test(hostileSink), 'frame-07: the ANSI tool name was sanitized to "evil"');
  ok(hostileSink.includes('__proto__'), 'frame-07: the __proto__ name is DATA in the sink, not pollution');
  ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(hostileSink.replace(/\n/g, '')), 'frame-07: no control bytes rode out');
  frames.push(['frame-07-refusals.txt', cap('frame-07 — THE REFUSAL WALL + THE HOSTILE LOG (real CLI, real hostile store)', [
    { cmd: 'telemetry export --dry-run   (endpoint: file:///etc/passwd)', run: f7, note: 'non-http(s) schemes are refused — a telemetry endpoint is a wire, not a file read; BROKEN CONFIG IS A REFUSAL (exit 2), never a silent JSONL-only fallback' },
    { cmd: 'telemetry export --dry-run   (endpoint embeds user:pass@)', run: f7b, note: 'the v0.48 secret-hygiene rule: credentials live in the ENV referenced by NAME; a refused export leaves zero side effects' },
    { cmd: 'telemetry export   (env MISSING_ENV_VAR unset + a hostile events log)', run: f7c, note: 'honest degradation: the sink lands, the wire skips with the reason, the corpse line is counted, hostile names are sanitized, __proto__ stays data' },
  ])]);
} finally {
  col.kill('SIGTERM');
}

// ── write frames + ground truth ──────────────────────────────────────────────
for (const [name, body] of frames) fs.writeFileSync(path.join(OUT, name), body.endsWith('\n') ? body : body + '\n');
const gt = {
  at: new Date().toISOString(),
  version: '0.53.0',
  repo: REPO,
  drillRoot: root,
  wave: 'telemetry export — opt-in OTel/JSONL metrics of turns, tokens, tool counts (§11)',
  assertions: { passed, total: asserted, drill: problems.length === 0 ? 'PASS' : 'FAIL' },
  frames: fs.readdirSync(OUT).filter((f) => f.startsWith('frame-')).sort(),
  sha256: {},
};
for (const f of gt.frames) gt.sha256[f] = createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex');
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(gt, null, 2) + '\n');
console.log(`drill done: ${gt.frames.join(', ')}`);
console.log(`assertions: ${passed}/${asserted} — DRILL: ${gt.assertions.drill}`);
if (problems.length) {
  console.log('problems:');
  for (const p of problems) console.log(`  ! ${p}`);
  process.exit(1);
}
console.log('drill temp root:', root);
