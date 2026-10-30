// watcher.js — the background workspace watcher (v0.60.0, the capability
// audit's gap #4): Buddy notices what moves in the workspace BETWEEN turns.
//
// The contract is deliberately narrow and honest:
//   BETWEEN-TURNS ONLY  — the OS watch is PAUSED for the whole duration of a
//     turn and RESUMED when it ends. The agent can never echo its own writes
//     back into its context: while Buddy works, nothing is watched; the drift
//     window is exactly "what changed while you were away". (In-turn external
//     changes are a named non-goal of this wave — a dev server writing logs
//     mid-turn is invisible to the drift window, and the checklist says so.)
//   FACTS, NOT CONTENT — an event row is {path, kind, at}. The file is never
//     opened, never read, never hashed: a watched file's BYTES cannot reach
//     the model, the events log, or the TUI (the drill plants a canary inside
//     a watched file and proves zero canary bytes anywhere).
//   HONEST ABOUT ITS SHAPE — fs.watch is the machine's own mechanism: if the
//     platform or the filesystem refuses (ENOENT, EMFILE, a non-directory
//     root), the watcher reports {started:false, reason} with the REAL error
//     and the session runs exactly as before — a watcher that cannot watch
//     never pretends to, and it can never break a turn.
//   BOUNDED UNDER FIRE — a burst of events coalesces per path (latest kind
//     wins), caps at maxEvents distinct paths, and counts the rest as
//     `suppressed` (the honesty number, never silent loss).
//
// Zero dependencies: fs.watch recursive (Node >= 20 floor, documented since
// v0.57's Install section) — no chokidar, no polling unless the platform
// gives us nothing (and then it says so).
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../eventslog.js';

// the two state directories are NEVER watched: the watcher must not report
// the agent's own bookkeeping (and .buddy/events.jsonl would otherwise make
// every turn a self-echo)
const EXCLUDED_DIRS = new Set(['.buddy', '.git']);
export const DRIFT_CLOSE = '(end workspace drift)';

const clamp = (v, lo, hi, dflt) => {
  try {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  } catch {
    return dflt;
  }
};

/**
 * Sanitize a watched path for display/injection. Paths arrive from the OS
 * (or from a hostile repo's filenames): control bytes (including the \n and
 * \r a POSIX filename may legally carry) are stripped so a path can never
 * forge a new line, and the drift-block close marker is defanged in place
 * so a filename cannot close the fence early. The result is DATA.
 * @param {any} raw
 * @param {{maxLen?: number}} [o]
 * @returns {string}
 */
export function sanitizeWatchPath(raw, { maxLen = 200 } = {}) {
  let s = '';
  try {
    s = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : String(raw ?? '');
  } catch {
    return '<unreadable>';
  }
  if (!s) return '<unknown>';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || c === 0x7f ? ' ' : ch; // control bytes — including \n, \r, \t
    if (out.length >= maxLen) break;
  }
  out = out.slice(0, maxLen);
  while (out.includes(DRIFT_CLOSE)) out = out.replace(DRIFT_CLOSE, '( end workspace drift )');
  return out || '<unknown>';
}

/**
 * Build the bounded drift fence from accumulated rows. Counts and paths
 * only — never file content. Paths one per line under a fixed prefix; the
 * fence closes with DRIFT_CLOSE, which sanitizeWatchPath has already made
 * impossible to forge from inside a path.
 * @param {Array<{path:string,kind:string,at:number}>} rows
 * @param {{max?: number}} [o]
 */
export function driftBlock(rows, { max = 8 } = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const shown = list.slice(0, Math.max(1, max));
  const rest = list.length - shown.length;
  const lines = [
    `[workspace drift] ${list.length} file${list.length === 1 ? '' : 's'} changed in this workspace between turns:`,
    ...shown.map((r) => `  - ${sanitizeWatchPath(r.path)} (${r.kind === 'rename' ? 'created/removed/renamed' : 'modified'})`),
    ...(rest > 0 ? [`  ... and ${rest} more (suppressed by the drift cap)`] : []),
    DRIFT_CLOSE,
  ];
  return lines.join('\n');
}

/**
 * Start watching `root` recursively. Never throws: an unwatchable workspace
 * is an honest {started:false, reason}.
 * @param {string} root absolute workspace root
 * @param {{debounceMs?: number, maxEvents?: number, onFlush?: (batch: {rows: any[], suppressed: number}) => void}} [opts]
 *        onFlush (CLI mode) fires roughly every debounceMs with the current
 *        coalesced batch and resets it; without onFlush (REPL mode) the
 *        accumulator is read by drain().
 */
export function startWorkspaceWatcher(root, opts = {}) {
  let o;
  try {
    o = { ...opts };
  } catch {
    o = {};
  }
  const debounceMs = clamp(o.debounceMs, 50, 5000, 400);
  const maxEvents = clamp(o.maxEvents, 1, 4096, 512);
  const onFlush = typeof o.onFlush === 'function' ? o.onFlush : null;

  const stats = { startedAt: null, eventsSeen: 0, suppressed: 0, pauses: 0, resumes: 0, deaths: 0 };
  let watcher = null;
  let paused = false;
  let dead = null; // { reason } once the OS watch died asynchronously
  let timer = null;
  const pending = new Map(); // relPath -> {path, kind, at}

  const fail = (reason) => ({ started: false, reason, pause() {}, resume() {}, drain: () => null, stop() {}, stats });

  // the root must be a directory we can actually watch — checked BEFORE any
  // OS call that could half-start
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return fail(`not a directory: ${sanitizeWatchPath(String(root), { maxLen: 120 })}`);
  } catch (e) {
    return fail(`cannot stat workspace root: ${e.message}`);
  }

  try {
    watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      try {
        if (paused || dead) return;
        const rel = sanitizeWatchPath(filename, { maxLen: 256 });
        const top = rel.split('/')[0].split('\\')[0];
        if (EXCLUDED_DIRS.has(top)) return;
        stats.eventsSeen += 1;
        const row = { path: rel, kind: eventType === 'rename' ? 'rename' : 'change', at: Date.now() };
        if (!pending.has(rel) && pending.size >= maxEvents) {
          stats.suppressed += 1;
          return;
        }
        pending.set(rel, row); // coalesce: the latest kind wins, one row per path
      } catch {
        /* an event handler can never take the process down */
      }
    });
  } catch (e) {
    return fail(`fs.watch refused: ${e.message}`);
  }

  // asynchronous death (EMFILE, ENOSPC, a deleted root) is a STOPPED watcher,
  // honestly recorded — never a thrown error from inside a callback
  watcher.on('error', (e) => {
    try {
      dead = { reason: e?.message || String(e) };
      stats.deaths += 1;
      try { watcher.close(); } catch { /* already gone */ }
    } catch { /* containment */ }
  });

  stats.startedAt = Date.now();

  if (onFlush) {
    timer = setInterval(() => {
      try {
        if (paused || dead) return;
        if (!pending.size) return;
        const rows = [...pending.values()];
        const suppressed = stats.suppressed;
        pending.clear();
        onFlush({ rows, suppressed });
      } catch {
        /* the flush can never take the process down */
      }
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref(); // a watcher must not hold the event loop open by itself
  }

  return {
    started: true,
    /** stop watching until resume() — used when a turn starts */
    pause() {
      if (dead) return;
      paused = true;
      stats.pauses += 1;
    },
    /** resume watching (a no-op if the watcher died) */
    resume() {
      if (dead || !paused) return;
      paused = false;
      stats.resumes += 1;
    },
    /** atomically: return the accumulated rows + the suppressed count, and
     *  clear the accumulator (pause is the caller's separate decision) */
    drain() {
      if (dead) return { rows: [...pending.values()], suppressed: stats.suppressed, dead: dead.reason };
      const rows = [...pending.values()];
      const suppressed = stats.suppressed;
      pending.clear();
      return { rows, suppressed, dead: null };
    },
    stop() {
      try { if (timer) clearInterval(timer); } catch { /* fine */ }
      try { watcher?.close(); } catch { /* fine */ }
      pending.clear();
    },
    stats,
  };
}

/**
 * chat.workspaceWatch resolution — the operator's declaration, the v0.53
 * discipline: junk is NAMED, never applied. false | 'off' | 'false' kills
 * the watcher; true / undefined / null → on; anything else is junk → the
 * default (on) applies WITH a naming note. A junk value never silently
 * configures the session, and never throws.
 */
export function resolveWatchSetting(v) {
  if (v === undefined || v === null || v === true) return { on: true, note: null };
  if (v === false || v === 'off' || v === 'false') return { on: false, note: null };
  let shown = '?';
  try { shown = JSON.stringify(String(v)).slice(0, 60); } catch { /* keep '?' */ }
  return { on: true, note: `chat.workspaceWatch: ${shown} is junk — NAMED, not applied; the watcher stays on (false | 'off' turns it off)` };
}

/**
 * The REPL's turn-start move, in one call: pause the watch (the turn is
 * about to write through the agent's own tools) and compute the drift fence
 * for everything that moved since the last turn ended. Returns null when
 * there is nothing to say (no rows and nothing suppressed).
 * The workspaceDrift fact row carries counts + capped sanitized paths only.
 */
export function drainDriftForTurn(handle, root, { factMaxPaths = 8 } = {}) {
  try {
    if (!handle || !handle.started) return null;
    handle.pause();
    const d = handle.drain();
    if (!d) return null;
    if (!d.rows.length && !d.suppressed) return null; // nothing moved — silence is the honest shape
    const block = driftBlock(d.rows);
    try {
      appendEvent(root, {
        type: 'workspaceDrift',
        count: d.rows.length,
        suppressed: d.suppressed,
        paths: d.rows.slice(0, factMaxPaths).map((r) => sanitizeWatchPath(r.path)),
      });
    } catch {
      /* the fact row is best-effort audit — never a broken turn */
    }
    return { block, count: d.rows.length, suppressed: d.suppressed };
  } catch {
    return null; // drift can never break a turn
  }
}
