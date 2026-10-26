// routing-memory.js — self-healing routing (v0.25.0).
//
// The router already survives failures with a circuit breaker, but it starts
// every session with the same static chain order and re-learns latency the
// hard way, live. This module gives it a memory: observed latencies persist
// to .buddy/routing.json and the chain reorders itself so the historically
// fastest gateway answers first — while a user-pinned gateway (/model kilo)
// always keeps the top slot.
//
// Latency is an EMA (α = 0.3): recent observations matter more than old ones,
// one outlier cannot bury a good gateway, and zero samples = no opinion.

import fs from 'node:fs';
import path from 'node:path';

const ALPHA = 0.3;

export function routingMemoryPath(root) {
  return path.join(root, '.buddy', 'routing.json');
}

/** Load .buddy/routing.json; junk degrades to {} — never throws. */
export function loadRoutingMemory(root) {
  try {
    const raw = fs.readFileSync(routingMemoryPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the memory atomically-ish (write temp, rename). Never throws. */
export function saveRoutingMemory(root, mem) {
  try {
    const file = routingMemoryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // learning is best-effort — a read-only .buddy must not kill a turn
  }
}

/**
 * Fold one observation into the memory. Latency is clamped to a sane band so
 * a hung-then-killed probe (or a GC pause) cannot poison the EMA.
 * @returns {number} the new EMA value
 */
export function noteLatency(mem, name, ms) {
  const v = Number(ms);
  if (!name || !Number.isFinite(v) || v <= 0) return mem?.[name]?.ema ?? 0;
  const clamped = Math.min(Math.max(v, 5), 300000);
  const prev = mem[name] && Number.isFinite(mem[name].ema) ? mem[name].ema : null;
  const ema = prev === null ? clamped : Math.round(prev * (1 - ALPHA) + clamped * ALPHA);
  mem[name] = {
    ema,
    samples: ((mem[name]?.samples) || 0) + 1,
    lastMs: Math.round(clamped),
    updatedAt: new Date().toISOString(),
  };
  return ema;
}

/**
 * Learned order: pinned gateway (chain[0]) keeps the top slot — the user
 * asked for it — everyone else sorts by learned EMA ascending. Gateways with
 * no samples keep their relative order at the back (no data = no opinion,
 * and unknowns must not leapfrog known-good gateways on a hunch).
 * Pure: returns a new array, never mutates the router.
 */
export function applyLearnedOrder(router, mem) {
  const current = [...router.order];
  if (!current.length) return current;
  const [pin = null, ...rest] = current;
  const withIdx = rest.map((name, i) => ({ name, i, ema: mem?.[name]?.ema ?? null }));
  const known = withIdx.filter((x) => x.ema !== null).sort((a, b) => a.ema - b.ema || a.i - b.i);
  const unknown = withIdx.filter((x) => x.ema === null);
  const ordered = [pin, ...known.map((x) => x.name), ...unknown.map((x) => x.name)].filter(Boolean);
  return ordered;
}

/** Reorder the router in place from learned memory (skips when nothing learned). */
export function selfHeal(router, mem, { enabled = true } = {}) {
  if (!enabled) return false;
  const learned = Object.keys(mem || {}).filter((n) => router.order.includes(n) && mem[n]?.ema);
  if (learned.length < 2) return false; // one sample is a coin flip, not signal
  const next = applyLearnedOrder(router, mem);
  if (next.join('→') === router.order.join('→')) return false;
  router.order = next;
  return true;
}
