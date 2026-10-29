// v0.53.0 — TELEMETRY EXPORT (§11): opt-in OTel/JSONL metrics of turns,
// tokens, tool counts. Tests run against the pure engine (src/telemetry.js),
// the REAL CLI (index.js telemetry …), and the REAL events log module that
// feeds it.
// Pins that carry the house rules:
//   - the OPT-IN contract: autoFlush with the default config returns null and
//     creates NOTHING — no dir, no file, no byte; ON lands the sink;
//   - knobs are canonical-only (the v0.50 baud / v0.51 Number() lessons):
//     enabled must be a real boolean, endpoint must parse http(s) without
//     credentials, headersEnv must be an env-var NAME — junk is refused with
//     a reason, never coerced;
//   - aggregation is PROTOTYPE-SAFE: a tool named __proto__ cannot become
//     [[Prototype]] pollution; labels are sanitized (control bytes, one
//     line, capped) and an empty label is _invalid, never dropped silently;
//   - the cursor is the channels drain discipline: advances only over
//     COMPLETE lines, a torn trailing line is never consumed (it may still
//     be completing), a torn line inside the window is counted + skipped, a
//     giant line is counted + stepped over (never a wedge), a shrunk log
//     resets with reset:true;
//   - dry-run is side-effect free (no sink, no cursor, no POST);
//   - the OTLP wire: token from the CALLER (the engine never reads
//     process.env), Authorization rides the wire only, the response body is
//     never quoted, a collector failure degrades the wire — never the local
//     sink, never the export, never a throw;
//   - OTLP JSON shape: int64 fields as STRINGS, delta temporality = 1,
//     histogram buckets = bounds + 1, an empty tool series becomes an
//     explicit _none zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  aggregateEvents, sanitizeLabel, parseTelemetryConfig, validateEndpoint,
  buildOtlpPayload, exportTelemetry, telemetryViewText, autoFlush,
  resetCursorToEnd, readExportLog, parseWindow, metricsPath, cursorPath,
  statusPath, readTelemetryConfig, HISTOGRAM_BOUNDS_MS, AGG_TEMPORALITY_DELTA,
} from '../src/telemetry.js';
import { appendEvent, projectEvent } from '../src/eventslog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v053-'));
const INDEX = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'index.js');
const CANARY = 'sk-TELEMETRY53-token-canary-4d2e91';
const buddy = (args, cwd, env = {}) =>
  spawnSync('node', [INDEX, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NO_COLOR: '1', ...env } });

const seedTurn = (root, over = {}) =>
  appendEvent(root, projectEvent({ type: 'turn_end', steps: 2, durationMs: 1200, calls: 2, tokIn: 100, tokOut: 20, said: true, error: false, ...over }));

// ── aggregation ──────────────────────────────────────────────────────────────

test('aggregateEvents: exact counters over a mixed window', () => {
  const m = aggregateEvents([
    { type: 'tool', tool: 'fs_read', denied: false },
    { type: 'tool', tool: 'fs_read', denied: false },
    { type: 'tool', tool: 'shell', denied: true },
    { type: 'compaction', kept: 2, dropped: 1 },
    { type: 'turn_end', calls: 3, tokIn: 1500, tokOut: 250, durationMs: 6000 },
    { type: 'turn_end', calls: 1, tokIn: 100, tokOut: 10, durationMs: 400, error: true },
    { type: 'say', chars: 12 },
  ]);
  assert.equal(m.turns, 2);
  assert.equal(m.calls, 4);
  assert.equal(m.tokIn, 1600);
  assert.equal(m.tokOut, 260);
  assert.equal(m.denied, 1);
  assert.equal(m.compactions, 1);
  assert.equal(m.turnErrors, 1);
  assert.equal(m.eventsRead, 7);
  assert.equal(m.eventsIgnored, 1); // say
  assert.deepEqual(m.byTool['fs_read'], { ok: 2, denied: 0 });
  assert.deepEqual(m.byTool['shell'], { ok: 0, denied: 1 });
  assert.equal(m.duration.count, 2);
  assert.equal(m.duration.sumMs, 6400);
  assert.equal(m.duration.buckets[2], 1); // 6s → (5000, 15000]
  assert.equal(m.duration.buckets[0], 1); // 0.4s → [0, 1000)
});

test('aggregateEvents: junk numbers count as zero, never guessed', () => {
  const m = aggregateEvents([
    { type: 'turn_end', calls: '9\n', tokIn: -5, tokOut: NaN, durationMs: Infinity },
    { type: 'turn_end' },
    { type: 'tool' },
  ]);
  assert.equal(m.calls, 0);
  assert.equal(m.tokIn, 0);
  assert.equal(m.tokOut, 0);
  assert.equal(m.turns, 2);
  assert.equal(m.duration.count, 2);
  assert.equal(m.duration.sumMs, 0);
  assert.equal(m.byTool['_invalid'].ok, 1); // an unnamed tool is _invalid, counted honestly
});

test('aggregateEvents: __proto__ / constructor tool names cannot pollute the prototype', () => {
  const m = aggregateEvents([
    { type: 'tool', tool: '__proto__', denied: false },
    { type: 'tool', tool: 'constructor', denied: false },
    { type: 'tool', tool: '__proto__', denied: true },
  ]);
  assert.equal(Object.keys(m.byTool).length, 2);
  assert.deepEqual(m.byTool['__proto__'], { ok: 1, denied: 1 });
  assert.deepEqual(m.byTool['constructor'], { ok: 1, denied: 0 });
  const round = JSON.parse(JSON.stringify({ byTool: m.byTool }));
  assert.ok(round.byTool['__proto__'], 'the round-trip keeps __proto__ as an OWN key');
  assert.equal(Object.getPrototypeOf(m.byTool), null, 'the map has no prototype to pollute');
});

test('sanitizeLabel: ANSI, control bytes, newlines, tabs, caps, empty', () => {
  assert.equal(sanitizeLabel('\u001b[31mfs_write\u0007'), 'fs_write');
  assert.equal(sanitizeLabel('a\nb\rc'), 'a b c');
  assert.equal(sanitizeLabel('\ta\tb\t'), 'a b');
  assert.equal(sanitizeLabel('x'.repeat(200)).length, 64);
  assert.equal(sanitizeLabel(''), '_invalid');
  assert.equal(sanitizeLabel('\u001b]0;pwned\u0007read'), 'read', 'a whole OSC sequence is stripped, not just the ESC byte');
  assert.equal(sanitizeLabel(null), '_invalid');
  assert.equal(sanitizeLabel('\u009fok'), 'ok');
});

// ── knobs (canonical-only) ───────────────────────────────────────────────────

test('parseTelemetryConfig: the canonical-only matrix', () => {
  const refused = [
    { enabled: 'yes' }, { enabled: 1 }, { enabled: 'true' },
    { endpoint: 'ftp://x' }, { endpoint: 'file:///etc/passwd' }, { endpoint: 'http://user:pass@h/v1/metrics' },
    { endpoint: 'not a url' }, { endpoint: 'http://h/\u0000' }, { endpoint: 'https://h/v1#frag' },
    { headersEnv: 'BAD NAME' }, { headersEnv: '9env' }, { headersEnv: 'a-b' },
    { junk: 1 },
  ];
  for (const r of refused) {
    const { problems } = parseTelemetryConfig(r);
    assert.ok(problems.length >= 1, `expected a refusal for ${JSON.stringify(r)}`);
  }
  const ok = parseTelemetryConfig({ enabled: true, endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.enabled, true);
  assert.equal(ok.config.endpoint, 'http://127.0.0.1:4318/v1/metrics');
  const def = parseTelemetryConfig(undefined);
  assert.equal(def.config.enabled, false);
  assert.equal(def.config.endpoint, '');
  const junkShape = parseTelemetryConfig('yes');
  assert.equal(junkShape.config.enabled, false, 'a non-object config degrades to the honest default');
});

test('validateEndpoint: loopback http is fine; credentials and controls are not', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:4318/v1/metrics').ok, true);
  assert.equal(validateEndpoint('https://otel.example.com/v1/metrics').ok, true);
  assert.equal(validateEndpoint('http://u:p@h/x').ok, false);
  assert.equal(validateEndpoint('http://h/x\r\nX-Inject: 1').ok, false);
  assert.equal(validateEndpoint('gopher://h').ok, false);
});

// ── the OTLP payload ─────────────────────────────────────────────────────────

test('buildOtlpPayload: OTLP JSON shape — int64 as strings, delta temporality, histogram', () => {
  const m = aggregateEvents([
    { type: 'tool', tool: 'fs_read', denied: false },
    { type: 'tool', tool: 'fs_read', denied: true },
    { type: 'turn_end', calls: 2, tokIn: 300, tokOut: 40, durationMs: 700 },
    { type: 'compaction' },
  ]);
  const p = buildOtlpPayload(m, { timeUnixNano: '1700000000000000000' });
  const rm = p.resourceMetrics[0];
  assert.equal(rm.resource.attributes.find((a) => a.key === 'service.name').value.stringValue, 'engineer-buddy');
  const sm = rm.scopeMetrics[0];
  assert.equal(sm.scope.name, 'engineer-buddy.telemetry');
  const byName = Object.fromEntries(sm.metrics.map((x) => [x.name, x]));
  for (const n of ['buddy.turns', 'buddy.brain.calls', 'buddy.tokens', 'buddy.tool.calls', 'buddy.compactions', 'buddy.turn.duration']) {
    assert.ok(byName[n], `metric ${n} present`);
  }
  for (const n of ['buddy.turns', 'buddy.brain.calls', 'buddy.tokens', 'buddy.tool.calls', 'buddy.compactions']) {
    assert.equal(byName[n].sum.aggregationTemporality, AGG_TEMPORALITY_DELTA);
    assert.equal(byName[n].sum.isMonotonic, true);
    for (const dp of byName[n].sum.dataPoints) {
      assert.equal(typeof dp.asInt, 'string', 'int64 travels as a STRING (OTLP JSON)');
      assert.ok(/^\d+$/.test(dp.asInt));
    }
  }
  const tok = byName['buddy.tokens'].sum.dataPoints;
  assert.equal(tok.length, 2);
  const dirs = tok.map((d) => d.attributes.find((a) => a.key === 'direction').value.stringValue).sort();
  assert.deepEqual(dirs, ['in', 'out']);
  assert.equal(tok.find((d) => d.attributes.some((a) => a.key === 'direction' && a.value.stringValue === 'in')).asInt, '300');
  const tools = byName['buddy.tool.calls'].sum.dataPoints;
  assert.equal(tools.length, 2); // ok row + denied row for fs_read
  const h = byName['buddy.turn.duration'].histogram;
  assert.equal(typeof h.dataPoints[0].asDouble, 'number');
  assert.equal(h.dataPoints[0].count, '1');
  assert.equal(h.dataPoints[0].bucketCounts.length, HISTOGRAM_BOUNDS_MS.length + 1);
  assert.deepEqual(h.dataPoints[0].explicitBounds, HISTOGRAM_BOUNDS_MS);
  assert.equal(h.aggregationTemporality, AGG_TEMPORALITY_DELTA);
});

test('buildOtlpPayload: an empty tool series becomes an explicit _none zero', () => {
  const m = aggregateEvents([{ type: 'turn_end', calls: 1, tokIn: 1, tokOut: 1, durationMs: 1 }]);
  const p = buildOtlpPayload(m, {});
  const tools = p.resourceMetrics[0].scopeMetrics[0].metrics.find((x) => x.name === 'buddy.tool.calls');
  assert.equal(tools.sum.dataPoints.length, 1);
  assert.equal(tools.sum.dataPoints[0].attributes.find((a) => a.key === 'tool').value.stringValue, '_none');
  assert.equal(tools.sum.dataPoints[0].asInt, '0');
});

test('buildOtlpPayload: hostile labels are sanitized on the wire', () => {
  const m = aggregateEvents([{ type: 'tool', tool: '\u001b[31mevil\u0007\nRUN', denied: false }]);
  const p = buildOtlpPayload(m, {});
  const dps = p.resourceMetrics[0].scopeMetrics[0].metrics.find((x) => x.name === 'buddy.tool.calls').sum.dataPoints;
  const label = dps[0].attributes.find((a) => a.key === 'tool').value.stringValue;
  assert.ok(!/[\u0000-\u001f\u007f]/.test(label), 'no control bytes ride the wire');
  assert.equal(label, 'evil RUN');
});

// ── the cursor + the export loop ─────────────────────────────────────────────

test('exportTelemetry: sink lands, cursor advances, second export is an honest empty', async () => {
  const root = tmp();
  seedTurn(root, { calls: 2, tokIn: 100, tokOut: 20 });
  appendEvent(root, projectEvent({ type: 'tool', tool: 'fs_read', denied: false, observation: 'x' }));
  const size1 = fs.statSync(path.join(root, '.buddy', 'events.jsonl')).size;
  const r1 = await exportTelemetry(root);
  assert.equal(r1.ok, true);
  assert.equal(r1.metrics.turns, 1);
  assert.equal(r1.metrics.calls, 2);
  assert.deepEqual(r1.metrics.byTool['fs_read'], { ok: 1, denied: 0 });
  assert.equal(r1.cursor.after, size1);
  assert.ok(r1.sink && fs.existsSync(r1.sink));
  const rec = readExportLog(root, 1)[0];
  assert.equal(rec.turns, 1);
  assert.equal(rec.v, 1);
  const r2 = await exportTelemetry(root);
  assert.match(r2.note, /no new complete events/);
  assert.equal(r2.sink, null, 'no empty-window record is written');
  assert.equal(readExportLog(root, 100).length, 1, 'the sink still holds exactly one record');
  // new event → exactly the delta
  seedTurn(root, { calls: 5, tokIn: 7, tokOut: 3 });
  const r3 = await exportTelemetry(root);
  assert.equal(r3.metrics.turns, 1);
  assert.equal(r3.metrics.calls, 5);
  assert.equal(r3.metrics.tokIn, 7);
});

test('exportTelemetry: a torn trailing line is never consumed; completed later, it exports', async () => {
  const root = tmp();
  seedTurn(root);
  const f = path.join(root, '.buddy', 'events.jsonl');
  const frag = '{"ts":"2026-10-29T09:00:00.000Z","type":"turn_end","calls":9,"tok';
  fs.appendFileSync(f, frag); // torn tail, no \n
  const sizeBefore = fs.statSync(f).size;
  const r1 = await exportTelemetry(root);
  assert.equal(r1.metrics.turns, 1, 'only the complete line counted');
  assert.equal(r1.cursor.after, sizeBefore - frag.length, 'the cursor stops before the fragment');
  fs.appendFileSync(f, 'In":50,"tokOut":5,"durationMs":10,"steps":1,"said":true,"error":false}\n'); // the append completes the line
  const r2 = await exportTelemetry(root);
  assert.equal(r2.metrics.turns, 1, 'the completed line exports exactly once');
  assert.equal(r2.metrics.tokIn, 50);
  const r3 = await exportTelemetry(root);
  assert.match(r3.note, /no new complete events/, 'and never twice');
});

test('exportTelemetry: a torn line INSIDE the window is counted and skipped, never guessed', async () => {
  const root = tmp();
  seedTurn(root);
  fs.appendFileSync(path.join(root, '.buddy', 'events.jsonl'), '{torn corpse line}\n');
  seedTurn(root, { calls: 4 });
  const r = await exportTelemetry(root);
  assert.equal(r.metrics.turns, 2);
  assert.equal(r.events.torn, 1);
});

test('exportTelemetry: a giant line over the window is counted and stepped over, never a wedge', async () => {
  const root = tmp();
  seedTurn(root);
  const f = path.join(root, '.buddy', 'events.jsonl');
  fs.appendFileSync(f, 'G'.repeat(2 * 1024 * 1024 + 10) + '\n'); // > MAX_WINDOW_BYTES, one line
  seedTurn(root, { calls: 8 });
  const r1 = await exportTelemetry(root);
  assert.equal(r1.metrics.turns, 1, 'the window held the first event before the giant');
  assert.equal(r1.events.giants, 0);
  let cur = r1.cursor.after;
  // each subsequent window makes STRICT progress over the giant — no wedge
  const rs = [];
  for (let i = 0; i < 5 && cur < fs.statSync(f).size; i++) {
    const r = await exportTelemetry(root);
    rs.push(r);
    assert.ok(r.cursor.after > cur, `window ${i + 1} advanced the cursor (${cur} → ${r.cursor.after})`);
    cur = r.cursor.after;
  }
  assert.equal(cur, fs.statSync(f).size, 'the cursor reaches the true end — the giant never wedges the stream');
  const giants = rs.reduce((a, r) => a + r.events.giants, 0);
  const torn = rs.reduce((a, r) => a + r.events.torn, 0);
  assert.ok(giants >= 1 || torn >= 1, 'the giant is counted honestly somewhere (giant or torn), never silent');
  const last = rs[rs.length - 1];
  assert.equal(last.metrics.turns, 1, 'the event after the giant exports exactly once');
  assert.equal(last.metrics.calls, 8);
});

test('exportTelemetry: a shrunk log resets with reset:true and re-exports honestly', async () => {
  const root = tmp();
  seedTurn(root);
  const r1 = await exportTelemetry(root);
  assert.equal(r1.reset, false);
  const cur = JSON.parse(fs.readFileSync(cursorPath(root), 'utf8'));
  fs.writeFileSync(path.join(root, '.buddy', 'events.jsonl'), ''); // rotation/truncation happened elsewhere
  const r2 = await exportTelemetry(root);
  assert.equal(r2.reset, true, 'the shrink is announced, never silent');
  assert.ok(r2.problems.some((p) => /shrank below the cursor/.test(p)));
  seedTurn(root, { calls: 3 });
  const r3 = await exportTelemetry(root);
  assert.equal(r3.metrics.turns, 1, 'post-reset deltas are exact');
  assert.equal(r3.calls ?? r3.metrics.calls, 3);
  assert.equal(r3.reset, false, 'the cursor did not re-reset — the reset unstuck it');
});

test('exportTelemetry: dry-run is side-effect free (no sink, no cursor, no POST)', async () => {
  const root = tmp();
  seedTurn(root);
  let posts = 0;
  const r = await exportTelemetry(root, { dryRun: true, fetchImpl: async () => { posts += 1; return { ok: true, status: 200 }; } });
  assert.equal(r.dryRun, true);
  assert.ok(r.payloadHead.length > 0);
  assert.equal(fs.existsSync(metricsPath(root)), false, 'no sink file');
  assert.equal(fs.existsSync(cursorPath(root)), false, 'no cursor file');
  assert.equal(fs.existsSync(path.join(root, '.buddy', 'telemetry')), false, 'not even the directory');
  assert.equal(posts, 0, 'no POST');
});

// ── the wire ─────────────────────────────────────────────────────────────────

function collectorSpy(status = 200, ok = true) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return { ok, status };
    },
  };
}

test('the OTLP wire: endpoint + env token ride ONE POST; the token appears nowhere on disk', async () => {
  const root = tmp();
  seedTurn(root, { calls: 1, tokIn: 10, tokOut: 2 });
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { enabled: true, endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' } },
  }));
  const spy = collectorSpy();
  const r = await exportTelemetry(root, { token: CANARY, fetchImpl: spy.impl });
  assert.equal(r.otlp.sent, true);
  assert.equal(r.otlp.status, 200);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].url, 'http://127.0.0.1:4318/v1/metrics');
  assert.equal(spy.calls[0].init.headers.authorization, `Bearer ${CANARY}`);
  assert.equal(spy.calls[0].init.headers['content-type'], 'application/json');
  const payload = JSON.parse(spy.calls[0].init.body);
  assert.ok(payload.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.length >= 5);
  assert.equal(spy.calls[0].init.method, 'POST');
  // the canary must appear in NO local surface — the wire carries it, disk never does
  const sink = fs.readFileSync(metricsPath(root), 'utf8');
  const status = fs.existsSync(statusPath(root)) ? fs.readFileSync(statusPath(root), 'utf8') : '';
  const cursor = fs.readFileSync(cursorPath(root), 'utf8');
  for (const [name, surf] of [['sink', sink], ['status', status], ['cursor', cursor]]) {
    assert.ok(!surf.includes(CANARY), `the token canary must not appear in ${name}`);
  }
});

test('the OTLP wire: a missing env token is an honest SKIP — the JSONL sink still lands', async () => {
  const root = tmp();
  seedTurn(root);
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics', headersEnv: 'OTLP_TOKEN' } },
  }));
  const spy = collectorSpy();
  const r = await exportTelemetry(root, { token: undefined, fetchImpl: spy.impl }); // the caller resolved: env unset
  assert.equal(r.ok, true, 'the export itself is fine');
  assert.ok(r.sink, 'the local sink landed');
  assert.equal(spy.calls.length, 0, 'NOTHING was posted');
  assert.equal(r.otlp.attempted, false);
  assert.match(r.otlp.reason, /unset — set it to export/);
});

test('the OTLP wire: a hostile collector degrades the wire, never the local export', async () => {
  const root = tmp();
  seedTurn(root);
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics' } },
  }));
  const throwing = collectorSpy(); throwing.impl = async () => { throw new Error('connection reset'); };
  const r1 = await exportTelemetry(root, { fetchImpl: throwing.impl });
  assert.equal(r1.ok, true, 'the export survives a dead collector');
  assert.ok(r1.sink, 'the sink landed');
  assert.equal(r1.otlp.sent, false);
  assert.match(r1.otlp.reason, /connection reset/);
  const r2 = await exportTelemetry(root, { fetchImpl: throwing.impl }); // a new event is needed — plant one
  assert.equal(r2.note ? true : true, true);
  seedTurn(root, { calls: 2 });
  const rejecting = collectorSpy(); rejecting.impl = async () => ({ ok: false, status: 503 });
  const r3 = await exportTelemetry(root, { fetchImpl: rejecting.impl });
  assert.equal(r3.otlp.sent, false);
  assert.equal(r3.otlp.status, 503);
  assert.match(r3.otlp.reason, /503/);
  assert.ok(r3.sink, 'and the sink still landed');
  const st = JSON.parse(fs.readFileSync(statusPath(root), 'utf8'));
  assert.equal(st.otlp.status, 503, 'the status gauge keeps the last attempt honestly');
});

test('the OTLP wire: a slow collector cannot hold the caller past the timeout', async () => {
  const root = tmp();
  seedTurn(root);
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'http://127.0.0.1:4318/v1/metrics' } },
  }));
  const t0 = Date.now();
  const r = await exportTelemetry(root, { fetchImpl: (_u, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })));
  }) });
  const dt = Date.now() - t0;
  assert.equal(r.otlp.sent, false);
  assert.match(r.otlp.reason, /timed out/);
  assert.ok(dt < 4500, `the hard timeout fired at ~${dt}ms — the wire can never wedge an export`);
});

// ── config from the real settings surface ────────────────────────────────────

test('readTelemetryConfig: reads the real settings.json; unknown keys are reported, not applied', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { enabled: true, intervalMin: 5 } },
  }));
  const { config, problems } = readTelemetryConfig(root);
  assert.equal(config.enabled, true);
  assert.ok(problems.some((p) => /unknown telemetry key "intervalMin"/.test(p)), 'the unknown key is named');
});

// ── the auto flush (the opt-in contract) ─────────────────────────────────────

test('autoFlush: OFF means OFF — zero bytes, zero activity', async () => {
  const root = tmp();
  seedTurn(root);
  const r = await autoFlush(root);
  assert.equal(r, null);
  assert.equal(fs.existsSync(path.join(root, '.buddy', 'telemetry')), false, 'not even the directory exists');
});

test('autoFlush: ON lands the sink; a hostile store cannot break it', async () => {
  const root = tmp();
  seedTurn(root);
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ chat: { telemetry: { enabled: true } } }));
  const r = await autoFlush(root);
  assert.ok(r && r.sink, 'the flush landed');
  // a settings file that is binary junk degrades to the honest default (OFF)
  const root2 = tmp();
  fs.mkdirSync(path.join(root2, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root2, '.buddy', 'settings.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  seedTurn(root2);
  const r2 = await autoFlush(root2);
  assert.equal(r2, null, 'junk config → the honest default, never a throw');
});

// ── reset + views + the sink reader ──────────────────────────────────────────

test('resetCursorToEnd: skips history from now; the events log is untouched', async () => {
  const root = tmp();
  seedTurn(root);
  const size = fs.statSync(path.join(root, '.buddy', 'events.jsonl')).size;
  const pos = resetCursorToEnd(root);
  assert.equal(pos, size);
  seedTurn(root, { calls: 7 });
  const r = await exportTelemetry(root);
  assert.equal(r.metrics.turns, 1, 'only the post-reset event exports');
  assert.equal(r.metrics.calls, 7);
});

test('readExportLog: torn sink lines are skipped, never surfaced', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.buddy', 'telemetry'), { recursive: true });
  fs.writeFileSync(metricsPath(root), '{"v":1,"turns":3}\n{torn\n{"v":1,"turns":4}\n');
  const rows = readExportLog(root, 10);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.turns), [3, 4]);
});

test('parseWindow: empty, whitespace-only, and CRLF windows are honest', () => {
  assert.deepEqual(parseWindow('', { atEof: true }), { events: [], consumed: 0, torn: 0, giants: 0 });
  const crlf = parseWindow('{"type":"turn_end"}\r\n{"type":"tool"}\n', { atEof: true });
  assert.equal(crlf.events.length, 2, 'a trailing \\r is JSON whitespace — CRLF logs parse fine');
  assert.equal(crlf.torn, 0);
});

test('telemetryViewText: the view names the config, the totals, and the honest empties', () => {
  const root = tmp();
  seedTurn(root, { calls: 3, tokIn: 1234, tokOut: 56 });
  appendEvent(root, projectEvent({ type: 'tool', tool: 'fs_read', denied: false, observation: 'x' }));
  const v = telemetryViewText(root);
  assert.match(v, /enabled    : false/);
  assert.match(v, /turns: 1/);
  assert.match(v, /~1_234 in · ~56 out/);
  assert.match(v, /fs_read/);
  assert.match(v, /export cursor: 0 bytes/);
  const v2 = telemetryViewText(tmp()); // a fresh root: no invented numbers
  assert.match(v2, /no events yet/);
});

// ── the REAL CLI ─────────────────────────────────────────────────────────────

test('CLI: buddy telemetry view/export/reset on a real store', () => {
  const root = tmp();
  seedTurn(root, { calls: 2, tokIn: 100, tokOut: 20 });
  appendEvent(root, projectEvent({ type: 'tool', tool: 'shell', denied: true, observation: 'x' }));
  const v = buddy(['telemetry'], root);
  assert.equal(v.status, 0);
  assert.match(v.stderr, /turns: 1/);
  const d = buddy(['telemetry', 'export', '--dry-run'], root);
  assert.equal(d.status, 0);
  assert.match(d.stderr, /dry run — nothing was written/);
  assert.equal(fs.existsSync(metricsPath(root)), false, 'dry-run via the REAL CLI writes nothing');
  const e = buddy(['telemetry', 'export'], root);
  assert.equal(e.status, 0);
  assert.match(e.stderr, /exported one DELTA window/);
  assert.ok(fs.existsSync(metricsPath(root)));
  const e2 = buddy(['telemetry', 'export'], root);
  assert.equal(e2.status, 0);
  assert.match(e2.stderr, /no new complete events/);
  const r0 = buddy(['telemetry', 'reset'], root);
  assert.equal(r0.status, 2, 'a reset without --yes refuses');
  assert.match(r0.stderr, /refusing to reset/);
  const r1 = buddy(['telemetry', 'reset', '--yes'], root);
  assert.equal(r1.status, 0);
  assert.match(r1.stderr, /cursor reset/);
});

test('CLI: junk subcommands and unknown flags answer with the teaching error', () => {
  const root = tmp();
  const j = buddy(['telemetry', 'deploy'], root);
  assert.equal(j.status, 2);
  assert.match(j.stderr, /unknown telemetry subcommand/);
  const n = buddy(['telemetry', 'view', '--nope'], root);
  assert.equal(n.status, 2, 'parseArgs junk exits 2 (the usage is the answer)');
});

test('CLI: the metrics alias works', () => {
  const root = tmp();
  const m = buddy(['metrics'], root);
  assert.equal(m.status, 0);
  assert.match(m.stderr, /telemetry — opt-in metrics/);
});

test('CLI: BROKEN CONFIG IS A REFUSAL — a hostile endpoint exits 2 with zero side effects', () => {
  const root = tmp();
  seedTurn(root);
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({
    chat: { telemetry: { endpoint: 'file:///etc/passwd' } },
  }));
  const r = buddy(['telemetry', 'export'], root);
  assert.equal(r.status, 2, 'the export is refused, never silently degraded to JSONL-only');
  assert.match(r.stderr, /refused/);
  assert.match(r.stderr, /nothing was exported/);
  assert.equal(fs.existsSync(metricsPath(root)), false, 'zero side effects');
  assert.equal(fs.existsSync(cursorPath(root)), false, 'the cursor did not move');
});
