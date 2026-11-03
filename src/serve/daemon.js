// daemon.js — `buddy serve`: the resident owner of the serve plane
// (v0.68.0, waves 1–3 of the rebuild; docs/serve-rebuild-plan.md).
//
// Hermes mechanism, Buddy size (docs/hermes-deep-map.md §b): a long-lived
// process that owns durable state across restarts — lease, control socket,
// delivery ledger flusher, goals ticker — while the session stays the only
// brain. The daemon DECIDES nothing an agent decides; it moves facts between
// files and the wire. Scope boundary (the plan's §1): the daemon hosts no
// sessions and holds no brain.
//
// Supervisor contract: exit 0 clean (stop/drain), 75 EX_TEMPFAIL transient
// (lease lost, tick error demand-restart), 78 EX_CONFIG fatal (restart loop).
// The restart guard counts UNCLEAN boots (a boot.json left behind by a dead
// predecessor) — 3 in 10 minutes means something is crash-looping and the
// honest move is to stop and say so, not to loop forever.

import fs from 'node:fs';
import os from 'node:os';
import { heartbeat, acquireLease, releaseLease, readLease, leaseAlive, EX_TEMPFAIL, EX_CONFIG } from './lease.js';
import { createControlServer, writePointer, clearPointer, controlEndpoint } from './control.js';
import { sweepDelivery, processDueDelivery, loadDeliveryView } from './delivery.js';
import {
  ensureServeDir, bootPath, pausedPath, drainPath, restartsPath, daemonLogPath,
  readJson, readJsonl, atomicWrite, appendJsonl,
} from './paths.js';

export const TICK_MS_DEFAULT = 60_000;   // Hermes' in-process cron cadence
export const HEARTBEAT_EVERY_MS = 5_000; // lease heartbeat (lease.js owns the staleness math)
export const RESTART_WINDOW_MS = 10 * 60_000;
export const RESTART_MAX = 3;
const cap = (s, n) => { const str = String(s ?? ''); return str.length <= n ? str : str.slice(0, n); };

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; } })();

// ── the restart guard: crash loops stop at three ────────────────────────────

/** Count unclean restarts inside the window. `bootRows` are the restart.jsonl
 *  rows; the new boot is NOT counted by this function (the caller appends). */
export function countRecentRestarts(rows, nowMs = Date.now(), { windowMs = RESTART_WINDOW_MS } = {}) {
  const cut = nowMs - windowMs;
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Date.parse(r?.at ?? '');
    return Number.isFinite(t) && t >= cut;
  }).length;
}

// ── boot: lease, guard, sweep, listen ───────────────────────────────────────

/** Run the daemon until stopped. Resolves with the process exit code — the
 *  CLI layer process.exits it. Never throws except on junk args. */
export async function startDaemon(root, {
  tickMs = TICK_MS_DEFAULT,
  goalsTicker = true,
  log = (line) => console.error(`[serve] ${line}`),
  now = Date.now,
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('startDaemon needs a root directory');
  const tick = Math.max(10_000, Math.min(Number(tickMs) || TICK_MS_DEFAULT, 600_000));
  ensureServeDir(root);

  // Restart guard: a boot.json on disk means the previous daemon never got
  // to clean up (crash / kill -9 / power). Count those inside the window.
  const prevBoot = readJson(bootPath(root));
  let restartRows = [];
  try { restartRows = readJsonl(restartsPath(root), { maxRows: 1000 }).rows; } catch { restartRows = []; }
  const unclean = prevBoot ? countRecentRestarts([{ at: prevBoot.at }], now()) : 0;
  if (unclean) appendJsonl(restartsPath(root), { at: new Date(now()).toISOString(), pid: prevBoot.pid, bootId: prevBoot.bootId });
  const recent = countRecentRestarts(unclean
    ? [...restartRows, { at: prevBoot.at }]
    : restartRows, now());
  if (recent >= RESTART_MAX) {
    log(`${recent} unclean restarts in ${Math.round(RESTART_WINDOW_MS / 60000)} minutes — refusing to loop (EX_CONFIG).`);
    log(`  investigate ${cap(daemonLogPath(root), 120)}`);
    log(`  clear the guard once the cause is fixed: rm ${cap(restartsPath(root), 120)}`);
    return EX_CONFIG;
  }

  const lease = acquireLease(root, { nowMs: now() });
  if (!lease.ok) {
    log(lease.error);
    return EX_TEMPFAIL;
  }
  const bootId = lease.lease.bootId;
  if (lease.stole) log(`reclaimed the lease from ${lease.stoleFrom} — the previous owner is gone`);
  log(`daemon up — boot ${bootId}, pid ${process.pid}, host ${os.hostname()}, tick ${tick / 1000}s, goals ticker ${goalsTicker ? 'on' : 'off'}`);
  atomicWrite(bootPath(root), JSON.stringify({ pid: process.pid, bootId, at: new Date(now()).toISOString(), version: VERSION }) + '\n');

  // Boot-time settlement: claims whose owner died resolve terminal 'unknown'
  // (at-most-once — losing beats duplicating). Torn/giant lines are counted.
  const sweep = sweepDelivery(root, { bootId });
  if (sweep.settledUnknown) log(`sweep: ${sweep.settledUnknown} claimed send(s) settled 'unknown' — their owner died mid-flight; never retried`);
  if (sweep.torn || sweep.giants) log(`sweep: ledger hygiene — ${sweep.torn} torn · ${sweep.giants} giant line(s) counted`);

  // Control plane.
  let server = null;
  try {
    server = await createControlServer(root, (req) => handleControl(req));
    writePointer(root, bootId);
    log(`control: ${controlEndpoint(root).transport} ${controlEndpoint(root).path}`);
  } catch (e) {
    log(`control endpoint failed (${cap(String(e?.message || e), 120)}) — continuing headless; buddy serve status will say unreachable`);
  }

  // Runtime state.
  let stopping = false;
  let paused = fs.existsSync(pausedPath(root));
  let lastTick = null;
  let tickBusy = false;
  let ticker = null;      // assigned after the handlers below are safe to call
  let beater = null;
  let resolveExit = null;

  const drainRequested = () => { try { return fs.existsSync(drainPath(root)); } catch { return false; } };
  const isPaused = () => { try { return fs.existsSync(pausedPath(root)); } catch { return false; } };

  async function runTick() {
    if (stopping || tickBusy) return;
    tickBusy = true;
    try {
      paused = isPaused();
      const hb = heartbeat(root, bootId, now());
      if (!hb.ok) {
        log('lease lost — another owner took the plane; standing down (EX_TEMPFAIL)');
        await gracefulStop(EX_TEMPFAIL, 'lease lost');
        return;
      }
      if (drainRequested()) {
        log('drain requested — finishing this tick and exiting clean');
        await gracefulStop(0, 'drained');
        return;
      }
      if (paused) {
        lastTick = { at: new Date(now()).toISOString(), paused: true };
        return;
      }
      const delivery = await processDueDelivery(root, { nowMs: now(), bootId });
      let goals = null;
      if (goalsTicker) {
        try {
          const G = await import('../goals.js');
          goals = await G.runDueGoals(root); // its own run.lock arbitrates overlap with OS cron
        } catch (e) {
          goals = { error: cap(String(e?.message || e), 160) };
        }
      }
      lastTick = { at: new Date(now()).toISOString(), paused: false, delivery, goals: goals ? { passed: goals.passed, failed: goals.failed, skipped: goals.skipped, busy: Boolean(goals.busy), error: goals.error } : null };
      const bits = [`delivery: ${delivery.sent} sent, ${delivery.retried} retried, ${delivery.dead} dead, ${delivery.failed} failed${delivery.skippedDead ? `, ${delivery.skippedDead} skipped (dead target)` : ''}`];
      if (goals) bits.push(`goals: ${goals.busy ? 'tick busy (another wake holds the lock)' : `${goals.passed} passed / ${goals.failed} failed / ${goals.skipped} skipped`}`);
      log(bits.join(' · '));
    } catch (e) {
      lastTick = { at: new Date(now()).toISOString(), error: cap(String(e?.message || e), 200) };
      log(`tick failed honestly — ${cap(String(e?.message || e), 200)}`);
    } finally {
      tickBusy = false;
    }
  }

  async function gracefulStop(code, reason) {
    if (stopping) return;
    stopping = true;
    if (ticker) clearInterval(ticker);
    if (beater) clearInterval(beater);
    try { if (server) await new Promise((res) => server.close(() => res())); } catch { /* best effort */ }
    try { clearPointer(root); } catch { /* best effort */ }
    try { fs.rmSync(bootPath(root), { force: true }); } catch { /* best effort */ }
    try { if (reason === 'drained') fs.rmSync(drainPath(root), { force: true }); } catch { /* best effort */ }
    const rel = releaseLease(root, bootId);
    log(`daemon stopped (${reason ?? 'signal'}) — lease ${rel.ok ? 'released' : `left (${rel.error})`}, exit ${code}`);
    if (resolveExit) resolveExit(code);
    else process.exit(code); // a stop before the await-loop existed — cleanup is done, leave now
  }

  function handleControl(req) {
    const cmd = String(req?.cmd ?? '');
    switch (cmd) {
      case 'status':
        return {
          ok: true,
          status: {
            bootId, pid: process.pid, host: os.hostname(), version: VERSION,
            startedAt: lease.lease.at, uptimeMs: now() - Date.parse(lease.lease.at),
            paused, stopping, tickMs: tick, goalsTicker,
            lastTick,
            lease: readLease(root),
            delivery: deliveryCounts(),
            restarts: countRecentRestarts(readJsonl(restartsPath(root), { maxRows: 1000 }).rows, now()),
          },
        };
      case 'stop':
        gracefulStop(0, 'stop request');
        return { ok: true, status: { stopping: true } };
      case 'pause':
        try { atomicWrite(pausedPath(root), `${new Date().toISOString()} paused by control request\n`); paused = true; return { ok: true, status: { paused: true } }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      case 'resume':
        try { fs.rmSync(pausedPath(root), { force: true }); paused = false; return { ok: true, status: { paused: false } }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      case 'drain':
        try { atomicWrite(drainPath(root), `${new Date().toISOString()} drain requested\n`); return { ok: true, status: { draining: true } }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      case 'ping':
        return { ok: true, status: { bootId, pid: process.pid } };
      default:
        return { ok: false, error: `unknown control cmd "${cap(cmd, 24)}" — known: status | stop | pause | resume | drain | ping` };
    }
  }

  function deliveryCounts() {
    try {
      const view = loadDeliveryView(root);
      const counts = {};
      for (const j of view.jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;
      return { total: view.jobs.length, ...counts, torn: view.torn, giants: view.giants };
    } catch {
      return { total: 0 };
    }
  }

  ticker = setInterval(() => { runTick(); }, tick);
  beater = setInterval(() => { heartbeat(root, bootId, now()); }, HEARTBEAT_EVERY_MS);
  ticker.unref?.();
  beater.unref?.();

  process.on('SIGTERM', () => { gracefulStop(0, 'SIGTERM'); });
  process.on('SIGINT', () => { gracefulStop(0, 'SIGINT'); });

  // The first tick fires inside the await — a daemon that boots into a
  // backlog flushes it without waiting a full interval, and resolveExit is
  // assigned before anything can stop us.
  return await new Promise((resolve) => {
    resolveExit = resolve;
    runTick();
  });
}
