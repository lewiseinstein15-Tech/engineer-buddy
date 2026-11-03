// serve.test.js — the serve rebuild (v0.68.0), unit level.
// Waves covered: 0 (firewall globs), 1 (lease/restart guard), 2 (delivery
// ledger fold + bounds + dead targets), 3 (missed-slot math), 4 (run tokens).
// Daemon/control end-to-end behavior is the drills' job (t5/t6); these tests
// pin the pure decisions the daemon and ledger are made of.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_DENY_GLOBS, isAgentDeniedPath, servePlaneRefusal } from '../src/harness/scaffold.js';
import { acquireLease, readLease, leaseAlive, releaseLease, LEASE_STALE_MS } from '../src/serve/lease.js';
import { countRecentRestarts, RESTART_MAX } from '../src/serve/daemon.js';
import {
  enqueueDelivery, loadDeliveryView, processDueDelivery, sweepDelivery,
  classifySend, nextRetryDelayMs, markDeadTarget, loadDeadTargets, forgetDeadTarget,
  deliveryStatusText,
} from '../src/serve/delivery.js';
import { writeRunFile, loadRunToken } from '../src/serve/runtoken.js';
import { missedSlotsFor, addGoal, editGoal, loadGoals } from '../src/goals.js';
import { atomicWrite, readJsonl } from '../src/serve/paths.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-serve-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// ── wave 0: the firewall reaches the serve plane ────────────────────────────

test('wave 0: the serve plane is inside the agent deny globs', () => {
  for (const p of [
    '.buddy/serve/obligations.jsonl',
    '.buddy/serve/lease.json',
    '.buddy/serve/runs/run-abc.json',
    '.buddy/serve/payloads/d-1.json',
    '.buddy/index/sessions.idx',
  ]) {
    assert.ok(isAgentDeniedPath(p), `agent must be denied: ${p}`);
  }
  assert.ok(AGENT_DENY_GLOBS.includes('.buddy/serve/**'));
});

test('wave 0+: the serve-plane floor refuses read-only bash (the t8 drill leak)', () => {
  // bash's risk is arg-dependent — a read-only `cat` would slip past every
  // gate and read the plane, including a run token. The floor is the answer.
  assert.ok(servePlaneRefusal('cat .buddy/serve/lease.json'));
  assert.ok(servePlaneRefusal('ls -la .buddy/serve/runs/'));
  assert.ok(servePlaneRefusal('grep token .buddy/index/sessions.idx'));
  assert.ok(servePlaneRefusal('echo x > .buddy/serve/obligations.jsonl'));
  assert.ok(servePlaneRefusal('tar czf /tmp/x.tgz .buddy/serve')); // even a bare mention
  assert.equal(servePlaneRefusal('cat .buddy/settings.json'), null, 'settings are fs-guarded; the floor is serve-scoped');
  assert.equal(servePlaneRefusal('git status'), null);
  assert.equal(servePlaneRefusal(null), null);
});

// ── wave 1: the lease ────────────────────────────────────────────────────────

test('wave 1: acquire, heartbeat freshness, and stale reclaim', () => {
  const now = Date.now();
  const first = acquireLease(root, { nowMs: now });
  assert.ok(first.ok);
  assert.ok(leaseAlive(first.lease, now + 1000));
  // a second daemon on a LIVE lease is refused, with the owner named
  const second = acquireLease(root, { nowMs: now + 1000 });
  assert.equal(second.ok, false);
  assert.match(second.error, /pid \d+/);
  // a stale heartbeat + dead pid is reclaimable
  const stale = acquireLease(root, { nowMs: now + LEASE_STALE_MS + 60_000 });
  assert.ok(stale.ok);
  assert.ok(stale.stole);
  assert.match(stale.stoleFrom, /dead or stale/);
  releaseLease(root, stale.lease.bootId);
  assert.equal(readLease(root), null);
});

test('wave 1: releaseLease never touches a successor lease', () => {
  const a = acquireLease(root);
  const b = acquireLease(root, { nowMs: Date.now() + LEASE_STALE_MS + 1000 }); // steal
  const r = releaseLease(root, a.lease.bootId); // the OLD owner tries to clean up
  assert.equal(r.ok, false);
  assert.match(r.error, /left it alone/);
  assert.equal(readLease(root).bootId, b.lease.bootId);
});

test('wave 1: the restart guard counts unclean boots inside the window', () => {
  const now = Date.now();
  const rows = [{ at: new Date(now - 60_000).toISOString() }, { at: new Date(now - 120_000).toISOString() }];
  assert.equal(countRecentRestarts(rows, now), 2);
  assert.equal(countRecentRestarts([{ at: new Date(now - 11 * 60_000).toISOString() }], now), 0); // outside the window
  assert.equal(countRecentRestarts([{ at: 'not-a-date' }], now), 0); // junk is not a restart
});

test('wave 1: RESTART_MAX stays at 3 — the loop stops at three, not eventually', () => {
  assert.equal(RESTART_MAX, 3);
});

// ── wave 2: the delivery ledger ──────────────────────────────────────────────

test('wave 2: classifySend — sent, dead, permanent, transient', () => {
  assert.equal(classifySend(200), 'sent');
  assert.equal(classifySend(204), 'sent');
  assert.equal(classifySend(404), 'dead');
  assert.equal(classifySend(403), 'dead');
  assert.equal(classifySend(410), 'dead');
  assert.equal(classifySend(400), 'permanent');
  assert.equal(classifySend(500), 'transient');
  assert.equal(classifySend(429), 'transient');
  assert.equal(classifySend(0), 'transient'); // network-level failure
});

test('wave 2: backoff is 30s then 120s then terminal — no loops', () => {
  assert.equal(nextRetryDelayMs(0), 30_000);
  assert.equal(nextRetryDelayMs(1), 30_000);
  assert.equal(nextRetryDelayMs(2), 120_000);
  assert.equal(nextRetryDelayMs(3), null);
  assert.equal(nextRetryDelayMs(50), null);
});

test('wave 2: enqueue persists BEFORE any send and works with no daemon', () => {
  const r = enqueueDelivery(root, { kind: 'webhook', target: 'https://hooks.example/x', summary: 'goal g-1 → ok', payload: { status: 'ok' } });
  assert.ok(r.ok);
  const view = loadDeliveryView(root);
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].state, 'pending');
  assert.equal(view.jobs[0].target, 'https://hooks.example/x');
});

test('wave 2: enqueue refuses junk targets without writing the ledger', () => {
  assert.equal(enqueueDelivery(root, { target: 'not a url' }).ok, false);
  assert.equal(enqueueDelivery(root, { target: 'ftp://x' }).ok, false);
  assert.equal(enqueueDelivery(root, { target: 'http://169.254.169.254/latest/meta-data' }).ok, false);
  assert.equal(loadDeliveryView(root).jobs.length, 0);
});

test('wave 2: a send is claimed then settled; transient retries are bounded', async () => {
  enqueueDelivery(root, { target: 'https://hooks.example/a', payload: {} });
  let calls = 0;
  const sender = async () => { calls += 1; return { status: calls < 3 ? 0 : 200, error: calls < 3 ? 'ECONNREFUSED' : null }; };
  const t0 = Date.now();
  let out = await processDueDelivery(root, { nowMs: t0, sender, bootId: 'b1' });
  assert.equal(calls, 1); // one pass, one attempt — the claim/send/settle cycle is per-pass
  let view = loadDeliveryView(root);
  assert.equal(view.jobs[0].state, 'pending'); // attempt 1 failed transiently
  assert.equal(view.jobs[0].attempts, 1);
  assert.equal(out.retried, 1); // the pass reports the honest retry plan (30s)
  // before nextAt the job is not due
  out = await processDueDelivery(root, { nowMs: t0 + 1000, sender, bootId: 'b1' });
  assert.equal(calls, 1);
  // after the 30s backoff it retries, fails again (attempt 2 → 120s)
  out = await processDueDelivery(root, { nowMs: t0 + 31_000, sender, bootId: 'b1' });
  assert.equal(calls, 2);
  assert.equal(out.retried, 1);
  view = loadDeliveryView(root);
  assert.equal(view.jobs[0].attempts, 2);
  // after the 120s backoff it succeeds
  out = await processDueDelivery(root, { nowMs: t0 + 31_000 + 121_000, sender, bootId: 'b1' });
  assert.equal(out.sent, 1);
  view = loadDeliveryView(root);
  assert.equal(view.jobs[0].state, 'sent');
});

test('wave 2: the retry budget terminates — attempt 3 failing is terminal', async () => {
  enqueueDelivery(root, { target: 'https://hooks.example/b', payload: {} });
  const sender = async () => ({ status: 0, error: 'down' });
  let t = Date.now();
  await processDueDelivery(root, { nowMs: t, sender });        // attempt 1 → +30s
  await processDueDelivery(root, { nowMs: t += 31_000, sender }); // attempt 2 → +120s
  await processDueDelivery(root, { nowMs: t += 121_000, sender }); // attempt 3 → terminal
  const view = loadDeliveryView(root);
  assert.equal(view.jobs[0].state, 'failed');
  assert.match(view.jobs[0].lastError, /retry budget spent/);
  // a terminal job is never touched again
  const out = await processDueDelivery(root, { nowMs: t + 600_000, sender });
  assert.equal(out.sent + out.retried + out.failed, 0);
});

test('wave 2: a dead target is attempted once, then parked forever', async () => {
  const url = 'https://gone.example/hook';
  enqueueDelivery(root, { target: url, payload: {} });
  let calls = 0;
  const sender = async () => { calls += 1; return { status: 404, error: null }; };
  await processDueDelivery(root, { sender });
  assert.equal(calls, 1);
  assert.equal(loadDeliveryView(root).jobs[0].state, 'dead');
  assert.equal(loadDeadTargets(root).count, 1);
  // the SECOND obligation to the same target costs zero attempts
  enqueueDelivery(root, { target: url, payload: {} });
  const out = await processDueDelivery(root, { sender });
  assert.equal(calls, 1);
  assert.equal(out.skippedDead, 1);
  // forget revives the TARGET — the already-terminal job stays dead (the
  // ledger is honest: that delivery was parked), so the proof of revival is
  // a fresh obligation being attempted again
  const f = forgetDeadTarget(root, url);
  assert.ok(f.ok);
  enqueueDelivery(root, { target: url, payload: {} });
  await processDueDelivery(root, { sender });
  assert.equal(calls, 2);
});

test('wave 2: a claim whose owner died settles unknown and is never retried', async () => {
  enqueueDelivery(root, { target: 'https://hooks.example/c', payload: {} });
  // simulate the crash window: claim lands, the send never does
  const { appendJsonl } = await import('../src/serve/paths.js');
  const view0 = loadDeliveryView(root);
  appendJsonl((await import('../src/serve/paths.js')).obligationsPath(root), { kind: 'evt', id: view0.jobs[0].id, event: 'claim', at: new Date().toISOString(), lease: 'dead-boot' });
  const sweep = sweepDelivery(root, { bootId: 'new-boot' });
  assert.equal(sweep.settledUnknown, 1);
  const view = loadDeliveryView(root);
  assert.equal(view.jobs[0].state, 'unknown');
  const out = await processDueDelivery(root, { sender: async () => { throw new Error('must not be called'); } });
  assert.equal(out.sent + out.retried, 0);
});

test('wave 2: torn and giant ledger lines are counted facts, never junk rows', async () => {
  enqueueDelivery(root, { target: 'https://hooks.example/t', payload: {} });
  const fs2 = await import('node:fs');
  const { obligationsPath } = await import('../src/serve/paths.js');
  fs2.appendFileSync(obligationsPath(root), '{"kind":"evt","id":TORN\n');            // torn
  fs2.appendFileSync(obligationsPath(root), 'x'.repeat(2 * 1024 * 1024) + '\n');      // giant
  fs2.appendFileSync(obligationsPath(root), '{"kind":"evt","id":"d-nojob","event":"sent"}\n'); // event for an unknown job
  const view = loadDeliveryView(root);
  assert.equal(view.jobs.length, 1); // exactly the real job
  assert.equal(view.torn, 1);
  assert.equal(view.giants, 1);
  assert.match(deliveryStatusText(root), /1 torn · 1 giant/);
});

// ── wave 3: the missed-slot ledger ──────────────────────────────────────────

test('wave 3: missedSlotsFor — every-goals count elapsed slots', () => {
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const goal = { schedule: { kind: 'every', minutes: 10 }, createdAt: new Date(t0).toISOString(), lastRun: new Date(t0).toISOString() };
  assert.equal(missedSlotsFor(goal, t0 + 10 * 60_000), 0); // exactly one slot due, none missed
  assert.equal(missedSlotsFor(goal, t0 + 45 * 60_000), 3); // slots at 10/20/30 elapsed, 40 fires now... floor(45/10)-1 = 3
  assert.equal(missedSlotsFor({ ...goal, lastRun: null, createdAt: new Date(t0).toISOString() }, t0), 0); // nothing elapsed yet
});

test('wave 3: missedSlotsFor — a FIRST fire never catches up', () => {
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  // registered an hour ago, never fired: the elapsed slots are registration
  // lag, not a lost wake — no catch-up row may exist for the first fire
  assert.equal(missedSlotsFor({ schedule: { kind: 'every', minutes: 10 }, createdAt: new Date(t0 - 3600_000).toISOString(), lastRun: null }, t0), 0);
  // after the first real fire, the ledger speaks: lastRun 25 min back on a
  // 10-minute cadence → the +10min slot was missed, the +20min slot fires now
  assert.equal(missedSlotsFor({ schedule: { kind: 'every', minutes: 10 }, createdAt: new Date(t0 - 3600_000).toISOString(), lastRun: new Date(t0 - 25 * 60_000).toISOString() }, t0), 1);
});

test('wave 3: missedSlotsFor — cron walks slots bounded, newest fires', () => {
  const goal = { schedule: { kind: 'cron', expr: '0 9 * * *' }, createdAt: '2026-10-30T09:00:00Z', lastRun: '2026-10-30T09:00:00Z' };
  const now = Date.parse('2026-11-02T09:00:00Z');
  // slots at 10-31, 11-01, 11-02 09:00 → the newest fires, two elapsed before it
  assert.equal(missedSlotsFor(goal, now), 2);
  assert.equal(missedSlotsFor({ schedule: { kind: 'at', at: '2026-11-01T00:00:00Z' }, createdAt: '2026-10-01T00:00:00Z' }, now), 0);
});

// ── wave 4: run tokens ──────────────────────────────────────────────────────

test('wave 4: write + load round-trip, then the token is consumed', () => {
  const tok = writeRunFile(root, { goalId: 'g-abc', allow: ['Bash(git *)', 'fs_read'] });
  const env = { BUDDY_RUN_FILE: tok.file, BUDDY_RUN_TOKEN: tok.token };
  const loaded = loadRunToken(root, env);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.allow, ['Bash(git *)', 'fs_read']);
  assert.equal(loaded.goalId, 'g-abc');
  assert.ok(!fs.existsSync(tok.file), 'single-use: the file is gone after the first read');
  assert.equal(env.BUDDY_RUN_FILE, undefined, 'the env is scrubbed for nested spawns');
  // a replay is worthless
  const replay = loadRunToken(root, { BUDDY_RUN_FILE: tok.file, BUDDY_RUN_TOKEN: tok.token });
  assert.equal(replay.ok, false);
});

test('wave 4: a token outside serve/runs is refused even with a valid token', () => {
  const tok = writeRunFile(root, { goalId: 'g-abc', allow: ['bash'] });
  const forged = path.join(root, 'evil.json');
  fs.writeFileSync(forged, fs.readFileSync(tok.file, 'utf8'));
  const r = loadRunToken(root, { BUDDY_RUN_FILE: forged, BUDDY_RUN_TOKEN: tok.token });
  assert.equal(r.ok, false);
  assert.match(r.reason, /under \.buddy\/serve\/runs/);
});

test('wave 4: a wrong token is refused and still consumed', () => {
  const tok = writeRunFile(root, { goalId: 'g-abc', allow: ['bash'] });
  const r = loadRunToken(root, { BUDDY_RUN_FILE: tok.file, BUDDY_RUN_TOKEN: 'deadbeef'.repeat(6) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mismatch/);
  assert.ok(!fs.existsSync(tok.file));
});

test('wave 4: junk rules are filtered at mint time — a token is always well-formed', () => {
  const tok = writeRunFile(root, { goalId: 'g-abc', allow: ['Bash(git *)', 'bad rule with spaces and no spec shape!', { obj: true }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(tok.file, 'utf8')).allow, ['Bash(git *)']);
});

// ── wave 4: the goals surface (editGoal whitelist round-trip) ───────────────

test('wave 4: editGoal grants an allowlist and a notify URL; junk refuses', () => {
  const { goal } = addGoal(root, { name: 'nightly', prompt: 'check the CI', everyMinutes: 60 });
  const edited = editGoal(root, goal.id, { allow: ['Bash(git *)', 'fs_read(docs/**)'], notify: 'https://hooks.example/goal' });
  assert.deepEqual(edited.goal.allow, ['Bash(git *)', 'fs_read(docs/**)']);
  assert.equal(edited.goal.notify, 'https://hooks.example/goal');
  // the store round-trips both fields through the whitelist
  assert.deepEqual(loadGoals(root).goals[0].allow, ['Bash(git *)', 'fs_read(docs/**)']);
  assert.equal(loadGoals(root).goals[0].notify, 'https://hooks.example/goal');
  // junk is a thrown refusal, never a silent store write
  assert.throws(() => editGoal(root, goal.id, { allow: ['not a rule!'] }), /invalid allow rule/);
  assert.throws(() => editGoal(root, goal.id, { notify: 'not-a-url' }), /--notify must be/);
  assert.throws(() => editGoal(root, goal.id, { notify: 'http://169.254.169.254/x' }), /metadata/);
  // clear paths
  assert.equal(editGoal(root, goal.id, { clearAllow: true }).goal.allow, null);
  assert.equal(editGoal(root, goal.id, { clearNotify: true }).goal.notify, null);
});

// ── wave 1 files: the cursor contract on serve JSONL ────────────────────────

test('serve JSONL: torn trailing lines never wedge the fold', () => {
  const file = path.join(root, '.buddy', 'serve', 'probe.jsonl');
  atomicWrite(file, '');
  fs.appendFileSync(file, '{"a":1}\n');
  fs.appendFileSync(file, '{"a":2'); // torn mid-write
  const { rows, torn } = readJsonl(file);
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.equal(torn, 1);
});
