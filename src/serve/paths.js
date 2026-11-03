// paths.js — the .buddy/serve/ layout (v0.68.0, the serve rebuild).
//
// The daemon owns FILES, not logic: every durable fact of the service layer
// is a line or a JSON document under .buddy/serve/, and the daemon is just
// the process that reads and advances them. That keeps the zero-dependency
// identity (JSONL + byte cursors, no SQLite) and makes every wave reversible
// — remove the directory and the workspace is exactly what it was before.
//
// CONTRACT (the telemetry.js cursor discipline, carried): every JSONL file
// here is append-only, read complete-lines-only, tolerates a torn trailing
// line (skip it, count it, never guess), and never wedges on a giant line.
// Writers use tmp+rename for whole documents; appends are single writeSync
// calls. The agent's tools may touch NONE of this (wave 0 firewall:
// .buddy/serve/** in AGENT_DENY_GLOBS) — the operator owns the plane.

import fs from 'node:fs';
import path from 'node:path';

export const SERVE_DIR = '.buddy/serve';

/** Every path the serve plane uses, derived from one place. */
export function servePath(root, ...rest) {
  return path.join(String(root ?? ''), SERVE_DIR, ...rest);
}
export const leasePath = (root) => servePath(root, 'lease.json');
export const controlPath = (root) => servePath(root, 'control.json');
export const bootPath = (root) => servePath(root, 'boot.json');
export const pausedPath = (root) => servePath(root, 'paused');
export const drainPath = (root) => servePath(root, '.drain_request');
export const restartsPath = (root) => servePath(root, 'restarts.jsonl');
export const obligationsPath = (root) => servePath(root, 'obligations.jsonl');
export const payloadsDir = (root) => servePath(root, 'payloads');
export const deadTargetsPath = (root) => servePath(root, 'dead-targets.json');
export const daemonLogPath = (root) => servePath(root, 'daemon.log');
export const runsDir = (root) => servePath(root, 'runs');

/** Ensure the serve directory exists (best effort — a read-only workspace is
 *  an honest failure at the call site, not here). */
export function ensureServeDir(root) {
  fs.mkdirSync(servePath(root), { recursive: true });
}

/** Atomic whole-document write: tmp in the SAME directory (rename is
 *  same-volume), then rename. The goals.js store precedent, shared. */
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/** Read a whole-document JSON file. Missing → null; torn/corrupt → null (the
 *  caller decides what an unreadable fact means — this layer never guesses). */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Append one JSON line. Best-effort by design (the eventslog.js contract):
 *  a failed audit must never take the action it recorded down with it. */
export function appendJsonl(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Fold a JSONL file into parsed rows, complete lines only. Returns
 *  { rows, torn, giants } — torn and giant lines are COUNTED facts, never
 *  surfacing as junk rows (the cursor contract, made reusable). */
export function readJsonl(file, { maxLine = 1024 * 1024, maxRows = 200000 } = {}) {
  const out = { rows: [], torn: 0, giants: 0 };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // absent file is an empty ledger, not an error
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.length > maxLine) { out.giants += 1; continue; }
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object' && !Array.isArray(j)) out.rows.push(j);
      else out.torn += 1;
    } catch {
      out.torn += 1;
    }
    if (out.rows.length >= maxRows) break; // a flood cannot read forever either
  }
  return out;
}
