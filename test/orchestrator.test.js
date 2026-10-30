// orchestrator.test.js — v0.58.0 run-until-done: the loop is pure here, so
// every test drives runAutonomous with INJECTED turn/verify runners (no
// wire, no subprocess): pick order, blockers, the one-shot-per-item block,
// the verify gate (RED blocks, GREEN marks done), the budget cap, plan
// adoption vs planning turn vs the honest single-item fallback, and the
// bounded event facts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pickNext,
  planFromTodoFile,
  writeTodoFile,
  todoPath,
  detectVerifyCmd,
  runVerify,
  planPrompt,
  focusPrompt,
  runAutonomous,
  MAX_ITEMS,
} from '../src/agent/orchestrator.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-orch-'));
}

const items = (a) => a.map(([id, status, blockedBy = []]) => ({ id, text: `item ${id}`, status, blocked_by: blockedBy }));

describe('pickNext', () => {
  test('first pending item with zero blockers wins, in order', () => {
    const next = pickNext(items([['1', 'done'], ['2', 'pending'], ['3', 'pending']]));
    assert.equal(next.id, '2');
  });

  test('a pending item with open blockers is skipped — the next ready one is picked', () => {
    const next = pickNext(items([['1', 'pending'], ['2', 'pending', ['1']], ['3', 'pending']]));
    assert.equal(next.id, '1'); // #2 is blocked by #1; #3 is ready but #1 is first
  });

  test('blockers unblock: once every blocker is done the item becomes pickable', () => {
    const list = items([['1', 'done'], ['2', 'pending', ['1']]]);
    assert.equal(pickNext(list)?.id, '2');
  });

  test('unknown blocker ids never select (junk in, no pick)', () => {
    const list = items([['1', 'pending', ['ghost']]]);
    assert.equal(pickNext(list), null);
  });

  test('attempted ids are skipped — an item that failed verify cannot wedge the loop', () => {
    const list = items([['1', 'pending'], ['2', 'pending']]);
    const tried = new Set(['1']);
    assert.equal(pickNext(list, tried)?.id, '2');
    tried.add('2');
    assert.equal(pickNext(list, tried), null);
  });

  test('in_progress items are not picked; all-done yields null', () => {
    assert.equal(pickNext(items([['1', 'in_progress'], ['2', 'pending', ['1']]])), null);
    assert.equal(pickNext(items([['1', 'done']])), null);
  });

  test('junk input is an honest null, never a throw', () => {
    assert.equal(pickNext(null), null);
    assert.equal(pickNext('nope'), null);
    assert.equal(pickNext([null, 42, { status: 'pending' }]), null); // no id, no pick
  });
});

describe('plan store', () => {
  test('roundtrip: writeTodoFile then planFromTodoFile returns the items', () => {
    const root = tmpRoot();
    const list = items([['1', 'pending']]);
    writeTodoFile(root, list);
    const read = planFromTodoFile(root);
    assert.equal(read.length, 1);
    assert.equal(read[0].id, '1');
    assert.equal(read[0].status, 'pending');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('missing or corrupt store is an honest null — never a guessed plan', () => {
    const root = tmpRoot();
    assert.equal(planFromTodoFile(root), null);
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    fs.writeFileSync(todoPath(root), '{not json');
    assert.equal(planFromTodoFile(root), null);
    fs.writeFileSync(todoPath(root), JSON.stringify({ savedAt: 't', items: [] }));
    assert.equal(planFromTodoFile(root), null); // empty plan is no plan
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('MAX_ITEMS is the todo tool ceiling (8)', () => {
    assert.equal(MAX_ITEMS, 8);
  });
});

describe('detectVerifyCmd', () => {
  test('the operator override wins over everything', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(detectVerifyCmd(root, 'make lint'), 'make lint');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('default: package.json test script → npm test', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
    assert.equal(detectVerifyCmd(root), 'npm test');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('no package.json — honest null (a finished turn is accepted, reported unverified)', () => {
    const root = tmpRoot();
    assert.equal(detectVerifyCmd(root), null);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('runVerify', () => {
  test('exit 0 is ok, non-zero is not, and the tail is bounded', () => {
    const root = tmpRoot();
    const good = runVerify(root, 'exit 0');
    assert.equal(good.ok, true);
    assert.equal(good.exitCode, 0);
    const bad = runVerify(root, 'echo boom-line && exit 3');
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 3);
    assert.match(bad.tail, /boom-line/);
    assert.ok(bad.tail.length <= 1600);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('prompts', () => {
  test('plan prompt asks for the todo tool and nothing else; focus prompt names the item and the verify gate', () => {
    const p = planPrompt('fix the bug', 'npm test');
    assert.match(p, /Do NOT implement/);
    assert.match(p, /todo tool/);
    const f = focusPrompt('fix the bug', { id: '2', text: 'patch it' }, 'npm test');
    assert.match(f, /#2/);
    assert.match(f, /patch it/);
    assert.match(f, /npm test/);
    assert.match(f, /ONLY/);
  });
});

describe('runAutonomous', () => {
  test('happy path: planning turn → todo file → focus turns → verify green → all done', async () => {
    const root = tmpRoot();
    const turns = [];
    const events = [];
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 5,
      verifyCmd: 'npm test',
      runOneTurn: async ({ phase, focus, turn }) => {
        turns.push({ phase, focus: focus?.id ?? null, turn });
        if (phase === 'plan') {
          writeTodoFile(root, items([['1', 'pending'], ['2', 'pending', ['1']]]));
        }
        return { ok: true, said: 'report' };
      },
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: (ev) => events.push(ev),
    });
    // plan + two focused turns
    assert.deepEqual(turns, [
      { phase: 'plan', focus: null, turn: 0 },
      { phase: 'work', focus: '1', turn: 1 },
      { phase: 'work', focus: '2', turn: 2 },
    ]);
    assert.equal(out.summary.planned, 2);
    assert.equal(out.summary.done, 2);
    assert.equal(out.summary.blocked, 0);
    assert.equal(out.summary.plannedBy, 'planning turn');
    // the file says DONE (the orchestrator is the verifier of record)
    const final = planFromTodoFile(root);
    assert.deepEqual(final.map((i) => i.status), ['done', 'done']);
    // the facts rode the event stream, bounded
    const types = events.map((e) => e.type);
    assert.ok(types.includes('orchestratorPlan'));
    assert.equal(types.filter((t) => t === 'orchestratorTurn').length, 2);
    assert.equal(types.filter((t) => t === 'orchestratorVerify').length, 2);
    assert.equal(types.filter((t) => t === 'orchestratorItemDone').length, 2);
    assert.equal(types[types.length - 1], 'orchestratorDone');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('verify RED → the item is blocked (notes + skipped), the loop moves on to the next item', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending'], ['2', 'pending']]));
    const verified = [];
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 5,
      verifyCmd: 'npm test',
      runOneTurn: async () => ({ ok: true, said: 'I edited something' }),
      runVerifyCmd: async (cmd) => {
        verified.push(cmd);
        return { ok: verified.length === 2, exitCode: verified.length === 2 ? 0 : 1 };
      },
      onEvent: () => {},
    });
    assert.equal(verified.length, 2); // #1 red, #2 green
    assert.equal(out.summary.done, 1);
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.blocked[0].id, '1');
    const final = planFromTodoFile(root);
    assert.equal(final.find((i) => i.id === '1').status, 'pending'); // honest: never faked done
    assert.match(final.find((i) => i.id === '1').notes, /blocked: verify exit 1/);
    assert.equal(final.find((i) => i.id === '2').status, 'done');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a failed turn (no reply) blocks the item without burning the verify', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending'], ['2', 'pending']]));
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 5,
      runOneTurn: async ({ focus }) => (focus.id === '1' ? { ok: false } : { ok: true, said: 'done' }),
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(out.summary.done, 1);
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.blocked[0].reason, 'turn failed');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the budget caps the loop even when items remain', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending'], ['2', 'pending'], ['3', 'pending']]));
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 2,
      runOneTurn: async () => ({ ok: true, said: 'work' }),
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(out.summary.turns, 2);
    assert.equal(out.summary.done, 2);
    assert.equal(out.summary.remaining, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an existing todo.json is ADOPTED — no planning turn is spent', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending']]));
    let planCalls = 0;
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 3,
      runOneTurn: async ({ phase }) => {
        if (phase === 'plan') planCalls += 1;
        return { ok: true, said: 'work' };
      },
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(planCalls, 0);
    assert.equal(out.summary.plannedBy, 'adopted');
    assert.equal(out.summary.done, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the honest fallback: a planning turn that produces no todo yields a single-item plan (the task itself)', async () => {
    const root = tmpRoot();
    const out = await runAutonomous({
      root,
      task: 'ship the thing',
      maxTurns: 3,
      runOneTurn: async () => ({ ok: true, said: 'I did the whole thing in one turn' }),
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(out.summary.plannedBy, 'fallback single-item');
    assert.equal(out.summary.planned, 1);
    assert.equal(out.items[0].text, 'ship the thing');
    assert.equal(out.summary.done, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('no verify command declared — a finished turn is accepted and the summary says unverified', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending']]));
    let verified = 0;
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 3,
      runOneTurn: async () => ({ ok: true, said: 'work' }),
      runVerifyCmd: async () => {
        verified += 1;
        return { ok: true, exitCode: 0 };
      },
      onEvent: () => {},
    });
    assert.equal(verified, 0);
    assert.equal(out.summary.verifyCmd, null);
    assert.equal(out.summary.done, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a throwing turn runner cannot crash the loop — the item blocks, the run completes', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending']]));
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 3,
      runOneTurn: async () => {
        throw new Error('gateway exploded');
      },
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.summary.turns, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the loop STOPS when every item is done — no idle turns burned', async () => {
    const root = tmpRoot();
    writeTodoFile(root, items([['1', 'pending'], ['2', 'pending', ['1']]]));
    let calls = 0;
    const out = await runAutonomous({
      root,
      task: 'fix it',
      maxTurns: 25,
      runOneTurn: async () => {
        calls += 1;
        return { ok: true, said: 'work' };
      },
      runVerifyCmd: async () => ({ ok: true, exitCode: 0 }),
      onEvent: () => {},
    });
    assert.equal(calls, 2);
    assert.equal(out.summary.turns, 2);
    assert.equal(out.summary.done, 2);
    assert.equal(out.summary.remaining, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
