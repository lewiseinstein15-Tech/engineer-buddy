// v0.49.0 — GOALS & SCHEDULED RUNS (the wave began as v0.47.0 and was
// renumbered after MCP auth shipped as v0.48.0 while this wave sat orphaned
// mid-reconciliation; the v047 file never entered git history). Tests run
// against the shared core in src/goals.js (the merged two-writer design:
// .buddy/goals/ tree, UTC cron engine, HELD junk entries, strict-load
// mutations vs degrading views, tick lock with loud stale-steal, per-run
// artifacts, injectable runPrompt/probe).
// Every scored path here is offline. Pins that carry the house rules:
//   - a CLI dry run provably calls no runner (it is a pure view);
//   - a runner cannot fabricate a pass — status comes from a whitelist;
//   - a hostile store cannot pollute Object.prototype and cannot be scheduled;
//   - a thrown runner is an honest error row, and one bad goal never kills
//     the batch;
//   - the tick SKIPs honestly when the brain is unreachable — never a fake
//     pass, and the SKIP still lands in history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  oneLine, scheduleText, parseCron, nextCronFire, buildGoal, normalizeGoal,
  loadGoals, addGoal, removeGoal, setGoalEnabled, nextDue, appendHistory,
  readHistory, acquireRunLock, releaseRunLock, summarizeChildRun, runDueGoals,
  goalsTableText, runSummaryText, storePath, historyPath, lockPath, runsDir,
  MAX_GOALS, MAX_MAX_MINUTES, FAST_TIMEOUT_MS, STALE_LOCK_MS,
} from '../src/goals.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v049-'));
const ENTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'index.js');
const UTC = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0, 0);
const deadPid = () => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
// Snowflake ids share their high-order time digits (36^2 ms ≈ 1.3 s) — a
// slice(0, N) prefix is timing-dependent between two goals created
// back-to-back. The deterministic unique prefix is the shortest prefix of x
// that no other id in the comparison shares; ambiguity pins use 'g-' (every
// id starts with it, always).
const uniqPrefix = (x, y) => {
  const a = String(x ?? '');
  const b = String(y ?? '');
  for (let n = 1; n <= a.length; n++) {
    const p = a.slice(0, n);
    if (!b.startsWith(p)) return p;
  }
  return a;
};

// ── text & schedule rendering ───────────────────────────────────────────────

test('oneLine: ANSI/OSC/control chars cannot smuggle into any listing', () => {
  assert.equal(oneLine('\x1b[31mred\x1b[0mname\nwith\tlines'), 'redname with lines');
  assert.equal(oneLine('\x1b]0;evil title\x07clean'), 'clean');
  assert.equal(oneLine('  spaced   out  '), 'spaced out');
  assert.equal(oneLine(null), '');
  assert.equal(oneLine('abcdef', 4).length, 4);
  assert.ok(oneLine('x'.repeat(5000), 80).length <= 80);
});

test('scheduleText: every form, cron (UTC), one-shot at, and the honest state suffixes', () => {
  assert.equal(scheduleText({ everyMinutes: 30, schedule: { kind: 'every', minutes: 30 } }), 'every 30m');
  assert.match(scheduleText({ cron: '*/15 * * * *', schedule: { kind: 'cron', expr: '*/15 * * * *' } }), /\(UTC\)/);
  assert.match(scheduleText({ at: '2026-11-01T09:30:00.000Z', schedule: { kind: 'at', at: '2026-11-01T09:30:00.000Z' } }), /^at 2026-11-01T09:30/);
  assert.match(scheduleText({ everyMinutes: 5, schedule: { kind: 'every', minutes: 5 }, enabled: false }), /disabled/);
  assert.match(scheduleText({ everyMinutes: 5, schedule: { kind: 'every', minutes: 5 }, maxRuns: 2, runCount: 2 }), /maxed|HELD|disabled/);
  assert.match(scheduleText({ everyMinutes: 5, schedule: { kind: 'every', minutes: 5 }, hold: 'junk definition — held' }), /HELD/);
  assert.equal(scheduleText(null), '(junk goal)');
  assert.match(scheduleText({ schedule: null }), /UNSCHEDULABLE/);
});

// ── the cron engine (UTC, zero-dep) ─────────────────────────────────────────

test('parseCron: fields parse and dow 7 normalizes to Sunday', () => {
  const p = parseCron('*/15 9-17 1,15 * 7');
  assert.deepEqual(p.min, [0, 15, 30, 45]);
  assert.deepEqual(p.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(p.dom, [1, 15]);
  assert.deepEqual(p.mon, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(p.dow.includes(0) && !p.dow.includes(7));
  for (const bad of ['', '* * * *', '* * * * * *', '61 * * * *', '* 24 * * *', 'a b c d e', '5-1 * * * *', '*/0 * * * *', '* * 0 * *', '* * * 13 *']) {
    assert.throws(() => parseCron(bad), undefined, `expected throw for "${bad}"`);
  }
});

test('nextCronFire: exact UTC math, OR-rule for dom/dow, honest phantom refusal', () => {
  assert.equal(nextCronFire('*/15 * * * *', UTC(2026, 10, 29, 10, 7)), UTC(2026, 10, 29, 10, 15));
  assert.equal(nextCronFire('30 9 * * *', UTC(2026, 10, 29, 9, 31)), UTC(2026, 10, 30, 9, 30));
  // 2026-10-30 is a Friday: next weekday 09:00 after Fri 09:01 is Mon 2026-11-02
  assert.equal(nextCronFire('0 9 * * 1-5', UTC(2026, 10, 30, 9, 1)), UTC(2026, 11, 2, 9, 0));
  // dom=1 OR Monday, both restricted → either may fire: Sun Nov 1 wins (dom)
  assert.equal(nextCronFire('0 0 1 * 1', UTC(2026, 10, 29, 12, 0)), UTC(2026, 11, 1, 0, 0));
  // next Feb 29 is 2028 — beyond the one-year window, so it is refused, not guessed
  assert.throws(() => nextCronFire('0 0 29 2 *', UTC(2026, 10, 29, 12, 0)), /never fires within the one-year/);
  assert.throws(() => nextCronFire('0 0 31 2 *', UTC(2026, 10, 29, 12, 0)), /never fires within the one-year/);
});

// ── buildGoal / normalizeGoal: refuse, never guess ──────────────────────────

test('buildGoal: one schedule form required; defaults you can trust; honest refusals', () => {
  const g = buildGoal({ name: '  Nightly Audit  ', prompt: ' do the thing ', everyMinutes: '90', maxMinutes: '5' });
  assert.equal(g.name, 'Nightly Audit');
  assert.equal(g.prompt, 'do the thing');
  assert.deepEqual(g.schedule, { kind: 'every', minutes: 90 });
  assert.equal(g.everyMinutes, 90);
  assert.equal(g.cron, null);
  assert.equal(g.at, null);
  assert.equal(g.maxMinutes, 5);
  assert.equal(g.yolo, false);
  assert.equal(g.enabled, true);
  assert.equal(g.runCount, 0);
  assert.match(g.id, /^g-[0-9a-z]+-[a-z0-9]+$/);
  const c = buildGoal({ name: 'c', prompt: 'p', cron: '  */15 * * * *  ' });
  assert.equal(c.cron, '*/15 * * * *');
  assert.deepEqual(c.schedule, { kind: 'cron', expr: '*/15 * * * *' });
  const a = buildGoal({ name: 'a', prompt: 'p', at: '2026-11-01 09:30' });
  assert.equal(a.at, '2026-11-01T09:30:00.000Z');
  assert.deepEqual(a.schedule, { kind: 'at', at: '2026-11-01T09:30:00.000Z' });
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p' }), /exactly one schedule/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: 10, cron: '* * * * *' }), /ONE schedule form/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: 10, at: '2026-11-01 09:30' }), /ONE schedule form/);
  assert.throws(() => buildGoal({ name: '', prompt: 'p', everyMinutes: 10 }), /needs a name/);
  assert.throws(() => buildGoal({ name: 'n', prompt: '', everyMinutes: 10 }), /needs --prompt/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'x'.repeat(9000), everyMinutes: 10 }), /too long/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: 0 }), /--every/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: 1.5 }), /--every/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: MAX_MAX_MINUTES + 1 }).message ?? '', /--every/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', cron: '61 * * * *' }), /cron/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', at: 'not a date' }), /--at/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', at: '2026-13-40 99:99' }), /--at/);
  assert.throws(() => buildGoal({ name: 'n', prompt: 'p', everyMinutes: 10, maxMinutes: 999 }), /--max-minutes/);
});

test('normalizeGoal: whitelist only; junk ids/schedules are HELD, never scheduled', () => {
  const ok = normalizeGoal({ id: 'g-abc-def', name: 'ok', prompt: 'p', everyMinutes: 30, spawn: 'evil', extra: { deep: true } });
  assert.equal(ok.id, 'g-abc-def');
  assert.equal(ok.spawn, undefined);
  assert.equal(ok.extra, undefined);
  assert.ok(!('spawn' in ok));
  assert.equal(normalizeGoal({ name: 'no-id', prompt: 'p', everyMinutes: 30 }).hold !== undefined, true);
  assert.equal(normalizeGoal({ id: '../../evil', name: 'x', prompt: 'p', everyMinutes: 30 }).hold !== undefined, true);
  assert.equal(normalizeGoal({ id: 'g-abc-def', name: 'x', prompt: 'p', everyMinutes: 0 }).hold !== undefined, true);
  const noSched = normalizeGoal({ id: 'g-abc-def', name: 'x', prompt: 'p' });
  assert.equal(noSched.schedule, null);
  assert.equal(noSched.hold !== undefined, true);
  assert.equal(normalizeGoal(null), null);
  assert.equal(normalizeGoal([1]), null);
});

// ── the store: views degrade, mutations refuse ──────────────────────────────

test('loadGoals: missing store is empty; torn/foreign/flooded stores degrade into problems[]', () => {
  const root = tmp();
  assert.deepEqual(loadGoals(root), { goals: [], problems: [] });
  fs.mkdirSync(path.dirname(storePath(root)), { recursive: true });
  fs.writeFileSync(storePath(root), '{ "goals": [ torn', 'utf8');
  let l = loadGoals(root);
  assert.equal(l.goals.length, 0);
  assert.ok(l.problems.some((p) => /torn JSON/.test(p) && /nothing was deleted/.test(p) && /goals\.json/.test(p)));
  fs.writeFileSync(storePath(root), '["array form"]', 'utf8');
  l = loadGoals(root);
  assert.ok(l.problems.some((p) => /wrong shape/.test(p)));
  const flood = JSON.stringify({ goals: Array.from({ length: MAX_GOALS + 1 }, (_, i) => ({ id: `g-flood-${i}`, name: `f${i}`, prompt: 'p', everyMinutes: 5 })) });
  fs.writeFileSync(storePath(root), flood, 'utf8');
  l = loadGoals(root);
  assert.ok(l.problems.some((p) => /cap/.test(p)));
});

test('loadGoals: a hostile store cannot pollute Object.prototype (v0.44 lesson, replayed)', () => {
  const root = tmp();
  fs.mkdirSync(path.dirname(storePath(root)), { recursive: true });
  const hostile = '{"goals":[{"id":"g-abc-def","name":"ok","prompt":"p","everyMinutes":5},{"__proto__":{"polluted":true},"name":"evil","prompt":"p","everyMinutes":5}]}';
  fs.writeFileSync(storePath(root), hostile, 'utf8');
  const l = loadGoals(root);
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must stay clean');
  assert.equal(l.goals.length, 2);
  assert.ok(l.goals[1].hold, 'the proto-keyed junk entry is HELD, not scheduled');
  assert.ok(l.problems.some((p) => /HELD/.test(p)));
});

test('addGoal: persists, caps at MAX_GOALS, allows duplicate display names (ids disambiguate)', () => {
  const root = tmp();
  const a = addGoal(root, { name: 'Alpha', prompt: 'a', everyMinutes: 30 }).goal;
  assert.equal(loadGoals(root).goals[0].name, 'Alpha');
  const b = addGoal(root, { name: 'Alpha', prompt: 'b', everyMinutes: 60 }).goal;
  assert.notEqual(a.id, b.id);
  assert.equal(loadGoals(root).goals.length, 2);
  assert.throws(() => addGoal(root, { name: 'Bad', prompt: 'p', cron: 'nope' }), /cron/);
  const caps = tmp();
  fs.mkdirSync(path.dirname(storePath(caps)), { recursive: true });
  fs.writeFileSync(storePath(caps), JSON.stringify({ goals: Array.from({ length: MAX_GOALS }, (_, i) => ({ id: `g-cap-${i}`, name: `c${i}`, prompt: 'p', everyMinutes: 5 })) }), 'utf8');
  assert.throws(() => addGoal(caps, { name: 'one-more', prompt: 'p', everyMinutes: 5 }), /cap reached/);
});

test('removeGoal / setGoalEnabled: prefix matching, ambiguity refused, mutations persist', () => {
  const root = tmp();
  const { goal: a } = addGoal(root, { name: 'A', prompt: 'p', everyMinutes: 10 });
  const { goal: b } = addGoal(root, { name: 'B', prompt: 'p', everyMinutes: 20 });
  assert.equal(setGoalEnabled(root, a.id, false).goal.enabled, false);
  let l = loadGoals(root);
  assert.equal(l.goals.find((g) => g.id === a.id).enabled, false);
  assert.equal(l.goals.find((g) => g.id === b.id).enabled, true);
  assert.equal(removeGoal(root, uniqPrefix(a.id, b.id)).goal.id, a.id, 'prefix works (a prefix no other id shares)');
  l = loadGoals(root);
  assert.equal(l.goals.length, 1);
  assert.equal(l.goals[0].id, b.id);
  assert.throws(() => setGoalEnabled(root, 'g-zzz', true), /no goal matches/);
  assert.throws(() => removeGoal(root, ''), /required/);
  const amb = tmp();
  addGoal(amb, { name: 'A', prompt: 'p', everyMinutes: 10 });
  addGoal(amb, { name: 'A2', prompt: 'p', everyMinutes: 10 });
  assert.throws(() => removeGoal(amb, 'g-'), /matches 2 goals/, "'g-' is a prefix of every id — ambiguity is refused, nothing is guessed");
});

// ── scheduling (injected clock) ─────────────────────────────────────────────

test('nextDue: exact math for every/cron/at; disabled/held/maxed never fire; at is one-shot', () => {
  const now = UTC(2026, 10, 29, 12, 0);
  const base = { id: 'g-x-y', name: 'x', prompt: 'p', enabled: true, runCount: 0, hold: undefined, maxMinutes: 10 };
  const every = { ...base, schedule: { kind: 'every', minutes: 30 }, everyMinutes: 30, cron: null, at: null, createdAt: new Date(now - 10 * 60000).toISOString(), lastRun: null };
  assert.equal(nextDue(every, now).getTime(), now - 10 * 60000 + 30 * 60000);
  const ran = { ...every, lastRun: new Date(now - 5 * 60000).toISOString() };
  assert.equal(nextDue(ran, now).getTime(), now - 5 * 60000 + 30 * 60000);
  const cron = { ...base, schedule: { kind: 'cron', expr: '*/15 * * * *' }, everyMinutes: null, cron: '*/15 * * * *', at: null, createdAt: new Date(now - 10 * 60000).toISOString(), lastRun: null };
  assert.equal(nextDue(cron, now).getTime(), UTC(2026, 10, 29, 12, 15));
  const at = { ...base, schedule: { kind: 'at', at: '2026-11-01T09:30:00.000Z' }, everyMinutes: null, cron: null, at: '2026-11-01T09:30:00.000Z', createdAt: new Date(now).toISOString(), lastRun: null };
  assert.equal(nextDue(at, now).getTime(), UTC(2026, 11, 1, 9, 30));
  assert.equal(nextDue({ ...at, runCount: 1 }, now), null, 'a one-shot that fired never re-fires');
  assert.equal(nextDue({ ...ran, enabled: false }, now), null);
  assert.equal(nextDue({ ...ran, hold: 'junk' }, now), null);
  assert.equal(nextDue({ ...ran, schedule: null, everyMinutes: null, cron: null, at: null }, now), null);
  assert.equal(nextDue(null, now), null);
  // clock skew: a lastRun in the future is simply not due until the clock passes it
  const future = { ...ran, lastRun: new Date(now + 60 * 60000).toISOString() };
  assert.equal(nextDue(future, now).getTime(), now + 60 * 60000 + 30 * 60000);
});

// ── history ─────────────────────────────────────────────────────────────────

test('history: append → read round-trip; torn lines skipped; id filter and limit work', () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) assert.ok(appendHistory(root, { at: `t${i}`, id: i % 2 ? 'g-odd' : 'g-even', name: `n${i}`, status: 'ok', durationMs: i }).ok);
  fs.appendFileSync(historyPath(root), '{ torn line\n', 'utf8');
  assert.ok(appendHistory(root, { at: 't5', id: 'g-even', name: 'n5', status: 'error', durationMs: 5 }).ok);
  assert.equal(readHistory(root, { limit: 100 }).length, 6);
  assert.deepEqual(readHistory(root, { id: 'g-odd', limit: 100 }).map((r) => r.at), ['t1', 't3']);
  assert.equal(readHistory(root, { limit: 2 }).length, 2);
  assert.equal(readHistory(tmp(), {}).length, 0);
});

// ── the tick lock ───────────────────────────────────────────────────────────

test('tick lock: fresh ok; second busy; stale/junk stolen LOUDLY; release only removes our own', () => {
  const root = tmp();
  const t0 = 1_000_000_000_000;
  assert.equal(acquireRunLock(root, { nowMs: t0 }).ok, true);
  const second = acquireRunLock(root, { nowMs: t0 + 1000 });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  assert.match(second.error, /holds the lock/);
  assert.match(second.error, /double-fire/);
  const stolen = acquireRunLock(root, { nowMs: t0 + 1000 + STALE_LOCK_MS + 1 });
  assert.equal(stolen.ok, true);
  assert.equal(stolen.stole, true);
  assert.match(stolen.stoleFrom, /pid/);
  releaseRunLock(root, {});
  fs.writeFileSync(lockPath(root), '\x00 not json', 'utf8');
  const junkSteal = acquireRunLock(root, { nowMs: t0 });
  assert.equal(junkSteal.ok, true);
  assert.match(junkSteal.stoleFrom, /junk lock/);
  releaseRunLock(root, {});
  const foreign = deadPid();
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: foreign, at: new Date().toISOString() }), 'utf8');
  const rel = releaseRunLock(root, { pid: process.pid });
  assert.equal(rel.ok, false);
  assert.match(rel.error, /held by pid/);
  assert.ok(fs.existsSync(lockPath(root)), 'a foreign lock is left alone');
  assert.equal(releaseRunLock(root, { pid: foreign }).ok, true);
});

// ── summarizeChildRun: status from the child's own testimony ────────────────

test('summarizeChildRun: the honesty matrix — junk tolerated, lies coerced to error', () => {
  const ok = summarizeChildRun({ code: 0, signal: null, events: [{ type: 'result', status: 'ok', said: 'did the thing', steps: 3 }] });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.said, 'did the thing');
  assert.equal(ok.steps, 3);
  const hostile = summarizeChildRun({ code: 0, signal: null, events: [{ type: 'result', status: 'ok', said: 'sa\x1b[31mid\r\nwith\nlines ' + 'x'.repeat(500) }] });
  assert.equal(hostile.status, 'ok');
  assert.ok(!/[\x1b\n]/.test(hostile.said));
  assert.ok(hostile.said.length <= 200);
  assert.equal(summarizeChildRun({ code: 0, signal: null, events: [{ type: 'result', status: 'ok' }] }).status, 'no_reply');
  assert.equal(summarizeChildRun({ code: 0, signal: null, events: [] }).status, 'error');
  assert.equal(summarizeChildRun({ code: 0, signal: null, events: [{ type: 'result', status: 'FAKE_PASS', said: 'trust me' }] }).status, 'error', 'a lying result status cannot fabricate a pass');
  const err = summarizeChildRun({ code: 1, signal: null, events: [], err: 'line1\nline2\nthe real error' });
  assert.equal(err.status, 'error');
  assert.match(err.error, /the real error/);
  assert.equal(summarizeChildRun({ code: null, signal: 'SIGKILL', events: [] }).status, 'timeout');
  assert.equal(summarizeChildRun({ code: 0, signal: null, events: ['junk', null, { type: 'result', status: 'ok', said: 'ok' }] }).status, 'ok');
  assert.equal(summarizeChildRun(null).status, 'error');
});

// ── the tick (injected runner + probe — no brain, no network) ───────────────

function mkGoal(root, { name, minutesAgo = 200, everyMin = 60, extra = {} } = {}) {
  const { goal } = addGoal(root, { name, prompt: `task for ${name}`, everyMinutes: everyMin, ...extra });
  if (minutesAgo != null) {
    const store = JSON.parse(fs.readFileSync(storePath(root), 'utf8'));
    const g = store.goals.find((x) => x.id === goal.id);
    g.createdAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
    fs.writeFileSync(storePath(root), JSON.stringify(store, null, 2) + '\n', 'utf8');
  }
  return goal;
}

test('runDueGoals: due goal runs — store + history + artifacts + lock release all agree', async () => {
  const root = tmp();
  const goal = mkGoal(root, { name: 'live-one', everyMin: 30 });
  const out = await runDueGoals(root, {
    probe: { ok: true, gateway: 'test' },
    runPrompt: async ({ g, timeoutMs }) => {
      assert.equal(g.id, goal.id);
      assert.equal(timeoutMs, 10 * 60000, 'maxMinutes (default 10) becomes the child timeout');
      return { status: 'ok', code: 0, signal: null, steps: 2, said: 'finished honestly', out: '{"type":"result"}\n' };
    },
  });
  assert.equal(out.passed, 1);
  assert.equal(out.failed, 0);
  assert.equal(out.skipped, 0);
  const row = out.results[0];
  assert.equal(row.status, 'ok');
  assert.equal(row.said, 'finished honestly');
  assert.ok(row.artifacts, 'artifacts dir recorded on the row');
  assert.ok(fs.existsSync(path.join(root, row.artifacts, 'result.json')));
  assert.ok(fs.existsSync(path.join(root, row.artifacts, 'stream.jsonl')));
  const result = JSON.parse(fs.readFileSync(path.join(root, row.artifacts, 'result.json'), 'utf8'));
  assert.ok(!JSON.stringify(result).includes('task for live-one'), 'the prompt TEXT is never persisted — promptChars discipline');
  assert.equal(result.goal.promptChars, 'task for live-one'.length);
  const g = loadGoals(root).goals.find((x) => x.id === goal.id);
  assert.equal(g.runCount, 1);
  assert.equal(g.lastStatus, 'ok');
  assert.ok(g.lastRun);
  const hist = readHistory(root, { limit: 10 });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, goal.id);
  assert.equal(hist[0].status, 'ok');
  assert.equal(acquireRunLock(root, {}).ok, true, 'the tick released the lock when it finished');
  releaseRunLock(root, {});
  assert.ok(out.nextWake > Date.now(), 'next wake is in the future after a fire');
});

test('runDueGoals: unreachable brain → every selected goal is an honest SKIP that still lands in history', async () => {
  const root = tmp();
  mkGoal(root, { name: 'skip-a' });
  mkGoal(root, { name: 'skip-b' });
  const out = await runDueGoals(root, {
    probe: { ok: false, reason: 'no keyless gateway answered the BUDDY_OK probe (offline or gateways down)' },
    runPrompt: async () => { throw new Error('THE RUNNER MUST NOT BE CALLED OFFLINE'); },
  });
  assert.equal(out.skipped, 2);
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 0);
  for (const r of out.results) {
    assert.equal(r.status, 'SKIP');
    assert.match(r.reason, /brain unreachable/);
  }
  assert.equal(readHistory(root, { limit: 10 }).length, 2, 'SKIPs are recorded, not hidden');
  assert.equal(loadGoals(root).goals.filter((g) => g.runCount === 0).length, 2, 'a SKIP does not advance runCount');
});

test('runDueGoals: a thrown runner is an honest error row and the batch continues', async () => {
  const root = tmp();
  mkGoal(root, { name: 'boom', minutesAgo: 300 });
  mkGoal(root, { name: 'fine', minutesAgo: 300 });
  let calls = 0;
  const out = await runDueGoals(root, {
    probe: { ok: true },
    runPrompt: async ({ goal }) => {
      calls++;
      if (goal.name === 'boom') throw new Error('runner exploded');
      return { status: 'ok', code: 0, signal: null, said: 'ok' };
    },
  });
  assert.equal(calls, 2, 'one bad goal never kills the batch');
  assert.equal(out.results.length, 2);
  const boom = out.results.find((r) => r.name === 'boom');
  assert.equal(boom.status, 'error');
  assert.match(boom.error, /runner exploded/);
  assert.equal(out.results.find((r) => r.name === 'fine').status, 'ok');
  const l = loadGoals(root);
  assert.equal(l.goals.find((g) => g.name === 'boom').lastStatus, 'error');
  assert.equal(l.goals.find((g) => g.name === 'fine').lastStatus, 'ok');
});

test('runDueGoals: a fabricated runner status is coerced to error — no wishful scoring', async () => {
  const root = tmp();
  mkGoal(root, { name: 'liar' });
  const out = await runDueGoals(root, { probe: { ok: true }, runPrompt: async () => ({ status: 'FAKE_PASS', code: 0, signal: null, said: 'everything is fine' }) });
  assert.equal(out.results[0].status, 'error');
  assert.equal(out.failed, 1);
  assert.equal(loadGoals(root).goals[0].lastStatus, 'error');
});

test('runDueGoals: --fast caps the child timeout at FAST_TIMEOUT_MS', async () => {
  const root = tmp();
  mkGoal(root, { name: 'swift' });
  let seen;
  await runDueGoals(root, {
    probe: { ok: true },
    fast: true,
    runPrompt: async ({ timeoutMs }) => { seen = timeoutMs; return { status: 'ok', code: 0, signal: null, said: '' }; },
  });
  assert.equal(seen, FAST_TIMEOUT_MS, `fast must cap the child timeout to ${FAST_TIMEOUT_MS}`);
});

test('runDueGoals: force runs non-due and disabled goals — explicit operator intent, recorded', async () => {
  const root = tmp();
  const patient = mkGoal(root, { name: 'patient', minutesAgo: 0, everyMin: 10080 });
  const shelved = mkGoal(root, { name: 'shelved', minutesAgo: null, everyMin: 60 });
  setGoalEnabled(root, shelved.id, false);
  let out = await runDueGoals(root, { probe: { ok: true }, runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: '' }) });
  assert.equal(out.results.length, 0, 'nothing due without force');
  assert.ok(out.problems.some((p) => /nothing due/.test(p)));
  out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: '' }) });
  assert.equal(out.results.length, 1, '--all runs enabled non-held goals even when not due');
  out = await runDueGoals(root, { probe: { ok: true }, force: uniqPrefix(shelved.id, patient.id), runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: 'manual' }) });
  assert.equal(out.results.length, 1, 'a named force runs even a DISABLED goal');
  assert.equal(loadGoals(root).goals.find((g) => g.id === shelved.id).lastStatus, 'ok');
  await assert.rejects(() => runDueGoals(root, { probe: { ok: true }, force: 'g-zzz', runPrompt: async () => ({ status: 'ok' }) }), /no goal matches/);
  await assert.rejects(() => runDueGoals(root, { probe: { ok: true }, force: 'g-', runPrompt: async () => ({ status: 'ok' }) }), /matches 2 goals/, "'g-' force is ambiguous — refused, nothing guessed (async contract: a rejection, not a sync throw)");
  assert.equal(patient.id.startsWith('g-'), true);
});

test('runDueGoals: nothing-due is honest and idle; a busy lock refuses; a corrupt store throws', async () => {
  const root = tmp();
  mkGoal(root, { name: 'patient', minutesAgo: 0, everyMin: 10080 });
  let out = await runDueGoals(root, { probe: { ok: true }, runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: '' }) });
  assert.deepEqual([out.passed, out.failed, out.skipped], [0, 0, 0]);
  assert.ok(out.nextWake > Date.now());
  assert.ok(out.problems.some((p) => /nothing due/.test(p)));
  const lock = acquireRunLock(root, {});
  out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: '' }) });
  assert.equal(out.busy, true);
  assert.match(out.problems[out.problems.length - 1], /holds the lock/);
  releaseRunLock(root, {});
  const junk = tmp();
  fs.mkdirSync(path.dirname(storePath(junk)), { recursive: true });
  fs.writeFileSync(storePath(junk), '{ torn', 'utf8');
  await assert.rejects(() => runDueGoals({ root: junk, probe: { ok: true }, runPrompt: async () => ({ status: 'ok' }) }), /torn JSON/);
});

// ── renderers: junk-tolerant by construction ────────────────────────────────

test('goalsTableText and runSummaryText survive hostile rows', () => {
  const hostile = 'na\x1b[31mme\r\nwith\nnewlines ' + 'f'.repeat(3000);
  const table = goalsTableText(
    [{ id: 'g-h-x', name: hostile, prompt: hostile, schedule: { kind: 'cron', expr: '* * * * *' }, cron: '* * * * *', everyMinutes: null, at: null, enabled: true, runCount: 0, maxMinutes: 10, yolo: false, createdAt: new Date().toISOString(), lastRun: null, lastStatus: null }],
    ['a problem line with \x1b[31mansi and\nnewline']
  );
  assert.ok(!/\x1b\[/g.test(table), 'ANSI stripped');
  assert.ok(!table.split('\n').some((l) => l.length > 400), 'rows are bounded');
  assert.match(table, /! a problem line/);
  const empty = goalsTableText([], []);
  assert.match(empty, /no goals registered/);
  assert.match(empty, /the wake is external/);
  const summary = runSummaryText({
    passed: 1, failed: 1, skipped: 1,
    results: [
      { at: 't', id: 'g-1', name: hostile, status: 'ok', durationMs: 3, steps: 2, said: hostile, artifacts: '.buddy/goals/runs/x' },
      { at: 't', id: 'g-2', name: 'bad', status: 'error', durationMs: 4, error: 'it broke' },
      { at: 't', id: 'g-3', name: 'off', status: 'SKIP', reason: 'brain unreachable — offline' },
    ],
    nextWake: new Date(Date.now() + 60000),
  });
  assert.match(summary, /GOALS RUN — 3 selected · 1 passed · 1 failed · 1 skipped/);
  assert.match(summary, /SKIP  off/);
  assert.match(summary, /artifacts:/);
});

// ── CLI end-to-end (real child, scratch root — no brain needed) ─────────────

test('CLI: goals add/list/next/dry/history/enable/disable/remove end-to-end; refusals exit 2', () => {
  const root = tmp();
  const run = (args) => spawnSync(process.execPath, [ENTRY, ...args, '--dir', root], { encoding: 'utf8', timeout: 30000 });
  let r = run(['goals', 'add', 'CLI Goal', '--every', '30', '--prompt', 'say hi']);
  assert.equal(r.status, 0, `add failed: ${r.stderr}`);
  assert.match(r.stderr, /goal added/);
  assert.match(r.stderr, /every 30m/);
  r = run(['goal', 'add', 'Cron Goal', '--cron', '*/15 * * * *', '--prompt', 'tick']); // singular alias
  assert.equal(r.status, 0, `alias add failed: ${r.stderr}`);
  r = run(['goals', 'add', 'One Shot', '--at', '2026-11-01 09:30', '--prompt', 'once']);
  assert.equal(r.status, 0);
  r = run(['goals', 'list']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /CLI Goal/);
  assert.match(r.stderr, /cron \*\/15 \* \* \* \* \(UTC\)/);
  r = run(['goals', 'next']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /next wake/);
  r = run(['goals', 'run', '--dry']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no runner was called/);
  r = run(['goals', 'run']);
  assert.equal(r.status, 1, 'nothing due → exit 1, honest, not a pass');
  assert.match(r.stderr, /GOALS RUN/);
  r = run(['goals', 'history']);
  assert.equal(r.status, 0);
  r = run(['goals', 'disable', 'CLI']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /disabled/);
  r = run(['goals', 'enable', 'CLI']);
  assert.equal(r.status, 0);
  r = run(['goals', 'remove', 'One Shot']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /goal removed/);
  r = run(['goals', 'wat']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown goal subcommand/);
  r = run(['goals', 'add', 'NoPrompt', '--every', '10']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs --prompt/);
  r = run(['goals', 'add', 'BadEvery', '--prompt', 'p', '--every', '99999999']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--every/);
  r = run(['goals', 'add', 'BadCron', '--prompt', 'p', '--cron', '61 * * * *']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /honestly/);
  r = run(['goals', 'add', 'Two', '--prompt', 'p', '--every', '10', '--cron', '* * * * *']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ONE schedule form/);
});

test('CLI: a held lock makes goals run exit 3; the dry run still works (it never ticks)', () => {
  const root = tmp();
  const set = spawnSync(process.execPath, [ENTRY, 'goals', 'add', 'Busy', '--prompt', 'p', '--every', '1', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(set.status, 0);
  const store = JSON.parse(fs.readFileSync(storePath(root), 'utf8'));
  store.goals[0].createdAt = new Date(Date.now() - 10 * 60000).toISOString();
  fs.writeFileSync(storePath(root), JSON.stringify(store), 'utf8');
  const lock = acquireRunLock(root, {});
  assert.equal(lock.ok, true);
  const run = spawnSync(process.execPath, [ENTRY, 'goals', 'run', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 3, `busy tick must exit 3, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /holds the lock/);
  const dry = spawnSync(process.execPath, [ENTRY, 'goals', 'run', '--dry', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(dry.status, 0, 'the dry view works even while another tick holds the lock');
  assert.match(dry.stderr, /would fire now/);
  releaseRunLock(root, {});
});
