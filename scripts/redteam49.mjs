// v0.49.0 RED TEAM PASS (war-room Play 4) — try to break the goals &
// scheduled-runs plane before it ships: registration refusals (schedule-form
// lies, junk numbers, cron injection, oversized floods), the store under
// direct attack (torn/flooded/polluted/hostile shapes — nothing may ever be
// silently deleted or guessed), the tick lock under race and sabotage (a
// second PROCESS must never double-fire a live tick; a stale steal must
// actually WORK and prove ownership), the tick itself (fabricated statuses,
// throwing runners, unreachable brains, 100k said-floods, HELD goals that
// must never run even under a named force), and the renderers (no control
// char may smuggle into any listing). Two planted canaries: a PROMPT phrase
// that must never reach artifacts/history (promptChars discipline) and a
// control-char name that must never survive a renderer. A crash, a guessed
// mutation, a double-fire, or a fabricated pass = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  buildGoal, normalizeGoal, loadGoals, addGoal, removeGoal, setGoalEnabled,
  nextDue, nextWake, parseCron, appendHistory, readHistory,
  acquireRunLock, releaseRunLock, runDueGoals, goalsTableText, runSummaryText,
  storePath, historyPath, lockPath, runsDir, MAX_GOALS, STALE_LOCK_MS, oneLine,
} from '../src/goals.js';

const CORE_URL = new URL('../src/goals.js', import.meta.url).pathname;
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `v49-redteam-${tag}-`));
const P_CANARY = 'REDTEAM-49-PROMPT-CANARY-9f3a2b7c';
const errs = [];
let pass = 0;
let fail = 0;

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const attempt = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) {
    fail++; errs.push(e); console.log(`  ✖ ${name}\n      ${oneLine(String(e?.message || e), 150)}`);
  }
};
const hostileStore = (root, body) => {
  fs.mkdirSync(path.dirname(storePath(root)), { recursive: true });
  fs.writeFileSync(storePath(root), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
};
const ControlName = 'evil\u001b[31mname\u001b]0;pwned\u0007with\nnewline';
const runnerOk = () => async () => ({ status: 'ok', code: 0, signal: null, said: 'fine' });

console.log('\n── A. registration refuses junk ──────────────────────────────────');
await attempt('no schedule form / two schedule forms are both refused ("a goal with two calendars lies")', () => {
  assert.throws(() => buildGoal({ name: 'x', prompt: 'p' }), /one schedule form/);
  assert.throws(() => buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, cron: '* * * * *' }), /ONE schedule form/);
  assert.throws(() => buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, at: '2026-01-01 10:00' }), /ONE schedule form/);
});
await attempt('--every junk: 0, -5, 1.5, "junk", 525601 (> one-year cap) — all refused with the cap named', () => {
  for (const bad of [0, -5, 1.5, 'junk', NaN, 525601]) {
    assert.throws(() => buildGoal({ name: 'x', prompt: 'p', everyMinutes: bad }), /--every must be a whole number/, `every=${String(bad)} must refuse`);
  }
  ok(buildGoal({ name: 'x', prompt: 'p', everyMinutes: 525600 }).everyMinutes === 525600, 'the cap itself is legal');
});
await attempt('cron injection and junk exprs refuse: 4 fields, 6 fields, minute 60, dow 8, "; rm -rf /", "$(id)"', () => {
  for (const bad of ['* * * *', '* * * * * *', '60 * * * *', '* * * * 8', '; rm -rf /', '$(id) * * * *', '']) {
    assert.throws(() => buildGoal({ name: 'x', prompt: 'p', cron: bad }), /cron/i, `cron=${JSON.stringify(bad)} must refuse`);
  }
});
await attempt('--at junk: month 13, hour 99, "tomorrow", torn ISO — all refused', () => {
  for (const bad of ['2026-13-01 10:00', '2026-01-01 99:99', 'tomorrow', '2026-01-01', 12345]) {
    assert.throws(() => buildGoal({ name: 'x', prompt: 'p', at: bad }), /--at/i, `at=${String(bad)} must refuse`);
  }
});
await attempt('hostile names cannot smuggle control chars: ANSI, OSC, newline — stored sanitized and bounded', () => {
  const g = buildGoal({ name: ControlName, prompt: 'p', everyMinutes: 10 });
  ok(!/[\u001b\u0007\n\r]/.test(g.name), 'no control chars survive into the stored name');
  ok(g.name.length <= 120, `name bounded (got ${g.name.length})`);
  assert.throws(() => buildGoal({ name: '   ', prompt: 'p', everyMinutes: 10 }), /needs a name/);
});
await attempt('prompt discipline: empty refused, >8000 refused, prompt is stored VERBATIM (it is the task text)', () => {
  assert.throws(() => buildGoal({ name: 'x', prompt: '   ' }), /needs --prompt/);
  assert.throws(() => buildGoal({ name: 'x', prompt: 'a'.repeat(8001) }), /too long/);
  ok(buildGoal({ name: 'x', prompt: '  padded task  ', everyMinutes: 10 }).prompt === 'padded task', 'prompt trimmed, never mangled');
});
await attempt('--max-minutes junk: 0, -1, 1.5, 721 (> 12h run cap) — refused; the run cap is hard', () => {
  for (const bad of [0, -1, 1.5, 'junk', 721]) {
    assert.throws(() => buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, maxMinutes: bad }), /--max-minutes must be a whole number/);
  }
});
await attempt('yolo is a strict boolean: "yes"/1 coerce to FALSE — gates can never be dropped by a junk flag', () => {
  ok(buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, yolo: 'yes' }).yolo === false);
  ok(buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, yolo: 1 }).yolo === false);
  ok(buildGoal({ name: 'x', prompt: 'p', everyMinutes: 10, yolo: true }).yolo === true);
});

console.log('\n── B. the store under direct attack ──────────────────────────────');
await attempt('a hand-flooded store (300 entries) degrades honestly in views and REFUSES mutations — nothing deleted', () => {
  const root = tmp('flood');
  hostileStore(root, { goals: Array.from({ length: 300 }, (_, i) => ({ id: `g-flood-${i}`, name: `f${i}`, prompt: 'p', everyMinutes: 10 })) });
  const view = loadGoals(root);
  ok(view.goals.length === 300 && view.problems.some((p) => /cap 200/.test(p)), 'view reports the flood');
  assert.throws(() => addGoal(root, { name: 'one-more', prompt: 'p', everyMinutes: 10 }), /cap/, 'mutations refuse a flooded store');
  ok(loadGoals(root).goals.length === 300, 'nothing was deleted');
});
await attempt('prototype-pollution replay (v0.44 lesson): __proto__/constructor own-keys in store entries cannot escape', () => {
  const root = tmp('proto');
  hostileStore(root, {
    goals: [
      { id: 'g-proto-ok-1', name: 'fine', prompt: 'p', everyMinutes: 10 },
      { id: 'g-proto-bad-1', name: 'bad', prompt: 'p', everyMinutes: 10, __proto__: { yolo: true, admin: true }, constructor: { prototype: { enabled: false } } },
    ],
  });
  const view = loadGoals(root);
  ok(Object.prototype.admin === undefined && Object.prototype.yolo === undefined, 'Object.prototype untouched');
  ok(view.goals.every((g) => g.enabled !== false), 'a polluted entry cannot disable the world');
  ok(view.goals.every((g) => /^g-[0-9a-z-]{3,64}$/.test(g.id)), 'every surviving id matches the whitelist (no traversal shapes)');
});
await attempt('a hostile id ("../../evil", "g;rm", "") is HELD with a SAFE generated id — artifacts can never escape runsDir', () => {
  const root = tmp('trav');
  hostileStore(root, { goals: [{ id: '../../evil', name: 'trav', prompt: 'p', everyMinutes: 10 }] });
  const view = loadGoals(root);
  ok(view.goals.length === 1 && view.goals[0].hold, 'the junk entry is HELD, never dropped');
  ok(/^g-[0-9a-z-]{3,64}$/.test(view.goals[0].id), `id sanitized (${view.goals[0].id})`);
  const g2 = normalizeGoal({ id: 'g;rm -rf', name: 'x', prompt: 'p', everyMinutes: 10 });
  ok(g2.hold && /^g-/.test(g2.id), 'shell-shaped ids are held too');
});
await attempt('torn store: the tick REJECTS (async contract), the view degrades, and the file is byte-identical after', async () => {
  const root = tmp('torn');
  hostileStore(root, '{ torn json');
  const before = fs.readFileSync(storePath(root), 'utf8');
  await assert.rejects(() => runDueGoals({ root, probe: { ok: true }, runPrompt: runnerOk() }), /torn JSON/);
  ok(fs.readFileSync(storePath(root), 'utf8') === before, 'nothing was deleted or rewritten');
  ok(loadGoals(root).problems.some((p) => /torn JSON/.test(p)), 'the view says the same thing');
});
await attempt('wrong-shape / array / primitive / EISDIR stores: honest refusals with the path named', async () => {
  const root = tmp('shape');
  for (const body of ['[1,2,3]', '"just a string"', '42', '{"nope":true}']) {
    const r = tmp('shape2');
    hostileStore(r, body);
    ok(loadGoals(r).problems.length >= 1, `shape ${body.slice(0, 12)} degrades with a problem`);
    assert.throws(() => addGoal(r, { name: 'x', prompt: 'p', everyMinutes: 10 }), /(shape|corrupt|unreadable)/, 'mutations refuse');
  }
  const dirStore = tmp('dirstore');
  fs.mkdirSync(storePath(dirStore), { recursive: true }); // the store path IS a directory
  ok(loadGoals(dirStore).problems.some((p) => /unreadable/.test(p)), 'EISDIR degrades honestly');
  await assert.rejects(() => runDueGoals({ root: dirStore, probe: { ok: true }, runPrompt: runnerOk() }), /(unreadable|shape)/);
});
await attempt('the API cannot flood the store: MAX_GOALS cap refuses with the count, store stays intact', () => {
  const root = tmp('cap');
  for (let i = 0; i < MAX_GOALS; i++) addGoal(root, { name: `g${i}`, prompt: 'p', everyMinutes: 10 });
  assert.throws(() => addGoal(root, { name: 'over', prompt: 'p', everyMinutes: 10 }), /cap reached \(200\)/);
  ok(loadGoals(root).goals.length === MAX_GOALS);
});

console.log('\n── C. the tick lock under race and sabotage ──────────────────────');
await attempt('live lock: second acquire busy-refuses with the pid and "double-fire"; junk/stale locks are stolen LOUDLY', () => {
  const root = tmp('lock');
  const t0 = 1_000_000_000_000;
  ok(acquireRunLock(root, { nowMs: t0 }).ok);
  const second = acquireRunLock(root, { nowMs: t0 + 1000 });
  ok(second.busy && /holds the lock/.test(second.error) && /double-fire/.test(second.error), 'honest busy');
  const stolen = acquireRunLock(root, { nowMs: t0 + 1000 + STALE_LOCK_MS + 1 });
  ok(stolen.ok && stolen.stole && /pid/.test(stolen.stoleFrom), `stale steal works (${stolen.stoleFrom})`);
  const mine = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'));
  ok(mine.pid === process.pid, 'after a steal, the lock PROVABLY belongs to the stealer');
  releaseRunLock(root, {});
  fs.writeFileSync(lockPath(root), '\x00 not json', 'utf8');
  const junk = acquireRunLock(root, { nowMs: t0 });
  ok(junk.ok && /junk lock/.test(junk.stoleFrom), 'a junk lock is stolen and named');
  releaseRunLock(root, {});
});
await attempt('a second PROCESS cannot double-fire a live tick — and takes over cleanly once it is released', () => {
  const root = tmp('xproc');
  ok(acquireRunLock(root, {}).ok, 'parent holds the lock');
  const childCode = `const { acquireRunLock } = await import(${JSON.stringify(CORE_URL)});
    const r = acquireRunLock(${JSON.stringify(root)}, {});
    console.log(JSON.stringify({ ok: !!r.ok, busy: !!r.busy }));`;
  const c1 = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { encoding: 'utf8' });
  ok(JSON.parse(c1.stdout).busy === true, `child is busy (${c1.stdout.trim()})`);
  releaseRunLock(root, {});
  const c2 = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { encoding: 'utf8' });
  ok(JSON.parse(c2.stdout).ok === true, 'after release, the next tick takes over');
});
await attempt('release discipline: a foreign pid lock is refused and left alone; our own releases cleanly', () => {
  const root = tmp('rel');
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: 999999, at: new Date().toISOString() }), 'utf8');
  const rel = releaseRunLock(root, { pid: process.pid });
  ok(rel.ok === false && /held by pid/.test(rel.error), 'foreign lock refused');
  ok(fs.existsSync(lockPath(root)), 'foreign lock left alone');
  ok(releaseRunLock(root, { pid: 999999 }).ok === true, 'the holder itself releases');
});
await attempt('sabotage: the lock directory replaced by a file → honest failure, no crash, nothing guessed', () => {
  const root = tmp('sabotage');
  // harness note: the first draft of this recipe mkdir'd .buddy/goals and then
  // writeFileSync'd OVER THE DIRECTORY — the EISDIR came from the TEST's own
  // setup, not the product. The real sabotage is the direct file form, plus
  // the lock FILE replaced by a directory (both must degrade honestly).
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'goals'), 'not a dir', 'utf8'); // .buddy/goals is a FILE
  const r = acquireRunLock(root, {});
  ok(r.ok === false && r.error, `honest failure (${oneLine(r.error || '', 80)})`);
});
await attempt('sabotage: the lock FILE replaced by a directory → honest busy-refusal, no crash', () => {
  const root = tmp('sabotage2');
  fs.mkdirSync(path.join(root, '.buddy', 'goals'), { recursive: true });
  fs.mkdirSync(lockPath(root)); // run.lock is now a DIRECTORY
  const r = acquireRunLock(root, {});
  ok(r.ok === false && r.error, `honest failure (${oneLine(r.error || '', 90)})`);
});

console.log('\n── D. the tick under attack ──────────────────────────────────────');
await attempt('junk roots: null / "" / 123 reject honestly — never a silent cwd fallback', async () => {
  for (const bad of [null, '', 123]) {
    await assert.rejects(() => runDueGoals({ root: bad, probe: { ok: true }, runPrompt: runnerOk() }), /root directory/);
  }
});
await attempt('a busy lock means NOTHING happens: the runner is never called, nothing lands in history, the refusal is the LAST problem', async () => {
  const root = tmp('busy');
  addGoal(root, { name: 'due', prompt: 'p', everyMinutes: 1 });
  let ran = false;
  const lock = acquireRunLock(root, {});
  ok(lock.ok);
  const out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async () => { ran = true; return { status: 'ok' }; } });
  ok(out.busy === true && ran === false, 'no runner call under a busy lock');
  ok(out.results.length === 0 && readHistory(root).length === 0, 'no rows, no history');
  ok(/holds the lock/.test(out.problems[out.problems.length - 1]), 'the refusal is the last problem');
  releaseRunLock(root, {});
});
await attempt('THE HOLD CONTRACT: a HELD goal can NEVER run — not due, not --all, and not even by a NAMED force', async () => {
  const root = tmp('held');
  hostileStore(root, { goals: [
    { id: 'g-held-one-ok', name: 'held-one', prompt: '', schedule: null, everyMinutes: null, cron: null, at: null, enabled: true, runCount: 0, createdAt: new Date().toISOString() },
    { id: 'g-live-two-ok', name: 'live-two', prompt: 'p', everyMinutes: 1, enabled: true, runCount: 0, createdAt: new Date(Date.now() - 3600_000).toISOString() },
  ] });
  const view = loadGoals(root);
  ok(view.goals.find((g) => g.id === 'g-held-one-ok').hold, 'the junk definition is HELD');
  let ran = [];
  await assert.rejects(
    () => runDueGoals(root, { probe: { ok: true }, force: 'g-held-one', runPrompt: async (r) => { ran.push(r.goal.id); return { status: 'ok' }; } }),
    /HELD/i,
    'a named force must refuse a held goal — hold means never scheduled by run',
  );
  ok(ran.length === 0, 'the runner was never invoked for the held goal');
  const all = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: runnerOk() });
  ok(all.results.every((r) => r.id !== 'g-held-one-ok'), '--all never selects held goals');
});
await attempt('fabricated statuses cannot pass: "passed"/"OK"/1/"ok " all coerce to error — the whitelist is the only door', async () => {
  const root = tmp('fabricate');
  for (const lie of ['passed', 'OK', 'PASSED', 1, 'ok ', null]) {
    const r = tmp('fab2');
    addGoal(r, { name: 'x', prompt: 'p', everyMinutes: 1 });
    const out = await runDueGoals(r, { probe: { ok: true }, force: true, runPrompt: async () => ({ status: lie }) });
    ok(out.results[0].status === 'error', `status ${JSON.stringify(lie)} coerced to error`);
  }
});
await attempt('a throwing runner is one honest error row; the batch continues and the next goal still scores', async () => {
  const root = tmp('throw');
  addGoal(root, { name: 'boom', prompt: 'p', everyMinutes: 1 });
  addGoal(root, { name: 'calm', prompt: 'p', everyMinutes: 1 });
  const out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async (r) => {
    if (r.goal.name === 'boom') throw new Error('runner exploded');
    return { status: 'ok', code: 0, signal: null, said: 'survived' };
  } });
  ok(out.failed === 1 && out.passed === 1, `boom=error, calm=ok (${out.passed}/${out.failed})`);
  ok(/runner exploded/.test(out.results.find((r) => r.status === 'error').error), 'the error is named');
});
await attempt('an unreachable brain is an honest SKIP: rows + history, runCount untouched, runner never called', async () => {
  const root = tmp('offline');
  addGoal(root, { name: 'g1', prompt: 'p', everyMinutes: 1 });
  addGoal(root, { name: 'g2', prompt: 'p', everyMinutes: 1 });
  let ran = false;
  const out = await runDueGoals(root, { probe: { ok: false, reason: 'rate-limited' }, force: true, runPrompt: async () => { ran = true; return { status: 'ok' }; } });
  ok(out.skipped === 2 && ran === false, 'both SKIP, no runner call');
  ok(out.results.every((r) => r.status === 'SKIP' && /rate-limited/.test(r.reason)), 'the reason rides the row');
  ok(readHistory(root).length === 2, 'SKIPs land in history');
  ok(loadGoals(root).goals.every((g) => g.runCount === 0), 'a SKIP advances nothing');
});
await attempt('a 100k-char ANSI/newline flood in "said" is capped to 200 sanitized chars in the row AND the artifacts', async () => {
  const root = tmp('floodsaid');
  addGoal(root, { name: 'loud', prompt: 'p', everyMinutes: 1 });
  const out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async () => ({
    status: 'ok', code: 0, signal: null,
    said: `${'\u001b[31m'.repeat(100)}x`.repeat(3000),
  }) });
  const row = out.results[0];
  ok(row.said.length <= 200, `said capped (${row.said.length})`);
  ok(!/[\u001b\u0007]/.test(row.said), 'no control chars in the row');
  const body = JSON.parse(fs.readFileSync(path.join(root, row.artifacts, 'result.json'), 'utf8'));
  ok((body.said || '').length <= 200, 'the artifact says the same thing');
});
await attempt('PROMPT CANARY discipline: the prompt text NEVER reaches artifacts or history — promptChars only', async () => {
  const root = tmp('canary');
  addGoal(root, { name: 'secret-task', prompt: `run quietly with ${P_CANARY} inside`, everyMinutes: 1 });
  const out = await runDueGoals(root, { probe: { ok: true }, force: true, runPrompt: async () => ({ status: 'ok', code: 0, signal: null, said: 'done' }) });
  ok(out.results[0].artifacts, 'artifacts exist');
  const dir = path.join(root, out.results[0].artifacts);
  const captured = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    + '\n' + fs.readFileSync(historyPath(root), 'utf8');
  ok(!captured.includes(P_CANARY), 'the prompt canary appears in NO artifact and NO history row');
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  ok(Number.isInteger(body.goal?.promptChars) && body.goal.prompt === undefined, 'promptChars, never the prompt');
  ok(JSON.parse(fs.readFileSync(storePath(root), 'utf8')).goals[0].prompt.includes(P_CANARY), 'the STORE holds the prompt by design (excluded from the scan)');
});
await attempt('history survives abuse: a 1MB row, torn lines, junk statuses — readHistory stays bounded and honest', () => {
  const root = tmp('histflood');
  appendHistory(root, { at: 't0', id: 'g-big', name: 'big', status: 'ok', durationMs: 1, said: 'y'.repeat(1_000_000) });
  fs.appendFileSync(historyPath(root), '{ torn\n', 'utf8');
  appendHistory(root, { at: 't1', id: 'g-big', name: 'big', status: 'PASSED', durationMs: 1 });
  const rows = readHistory(root, { limit: 100 });
  ok(rows.length === 2, `torn line skipped, 2 readable rows (${rows.length})`);
  ok(readHistory(root, { limit: 1 }).length === 1, 'limit works under flood');
});

console.log('\n── E. schedule math and renderers under attack ───────────────────');
await attempt('nextDue/nextWake survive hostile rows: null, junk schedules, future lastRun — finite or null, never a throw', () => {
  const now = Date.now();
  const junk = [null, {}, { schedule: { kind: 'every', minutes: 'NaN' } }, { schedule: { kind: 'cron', expr: 'junk' } },
    { schedule: { kind: 'at', at: 'not-a-date' } }, { schedule: { kind: 'every', minutes: 5 }, lastRun: new Date(now + 9e12).toISOString() }];
  for (const g of junk) ok(nextDue(g, now) === null || nextDue(g, now) > now, 'nextDue is finite-or-null');
  ok(nextWake(junk, now) == null || Number.isFinite(nextWake(junk, now)), 'nextWake finite-or-null');
  ok(nextWake([null, 'junk', 42], now) == null, 'junk lists wake nothing');
});
await attempt('renderers survive ANSI/OSC/newline/1e6-length fields — every output line is bounded and control-free', () => {
  const rows = [{ id: 'g-ansi', name: ControlName, prompt: 'p', schedule: { kind: 'every', minutes: 5 }, runCount: 1e6, lastRun: '2026-01-01T00:00:00.000Z', lastStatus: '\u001b[31mok' },
    { id: 'g-long', name: 'x'.repeat(1e6), prompt: 'p', schedule: null, hold: 'why'.repeat(1e6) }];
  for (const text of [goalsTableText(rows, ['\u001b[31m problem\ninjected']), runSummaryText({ results: rows.map((r) => ({ ...r, status: 'ok', said: ControlName + 'z'.repeat(1e6), error: ControlName })) })]) {
    for (const line of text.split('\n')) {
      ok(line.length <= 420, `line bounded (${line.length})`);
      ok(!/[\u001b\u0007\r]/.test(line), 'no control chars in any rendered line');
    }
  }
});

console.log('\n── F. the finale ─────────────────────────────────────────────────');
await attempt('FINALE: every error this pass produced is canary-free and control-free', () => {
  const joined = errs.map((e) => e?.stack || String(e)).join('\n');
  ok(!joined.includes(P_CANARY), 'the prompt canary never leaked into any error');
  ok(!/\u001b\[31mname/.test(joined), 'the control-char name never leaked raw into any error');
});

console.log(`\nRED TEAM v0.49 result: ${pass} pass / ${fail} fail\n`);
process.exit(fail ? 1 : 0);
