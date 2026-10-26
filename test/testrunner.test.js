// testrunner.test.js — Build 17 (P1): the test debugging suite.
//
// Locks down:
//   1. parseTarget: `file::name`, bare `file`, empty
//   2. detectTestRunner: node (test/*.test.js) beats npm script; go/pytest markers
//   3. buildCommand: single-file, single-test (--test-name-pattern, regex-escaped),
//      rerun pattern joining
//   4. parseResults: node spec format (counts + ✖ names), TAP fallback, pytest -q,
//      go, npm verdict
//   5. REAL end-to-end: the tool spawns node --test against a fixture repo —
//      suite run reports the failure; rerun_failures reruns only the failing
//      test (and passes once "fixed"); a second tool instance has no memory
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTarget, detectTestRunner, buildCommand, parseResults, formatTestReport, createTestTool } from '../src/tools/testrunner.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tst-'));
}

test('testrunner: parseTarget handles file::name, bare file, empty', () => {
  assert.deepEqual(parseTarget('test/app.test.js::my test'), { file: 'test/app.test.js', name: 'my test' });
  assert.deepEqual(parseTarget('test/app.test.js'), { file: 'test/app.test.js', name: null });
  assert.deepEqual(parseTarget(''), { file: null, name: null });
  assert.deepEqual(parseTarget(null), { file: null, name: null });
  assert.deepEqual(parseTarget('a::b::c'), { file: 'a', name: 'b::c' });
});

test('testrunner: detection — node beats npm, go/pytest markers win', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'x.test.js'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'tape **' } }));
  assert.equal(detectTestRunner(root).kind, 'node', 'node --test needs no node_modules — zero-dep first');

  const root2 = tmp();
  fs.writeFileSync(path.join(root2, 'go.mod'), 'module x\n');
  assert.equal(detectTestRunner(root2).kind, 'go');

  const root3 = tmp();
  fs.writeFileSync(path.join(root3, 'pytest.ini'), '[pytest]\n');
  assert.equal(detectTestRunner(root3).kind, 'pytest');

  const root4 = tmp();
  fs.writeFileSync(path.join(root4, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  assert.equal(detectTestRunner(root4).kind, 'npm');

  assert.equal(detectTestRunner(tmp()), null, 'no markers → no runner');
});

test('testrunner: buildCommand filters per framework', () => {
  const node = { kind: 'node' };
  assert.deepEqual(buildCommand(node, {}).args, ['--test', '--test-concurrency=4']);
  const single = buildCommand(node, { file: 'test/a.test.js', name: 'runs (fast) now' });
  assert.deepEqual(single.args, ['--test', '--test-concurrency=4', `--test-name-pattern=${'runs \\(fast\\) now'}`, 'test/a.test.js']);
  const rerun = buildCommand(node, { rerunFiles: ['test/a.test.js', 'test/b.test.js'], rerunPattern: 'one|two' });
  assert.deepEqual(rerun.args, ['--test', '--test-concurrency=4', '--test-name-pattern=one|two', 'test/a.test.js', 'test/b.test.js']);
  const go = buildCommand({ kind: 'go' }, { name: 'TestFoo' });
  assert.deepEqual(go.args, ['test', '-run', 'TestFoo', './...']);
  const npm = buildCommand({ kind: 'npm' }, { file: 'x', name: 'y' });
  assert.deepEqual(npm.args, ['test']);
  assert.match(npm.note, /whole-suite only/);
});

test('testrunner: parseResults reads node spec, TAP, pytest, go, npm', () => {
  const spec = parseResults('node', [
    '✖ autocompact: fires at >80% (1.2ms)',
    '  AssertionError: nope',
    '✔ other (0.1ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ skipped 0',
    'ℹ duration_ms 12',
  ].join('\n'), { durationMs: 12 });
  assert.equal(spec.ok, false);
  assert.equal(spec.total, 2);
  assert.equal(spec.passed, 1);
  assert.equal(spec.failed, 1);
  assert.deepEqual(spec.failures.map((f) => f.name), ['autocompact: fires at >80%']);
  assert.match(spec.summary, /2 run · 1 passed · 1 failed/);

  const tap = parseResults('node', 'not ok 3 - deep thing\nok 1 - fine\n1..2\n# fail 1\n', { durationMs: 5 });
  assert.deepEqual(tap.failures.map((f) => f.name), ['deep thing']);

  const py = parseResults('pytest', '2 failed, 10 passed, 1 skipped in 0.42s\nFAILED test_a.py::test_one\nFAILED test_b.py::test_two\n', { durationMs: 420 });
  assert.equal(py.failed, 2);
  assert.equal(py.passed, 10);
  assert.equal(py.skipped, 1);
  assert.equal(py.failures.length, 2);

  const go = parseResults('go', '--- FAIL: TestAdd\n    x_test.go:12: nope\nFAIL\n', { durationMs: 900, code: 1 });
  assert.equal(go.ok, false);
  assert.deepEqual(go.failures.map((f) => f.name), ['TestAdd']);

  const npm = parseResults('npm', 'all good', { durationMs: 3000, code: 0 });
  assert.equal(npm.ok, true);
  assert.match(npm.summary, /npm test passed/);

  const to = parseResults('node', '', { durationMs: 120000, timedOut: true });
  assert.equal(to.timedOut, true);
  assert.match(to.summary, /TIMED OUT/);
});

test('testrunner: formatTestReport lists failures + rerun hint', () => {
  const res = parseResults('node', 'ℹ tests 2\nℹ pass 1\nℹ fail 1\n', { durationMs: 10 });
  res.failures = [{ name: 'the broken one' }];
  const report = formatTestReport(res);
  assert.match(report, /FAILING:/);
  assert.match(report, /✖ the broken one/);
  assert.match(report, /rerun_failures: true/);
});

// ── Real end-to-end: spawn node --test in a fixture repo ─────────────────────

const PASSING = `import { test } from 'node:test'; import assert from 'node:assert/strict';
test('math adds', () => { assert.equal(1 + 1, 2); });
`;
const FAILING = `import { test } from 'node:test'; import assert from 'node:assert/strict';
test('math breaks', () => { assert.equal(2 + 2, 5, 'intentional fixture failure'); });
test('math adds', () => { assert.equal(1 + 1, 2); });
`;

function fixtureRepo({ broken }) {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), broken ? FAILING : PASSING);
  return root;
}

test('testrunner: end-to-end — suite run, rerun-failures after fix, fresh tool has no memory', async () => {
  const root = fixtureRepo({ broken: true });
  const tool = createTestTool({ root, timeoutMs: 60000 });
  const first = await tool.run({});
  assert.match(first, /1 failed/);
  assert.match(first, /✖ math breaks/);

  // rerun_failures BEFORE a fix → still failing, only the failing test ran
  const rerun = await tool.run({ rerun_failures: true });
  assert.match(rerun, /math breaks/);
  assert.doesNotMatch(rerun, /1 passed.*2 run|2 run/, 'rerun did not run the whole suite');

  // "fix" the file → rerun_failures passes
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), PASSING);
  const fixed = await tool.run({ rerun_failures: true });
  assert.match(fixed, /tests: 1 run · 1 passed · 0 failed/);

  // failure memory cleared by the green run
  const noMemory = await tool.run({ rerun_failures: true });
  assert.match(noMemory, /no failures remembered/);

  // a fresh tool instance knows nothing
  const fresh = createTestTool({ root });
  const out = await fresh.run({ rerun_failures: true });
  assert.match(out, /no failures remembered/);
});

test('testrunner: single-test targeting runs one test', async () => {
  const root = fixtureRepo({ broken: true });
  const tool = createTestTool({ root, timeoutMs: 60000 });
  const out = await tool.run({ target: 'test/a.test.js::math adds' });
  assert.match(out, /tests: 1 run · 1 passed · 0 failed/, 'only the named test ran');
});

test('testrunner: no runner detected → honest error; unknown target file → runner decides', async () => {
  const tool = createTestTool({ root: tmp() });
  const out = await tool.run({});
  assert.match(out, /no test runner detected/);
});

test('testrunner: the tool is registered in buildLocalTools (source + registry)', async () => {
  const { LocalScope, buildLocalTools } = await import('../src/tools/local.js');
  const root = fixtureRepo({ broken: false });
  const tools = buildLocalTools({ scope: new LocalScope(root) });
  const t = tools.find((x) => x.name === 'test');
  assert.ok(t, 'test tool present');
  assert.equal(t.risky, undefined, 'not gated — tests are the safe happy path');
  assert.match(t.description, /rerun_failures/);
});
