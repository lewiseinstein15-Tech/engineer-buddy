// telemetry.js — opt-in metrics export (v0.53.0, §11). CORE module — the CLI
// layer lives in index.js (cmdTelemetry); this file is the whole engine.
//
// §11 "Telemetry export — opt-in OTel/JSONL metrics of turns, tokens, tool
// counts." The events log (.buddy/events.jsonl, v0.25.0) has carried the facts
// since the day it shipped — its header promised "Buddy can later ship it to
// an OTel collector — opt-in, zero deps, via the same append point". This is
// that promise, kept.
//
// THE OPT-IN CONTRACT (the channels lesson applied to data that LEAVES the
// machine): `chat.telemetry.enabled` defaults to FALSE and gates the auto
// flush at turn boundaries — with the default, NOTHING in this module ever
// runs (no dir is created, no byte leaves, no timer ticks). An explicit
// `buddy telemetry export` is the operator's own finger on the trigger and
// works regardless, because the operator typed it.
//
// THE WIRE (zero dependencies is the identity):
//   - JSONL sink  .buddy/telemetry/metrics.jsonl — one aggregated DELTA
//     record per export window (rotate at the cap, keep one old file);
//   - OTLP/HTTP JSON — the collector wire format OTel itself defines for
//     JSON (content-type application/json; int64 fields travel as STRINGS).
//     No SDK, no protobuf, one fetch with a hard timeout.
//
// THE SOURCE: events.jsonl is the single source of truth. The exporter is a
// CURSOR over it (the v0.51 channels drain discipline, carried):
//   - the byte cursor advances only over COMPLETE lines that were returned;
//   - a torn trailing line is never consumed (it may still be completing);
//     a torn line INSIDE the window is counted and skipped, never guessed;
//   - a giant line over the window cap is counted and discarded — it can
//     never wedge the cursor at zero forever;
//   - a shrunk or rotated log (cursor beyond EOF) resets with an announced
//     reset:true, never silently re-reads nothing.
//
// THE SECRET-HYGIENE CONTRACT (the v0.48.0 rules, carried): the collector
// token lives in the ENVIRONMENT, referenced by NAME (`headersEnv`) — a
// literal token in config is refused by shape, a missing env var is an
// honest OTLP skip (the JSONL sink still lands — local is not the wire),
// and token VALUES never render anywhere: errors name the env var, never
// the bytes. The endpoint is refused if it embeds credentials (user:pass@).
//
// KNOBS ARE CANONICAL-ONLY (the v0.50 baud / v0.51 Number() lessons):
// `enabled` must be true/false; `endpoint` must parse as http(s) with no
// userinfo; `headersEnv` must be a valid env-var NAME; unknown keys are
// reported as problems, never silently applied.
//
// AGGREGATION IS PROTOTYPE-SAFE (the v0.44 __proto__ lesson): per-tool
// counters live in a null-prototype object — a hostile tool name cannot
// become [[Prototype]] pollution, and every label that leaves this module
// is sanitized: control bytes stripped, one line, capped (the v0.50
// renderer discipline carried into metrics).
//
// TELEMETRY MUST NEVER BREAK A TURN (the eventslog doctrine, inherited):
// every export failure degrades to a returned problem or a swallowed
// best-effort — never a throw through the caller's stack.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('../package.json').version;

export const TELEMETRY_DIR = '.buddy/telemetry';
export const METRICS_FILE = 'metrics.jsonl';
export const CURSOR_FILE = 'cursor.json';
export const STATUS_FILE = 'status.json';
export const DEFAULT_MAX_SINK_BYTES = 5 * 1024 * 1024; // rotate at 5MB, keep one old file
export const MAX_WINDOW_BYTES = 2 * 1024 * 1024;       // one export reads at most 2MB of new events
export const MAX_LABEL = 64;                           // tool-label cap (chars) after sanitization
export const MAX_ENDPOINT_LEN = 2048;
export const MAX_TOOL_DIMS = 256;                      // distinct tool labels per window (flood cap)
export const OTLP_TIMEOUT_MS = 3000;
export const HISTOGRAM_BOUNDS_MS = [1000, 5000, 15000, 60000, 300000]; // turn-duration buckets
export const AGG_TEMPORALITY_DELTA = 1;                // OTLP enum: UNSPECIFIED=0, DELTA=1, CUMULATIVE=2

export function telemetryDirPath(root) {
  return path.join(String(root ?? ''), TELEMETRY_DIR);
}
export function metricsPath(root) {
  return path.join(telemetryDirPath(root), METRICS_FILE);
}
export function cursorPath(root) {
  return path.join(telemetryDirPath(root), CURSOR_FILE);
}
export function statusPath(root) {
  return path.join(telemetryDirPath(root), STATUS_FILE);
}
export function eventsFile(root) {
  return path.join(String(root ?? ''), '.buddy', 'events.jsonl');
}

// ── label discipline ─────────────────────────────────────────────────────────

// The proven channels.js oneLine discipline: strip WHOLE CSI/OSC sequences
// (an ESC byte alone would leave the '[31m' payload riding the label), then
// every remaining control byte.
const ANSI_SEQ_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x1f\x7f\x9f]/g;

/** One line, no ANSI/OSC, no control bytes, capped. Empty means 'invalid'. */
export function sanitizeLabel(s, cap = MAX_LABEL) {
  const folded = String(s ?? '')
    .replace(/[\t\v\f\r\n]/g, ' ')
    .replace(ANSI_SEQ_RE, '')
    .replace(CONTROL_RE, '');
  const one = folded.replace(/\s+/g, ' ').trim();
  const clipped = one.length > cap ? one.slice(0, cap) : one;
  return clipped === '' ? '_invalid' : clipped;
}

// ── config (canonical-only knobs) ────────────────────────────────────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate the raw chat.telemetry shape → { config, problems }. Never throws. */
export function parseTelemetryConfig(raw) {
  const problems = [];
  const cfg = { enabled: false, endpoint: '', headersEnv: '' };
  if (raw === undefined || raw === null) return { config: cfg, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: cfg, problems: ['telemetry config must be an object — refused'] };
  }
  const known = new Set(['enabled', 'endpoint', 'headersEnv']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) problems.push(`unknown telemetry key "${sanitizeLabel(k, 32)}" — not applied`);
  }
  const e = raw.enabled;
  if (e === undefined || e === null) cfg.enabled = false;
  else if (e === true || e === false) cfg.enabled = e;
  else problems.push(`telemetry.enabled must be true or false — got "${sanitizeLabel(String(e), 24)}"`);
  const ep = raw.endpoint;
  if (ep === undefined || ep === null || ep === '') cfg.endpoint = '';
  else {
    const v = validateEndpoint(ep);
    if (v.ok) cfg.endpoint = v.url.href;
    else problems.push(`telemetry.endpoint refused — ${v.reason}`);
  }
  const he = raw.headersEnv;
  if (he === undefined || he === null || he === '') cfg.headersEnv = '';
  else if (typeof he === 'string' && ENV_NAME_RE.test(he)) cfg.headersEnv = he;
  else problems.push(`telemetry.headersEnv must be an environment variable NAME (got "${sanitizeLabel(String(he), 24)}") — the VALUE lives in the environment, never in config`);
  return { config: cfg, problems };
}

/** Endpoint shape rules: http(s), no userinfo, no control bytes, bounded. */
export function validateEndpoint(ep) {
  if (typeof ep !== 'string' || ep.trim() === '') return { ok: false, reason: 'endpoint must be a non-empty URL string' };
  if (ep.length > MAX_ENDPOINT_LEN) return { ok: false, reason: `endpoint over ${MAX_ENDPOINT_LEN} chars` };
  if (/[\u0000-\u001f\u007f]/.test(ep)) return { ok: false, reason: 'endpoint contains control bytes' };
  let u;
  try { u = new URL(ep); } catch { return { ok: false, reason: 'endpoint is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `endpoint scheme must be http(s) — got ${sanitizeLabel(u.protocol, 16)}` };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'endpoint must not embed credentials — reference the token by env NAME (headersEnv)' };
  if (!u.hostname) return { ok: false, reason: 'endpoint has no host' };
  if (u.hash) return { ok: false, reason: 'endpoint must not carry a fragment' };
  return { ok: true, url: u };
}

/** Read the merged settings view → validated telemetry config + problems. */
export function readTelemetryConfig(root, { settingsView } = {}) {
  let view = settingsView;
  if (!view) {
    // Late import would be circular-free but the settings surface is tiny —
    // read it directly to keep the engine dependency-light.
    try {
      const sp = path.join(String(root ?? ''), '.buddy', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(sp, 'utf8'));
      view = { chat: parsed?.chat ?? {} };
    } catch { view = {}; }
  }
  return parseTelemetryConfig(view?.chat?.telemetry);
}

// ── aggregation (pure) ───────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Aggregate projected events into one DELTA window. Pure. The per-tool map
 * is a null-prototype object — hostile names cannot pollute [[Prototype]].
 */
export function aggregateEvents(events, { maxDims = MAX_TOOL_DIMS } = {}) {
  const m = {
    turns: 0, calls: 0, tokIn: 0, tokOut: 0, denied: 0, compactions: 0,
    turnErrors: 0, eventsRead: 0, eventsTorn: 0, eventsIgnored: 0,
    byTool: Object.create(null),
    duration: { count: 0, sumMs: 0, buckets: new Array(HISTOGRAM_BOUNDS_MS.length + 1).fill(0) },
    dimsOverflow: false,
  };
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') { m.eventsTorn += 1; continue; }
    m.eventsRead += 1;
    if (ev.type === 'turn_end') {
      m.turns += 1;
      m.calls += num(ev.calls);
      m.tokIn += num(ev.tokIn);
      m.tokOut += num(ev.tokOut);
      if (ev.error) m.turnErrors += 1;
      const dur = num(ev.durationMs);
      m.duration.count += 1;
      m.duration.sumMs += dur;
      let b = 0;
      while (b < HISTOGRAM_BOUNDS_MS.length && dur >= HISTOGRAM_BOUNDS_MS[b]) b += 1;
      m.duration.buckets[b] += 1;
    } else if (ev.type === 'tool') {
      const denied = Boolean(ev.denied);
      if (denied) m.denied += 1;
      if (Object.keys(m.byTool).length >= maxDims && !(ev.tool in m.byTool)) { m.dimsOverflow = true; continue; }
      const label = sanitizeLabel(ev.tool);
      const slot = (m.byTool[label] ??= { ok: 0, denied: 0 });
      if (denied) slot.denied += 1; else slot.ok += 1;
    } else if (ev.type === 'compaction') {
      m.compactions += 1;
    } else {
      m.eventsIgnored += 1;
    }
  }
  return m;
}

const uintStr = (n) => String(Math.max(0, Math.floor(num(n))));

function attr(key, sValue) {
  return { key, value: { stringValue: String(sValue) } };
}
function intDp(valueInt, attrs = [], timeUnixNano) {
  const dp = { asInt: uintStr(valueInt), timeUnixNano };
  if (attrs.length) dp.attributes = attrs;
  return dp;
}

/**
 * Build an OTLP/HTTP JSON metrics payload (delta temporality). Pure — the
 * wire shape follows the OTLP JSON encoding: int64 fields as strings.
 */
export function buildOtlpPayload(m, { serviceName = 'engineer-buddy', version = PKG_VERSION, sessionRoot = '', timeUnixNano } = {}) {
  const t = timeUnixNano || String(Date.now()) + '000000';
  const resource = {
    attributes: [
      attr('service.name', serviceName),
      attr('service.version', sanitizeLabel(version, 32)),
      ...(sessionRoot ? [attr('buddy.session_root', sanitizeLabel(sessionRoot, 120))] : []),
    ],
  };
  const metrics = [];
  metrics.push({ name: 'buddy.turns', sum: { dataPoints: [intDp(m.turns, [], t)], aggregationTemporality: AGG_TEMPORALITY_DELTA, isMonotonic: true } });
  metrics.push({
    name: 'buddy.brain.calls',
    sum: { dataPoints: [intDp(m.calls, [], t)], aggregationTemporality: AGG_TEMPORALITY_DELTA, isMonotonic: true },
  });
  metrics.push({
    name: 'buddy.tokens',
    sum: {
      dataPoints: [
        intDp(m.tokIn, [attr('direction', 'in')], t),
        intDp(m.tokOut, [attr('direction', 'out')], t),
      ],
      aggregationTemporality: AGG_TEMPORALITY_DELTA,
      isMonotonic: true,
    },
  });
  const toolDps = Object.keys(m.byTool).flatMap((tool) => {
    const slot = m.byTool[tool];
    const rows = [];
    if (slot.ok) rows.push(intDp(slot.ok, [attr('tool', tool), attr('denied', 'false')], t));
    if (slot.denied) rows.push(intDp(slot.denied, [attr('tool', tool), attr('denied', 'true')], t));
    return rows;
  });
  if (toolDps.length === 0) {
    // an empty dataPoints array is legal OTLP, but an explicit zero with a
    // named placeholder series is friendlier to dashboards — and honest
    toolDps.push(intDp(0, [attr('tool', '_none'), attr('denied', 'false')], t));
  }
  metrics.push({
    name: 'buddy.tool.calls',
    sum: { dataPoints: toolDps, aggregationTemporality: AGG_TEMPORALITY_DELTA, isMonotonic: true },
  });
  metrics.push({ name: 'buddy.compactions', sum: { dataPoints: [intDp(m.compactions, [], t)], aggregationTemporality: AGG_TEMPORALITY_DELTA, isMonotonic: true } });
  metrics.push({
    name: 'buddy.turn.duration',
    histogram: {
      dataPoints: [{
        asDouble: m.duration.sumMs,
        count: uintStr(m.duration.count),
        bucketCounts: m.duration.buckets.map(uintStr),
        explicitBounds: HISTOGRAM_BOUNDS_MS,
        timeUnixNano: t,
      }],
      aggregationTemporality: AGG_TEMPORALITY_DELTA,
    },
  });
  return { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'engineer-buddy.telemetry', version: sanitizeLabel(version, 32) }, metrics }] }] };
}

// ── the cursor (channels drain discipline, carried) ──────────────────────────

/** Explicit reset (the operator's own finger): cursor → end of the CURRENT
 *  log. History is skipped from now on — never deleted, the events log is
 *  not touched. Returns the new cursor position. */
export function resetCursorToEnd(root) {
  let size = 0;
  try { size = fs.statSync(eventsFile(root)).size; } catch { size = 0; } // no log yet: 0 is the truth
  writeCursor(root, size);
  return size;
}

function readCursor(root) {
  try {
    const raw = fs.readFileSync(cursorPath(root), 'utf8');
    const j = JSON.parse(raw);
    const pos = Math.floor(num(j.pos));
    return { pos, updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null, torn: false };
  } catch {
    return { pos: 0, updatedAt: null, torn: true }; // absent or hostile — start honestly at 0
  }
}

function writeCursor(root, pos, { now = new Date().toISOString() } = {}) {
  fs.mkdirSync(telemetryDirPath(root), { recursive: true });
  fs.writeFileSync(cursorPath(root), `${JSON.stringify({ pos, updatedAt: now })}\n`, 'utf8');
}

// ── reading the events window (bounded, never loads the whole log) ───────────

function readEventsWindow(file, pos) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { raw: '', size: 0, exists: false }; }
  if (pos >= size) return { raw: '', size, exists: true };
  const len = Math.min(MAX_WINDOW_BYTES, size - pos);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, pos + off);
      if (n <= 0) break;
      off += n;
    }
    return { raw: buf.toString('utf8', 0, off), size, exists: true };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a window of bytes into complete event lines. Returns the events, the
 * byte length CONSUMED (through the last complete '\n'), and honest counters.
 * A trailing fragment without '\n' is left for the next export (it may still
 * be completing); a single line over the window with NO newline is counted as
 * a giant and the cursor steps over it — it can never wedge the stream.
 */
export function parseWindow(raw, { atEof } = {}) {
  const events = [];
  let consumed = 0, torn = 0, giants = 0;
  let start = 0;
  for (;;) {
    const nl = raw.indexOf('\n', start);
    if (nl === -1) {
      const tail = raw.slice(start);
      if (tail.length > 0) {
        if (atEof) {
          // trailing fragment at EOF: not complete, never consumed, counted
          // as pending — the next export sees it completed or still torn.
        } else if (tail.length >= MAX_WINDOW_BYTES) {
          giants += 1; // a window-full with no newline — step over it, honestly
          consumed += tail.length;
        }
        // (window boundary mid-line: leave it — more bytes may follow)
      }
      break;
    }
    const line = raw.slice(start, nl);
    consumed += line.length + 1;
    start = nl + 1;
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      torn += 1; // a corpse line is counted, skipped, never guessed
    }
  }
  return { events, consumed, torn, giants };
}

// ── the JSONL sink ───────────────────────────────────────────────────────────

function appendSinkRecord(root, record, { maxBytes = DEFAULT_MAX_SINK_BYTES } = {}) {
  const file = metricsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size + line.length > maxBytes) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch { /* rotation is an optimization */ }
  fs.appendFileSync(file, line, 'utf8');
  return file;
}

/** Read the last n export records (torn lines skipped, never surfaced). */
export function readExportLog(root, n = 10) {
  try {
    const raw = fs.readFileSync(metricsPath(root), 'utf8');
    const out = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* torn */ }
    }
    return out.slice(-Math.max(1, n));
  } catch { return []; }
}

// ── the OTLP wire (one fetch, hard timeout, honest failure) ──────────────────

async function postOtlp(endpoint, payload, { token, fetchImpl, timeoutMs = OTLP_TIMEOUT_MS } = {}) {
  const f = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // RED TEAM v0.53: a hostile env VALUE with newlines must never be able to
    // split the Authorization header — the value is stripped of CR/LF here,
    // at the ONE place a header is built, regardless of caller diligence
    // (defense in depth: fetch/undici would refuse it anyway — we refuse it
    // first, without relying on the wire library's mood).
    const safeToken = typeof token === 'string' ? token.replace(/[\r\n\u0000-\u001f\u007f]+/g, '') : null;
    const headers = {
      'content-type': 'application/json',
      'user-agent': `engineer-buddy/${PKG_VERSION} telemetry`,
      ...(safeToken ? { authorization: `Bearer ${safeToken}` } : {}),
    };
    const res = await f(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    // the response BODY is never quoted (the v0.48 discipline: a hostile
    // collector echoing the token back leaks nothing — we keep the status only)
    return { attempted: true, sent: res.ok, status: res.status, reason: res.ok ? null : `collector answered ${res.status}` };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : sanitizeLabel(String(e?.message || e), 120);
    return { attempted: true, sent: false, status: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

function writeStatusGauge(root, gauge) {
  try {
    fs.mkdirSync(telemetryDirPath(root), { recursive: true });
    fs.writeFileSync(statusPath(root), `${JSON.stringify({ ...gauge, at: gauge.at || new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch { /* the gauge is best-effort */ }
}

// ── the export (the one entry point) ─────────────────────────────────────────

/**
 * Export one DELTA window: read new events since the cursor, aggregate, land
 * the JSONL sink record, advance the cursor, and (if configured + a token
 * env is resolvable) POST the OTLP payload.
 *
 * opts: { now, fetchImpl, token (resolved VALUE — resolved by the caller, the
 * engine never touches process.env), maxSinkBytes, dryRun }
 */
export async function exportTelemetry(root, opts = {}) {
  const problems = [];
  const { config: cfg, problems: cfgProblems } = readTelemetryConfig(root);
  problems.push(...cfgProblems);
  const nowIso = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
  const file = eventsFile(root);
  const cur = readCursor(root);
  let pos = cur.pos;

  const { raw, size } = readEventsWindow(file, pos);
  const win = { fromIso: null, toIso: null, bytes: 0 };
  let reset = false;

  let parsed;
  if (cur.pos > size) {
    // the log shrank (rotated/truncated): honest reset, announced — and the
    // stale cursor is unstuck IMMEDIATELY (written to 0), or every future
    // export would re-reset forever
    reset = true;
    pos = 0;
    problems.push(`events log shrank below the cursor (${cur.pos} > ${size}) — reset to 0`);
    try { writeCursor(root, 0, { now: nowIso }); } catch { /* the next export re-detects */ }
    const r2 = readEventsWindow(file, 0);
    parsed = parseWindow(r2.raw, { atEof: true });
  } else {
    const atEof = pos + raw.length >= size;
    parsed = parseWindow(raw, { atEof });
  }
  win.bytes = parsed.consumed;
  const startPos = reset ? 0 : cur.pos; // the shrink branch resets the origin to 0

  const agg = aggregateEvents(parsed.events);

  // window bounds from the events themselves (honest when empty)
  const stamps = parsed.events.map((e) => e?.ts).filter((s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)));
  win.fromIso = stamps.length ? stamps[0] : nowIso;
  win.toIso = stamps.length ? stamps[stamps.length - 1] : nowIso;

  const hasNew = win.bytes > 0 || parsed.torn > 0 || parsed.giants > 0;
  const result = {
    ok: true,
    dryRun: Boolean(opts.dryRun),
    reset,
    cursor: { before: cur.pos, after: startPos + win.bytes },
    events: { read: agg.eventsRead, torn: agg.eventsTorn + parsed.torn, ignored: agg.eventsIgnored, giants: parsed.giants },
    metrics: agg,
    window: win,
    sink: null,
    otlp: { attempted: false, sent: false, status: null, reason: null },
    problems,
  };

  if (opts.dryRun) {
    if (cfg.endpoint) result.otlp.wouldPost = true;
    result.payloadHead = JSON.stringify(buildOtlpPayload(agg, { sessionRoot: String(root), timeUnixNano: String(new Date(nowIso).getTime()) + '000000' })).slice(0, 400);
    return result; // ZERO side effects: no sink line, no cursor move, no POST
  }
  if (!hasNew) {
    result.note = 'no new complete events since the cursor — nothing exported';
    return result; // honest empty; no sink line, cursor untouched
  }

  const record = {
    v: 1,
    ts: nowIso,
    version: PKG_VERSION,
    window: win,
    reset,
    events: result.events,
    turns: agg.turns,
    calls: agg.calls,
    tokIn: agg.tokIn,
    tokOut: agg.tokOut,
    denied: agg.denied,
    compactions: agg.compactions,
    turnErrors: agg.turnErrors,
    byTool: agg.byTool,
    duration: agg.duration,
    dimsOverflow: agg.dimsOverflow,
    problems,
  };
  try {
    result.sink = appendSinkRecord(root, record, { maxBytes: opts.maxSinkBytes });
  } catch (e) {
    result.ok = false;
    problems.push(`sink write failed — ${sanitizeLabel(String(e?.message || e), 120)}`);
    return result; // the sink IS the local record; without it do not advance
  }

  // the cursor advances ONLY after the sink landed (the drain discipline)
  try { writeCursor(root, result.cursor.after, { now: nowIso }); } catch (e) {
    problems.push(`cursor write failed — ${sanitizeLabel(String(e?.message || e), 120)}`);
  }

  // the wire: only when configured; a missing token env is an honest skip
  if (cfg.endpoint) {
    const timeUnixNano = String(new Date(nowIso).getTime()) + '000000';
    const payload = buildOtlpPayload(agg, { sessionRoot: String(root), timeUnixNano });
    if (!cfg.headersEnv) {
      // the operator runs an unauthenticated collector — their call, not ours
      const r = await postOtlp(cfg.endpoint, payload, { token: null, fetchImpl: opts.fetchImpl });
      result.otlp = r;
      writeStatusGauge(root, { otlp: r, endpoint: cfg.endpoint });
    } else if (typeof opts.token === 'string' && opts.token !== '') {
      const r = await postOtlp(cfg.endpoint, payload, { token: opts.token, fetchImpl: opts.fetchImpl });
      result.otlp = r;
      writeStatusGauge(root, { otlp: r, endpoint: cfg.endpoint });
    } else {
      result.otlp = { attempted: false, sent: false, status: null, reason: `env ${cfg.headersEnv} is unset — set it to export (the VALUE never touches config or disk)` };
      writeStatusGauge(root, { otlp: result.otlp, endpoint: cfg.endpoint });
    }
  }
  return result;
}

// ── the auto flush (REPL, opt-in, never breaks a turn) ───────────────────────

/**
 * The turn-boundary flush. Runs ONLY when chat.telemetry.enabled is true —
 * with the default this returns null without creating a single byte (the
 * opt-in contract). The JSONL sink is written synchronously (fast, bounded);
 * the OTLP POST is scheduled fire-and-forget with a hard timeout so a slow
 * collector can never hold a turn. Every failure is swallowed.
 */
export function autoFlush(root, { env = process.env } = {}) {
  try {
    const { config: cfg } = readTelemetryConfig(root);
    if (!cfg || cfg.enabled !== true) return null; // OFF means OFF: zero activity
    return exportTelemetry(root, {
      token: cfg.headersEnv ? env[cfg.headersEnv] : undefined, // undefined = honest skip on the wire
    }).catch(() => null); // telemetry must never break a turn
  } catch {
    return null; // telemetry must never break a turn
  }
}

// ── views ────────────────────────────────────────────────────────────────────

function fmtInt(n) { return String(Math.floor(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '_'); }

/**
 * All-time view over the CURRENT events log (the view is state, the export
 * is the stream). Reads are bounded and torn-tolerant.
 */
export function telemetryViewText(root) {
  const lines = [];
  const { config: cfg, problems: cfgProblems } = readTelemetryConfig(root);
  const file = eventsFile(root);
  let raw = '';
  let truncated = false;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_WINDOW_BYTES) {
      truncated = true;
      const buf = Buffer.alloc(MAX_WINDOW_BYTES);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, MAX_WINDOW_BYTES, st.size - MAX_WINDOW_BYTES); } finally { fs.closeSync(fd); }
      raw = buf.toString('utf8');
      raw = raw.slice(raw.indexOf('\n') + 1); // drop the torn head fragment
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { /* no log yet */ }
  const parsed = parseWindow(raw, { atEof: true });
  const agg = aggregateEvents(parsed.events);

  const cur = readCursor(root);
  lines.push('telemetry — opt-in metrics over .buddy/events.jsonl (v0.53.0)');
  lines.push('');
  lines.push(`  config (chat.telemetry):`);
  lines.push(`    enabled    : ${cfg.enabled ? 'true — auto-flush ON at turn boundaries' : 'false — auto-flush OFF (default; explicit `buddy telemetry export` still works)'}`);
  lines.push(`    endpoint   : ${cfg.endpoint ? cfg.endpoint : '(none — JSONL sink only)'}`);
  lines.push(`    headersEnv : ${cfg.headersEnv ? `$${cfg.headersEnv} (the VALUE lives in the environment, never in config)` : '(none — the collector is treated as unauthenticated)'}`);
  for (const p of cfgProblems) lines.push(`    problem    : ${p}`);
  lines.push('');
  if (agg.eventsRead === 0 && parsed.torn === 0) {
    lines.push('  no events yet — the events log is empty or absent (nothing is invented).');
  } else {
    lines.push(`  all-time totals${truncated ? ` (last ${fmtInt(MAX_WINDOW_BYTES)}B of the log — older bytes exist)` : ''}:`);
    lines.push(`    events read: ${fmtInt(agg.eventsRead)}   torn: ${fmtInt(parsed.torn + agg.eventsTorn)}   other types: ${fmtInt(agg.eventsIgnored)}`);
    lines.push(`    turns: ${fmtInt(agg.turns)}   brain calls: ${fmtInt(agg.calls)}   compactions: ${fmtInt(agg.compactions)}   turn errors: ${fmtInt(agg.turnErrors)}`);
    lines.push(`    tokens: ~${fmtInt(agg.tokIn)} in · ~${fmtInt(agg.tokOut)} out`);
    lines.push(`    tool calls: ${fmtInt(agg.eventsRead >= 0 ? Object.values(agg.byTool).reduce((a, s) => a + s.ok + s.denied, 0) : 0)} (denied: ${fmtInt(agg.denied)})`);
    if (agg.duration.count > 0) {
      lines.push(`    turn duration: count ${fmtInt(agg.duration.count)} · sum ${(agg.duration.sumMs / 1000).toFixed(1)}s · buckets [${HISTOGRAM_BOUNDS_MS.join(', ')}]ms → [${agg.duration.buckets.join(', ')}]`);
    }
    const tools = Object.keys(agg.byTool);
    if (tools.length) {
      lines.push('    per tool:');
      for (const t of tools.slice(0, 12)) {
        const s = agg.byTool[t];
        lines.push(`      ${t.padEnd(24, ' ').slice(0, 24)} ok ${fmtInt(s.ok)} · denied ${fmtInt(s.denied)}`);
      }
      if (tools.length > 12) lines.push(`      … ${tools.length - 12} more distinct tools`);
      if (agg.dimsOverflow) lines.push('      (over the distinct-tool cap — some calls were not attributed)');
    }
  }
  lines.push('');
  lines.push(`  export cursor: ${fmtInt(cur.pos)} bytes${cur.torn ? ' (cursor file absent/hostile — next export starts from 0)' : ''}`);
  const sink = readExportLog(root, 1)[0];
  lines.push(`  export sink  : ${sink ? `${readExportLog(root, 10000).length} record(s) in .buddy/telemetry/metrics.jsonl (last: ${sink.ts})` : 'empty — nothing exported yet'}`);
  try {
    const st = JSON.parse(fs.readFileSync(statusPath(root), 'utf8'));
    lines.push(`  last OTLP    : ${st.otlp?.sent ? `sent (collector answered ${st.otlp.status})` : `NOT sent — ${st.otlp?.reason || 'unknown reason'}`} at ${st.at}`);
  } catch { lines.push('  last OTLP    : (no attempt on record)'); }
  lines.push('');
  lines.push('  export now  : buddy telemetry export [--dry-run]');
  lines.push('  start fresh : buddy telemetry reset --yes   (cursor → end of log; history is skipped, not deleted)');
  return lines.join('\n');
}
