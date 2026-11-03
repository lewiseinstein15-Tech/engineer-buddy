// delivery.js — the durable outbound ledger (v0.68.0, wave 2 of the serve
// rebuild).
//
// Hermes mechanism (docs/hermes-deep-map.md row 15, delivery_ledger.py +
// delivery_queue.py): an outbound send that matters is PERSISTED as an
// obligation BEFORE it is attempted, and a crash anywhere in the window is a
// named, bounded outcome — never a mystery, never a silent loss, never a
// fork bomb of retries. Buddy's version is one append-only JSONL ledger
// (.buddy/serve/obligations.jsonl) holding two row kinds:
//
//   {kind:'job', id, target, …}            — an obligation (immutable)
//   {kind:'evt', id, event:…}              — what happened to it, in order
//
// The state of a job is the FOLD of its events, so the file is append-only
// end to end and a torn line can never corrupt a verdict. The bounds are
// Hermes' own, restated as code:
//   - redelivery: 3 attempts, 30s then 120s backoff, then terminal 'failed';
//   - at-most-once: a send is CLAIMED before it runs; a claim whose owner
//     died in the window resolves terminal 'unknown' — losing a delivery is
//     safer than duplicating one;
//   - dead targets: a target that answers 403/404/410 once is parked forever
//     (dead-targets.json) — later obligations to it die on arrival with zero
//     attempts;
//   - enqueue works with NO daemon running: the files are the interface, the
//     daemon is just the flusher. A backlog is an honest, visible fact
//     (buddy serve status), not a failure.
//
// Payload discipline: the prompt never rides the wire — goal notices carry
// status + said + artifact paths (promptChars discipline, goals.js §).

import fs from 'node:fs';
import path from 'node:path';
import { fetchWithTimeout } from '../util.js';
import {
  obligationsPath,
  payloadsDir,
  deadTargetsPath,
  appendJsonl,
  readJsonl,
  readJson,
  atomicWrite,
} from './paths.js';

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [30_000, 120_000]; // attempt 1 → +30s, attempt 2 → +120s
export const INLINE_PAYLOAD_CAP = 16_000;
export const DEAD_STATUSES = new Set([403, 404, 410]); // re-sending can never help
export const RETRYABLE_STATUSES = new Set([408, 425, 429]); // 4xx worth another bounded try
export const BATCH_PER_TICK = 20;
export const COMPACT_LINES = 5000;
export const SEND_TIMEOUT_MS = 15_000;

const rndId = () => 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const cap = (s, n) => { const str = String(s ?? ''); return str.length <= n ? str : str.slice(0, n); };

// ── pure decision helpers (unit-tested directly) ────────────────────────────

/** Backoff for the NEXT attempt. attempts = the failure count so far.
 *  Returns the delay before the next try, or null when the budget is spent
 *  (terminal — no loops, ever). */
export function nextRetryDelayMs(attempts) {
  const a = Number(attempts) || 0;
  if (a < 1) return RETRY_DELAYS_MS[0];
  return a < MAX_ATTEMPTS ? RETRY_DELAYS_MS[Math.min(a, RETRY_DELAYS_MS.length) - 1] : null;
}

/** Classify one send outcome. status: an HTTP status number, or 0 for a
 *  network-level failure (timeout, refused, DNS). */
export function classifySend(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return 'sent';
  if (DEAD_STATUSES.has(s)) return 'dead';
  if (RETRYABLE_STATUSES.has(s)) return 'transient'; // 408/425/429 — the target said "later"
  if (s >= 400 && s < 500) return 'permanent';
  return 'transient'; // 0, 5xx — the wire, not the target
}

// ── enqueue: the commit point BEFORE any send ───────────────────────────────

/** Persist an obligation. Works with or without a daemon — the ledger file
 *  IS the interface. Returns {ok:true, id} or {ok:false, error}. */
export function enqueueDelivery(root, { kind = 'webhook', target, payload, summary = '' } = {}) {
  try {
    if (!['webhook'].includes(String(kind))) return { ok: false, error: `unknown delivery kind "${cap(kind, 24)}" — known: webhook` };
    let url;
    try { url = new URL(String(target ?? '')); } catch { return { ok: false, error: 'delivery target must be an absolute http(s) URL' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `delivery target scheme must be http(s) — got "${cap(url.protocol, 16)}"` };
    }
    if (url.hostname === '169.254.169.254' || url.hostname.endsWith('.169.254.169.254')) {
      return { ok: false, error: 'delivery target refused — cloud metadata endpoints are never a delivery target' };
    }
    const id = rndId();
    let body = null, payloadRef = null;
    try { body = payload == null ? null : JSON.stringify(payload); } catch { body = null; }
    if (body != null && body.length > INLINE_PAYLOAD_CAP) {
      const dir = payloadsDir(root);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ref = path.join(dir, `${id}.json`);
      fs.writeFileSync(ref, body, { mode: 0o600 });
      payloadRef = ref;
      body = null;
    }
    const job = {
      kind: 'job',
      id,
      delivery: String(kind),
      target: url.toString(),
      summary: cap(summary, 160),
      payloadInline: body == null ? null : JSON.parse(body),
      payloadRef,
      createdAt: new Date().toISOString(),
    };
    if (!appendJsonl(obligationsPath(root), job)) return { ok: false, error: 'obligations ledger append failed' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: cap(String(e?.message || e), 200) };
  }
}

// ── the view: fold events over jobs ─────────────────────────────────────────

/** Fold the ledger into one row per job: state, attempts, nextAt, lastError.
 *  Torn/giant lines are counted facts on the view, never junk rows. */
export function loadDeliveryView(root) {
  const { rows, torn, giants } = readJsonl(obligationsPath(root));
  const jobs = new Map();
  for (const r of rows) {
    if (r.kind === 'job') {
      jobs.set(r.id, {
        id: r.id,
        delivery: r.delivery ?? 'webhook',
        target: r.target ?? '',
        summary: r.summary ?? '',
        payloadInline: r.payloadInline ?? null,
        payloadRef: r.payloadRef ?? null,
        createdAt: r.createdAt ?? null,
        state: 'pending',
        attempts: 0,
        nextAt: Number.isFinite(Number(r.nextAt)) ? Number(r.nextAt) : null,
        lastError: null,
        sentAt: null,
      });
      continue;
    }
    const j = r.kind === 'evt' ? jobs.get(r.id) : null;
    if (!j) continue; // an event for an unknown/compacted job — tolerated, ignored
    switch (r.event) {
      case 'claim':
        if (j.state === 'pending') { j.state = 'claimed'; j.claimedAt = r.at ?? null; j.claimedBy = r.lease ?? null; }
        break;
      case 'sent':
        j.state = 'sent'; j.sentAt = r.at ?? null; break;
      case 'failed':
        j.attempts = Math.max(j.attempts, Number(r.attempts) || 0);
        j.lastError = r.detail ?? null;
        j.nextAt = Number.isFinite(Number(r.nextAt)) ? Number(r.nextAt) : null;
        j.state = r.terminal ? 'failed' : 'pending';
        break;
      case 'dead':
        j.state = 'dead'; j.lastError = r.detail ?? null; break;
      case 'unknown':
        j.state = 'unknown'; j.lastError = r.detail ?? null; break;
      default:
        break; // unknown event names are tolerated — the fold ignores them
    }
  }
  return { jobs: [...jobs.values()], torn, giants };
}

// ── dead targets: attempted once, parked forever ────────────────────────────

export function loadDeadTargets(root) {
  const doc = readJson(deadTargetsPath(root));
  const targets = doc && typeof doc === 'object' && doc.targets && typeof doc.targets === 'object' ? doc.targets : {};
  return { targets, count: Object.keys(targets).length };
}

export function markDeadTarget(root, target, reason) {
  const { targets } = loadDeadTargets(root);
  if (!targets[target]) {
    targets[target] = { reason: cap(reason, 160), at: new Date().toISOString() };
    atomicWrite(deadTargetsPath(root), JSON.stringify({ targets }, null, 2) + '\n');
  }
}

/** The operator revives a parked target (after fixing whatever answered
 *  404). Exact URL or unambiguous prefix; ambiguity is refused, not guessed. */
export function forgetDeadTarget(root, needle) {
  const { targets } = loadDeadTargets(root);
  const key = Object.keys(targets).find((t) => t === needle || t.startsWith(String(needle ?? '\u0000')));
  if (!key) return { ok: false, error: `no parked target matches "${cap(String(needle ?? ''), 80)}" — buddy serve targets lists them` };
  const matches = Object.keys(targets).filter((t) => t.startsWith(String(needle ?? '\u0000')));
  if (matches.length > 1) return { ok: false, error: `"${cap(String(needle), 60)}" matches ${matches.length} parked targets — be more specific: ${matches.map((m) => cap(m, 60)).join(' · ')}` };
  delete targets[key];
  atomicWrite(deadTargetsPath(root), JSON.stringify({ targets }, null, 2) + '\n');
  return { ok: true, forgotten: key };
}

// ── the sender (one fetch, hard timeout, honest statuses) ───────────────────

async function sendWebhook(target, payload, { fetchImpl, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  try {
    const res = await (fetchImpl || fetchWithTimeout)(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'engineer-buddy-serve' },
      body: JSON.stringify(payload ?? {}),
    }, timeoutMs);
    // The body is never quoted back (the v0.48 discipline) — statuses only.
    return { status: res.status, error: null };
  } catch (e) {
    return { status: 0, error: cap(String(e?.message || e), 160) };
  }
}

function readPayload(job) {
  if (job.payloadRef) {
    try { return JSON.parse(fs.readFileSync(job.payloadRef, 'utf8')); } catch { return { deliveryError: 'payload file unreadable' }; }
  }
  return job.payloadInline ?? {};
}

// ── sweep: boot-time honest settlement + compaction ─────────────────────────

/** Settle claims whose owner died mid-send: terminal 'unknown', never
 *  retried (at-most-once — the one place losing beats duplicating). Also
 *  compacts an oversized ledger to its live state. Daemon-only under lease;
 *  `buddy serve sweep` runs it offline on purpose. */
export function sweepDelivery(root, { bootId = 'offline', compactLines = COMPACT_LINES } = {}) {
  const view = loadDeliveryView(root);
  let settledUnknown = 0;
  for (const j of view.jobs) {
    if (j.state === 'claimed') {
      appendJsonl(obligationsPath(root), {
        kind: 'evt', id: j.id, event: 'unknown', at: new Date().toISOString(),
        lease: j.claimedBy ?? bootId,
        detail: 'the send was claimed but its owner died before the outcome landed — at-most-once: never retried',
      });
      settledUnknown += 1;
    }
  }
  let compacted = false;
  const file = obligationsPath(root);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const lineCount = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      if (lineCount > compactLines) {
        const fresh = loadDeliveryView(root);
        const lines = [];
        const jobRow = (j) => JSON.stringify({
          kind: 'job', id: j.id, delivery: j.delivery, target: j.target, summary: j.summary,
          payloadInline: j.payloadRef ? null : j.payloadInline, payloadRef: j.payloadRef,
          createdAt: j.createdAt, nextAt: j.nextAt ?? null,
        });
        // Terminal states re-fold correctly only as EVENTS — a job row alone
        // always folds to 'pending', so each kept job re-plays the one event
        // that carries its current state (the fold is the format).
        const stateEvt = (j) => {
          const at = j.sentAt ?? new Date().toISOString();
          if (j.state === 'sent') return { kind: 'evt', id: j.id, event: 'sent', at };
          if (j.state === 'failed') return { kind: 'evt', id: j.id, event: 'failed', at, terminal: true, attempts: j.attempts, detail: j.lastError };
          if (j.state === 'dead') return { kind: 'evt', id: j.id, event: 'dead', at, detail: j.lastError };
          if (j.state === 'unknown') return { kind: 'evt', id: j.id, event: 'unknown', at, detail: j.lastError };
          if (j.state === 'claimed') return { kind: 'evt', id: j.id, event: 'claim', at: j.claimedAt ?? at, lease: j.claimedBy ?? bootId };
          return null; // pending — the job row alone is the whole truth
        };
        for (const j of fresh.jobs.slice(-2000)) {
          lines.push(jobRow(j));
          const evt = stateEvt(j);
          if (evt) lines.push(JSON.stringify(evt));
        }
        atomicWrite(file, lines.join('\n') + '\n');
        compacted = true;
      }
    }
  } catch { /* compaction is an optimization — the fold still reads the long file */ }
  return { settledUnknown, compacted, torn: view.torn, giants: view.giants };
}

// ── the tick: claim → send → settle, bounded per pass ───────────────────────

/** One delivery pass. Claims BEFORE sending (at-most-once), settles every
 *  claim with an explicit event, never lets one bad target stall the batch. */
export async function processDueDelivery(root, {
  nowMs = Date.now(),
  bootId = 'offline',
  paused = false,
  sender = null,
  batch = BATCH_PER_TICK,
} = {}) {
  if (paused) return { paused: true, sent: 0, retried: 0, dead: 0, failed: 0, unknown: 0, skippedDead: 0 };
  const view = loadDeliveryView(root);
  const { targets: dead } = loadDeadTargets(root);
  const send = sender || ((t, p) => sendWebhook(t, p));
  const due = view.jobs
    .filter((j) => j.state === 'pending' && (j.nextAt == null || j.nextAt <= nowMs))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, Math.max(1, Math.min(Number(batch) || BATCH_PER_TICK, 100)));
  const out = { paused: false, sent: 0, retried: 0, dead: 0, failed: 0, unknown: 0, skippedDead: 0 };
  for (const j of due) {
    if (dead[j.target]) {
      appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'dead', at: new Date().toISOString(), detail: `target parked (${dead[j.target].reason}) — zero attempts` });
      out.skippedDead += 1;
      continue;
    }
    appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'claim', at: new Date().toISOString(), lease: bootId });
    const r = await send(j.target, readPayload(j));
    const verdict = classifySend(r.status);
    const at = new Date().toISOString();
    if (verdict === 'sent') {
      appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'sent', at });
      out.sent += 1;
    } else if (verdict === 'dead') {
      markDeadTarget(root, j.target, `HTTP ${r.status}`);
      appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'dead', at, detail: `HTTP ${r.status} — target parked` });
      out.dead += 1;
    } else if (verdict === 'permanent') {
      appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'failed', at, terminal: true, attempts: j.attempts + 1, detail: `HTTP ${r.status} — permanent, not retried` });
      out.failed += 1;
    } else {
      const delay = nextRetryDelayMs(j.attempts + 1);
      const attempts = j.attempts + 1;
      if (delay == null) {
        appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'failed', at, terminal: true, attempts, detail: `${r.error || `HTTP ${r.status}`} — retry budget spent (${MAX_ATTEMPTS})` });
        out.failed += 1;
      } else {
        appendJsonl(obligationsPath(root), { kind: 'evt', id: j.id, event: 'failed', at, attempts, nextAt: nowMs + delay, detail: r.error || `HTTP ${r.status}` });
        out.retried += 1;
      }
    }
  }
  return out;
}

// ── the status renderer (facts, one line each) ──────────────────────────────

export function deliveryStatusText(root, { nowMs = Date.now() } = {}) {
  const view = loadDeliveryView(root);
  const { targets: dead, count: deadCount } = loadDeadTargets(root);
  const byState = { pending: 0, claimed: 0, sent: 0, failed: 0, dead: 0, unknown: 0 };
  let oldestPending = null;
  for (const j of view.jobs) {
    byState[j.state] = (byState[j.state] ?? 0) + 1;
    if (j.state === 'pending' && (oldestPending == null || String(j.createdAt) < oldestPending)) oldestPending = j.createdAt;
  }
  const lines = [
    `obligations: ${view.jobs.length} total — pending ${byState.pending} · claimed ${byState.claimed} · sent ${byState.sent} · failed ${byState.failed} · dead ${byState.dead} · unknown ${byState.unknown}`,
  ];
  if (oldestPending) {
    const age = Math.round((nowMs - Date.parse(oldestPending)) / 60000);
    lines.push(`oldest pending: ${age} min${!Number.isFinite(age) || age > 60 ? ' — is the daemon running? buddy serve start' : ''}`);
  }
  if (view.torn || view.giants) lines.push(`ledger hygiene: ${view.torn} torn · ${view.giants} giant line(s) counted, never guessed`);
  if (deadCount) {
    lines.push(`dead targets (${deadCount}) — attempted once, parked: buddy serve targets --forget <url> to revive`);
    for (const [t, info] of Object.entries(dead).slice(0, 5)) lines.push(`  ${cap(t, 90)} — ${cap(info.reason, 60)}`);
  }
  return lines.join('\n');
}
