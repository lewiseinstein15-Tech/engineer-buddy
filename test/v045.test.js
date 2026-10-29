// v0.45.0 — the benchmark plane: `buddy benchmark` runs THE CONTRACT's seven
// dimensions as real scored exercises with evidence artifacts.
//
// Units pin the pure scorers and the orchestration invariant on injected
// runners; the LIVE leg is a REAL run of the mechanical dimensions against a
// real `buddy mcp-serve` child (the same loopback v0.44.0 proved, now scoring
// CAPABILITIES) — REAL > SIMULATED. Live brain dimensions are never faked in
// tests: they are exercised through injected runner fakes, never pretended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DIMENSIONS, parseDimList, fetchCitation, firstToolIsPlanner, whyRatio,
  detectFalsePremiseCorrection, writeMentioning, scorecardText, runBenchmark,
} from '../src/benchmark.js';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v045-'));

// ── parseDimList ─────────────────────────────────────────────────────────────

test('benchmark: parseDimList — null means all, case/dupes normalize, order preserved', () => {
  assert.deepEqual(parseDimList(null).dims, DIMENSIONS.map((d) => d.id));
  assert.deepEqual(parseDimList('Research, REASON ,research').dims, ['research', 'reason']);
  const junk = parseDimList('research;rm -rf /tmp/x');
  assert.match(junk.error, /unknown dimension/);
  assert.match(junk.error, /known: /);
  assert.match(parseDimList('../../etc').error, /unknown dimension/);
  assert.match(parseDimList('').error, /empty --dim/);
  assert.match(parseDimList('   ').error, /empty --dim/);
  const long = parseDimList('x'.repeat(10000));
  assert.match(long.error, /unknown dimension/);
  assert.ok(long.error.length < 300, 'error is truncated, not echoed in full');
});

// ── pure scorers ─────────────────────────────────────────────────────────────

test('benchmark: firstToolIsPlanner — planners/readers ok, a write first is the failure mode', () => {
  assert.equal(firstToolIsPlanner([{ type: 'tool', tool: 'todo' }, { type: 'tool', tool: 'fs_write' }]).ok, true);
  assert.equal(firstToolIsPlanner([{ type: 'tool', tool: 'fs_read' }]).ok, true);
  assert.equal(firstToolIsPlanner([{ type: 'tool', tool: 'glob' }]).ok, true);
  assert.equal(firstToolIsPlanner([{ type: 'tool', tool: 'fs_write' }]).ok, false);
  assert.deepEqual(firstToolIsPlanner([{ type: 'say', text: 'no tools' }]), { ok: false, tool: null });
});

test('benchmark: whyRatio — majority math, zero tools stays zero, junk whys ignored', () => {
  const ev = [
    { type: 'tool', tool: 'todo', why: 'plan first' },
    { type: 'tool', tool: 'fs_read' },
    { type: 'tool', tool: 'fs_write', why: 'implement the spec' },
    { type: 'tool', tool: 'bash', why: 42 },
  ];
  const r = whyRatio(ev);
  assert.equal(r.total, 4);
  assert.equal(r.whys, 2);
  assert.equal(r.ratio, 0.5);
  assert.deepEqual(whyRatio([]), { total: 0, whys: 0, ratio: 0 });
});

test('benchmark: false-premise detection — catches corrections, never the compliant silence', () => {
  assert.equal(detectFalsePremiseCorrection('there is no 3.2.0 section in this repo', '3.2.0').caught, true);
  assert.equal(detectFalsePremiseCorrection('package.json says 3.2.0 but that does not exist here', '3.2.0').caught, true);
  assert.equal(detectFalsePremiseCorrection("the changelog doesn't mention 3.2.0 anywhere", '3.2.0').caught, true);
  assert.equal(detectFalsePremiseCorrection('the task claims 3.2.0, but actually the version is 0.1.0', '3.2.0').caught, true);
  assert.equal(detectFalsePremiseCorrection('done, updated the 3.2.0 section date as asked', '3.2.0').caught, false, 'compliance is not a correction');
  assert.equal(detectFalsePremiseCorrection('nothing about the version here', '3.2.0').caught, false);
  // the premise string is DATA — regex metacharacters must not throw
  assert.equal(detectFalsePremiseCorrection('no such 3.2.0(?) release', '3.2.0(?)').caught, true);
});

test('benchmark: writeMentioning — finds fs_write targets the transcript mentions', () => {
  const ev = [
    { type: 'tool', tool: 'fs_write', args: { _preview: '{"path":"CHANGELOG.md","content":"x"}' } },
    { type: 'tool', tool: 'fs_write', args: { _preview: '{"path":"src/a.js"}' } },
    { type: 'tool', tool: 'fs_read', args: { _preview: '{"path":"CHANGELOG.md"}' } },
  ];
  assert.equal(writeMentioning(ev, 'changelog').length, 1);
  assert.equal(writeMentioning(ev, 'package.json').length, 0);
});

// ── citation fetcher: the harness rides the SAME SSRF guard ─────────────────

test('benchmark: fetchCitation refuses non-http(s), internal addresses, and bracketed IPv6 — no network touched', async () => {
  assert.match((await fetchCitation('file:///etc/passwd')).reason, /refused/);
  assert.match((await fetchCitation('javascript:alert(1)')).reason, /refused/);
  assert.match((await fetchCitation('ftp://example.com/x')).reason, /refused/);
  assert.match((await fetchCitation('not a url at all')).reason, /not a URL/);
  assert.match((await fetchCitation('http://127.0.0.1:9/x')).reason, /SSRF guard/);
  assert.match((await fetchCitation('http://169.254.169.254/latest/meta-data/')).reason, /SSRF guard/);
  assert.match((await fetchCitation('http://10.0.0.1/x')).reason, /SSRF guard/);
  assert.match((await fetchCitation('http://[fd00::1]:8080/x')).reason, /SSRF guard/, 'bracketed IPv6 — the v0.42.0 lesson, shared guard');
});

// ── scorecard rendering ──────────────────────────────────────────────────────

test('benchmark: scorecardText — every result renders, reasons sanitize, skip reason shown', () => {
  const results = [
    { id: 'research', title: 'RESEARCH', kind: 'live', status: 'PASS', reason: 'citation fetched by the harness' },
    { id: 'verify', title: 'VERIFY', kind: 'live', status: 'FAIL', reason: 'the agent COMPLIED with a false premise\nand injected ANSI \x1b[31m codes' },
    { id: 'capabilities', title: 'CAPABILITIES', kind: 'mechanical', status: 'SKIP', reason: 'brain unreachable: injected' },
  ];
  const text = scorecardText(results, { passed: 1, failed: 1, skipped: 1, score: 0.5, benchDir: '/tmp/bench', fast: false, brain: { ok: false, reason: 'injected' } });
  assert.match(text, /research\s+live\s+PASS/);
  assert.match(text, /verify\s+live\s+FAIL/);
  assert.match(text, /capabilities\s+mechanical\s+SKIP/);
  assert.ok(!text.includes('\x1b['), 'ANSI escapes sanitized out of the scorecard');
  const lines = text.split('\n').filter((l) => l.startsWith('verify'));
  assert.equal(lines.length, 1, 'a hostile multiline reason cannot break the table (one row per dimension)');
  assert.match(text, /score: 1\/2 scored dimensions passed · 1 skipped honestly/);
  assert.match(text, /evidence: \/tmp\/bench/);
});

// ── orchestration: invariant + honest degradation (injected runners, offline) ─

function fakePass(ctx) {
  const file = path.join(ctx.dir, 'fake-artifact.json');
  fs.mkdirSync(ctx.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fake: true, dim: ctx.dim.id }), 'utf8');
  return { status: 'PASS', reason: 'injected pass', evidence: [file] };
}

test('benchmark: all-PASS run — invariant passed+failed+skipped === selected, scorecard lands on disk', async () => {
  const root = tmp();
  const runners = {};
  for (const d of DIMENSIONS) {
    if (d.id === 'evidence') continue;
    runners[d.id] = fakePass;
  }
  const out = await runBenchmark({ root, probeBrain: async () => ({ ok: true, gateway: 'injected' }), runners });
  assert.equal(out.results.length, DIMENSIONS.length);
  assert.equal(out.passed + out.failed + out.skipped, DIMENSIONS.length, 'THE invariant');
  assert.equal(out.passed, DIMENSIONS.length);
  assert.equal(out.score, 1);
  const card = JSON.parse(fs.readFileSync(path.join(out.benchDir, 'scorecard.json'), 'utf8'));
  assert.equal(card.passed, DIMENSIONS.length);
  assert.ok(card.at && card.version);
  assert.ok(fs.existsSync(path.join(out.benchDir, 'summary.md')));
  assert.ok(out.benchDir.startsWith(path.join(root, '.buddy', 'benchmark')), 'evidence contained under the root');
  // the EVIDENCE dimension audited the others for real: its note names them
  const ev = out.results.find((r) => r.id === 'evidence');
  assert.equal(ev.status, 'PASS');
  assert.match(ev.reason, /6 scored dimension\(s\) audited/);
});

function fakeFail(ctx) {
  fs.mkdirSync(ctx.dir, { recursive: true });
  const file = path.join(ctx.dir, 'fake-failure.json');
  fs.writeFileSync(file, JSON.stringify({ fake: true, dim: ctx.dim.id, failed: true }), 'utf8');
  return { status: 'FAIL', reason: 'injected failure (artifact saved — real failures leave evidence too)', evidence: [file] };
}

test('benchmark: mixed run (brain up) — FAIL counts against the score, evidence audits the failure too', async () => {
  const root = tmp();
  const runners = {
    research: fakeFail,
    reason: fakePass, build: fakePass, recover: fakePass, verify: fakePass, capabilities: fakePass,
  };
  const out = await runBenchmark({ root, probeBrain: async () => ({ ok: true, gateway: 'injected' }), runners });
  const r = Object.fromEntries(out.results.map((x) => [x.id, x.status]));
  assert.equal(r.research, 'FAIL');
  assert.equal(r.evidence, 'PASS', 'the failure itself left an artifact — audited like any other claim');
  assert.equal(out.passed + out.failed + out.skipped, DIMENSIONS.length);
  assert.equal(out.passed, 6); // five passes + evidence auditing all six scored
  assert.equal(out.failed, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.score, 6 / 7);
});

test('benchmark: brain down — live dims SKIP with the probe reason, mechanical dims still score', async () => {
  const root = tmp();
  const out = await runBenchmark({ root, probeBrain: async () => ({ ok: false, reason: 'injected: offline' }) });
  for (const id of ['research', 'reason', 'build', 'recover', 'verify']) {
    const row = out.results.find((x) => x.id === id);
    assert.equal(row.status, 'SKIP', `${id} skips when the brain is down`);
    assert.match(row.reason, /brain unreachable: injected: offline/);
  }
  assert.equal(out.results.find((x) => x.id === 'capabilities').status, 'PASS');
  assert.equal(out.results.find((x) => x.id === 'evidence').status, 'PASS');
  assert.equal(out.passed + out.failed + out.skipped, DIMENSIONS.length);
  assert.equal(out.skipped, 5);
  assert.equal(out.score, 1); // 2/2 scored — nothing faked about the two that ran
});

test('benchmark: evidence-only selection — honest SKIP, not a fabricated pass', async () => {
  const root = tmp();
  const out = await runBenchmark({ root, dims: ['evidence'] });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, 'SKIP');
  assert.match(out.results[0].reason, /nothing to audit/);
  assert.equal(out.passed, 0);
  assert.equal(out.score, null);
});

test('benchmark: hostile opts — junk root refuses honestly, junk runner result degrades to FAIL', async () => {
  await assert.rejects(() => runBenchmark({ root: null }), /non-empty path string/);
  await assert.rejects(() => runBenchmark({ root: 42 }), /non-empty path string/);
  const fileRoot = path.join(tmp(), 'afile');
  fs.writeFileSync(fileRoot, 'x');
  await assert.rejects(() => runBenchmark({ root: fileRoot }), /not a directory/);
  const root = tmp();
  const out = await runBenchmark({
    root, dims: ['capabilities'],
    runners: { capabilities: () => { throw new Error('injected boom'); } },
  });
  assert.equal(out.results[0].status, 'FAIL');
  assert.match(out.results[0].reason, /harness error: injected boom/);
  assert.equal(out.failed, 1);
});

// ── watcher: an exited child resolves honestly instead of burning the window ─

test('benchmark: watchFirstWrite — child that exits before any write resolves killed:false at once', async () => {
  const { watchFirstWrite } = await import('../src/benchmark.js');
  const fakeChild = { exitCode: 1, signalCode: null, kill() {} };
  const t0 = Date.now();
  const w = await watchFirstWrite(tmp(), fakeChild, { pollMs: 30, timeoutMs: 60000 });
  assert.equal(w.killed, false);
  assert.match(w.reason, /exited before any completed fs_write/);
  assert.ok(Date.now() - t0 < 5000, 'resolves immediately, not on the timeout');
});

// ── LIVE: the real CLI subcommands (mechanical dims — no brain, no mocks) ────

test('benchmark: LIVE CLI — --list prints the contract, --dim junk refuses with exit 2', async () => {
  const list = await run(process.execPath, [path.join(REPO, 'src', 'index.js'), 'benchmark', '--list']);
  assert.match(list.stderr, /RESEARCH/);
  assert.match(list.stderr, /CAPABILITIES/);
  assert.match(list.stderr, /seven dimensions/);
  await assert.rejects(
    () => run(process.execPath, [path.join(REPO, 'src', 'index.js'), 'benchmark', '--dim', 'research;shutdown now']),
    (e) => e.code === 2 && /unknown dimension/.test(e.stderr),
  );
});

test('benchmark: LIVE fast run — real MCP loopback scores CAPABILITIES + EVIDENCE with artifacts on disk', { timeout: 120000 }, async () => {
  const root = tmp();
  const r = await run(process.execPath, [path.join(REPO, 'src', 'index.js'), 'benchmark', '--fast', '--dir', root], { timeout: 110000 });
  assert.match(r.stderr, /capabilities\s+mechanical\s+PASS/);
  assert.match(r.stderr, /evidence\s+mechanical\s+PASS/);
  assert.match(r.stderr, /5 skipped honestly \(fast mode\)/);
  assert.match(r.stderr, /score: 2\/2 scored dimensions passed/);
  const benchRoot = path.join(root, '.buddy', 'benchmark');
  const run_ = fs.readdirSync(benchRoot)[0];
  assert.ok(run_);
  const card = JSON.parse(fs.readFileSync(path.join(benchRoot, run_, 'scorecard.json'), 'utf8'));
  assert.equal(card.passed, 2);
  assert.equal(card.skipped, 5);
  assert.ok(fs.existsSync(path.join(benchRoot, run_, 'capabilities', 'loopback-log.json')));
  assert.ok(fs.statSync(path.join(benchRoot, run_, 'capabilities', 'loopback-log.json')).size > 10);
});
