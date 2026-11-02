// v067-p0-hardening.test.js — the v0.67.0 P0 hardening wave, one test per fix:
//   1. the self-edit firewall (AGENT_DENY_GLOBS) covers the .buddy control
//      plane — files the agent could otherwise rewrite to grant itself
//      durable privilege (allow rules, MCP servers, personas, slash
//      commands, goals that later run unattended, planted "lessons" that
//      ride every future recall) or to erase its own audit trail
//   2. headless runs deny risky tools by default; --yolo is the explicit
//      operator opt-in; --safe stays the hard deny
//   3. the router fails FAST when every gateway is parked — the 30s in-call
//      sleep is gone; the final error carries the park times and /retry hint
//   4. `buddy update` only moves forward (ancestor check) and verifies the
//      checkout against the commit it validated, then records the event
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAgentDeniedPath } from '../src/harness/scaffold.js';
import { defaultApproval } from '../src/terminal/repl.js';
import { GatewayRouter } from '../src/brain/router.js';
import { BuddyError, RateLimitError } from '../src/util.js';
import { planUpdate, cmdUpdate } from '../src/update.js';

// ── 1. control-plane firewall ────────────────────────────────────────────────

test('firewall: the .buddy control plane is agent-denied', () => {
  const denied = [
    '.buddy/settings.json',            // permission rules — the gate reads them
    '.buddy/mcp.json',                 // MCP servers auto-spawn next session
    '.buddy/agents/helper.md',         // personas
    '.buddy/agents/deep/nested.md',    // ** crosses directories
    '.buddy/commands/ship.md',         // slash commands
    '.buddy/goals.json',               // decides what runs unattended later
    '.buddy/goals/history.jsonl',
    '.buddy/experience/EXPERIENCE.md', // rides every future lesson recall
    '.buddy/todo.json',                // the todo tool owns it, not fs_write
    '.buddy/routing.json',
    '.buddy/audit.jsonl',              // the agent must not edit its own record
    '.buddy/events.jsonl',
  ];
  for (const p of denied) assert.equal(isAgentDeniedPath(p), true, p);
  // Conversation/plans stay agent-visible: the resume picker is user-driven,
  // and blinding the model to its own history buys nothing (P1 audit note).
  assert.equal(isAgentDeniedPath('.buddy/sessions/2026-01-01.jsonl'), false);
  assert.equal(isAgentDeniedPath('.buddy/plans/plan.md'), false);
  assert.equal(isAgentDeniedPath('src/app.js'), false);
});

// ── 2. headless approval default ─────────────────────────────────────────────

test('approval: headless default denies risky tools; --yolo opts in; --safe stays hard', () => {
  assert.equal(defaultApproval({ yolo: true })(), 'yes');
  // 'no-headless' (not 'no'): chat.js gives the model different guidance for
  // an unattended default than for a user's explicit refusal.
  assert.equal(defaultApproval({})(), 'no-headless');
  assert.equal(defaultApproval()(), 'no-headless');
  assert.equal(defaultApproval({ safe: true })(), 'no-headless');
  assert.equal(defaultApproval({ safe: true, yolo: true })(), 'no-headless'); // safe wins
});

test('chat: the headless denial verdict reaches the gate (source-text guard)', () => {
  // The gate must treat 'no-headless' as a denial — subagents.js must NOT
  // fall through and run the risky tool (that was the bug this guards).
  const chatSrc = fs.readFileSync(new URL('../src/agent/chat.js', import.meta.url), 'utf8');
  assert.match(chatSrc, /decision === 'no' \|\| decision === 'no-headless'/);
  const subSrc = fs.readFileSync(new URL('../src/agent/subagents.js', import.meta.url), 'utf8');
  assert.match(subSrc, /decision === 'no-headless'/);
});

test('goals: the recorded yolo choice reaches the headless child', () => {
  // runPromptDefault spawns a real child, so this is a source-text guard
  // (same pattern as v066): before v0.67 the flag was metadata only and the
  // child auto-approved implicitly — this pins the wiring that replaced it.
  const src = fs.readFileSync(new URL('../src/goals.js', import.meta.url), 'utf8');
  assert.match(src, /goal\?\.yolo \? \['--yolo'\] : \[\]/);
});

// ── 3. router: fail fast when every gateway is parked ────────────────────────

function fakeGateway(name, behavior) {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    async chat() {
      calls++;
      const out = behavior(calls);
      if (out instanceof RateLimitError || out instanceof BuddyError) throw out;
      return out;
    },
  };
}

test('router: all gateways parked → fast ALL_GATEWAYS_FAILED (no in-call sleep)', async () => {
  const a = fakeGateway('a', () => new RateLimitError('limited', { retryAfterMs: 60000 }));
  const b = fakeGateway('b', () => new RateLimitError('limited', { retryAfterMs: 30000 }));
  const r = new GatewayRouter(new Map([['a', a], ['b', b]]), { gatewayOrder: ['a', 'b'], maxRoundTrips: 2, failureThreshold: 99 });
  const t0 = Date.now();
  let err = null;
  try {
    await r.chat([{ role: 'user', content: 'x' }]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the chain to fail');
  assert.equal(err.code, 'ALL_GATEWAYS_FAILED');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `must fail fast, took ${elapsed}ms (the old code slept up to 30s here)`);
  // Both parks named, with the /retry hint — the scheduled retry.
  assert.match(err.message, /a: rate-limited \(60s\)/);
  assert.match(err.message, /b: rate-limited \(30s\)/);
  assert.match(err.message, /wait ~\d+s for the rate limit to lift, then \/retry/);
});

// ── 4. update: forward-only, verified, recorded ──────────────────────────────

function scriptRun(script) {
  const calls = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return { ...(script[args.join(' ')] || { ok: true, stdout: '', stderr: '' }) };
    },
  };
}

test('update: a tag that is not ahead of HEAD is refused (rollback/rewritten history)', () => {
  const script = {
    'fetch origin --tags': { ok: true, stdout: '' },
    'tag -l --sort=-v:refname': { ok: true, stdout: 'v0.99.0\n' },
    'status --porcelain': { ok: true, stdout: '' },
    'rev-parse v0.99.0^{commit}': { ok: true, stdout: 'aaa111222333\n' },
    'merge-base --is-ancestor HEAD aaa111222333': { ok: false, stderr: 'not ancestor' },
  };
  const plan = planUpdate({ currentVersion: '0.66.0', run: scriptRun(script).run, cwd: '/x' });
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /not ahead of the current checkout/);
  // --force keeps the operator in charge of the override
  const forced = planUpdate({ currentVersion: '0.66.0', run: scriptRun(script).run, cwd: '/x', force: true });
  assert.equal(forced.action, 'checkout');
  assert.equal(forced.sha, 'aaa111222333');
});

test('update: end-to-end verifies HEAD against the validated tag and records the event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v067-update-'));
  const lines = [];
  const script = {
    'fetch origin --tags': { ok: true, stdout: '' },
    'tag -l --sort=-v:refname': { ok: true, stdout: 'v0.99.0\n' },
    'status --porcelain': { ok: true, stdout: '' },
    'rev-parse v0.99.0^{commit}': { ok: true, stdout: 'aaa111222333\n' },
    'merge-base --is-ancestor HEAD aaa111222333': { ok: true, stdout: '' },
    '-c advice.detachedHead=false checkout v0.99.0': { ok: true, stdout: '' },
    'rev-parse HEAD': { ok: true, stdout: 'aaa111222333\n' },
  };
  const code = await cmdUpdate([], { cwd: root, out: (s) => lines.push(s), run: scriptRun(script).run });
  assert.equal(code, 0);
  assert.ok(lines.join('\n').includes('aaa111222333'), 'the commit sha is reported');
  const events = fs.readFileSync(path.join(root, '.buddy', 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const ev = events.find((e) => e.type === 'update');
  assert.ok(ev, 'the update lands in the events log');
  assert.equal(ev.to, 'v0.99.0');
  assert.equal(ev.sha, 'aaa111222333');
});

test('update: HEAD mismatch after checkout is an error, not a silent success', async () => {
  const lines = [];
  const script = {
    'fetch origin --tags': { ok: true, stdout: '' },
    'tag -l --sort=-v:refname': { ok: true, stdout: 'v0.99.0\n' },
    'status --porcelain': { ok: true, stdout: '' },
    'rev-parse v0.99.0^{commit}': { ok: true, stdout: 'aaa111222333\n' },
    'merge-base --is-ancestor HEAD aaa111222333': { ok: true, stdout: '' },
    '-c advice.detachedHead=false checkout v0.99.0': { ok: true, stdout: '' },
    'rev-parse HEAD': { ok: true, stdout: 'bbb444555666\n' },
  };
  const code = await cmdUpdate([], { cwd: '/x', out: (s) => lines.push(s), run: scriptRun(script).run });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /checkout verification failed/);
});
