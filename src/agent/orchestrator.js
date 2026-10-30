// orchestrator.js — v0.58.0: run-until-done (§11 −1, the capability audit's
// gap #1). The verdict the audit landed: top agents run long-horizon tasks
// with minimal steering; Buddy stopped at ONE turn per invocation. This
// module adds the missing loop ABOVE the turn:
//
//   plan once (todo v2 DAG — the todo tool's own validated shape, persisted
//   in .buddy/todo.json)  →  repeatedly  →  pickNext (first pending item
//   whose blockers are all done)  →  give the turn engine ONE focused turn
//   →  verify with the project's OWN test command  →  mark done or blocked
//   →  until the plan is finished or the turn budget is spent.
//
// THE ENGINE NEVER GUESSES: the plan is the todo tool's own DAG (validated
// there, adopted here — a planning turn only ASKS for it); the verify is
// the operator's declared command (package.json test script by default,
// orchestrator.verifyCmd override wins); an item that fails verify once is
// blocked for the rest of the run (the audit pseudocode's markBlocked) so a
// red test can never wedge the loop into a spin. Every step lands in
// events.jsonl as a bounded fact (orchestratorPlan / orchestratorTurn /
// orchestratorVerify / orchestratorItemDone / orchestratorDone). The loop
// is PURE here — turn execution and verify execution are injected, so the
// tests stub them and the CLI wires the real runOneShot + spawnSync.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MAX_ITEMS = 8; // same ceiling the todo tool enforces

export function todoPath(root) {
  return path.join(String(root ?? ''), '.buddy', 'todo.json');
}

/**
 * pickNext — the audit pseudocode's pickNext: the FIRST pending item whose
 * blockers are all done. `attempted` carries the ids this run already gave
 * a turn to (an item that failed verify once is blocked for the rest of the
 * run — a red test must never wedge the loop into a spin). Junk in, null
 * out: a non-array, junk entries and unknown blocker ids can never select.
 */
export function pickNext(items, attempted = new Set()) {
  if (!Array.isArray(items)) return null;
  const byId = new Map();
  for (const it of items) if (it && it.id != null) byId.set(String(it.id), it);
  const tried = attempted instanceof Set ? attempted : new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object' || it.id == null || it.status !== 'pending') continue;
    const id = String(it.id);
    if (tried.has(id)) continue;
    const blockedBy = Array.isArray(it.blocked_by) ? it.blocked_by.map(String) : [];
    const open = blockedBy.filter((b) => byId.get(b)?.status !== 'done');
    if (open.length === 0) return it;
  }
  return null;
}

/**
 * planFromTodoFile — the plan is whatever the todo tool persisted; a
 * missing, corrupt or empty store is an honest null, never a guessed plan.
 */
export function planFromTodoFile(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(todoPath(root), 'utf8'));
    if (Array.isArray(parsed?.items) && parsed.items.length) return parsed.items;
  } catch {
    /* absent store is an honest null */
  }
  return null;
}

export function writeTodoFile(root, items) {
  const file = todoPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), items }, null, 2));
}

function setNotes(items, id, notes) {
  const it = items.find((x) => x && String(x.id) === String(id));
  if (it) it.notes = String(notes).slice(0, 80);
}

/**
 * detectVerifyCmd — the operator's declared verify wins; otherwise the
 * project's own npm test script; otherwise null (a finished turn is then
 * accepted, honestly reported as unverified). The command is the
 * OPERATOR's declaration at the operator's trust level — the same trust
 * the REPL's `!cmd` carries — never model-authored text.
 */
export function detectVerifyCmd(root, configOverride = null) {
  if (typeof configOverride === 'string' && configOverride.trim()) return configOverride.trim();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(String(root ?? ''), 'package.json'), 'utf8'));
    if (pkg?.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) return 'npm test';
  } catch {
    /* no package.json, no test script — no default verify */
  }
  return null;
}

/**
 * runVerify — run the declared verify command in the repo root, hard
 * timeout, bounded tail (facts, not content: the event carries the exit
 * code and a 1600-char tail, never the full stream).
 */
export function runVerify(root, cmd, timeoutMs = 300000) {
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd: String(root),
    shell: true,
    timeout: Math.max(1000, Math.min(600000, timeoutMs | 0)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.slice(-1600);
  return {
    ok: r.status === 0,
    exitCode: r.status,
    timedOut: Boolean(r.error && r.error.code === 'ABORT_ERR'),
    tail,
    durationMs: Date.now() - t0,
  };
}

export function planPrompt(task, verifyCmd) {
  return (
    `${task}\n\n` +
    'ORCHESTRATOR CONTEXT (plan phase): Do NOT implement anything yet. ' +
    'Call the todo tool ONCE with the plan for this task (max 6 items, ids "1".."n", ' +
    'short texts, declare blocked_by when order matters), then IMMEDIATELY finish with ' +
    'a one-sentence summary of the plan.' +
    (verifyCmd ? ` After each item the orchestrator will run: ${verifyCmd}` : '')
  );
}

export function focusPrompt(task, item, verifyCmd) {
  return (
    `${task}\n\n` +
    `ORCHESTRATOR CONTEXT (run-until-done): you are working through a persisted plan ` +
    `(.buddy/todo.json). Your CURRENT FOCUS is item #${item.id}: "${item.text}".\n` +
    'Work ONLY on this focus item this turn. Keep the todo tool statuses accurate as you go. ' +
    'When you believe the focus is complete, finish with a short report of what changed.' +
    (verifyCmd ? ` After your turn the orchestrator runs the verify command ("${verifyCmd}") — the item counts as done ONLY if it exits 0.` : '')
  );
}

/**
 * runAutonomous — the loop. Everything harmful is injected:
 *   runOneTurn({phase, task, focus, turn}) => {ok:boolean, said?:string}
 *   runVerifyCmd(cmd) => {ok, exitCode, ...}        (defaults to runVerify(root, cmd, verifyTimeoutMs))
 * The plan is ADOPTED from .buddy/todo.json when one already exists (a
 * resumed run continues where it stopped — the benchmark RECOVER shape);
 * otherwise ONE planning turn asks for it; if even that produces no plan,
 * an honest single-item fallback keeps the loop runnable (the task itself).
 */
export async function runAutonomous({
  root,
  task,
  maxTurns = 25,
  verifyCmd = null,
  verifyTimeoutMs = 300000,
  runOneTurn,
  runVerifyCmd = null,
  onEvent = () => {},
}) {
  const t0 = Date.now();
  const cappedTask = String(task ?? '');
  const attempted = new Set();
  const blocked = [];

  // ── 1. PLAN — adopt or ask ────────────────────────────────────────────────
  let items = planFromTodoFile(root);
  let plannedBy = 'adopted';
  if (!items) {
    plannedBy = 'planning turn';
    onEvent({ type: 'orchestratorPlan', mode: 'planning' });
    let planned = false;
    try {
      ({ ok: planned } = (await runOneTurn({ phase: 'plan', task: cappedTask, focus: null, turn: 0 })) || {});
    } catch {
      planned = false;
    }
    items = planFromTodoFile(root);
    if (!Array.isArray(items) || !items.length) {
      // honest degradation: no plan from the model — the task itself is the
      // one item. The loop stays runnable; the summary SAYS so.
      items = [{ id: '1', text: cappedTask.slice(0, 120), status: 'pending', blocked_by: [] }];
      plannedBy = 'fallback single-item';
    }
  } else {
    onEvent({ type: 'orchestratorPlan', mode: 'adopted', items: items.length });
  }
  items = items.slice(0, MAX_ITEMS);

  const cmd = detectVerifyCmd(root, verifyCmd);

  // ── 2. LOOP — pick → focus turn → verify → mark ──────────────────────────
  let turn = 0;
  const done = [];
  while (turn < maxTurns) {
    const next = pickNext(items, attempted);
    if (!next) break; // every item done or blocked — the loop is honest either way
    turn += 1;
    attempted.add(String(next.id));
    onEvent({ type: 'orchestratorTurn', turn, of: maxTurns, focus: String(next.id), text: String(next.text).slice(0, 120) });

    let ok = false;
    try {
      ({ ok = false } = (await runOneTurn({ phase: 'work', task: cappedTask, focus: next, turn })) || {});
    } catch {
      ok = false;
    }
    if (!ok) {
      setNotes(items, next.id, `blocked: turn failed (turn ${turn})`);
      writeTodoFile(root, items);
      blocked.push({ id: String(next.id), reason: 'turn failed' });
      onEvent({ type: 'orchestratorBlocked', turn, focus: String(next.id), reason: 'turn failed' });
      continue;
    }

    if (cmd) {
      const verify = runVerifyCmd
        ? await runVerifyCmd(cmd)
        : runVerify(root, cmd, verifyTimeoutMs);
      onEvent({
        type: 'orchestratorVerify',
        turn,
        focus: String(next.id),
        cmd,
        exitCode: verify.exitCode ?? null,
        ok: Boolean(verify.ok),
      });
      if (!verify.ok) {
        setNotes(items, next.id, `blocked: verify exit ${verify.exitCode ?? '?'} (turn ${turn})`);
        writeTodoFile(root, items);
        blocked.push({ id: String(next.id), reason: `verify exit ${verify.exitCode ?? '?'}` });
        onEvent({ type: 'orchestratorBlocked', turn, focus: String(next.id), reason: 'verify failed' });
        continue;
      }
    }

    const it = items.find((x) => x && String(x.id) === String(next.id));
    if (it) it.status = 'done';
    writeTodoFile(root, items);
    done.push(String(next.id));
    onEvent({ type: 'orchestratorItemDone', turn, focus: String(next.id) });
  }

  // ── 3. SUMMARY — bounded facts, the ship report ──────────────────────────
  const summary = {
    plannedBy,
    planned: items.length,
    turns: turn,
    done: done.length,
    blocked: blocked.length,
    remaining: items.filter((it) => it && it.status === 'pending').length,
    verifyCmd: cmd,
    maxTurns,
    durationMs: Date.now() - t0,
  };
  onEvent({ type: 'orchestratorDone', ...summary });
  return { items, summary, blocked, done };
}
