// lease.js — single-writer ownership for the serve plane (v0.68.0, wave 1).
//
// Hermes mechanism (docs/hermes-deep-map.md row: turn_facade_lease.py +
// scheduler_ownership.py): a lease records WHO owns the plane — pid + bootId
// + a heartbeat — and a dead owner is reclaimable, never negotiated with.
// Two `buddy serve` processes on one workspace cannot both be the daemon:
// the second one exits EX_TEMPFAIL (75) and says why.
//
// bootId exists because pids are recycled: a fresh daemon proves it owns the
// lease by reading back ITS OWN bootId after the write (the goals.js run.lock
// read-back precedent), and a live-vs-dead verdict never trusts a heartbeat
// alone — the pid must exist too.

import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { leasePath, atomicWrite, readJson } from './paths.js';

export const HEARTBEAT_MS = 5000;      // the owner rewrites the lease this often
export const LEASE_STALE_MS = 16000;   // > 3 missed heartbeats = dead, reclaimable

export const EX_TEMPFAIL = 75; // supervisor-readable: "transient — restart me"
export const EX_CONFIG = 78;   // supervisor-readable: "fatal — do not loop"

export const newBootId = () => randomBytes(8).toString('hex');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // signal 0 = existence probe
  } catch (e) {
    return e && e.code === 'EPERM'; // EPERM means it exists but is not ours
  }
}

/** Read the lease file. null when absent or junk (an unreadable fact is not
 *  a verdict — the acquire path treats null as reclaimable). */
export function readLease(root) {
  const l = readJson(leasePath(root));
  if (!l || typeof l !== 'object') return null;
  if (typeof l.bootId !== 'string' || !Number.isInteger(l.pid)) return null;
  return l;
}

/** Is this lease held by a LIVE process with a FRESH heartbeat? Junk and
 *  stale leases are dead by definition — reclaimable, not fatal. */
export function leaseAlive(lease, nowMs = Date.now()) {
  if (!lease) return false;
  const hb = Date.parse(lease.heartbeatAt ?? lease.at ?? '');
  if (!Number.isFinite(hb)) return false;
  if (nowMs - hb > LEASE_STALE_MS) return false;
  return pidAlive(lease.pid);
}

/** Take or reclaim the lease. Returns {ok, lease, stole, stoleFrom} or
 *  {ok:false, busy, error}. The read-back proves ownership: a daemon that
 *  stole in the same window wins, and the loser says so instead of
 *  split-braining. */
export function acquireLease(root, { nowMs = Date.now() } = {}) {
  const mine = {
    pid: process.pid,
    bootId: newBootId(),
    host: os.hostname(),
    at: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
  };
  const existing = readLease(root);
  if (existing && leaseAlive(existing, nowMs) && existing.bootId !== mine.bootId) {
    return {
      ok: false,
      busy: true,
      error: `another serve daemon owns this workspace (pid ${existing.pid}, heartbeat ${existing.heartbeatAt}) — refusing to double-own; stop it first: buddy serve stop`,
    };
  }
  atomicWrite(leasePath(root), JSON.stringify(mine, null, 2) + '\n');
  const readBack = readLease(root);
  if (!readBack || readBack.bootId !== mine.bootId) {
    return { ok: false, busy: true, error: 'lease write lost the race — another daemon owns the workspace now' };
  }
  return {
    ok: true,
    lease: readBack,
    stole: Boolean(existing),
    stoleFrom: existing
      ? `pid ${existing.pid} (heartbeat ${existing.heartbeatAt ?? existing.at ?? 'unknown'} — ${leaseAlive(existing, nowMs) ? 'live but replaced' : 'dead or stale'})`
      : null,
  };
}

/** Heartbeat: refresh the timestamps on OUR lease. A lost lease (reclaimed
 *  underneath us) is reported, never thrown — the caller decides to stand
 *  down. */
export function heartbeat(root, bootId, nowMs = Date.now()) {
  const current = readLease(root);
  if (!current || current.bootId !== bootId) return { ok: false, lost: true };
  current.heartbeatAt = new Date(nowMs).toISOString();
  try {
    atomicWrite(leasePath(root), JSON.stringify(current, null, 2) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Only ever clear OUR OWN lease — a live successor's lease is left alone. */
export function releaseLease(root, bootId) {
  const current = readLease(root);
  if (current && current.bootId !== bootId) return { ok: false, error: `lease is held by boot ${current.bootId} — left it alone` };
  try {
    fs.unlinkSync(leasePath(root));
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true };
    return { ok: false, error: String(e?.message || e) };
  }
}
