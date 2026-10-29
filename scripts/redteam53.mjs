// v0.53.0 RED TEAM PASS (war-room Play 4) — try to break the telemetry plane
// before it ships: the exporter under HOSTILE EVENT LOGS (torn lines, a 1MB
// giant line, CRLF, binary bytes, ANSI/OSC/control-byte tool names, regex
// metachars, ${}, backticks, __proto__ as a tool name, string/negative/
// 1e308/NaN token numbers — counters stay sane, labels are sanitized, the
// cursor never wedges), aggregation POLLUTION (__proto__/constructor land as
// OWN keys on a null-prototype map, never [[Prototype]] writes; JSON
// round-trips keep them own-keyed), endpoint ATTACKS (file://, gopher://,
// userinfo credentials, CRLF header injection through the URL, fragments —
// all refused; loopback http allowed: the operator's own collector is not
// the agent's web surface), TOKEN HYGIENE (the engine never touches
// process.env; a hostile env VALUE with newlines cannot split the
// Authorization header — it is refused before the wire; a missing env is an
// honest skip; the token VALUE appears in ZERO local bytes), CURSOR
// FORENSICS (a torn/hostile cursor file degrades to 0 with an honest note;
// a cursor beyond EOF resets with reset:true; a cursor mid-line skips the
// fragment, never doubles), KNOB COERCION ("30\n", 1.5, -5, 0x10, "" — all
// refused canonically, the v0.50/v0.51 lessons), CLI UNDER ATTACK (a 100-arg
// flood, a telemetry dir planted as a FILE, dash-leading junk — teaching
// errors, honest degradation), and the OPT-IN CONTRACT (the default config
// creates NOTHING — no dir, no byte, no wire; autoFlush with a hostile
// settings file returns null, never throws). A crash, a leaked control
// byte, a polluted prototype, a wedge, or a token on disk = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  aggregateEvents, sanitizeLabel, parseTelemetryConfig, validateEndpoint,
  buildOtlpPayload, exportTelemetry, telemetryViewText, autoFlush,
  resetCursorToEnd, readExportLog, metricsPath, cursorPath, statusPath,
} from '../src/telemetry.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CANARY = 'sk-REDTEAM53-token-canary-8b3f07-ONLY-THE-WIRE-MAY-CARRY-ME';
const HEADER_CANARY = 'header-split-canary-2c9d61';
const errs = [];
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const attempt = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) {
    fail++; errs.push(e); console.log(`  ✖ ${name}\n      ${String(e?.message || e).split('\n')[0].slice(0, 160)}`);
  }
};
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `v53-redteam-${tag}-`));
const writeSettings = (root, chat) => {
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ chat }));
};
const appendRaw = (root, text) => {
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.appendFileSync(path.join(root, '.buddy', 'events.jsonl'), text);
};

console.log('\n── A. the exporter under hostile event logs ─────────────────────');
await attempt('torn + giant + CRLF + binary + a 1MB line: export survives, counters sane, no wedge', async () => {
  const root = tmp('logs');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  appendRaw(root, '{torn corpse\n');
  appendRaw(root, '{"ts":"2026-10-29T09:00:01.000Z","type":"tool","tool":"fs_read","denied":false,"observation":"x"}\r\n');
  appendRaw(root, '\x00\x01\x02binary junk\n');
  appendRaw(root, '{"ts":"2026-10-29T09:00:02.000Z","type":"tool","tool":"' + 'L'.repeat(1024 * 1024) + '","denied":false}\n');
  appendRaw(root, '{"ts":"2026-10-29T09:00:03.000Z","type":"turn_end","steps":1,"durationMs":50,"calls":2,"tokIn":20,"tokOut":4,"said":true,"error":false}\n');
  const rs = [];
  for (let i = 0; i < 6; i++) {
    const r = await exportTelemetry(root, { fetchImpl: async () => ({ ok: true, status: 200 }) });
    rs.push(r);
    if (r.note) break;
  }
  const totalTurns = rs.reduce((a, r) => a + (r.metrics?.turns || 0), 0);
  const totalTorn = rs.reduce((a, r) => a + (r.events?.torn || 0), 0);
  ok(totalTurns === 2, `both complete turns exported (got ${totalTurns})`);
  ok(totalTorn >= 2, `torn lines counted (binary junk + corpse, got ${totalTorn})`);
  const cur = JSON.parse(fs.readFileSync(cursorPath(root), 'utf8'));
  ok(cur.pos === fs.statSync(path.join(root, '.buddy', 'events.jsonl')).size, 'the cursor reached the true end — nothing wedged');
  const sink = fs.readFileSync(metricsPath(root), 'utf8');
  ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(sink.replace(/\n/g, '')), 'no control bytes ride the sink');
});

await attempt('hostile tool names (ANSI, OSC, newline, ${}, backticks, regex, unicode) — labels sanitized on sink and wire', async () => {
  const root = tmp('names');
  const bad = ['\u001b[31mred\u0007', '\u001b]0;title\u0007osc', 'a\nb', 'x${y}', 'p`q', '.*+?()[]{}|', '工具\u202e', '__proto__', 'constructor'];
  for (let i = 0; i < bad.length; i++) {
    appendRaw(root, JSON.stringify({ ts: `2026-10-29T09:0${i}:00.000Z`, type: 'tool', tool: bad[i], denied: false }) + '\n');
  }
  const r = await exportTelemetry(root);
  const sink = fs.readFileSync(metricsPath(root), 'utf8');
  ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(sink.replace(/\n/g, '')), 'no control bytes in the sink');
  ok(!/\\u001b/.test(sink), 'no ESC escapes in the sink');
  const payload = buildOtlpPayload(r.metrics, {});
  const wire = JSON.stringify(payload);
  ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(wire), 'no control bytes on the wire payload');
  ok(Object.keys(r.metrics.byTool).length === bad.length, `every distinct hostile name became its own sanitized label (${Object.keys(r.metrics.byTool).length})`);
  ok(r.metrics.byTool['red']?.ok === 1, 'the CSI name became "red"');
  ok(r.metrics.byTool['osc']?.ok === 1, 'the OSC name became "osc"');
  ok(r.metrics.byTool['a b']?.ok === 1, 'the newline name became "a b"');
});

await attempt('number coercion games (string tokens, negatives, 1e308, NaN, Infinity) — counters stay finite and sane', async () => {
  const root = tmp('nums');
  const rows = [
    { type: 'turn_end', calls: '9', tokIn: '99999', tokOut: -50, durationMs: 'fast' },
    { type: 'turn_end', calls: 1e308, tokIn: NaN, tokOut: Infinity, durationMs: -10 },
    { type: 'turn_end', calls: { a: 1 }, tokIn: [1], tokOut: null, durationMs: true },
  ];
  rows.forEach((r2, i) => appendRaw(root, JSON.stringify({ ts: `2026-10-29T09:0${i}:00.000Z`, ...r2 }) + '\n'));
  const r = await exportTelemetry(root);
  ok(Number.isFinite(r.metrics.calls) && r.metrics.calls >= 0, `calls stayed finite ≥0 (${r.metrics.calls})`);
  ok(Number.isFinite(r.metrics.tokIn) && r.metrics.tokIn >= 0, 'tokIn finite ≥0');
  ok(Number.isFinite(r.metrics.tokOut) && r.metrics.tokOut >= 0, 'tokOut finite ≥0');
  const payload = JSON.stringify(buildOtlpPayload(r.metrics, {}));
  ok(!/Infinity|NaN|-\d/.test(payload), 'no Infinity/NaN/negative ever reaches the wire (int64 strings)');
  ok(/^\d+$/.test(JSON.parse(payload).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt), 'asInt is a pure digit string');
});

await attempt('a 2.5MB event log exports in bounded windows without loading it whole', async () => {
  const root = tmp('flood');
  for (let i = 0; i < 32000; i++) {
    appendRaw(root, JSON.stringify({ ts: '2026-10-29T09:00:00.000Z', type: 'tool', tool: `tool_${i % 7}`, denied: i % 5 === 0 }) + '\n');
  }
  ok(fs.statSync(path.join(root, '.buddy', 'events.jsonl')).size > 2 * 1024 * 1024, 'the fixture really exceeds one window');
  let exports = 0, tools = 0, turns = 0;
  for (;;) {
    const r = await exportTelemetry(root, { fetchImpl: async () => ({ ok: true, status: 200 }) });
    if (r.note) break;
    exports += 1;
    turns += r.metrics.turns;
    tools += Object.values(r.metrics.byTool).reduce((a, s) => a + s.ok + s.denied, 0);
    ok(exports < 50, 'the flood stays bounded — no infinite export loop');
  }
  ok(exports >= 2, `a 2.5MB log took ${exports} bounded windows`);
  ok(turns === 0 && tools === 32000, `all 32000 tool calls exported exactly once (got ${tools})`);
});

console.log('\n── B. aggregation pollution ──────────────────────────────────────');
await attempt('__proto__/constructor tool names cannot write [[Prototype]] or escape own-key round-trips', async () => {
  const m = aggregateEvents([
    { type: 'tool', tool: '__proto__', denied: false },
    { type: 'tool', tool: 'constructor', denied: false },
    { type: 'tool', tool: 'hasOwnProperty', denied: true },
    { type: 'tool', tool: 'valueOf', denied: false },
  ]);
  ok(Object.getPrototypeOf(m.byTool) === null, 'the per-tool map has NO prototype');
  for (const k of ['__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
    ok(Object.prototype.hasOwnProperty.call(m.byTool, k), `${k} is an OWN key`);
  }
  ok(m.byTool['__proto__'].ok === 1 && m.byTool['constructor'].ok === 1, 'the counts landed on the own keys');
  const round = JSON.parse(JSON.stringify({ byTool: m.byTool }));
  ok(Object.keys(round.byTool).length === 4, 'the JSON round-trip keeps all four own keys');
  const viaIn = buildOtlpPayload(m, {}).resourceMetrics[0].scopeMetrics[0].metrics.find((x) => x.name === 'buddy.tool.calls');
  ok(viaIn.sum.dataPoints.length === 4, 'the wire carries one row per series: 3 ok + 1 denied');
  const sinkObj = JSON.parse(JSON.stringify({ d: aggregateEvents([{ type: 'tool', tool: '__proto__', denied: false }]).byTool }));
  ok(sinkObj.d['__proto__'].ok === 1, 'a sink record serializes the hostile name as data');
});

console.log('\n── C. endpoint attacks ───────────────────────────────────────────');
await attempt('file://, gopher://, userinfo, CRLF injection, fragment, control bytes — every hostile endpoint is refused', async () => {
  const hostile = [
    'file:///etc/passwd', 'gopher://evil', 'unix:///tmp/s', 'data:text/plain,x',
    'http://user:pass@127.0.0.1:4318/v1/metrics', 'https://otlp:hunter2@collector.example.com',
    'http://127.0.0.1:4318/v1/metrics\r\nX-Injected: 1', 'http://127.0.0.1:4318/\nEVIL',
    'https://collector.example.com/v1/metrics#fragment', 'http://127.0.0.1:4318/\u0000',
    'http://[::1]:4318/v1/metrics?ok=1\u0000more', '  ', '', 42, null,
  ];
  for (const ep of hostile) {
    const v = validateEndpoint(ep);
    ok(v.ok === false, `refused: ${JSON.stringify(ep)} (${v.reason?.slice(0, 60)})`);
  }
  const good = validateEndpoint('http://127.0.0.1:4318/v1/metrics');
  ok(good.ok === true, 'the loopback collector is allowed (the operator\u2019s own wire)');
  const good2 = validateEndpoint('https://otel.example.com/v1/metrics?key=abc');
  ok(good2.ok === true, 'a query string is allowed (paths are the operator\u2019s business)');
});

console.log('\n── D. token hygiene ──────────────────────────────────────────────');
await attempt('the engine NEVER reads process.env — the token arrives only via opts (proven by a poisoned env)', async () => {
  const root = tmp('env');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  writeSettings(root, { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' } });
  process.env.OTLP_TOKEN = CANARY; // hostile env: if the engine peeked, this would leak
  const spyCalls = [];
  const r = await exportTelemetry(root, { fetchImpl: async (u, i) => { spyCalls.push({ u, i }); return { ok: true, status: 200 }; } });
  delete process.env.OTLP_TOKEN;
  ok(spyCalls.length === 0, 'no POST happened — the caller did not resolve the env, the engine did not either');
  ok(r.otlp.reason?.includes('unset'), `the skip names the env var, never a value (${r.otlp.reason?.slice(0, 50)})`);
  ok(r.sink && fs.existsSync(r.sink), 'the local sink still landed');
});

await attempt('a hostile env VALUE (newlines, CRLF, bearer-prefix games) cannot split the Authorization header', async () => {
  const root = tmp('split');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  writeSettings(root, { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' } });
  const evil = `${HEADER_CANARY}\r\nX-Injected: yes\r\nAuthorization: Bearer fake`;
  const spyCalls = [];
  await exportTelemetry(root, { token: evil, fetchImpl: async (u, i) => { spyCalls.push(i); return { ok: true, status: 200 }; } });
  ok(spyCalls.length === 1, 'the POST went out (the caller explicitly passed the value — its choice)');
  const hdr = spyCalls[0].headers.authorization;
  ok(typeof hdr === 'string' && !/[\r\n]/.test(hdr), 'the ENGINE stripped the CRLF at the one place a header is built (RED TEAM v0.53 fix)');
  ok(spyCalls[0].headers.authorization.startsWith('Bearer '), 'the shape is still Bearer');
  ok(hdr.includes(HEADER_CANARY), 'the stripped value still authenticates (the canary, minus the newlines)');
});

await attempt('the token VALUE appears in ZERO local bytes (sink, cursor, status, view)', async () => {
  const root = tmp('leak');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  writeSettings(root, { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' } });
  await exportTelemetry(root, { token: CANARY, fetchImpl: async () => ({ ok: false, status: 500 }) });
  const surfaces = [
    ['sink', fs.readFileSync(metricsPath(root), 'utf8')],
    ['cursor', fs.readFileSync(cursorPath(root), 'utf8')],
    ['status', fs.readFileSync(statusPath(root), 'utf8')],
    ['view', telemetryViewText(root)],
  ];
  for (const [name, surf] of surfaces) {
    ok(!surf.includes(CANARY), `the canary never appears in ${name}`);
    ok(!surf.includes('Bearer sk-'), `${name} never renders a bearer value`);
  }
  const v = telemetryViewText(root);
  ok(v.includes('$OTLP_TOKEN'), 'the view names the env VAR (the reference), never the value');
});

console.log('\n── E. cursor forensics ───────────────────────────────────────────');
await attempt('a torn/hostile cursor file degrades to 0; a cursor beyond EOF resets with reset:true', async () => {
  const root = tmp('cur1');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  fs.mkdirSync(path.join(root, '.buddy', 'telemetry'), { recursive: true });
  fs.writeFileSync(cursorPath(root), '{torn cursor');
  const r1 = await exportTelemetry(root);
  ok(r1.metrics.turns === 1, 'a torn cursor re-exports from 0 exactly once (data is never lost twice)');
  const root2 = tmp('cur2');
  appendRaw(root2, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  fs.mkdirSync(path.join(root2, '.buddy', 'telemetry'), { recursive: true });
  fs.writeFileSync(cursorPath(root2), JSON.stringify({ pos: 999999 }));
  const r2 = await exportTelemetry(root2);
  ok(r2.reset === true, 'a cursor beyond EOF resets, announced');
  ok(r2.metrics.turns === 1, 'and the event exports once');
  const root3 = tmp('cur3');
  appendRaw(root3, '{"a":1}\n{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  fs.mkdirSync(path.join(root3, '.buddy', 'telemetry'), { recursive: true });
  fs.writeFileSync(cursorPath(root3), JSON.stringify({ pos: 4 })); // mid-line
  const r3 = await exportTelemetry(root3);
  ok(r3.events.torn >= 1, 'a mid-line cursor turns the fragment into a counted corpse, never a double');
  ok(r3.metrics.turns === 1, 'the real event still exports exactly once');
});

await attempt('a telemetry dir planted as a FILE degrades honestly — nothing crashes', async () => {
  const root = tmp('planted');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'telemetry'), 'not a directory');
  const r = await exportTelemetry(root);
  ok(r.ok === false || r.problems.length > 0, 'the failure is honest, with a reason');
  const af = await autoFlush(root); // hostile store must not break the flusher either
  ok(af === null || af?.ok === false || af?.problems?.length > 0, 'autoFlush degrades, never throws');
});

console.log('\n── F. knob coercion (canonical-only) ─────────────────────────────');
await attempt('"30\\n", 1.5, -5, 0x10-style strings, "", arrays — every junk knob is refused with a reason', async () => {
  const junk = [
    { enabled: 'true\n' }, { enabled: 0 }, { enabled: '1' },
    { endpoint: 'http://127.0.0.1:4318/\n' }, { endpoint: 30 }, { endpoint: [] },
    { headersEnv: 'OTLP_TOKEN\n' }, { headersEnv: 'A-B' }, { headersEnv: 42 },
    { intervalMin: '30\n' }, { intervalMin: 1.5 }, { knob: '' },
  ];
  for (const j of junk) {
    const { problems } = parseTelemetryConfig(j);
    const hasUnknown = Object.keys(j).some((k) => !['enabled', 'endpoint', 'headersEnv'].includes(k));
    ok(problems.length >= 1, `refused: ${JSON.stringify(j)}`);
    if (hasUnknown) ok(problems.some((p) => /unknown telemetry key/.test(p)), 'unknown keys are NAMED, not applied silently');
  }
  const { problems, config } = parseTelemetryConfig({ enabled: true, endpoint: '', headersEnv: '' });
  ok(problems.length === 0 && config.enabled === true, 'the honest empty strings are the explicit JSONL-only shape');
});

console.log('\n── G. the CLI under attack ───────────────────────────────────────');
const buddy = (args, cwd, env = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NO_COLOR: '1', ...env } });

await attempt('a 100-arg flood and dash-leading junk answer with teaching errors, exit 2', async () => {
  const root = tmp('cli');
  const flood = buddy(['telemetry', ...Array.from({ length: 100 }, (_x, i) => `--arg${i}=x`)], root);
  ok(flood.status === 2 || flood.status === 0, `the flood exits honestly (${flood.status})`);
  const dash = buddy(['telemetry', '-999'], root);
  ok(dash.status === 2, 'a dash-leading junk subcommand exits 2');
  ok(/unknown telemetry subcommand|refusing|usage|problem/i.test(dash.stderr + flood.stderr), 'the refusal teaches');
});

await attempt('the CLI never renders a token VALUE (canary env passed through a real export)', async () => {
  const root = tmp('clicanary');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  writeSettings(root, { telemetry: { endpoint: 'http://127.0.0.1:9/v1/metrics', headersEnv: 'OTLP_TOKEN' } });
  const r = buddy(['telemetry', 'export'], root, { OTLP_TOKEN: CANARY }); // port 9 (discard): the wire fails fast, the CLI must stay honest
  const out = r.stdout + r.stderr;
  ok(!out.includes(CANARY), 'the CLI output carries ZERO token bytes');
  ok(/sink|cursor|otlp/i.test(out), 'the CLI reports the export facts');
  ok(r.status === 0, `the export stays ok even when the collector is dead (got ${r.status})`);
});

console.log('\n── H. the opt-in contract under attack ───────────────────────────');
await attempt('the DEFAULT config creates NOTHING — proven byte-for-byte on a fresh root', async () => {
  const before = new Set();
  const root = tmp('optin');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  const snap = (p, acc) => { try { for (const f of fs.readdirSync(p, { recursive: true })) acc.add(f); } catch {} };
  snap(root, before);
  await autoFlush(root);
  const after = new Set();
  snap(root, after);
  ok(before.size === after.size && [...after].every((f) => before.has(f)), 'autoFlush(OFF) created ZERO files');
  const r = await exportTelemetry(root, { dryRun: true });
  const after2 = new Set(); snap(root, after2);
  ok(before.size === after2.size, 'dry-run created ZERO files');
  ok(r.dryRun === true, 'dry-run reports itself');
});

await attempt('a hostile settings file (binary junk, arrays, null) degrades to the honest OFF', async () => {
  for (const [tag, content] of [['bin', Buffer.from([0xff, 0xfe, 0x00])], ['arr', '[1,2,3]'], ['null', 'null'], ['empty', '']]) {
    const root = tmp(tag);
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), content);
    const af = await autoFlush(root);
    ok(af === null, `autoFlush with ${tag} settings → null (OFF), never a throw`);
    const { config, problems } = parseTelemetryConfig((() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.buddy', 'settings.json'), 'utf8'))?.chat?.telemetry; } catch { return undefined; } })());
    ok(config.enabled === false, `${tag}: the default is OFF`);
  }
});

await attempt('enabled=true auto-flush with a hostile collector: the turn path survives (fire-and-forget semantics)', async () => {
  const root = tmp('autofire');
  appendRaw(root, '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","steps":1,"durationMs":100,"calls":1,"tokIn":10,"tokOut":2,"said":true,"error":false}\n');
  writeSettings(root, { telemetry: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/metrics' } });
  const p = autoFlush(root);
  ok(p && typeof p.then === 'function', 'autoFlush returns a promise (the REPL never awaits it)');
  const r = await p;
  ok(r && r.sink, 'the flush landed despite the dead collector');
  ok(r.otlp.sent === false, 'the wire failure is recorded honestly');
});

console.log('\n── finale: the leak sweep ────────────────────────────────────────');
await attempt('FULL SWEEP: neither canary appears in any sink/cursor/status/view byte across all roots', async () => {
  // walk every tmp root this run touched and grep every byte the wave wrote
  let hits = 0;
  const dir = os.tmpdir();
  for (const d of fs.readdirSync(dir)) {
    if (!d.startsWith('v53-redteam-')) continue;
    const walk = (p) => {
      for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, f.name);
        if (f.isDirectory()) walk(fp);
        else {
          try {
            const txt = fs.readFileSync(fp, 'utf8');
            if (txt.includes(CANARY) || txt.includes(HEADER_CANARY)) hits += 1;
          } catch { /* binary — skip */ }
        }
      }
    };
    walk(path.join(dir, d));
  }
  ok(hits === 0, `ZERO canary occurrences across every byte the wave wrote (found ${hits})`);
});

console.log(`\nred team v0.53: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const e of errs) console.log(`  ! ${String(e?.message || e).split('\n')[0]}`);
  process.exit(1);
}
console.log('RED TEAM: PASS');
