// testrunner.js — Build 17 (P1): the test debugging suite.
//
// A dedicated `test` tool so the model stops hand-rolling `npm test` guesses
// through bash: one call runs the project's tests with per-framework
// detection, `file::name` single-test targeting, rerun-only-failures, and a
// STRUCTURED pass/fail/skip summary parsed from runner output (the raw TAP
// soup is capped and trimmed — the model gets the verdict, the failure list,
// and a short output tail).
//
// Frameworks (auto-detected, first match wins):
//   go      — go.mod present              → go test [-run re] [pkg]
//   pytest  — pytest.ini/pyproject/pytest in requirements → pytest [-k pat] [file] -q
//   node    — test files matching test pattern + node --test (this repo's stack;
//             zero-dep: no npm install needed, no script required)
//   npm     — package.json scripts.test exists → npm test (as-is; filters
//             unsupported by arbitrary scripts — documented honestly)
//
// The failure memory (lastFailures) lives in the tool closure: one session's
// reruns, in order, no disk state.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT_TAIL = 6000;
const DEFAULT_TIMEOUT_MS = 120000;

/** Parse a `path::name` target. Pure. Returns { file, name } (both nullable). */
export function parseTarget(target) {
  const s = String(target || '').trim();
  if (!s) return { file: null, name: null };
  const idx = s.indexOf('::');
  if (idx === -1) return { file: normalizeRel(s), name: null };
  return { file: normalizeRel(s.slice(0, idx)), name: s.slice(idx + 2).trim() };
}

function normalizeRel(p) {
  const s = String(p || '').trim().replace(/\\/g, '/');
  if (!s || s === '.') return null;
  try {
    const rel = path.relative('.', path.resolve(s));
    return rel && rel !== '.' ? rel : null;
  } catch {
    return s;
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Detect the project's test runner. Pure over the filesystem. */
export function detectTestRunner(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  if (has('go.mod')) return { kind: 'go', cmd: 'go' };
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg')) {
    const req = (() => {
      try {
        return fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');
      } catch {
        return '';
      }
    })();
    if (has('pytest.ini') || has('pyproject.toml') || /pytest/.test(req)) return { kind: 'pytest', cmd: 'pytest' };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    /* not a package */
  }
  const testFiles = (() => {
    try {
      return fs.readdirSync(path.join(root, 'test')).filter((f) => /\.(test|spec)\.[cm]?js$/.test(f));
    } catch {
      return [];
    }
  })();
  // node:test direct beats npm: works with zero installed deps (this repo's
  // own rule — `npm test` would need node_modules; `node --test` does not).
  if (testFiles.length) return { kind: 'node', cmd: 'node' };
  if (pkg?.scripts?.test) return { kind: 'npm', cmd: 'npm' };
  return null;
}

/** Build the runner command. Pure. Returns { args, note }. */
export function buildCommand(runner, { file = null, name = null, rerunFiles = null, rerunPattern = null } = {}) {
  if (runner.kind === 'node') {
    const args = ['--test', '--test-concurrency=4'];
    if (rerunPattern) args.push(`--test-name-pattern=${rerunPattern}`);
    else if (name) args.push(`--test-name-pattern=${escapeRe(name)}`);
    if (rerunFiles?.length) args.push(...rerunFiles);
    else if (file) args.push(file);
    return { args, note: null };
  }
  if (runner.kind === 'pytest') {
    const args = ['-q'];
    if (name) args.push('-k', escapeRe(name).replace(/\\\\/g, '\\'));
    if (rerunFiles?.length) args.push(...rerunFiles);
    else if (file) args.push(file);
    return { args, note: null };
  }
  if (runner.kind === 'go') {
    const args = ['test'];
    if (rerunPattern || name) args.push('-run', escapeRe(rerunPattern || name));
    args.push(...(rerunFiles?.length ? rerunFiles : file ? ['./' + path.dirname(file) + '/...'] : ['./...']));
    return { args, note: null };
  }
  // npm — arbitrary script, filters unsupported (honest limitation)
  return { args: ['test'], note: 'npm test runs whole-suite only — single-test filters unsupported for custom scripts' };
}

/** Parse runner output into a structured result. Pure. */
export function parseResults(kind, stdout, { durationMs = 0, timedOut = false, code = 0 } = {}) {
  const out = { ok: false, total: null, passed: null, failed: null, skipped: null, durationMs, timedOut, failures: [], kind };
  if (timedOut) {
    out.timedOut = true;
    out.summary = `tests TIMED OUT after ${Math.round(durationMs / 1000)}s`;
    return out;
  }
  if (kind === 'node') {
    // Two dialects: spec (TTY) prints "ℹ tests 2", TAP (piped — our case,
    // spawnSync captures through a pipe) prints "# tests 2".
    const num = (key) => {
      const m = new RegExp(`^(?:ℹ|#) ${key} (\\d+)`, 'm').exec(stdout);
      return m ? Number(m[1]) : null;
    };
    out.total = num('tests');
    out.passed = num('pass');
    out.failed = num('fail');
    out.skipped = num('skipped') ?? num('cancelled') ?? 0;
    // spec format: "✖ name (1.2ms)" (excluding the "failing tests:" header
    // line) · TAP fallback: "not ok N - name"
    const seen = new Set();
    for (const m of stdout.matchAll(/^✖ (?!failing tests)(.+?) \([\d.]+ms\)$/gm)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.failures.push({ name: m[1] });
      }
    }
    if (!out.failures.length) {
      for (const m of stdout.matchAll(/^not ok \d+ - (.+)$/gm)) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          out.failures.push({ name: m[1] });
        }
      }
    }
    out.ok = out.failed === 0;
    out.summary = `tests: ${out.total ?? '?'} run · ${out.passed ?? '?'} passed · ${out.failed ?? '?'} failed · ${out.skipped ?? 0} skipped (${(durationMs / 1000).toFixed(1)}s)`;
    return out;
  }
  if (kind === 'pytest') {
    // "-q" summary: "2 failed, 10 passed, 1 skipped in 0.42s"
    const m = /(\d+) failed(?:[^\d]+(\d+) passed)?(?:[^\d]+(\d+) skipped)?/.exec(stdout);
    if (m) {
      out.failed = Number(m[1]);
      out.passed = m[2] !== undefined ? Number(m[2]) : null;
      out.skipped = m[3] !== undefined ? Number(m[3]) : 0;
      out.total = (out.failed || 0) + (out.passed || 0) + (out.skipped || 0);
    }
    for (const f of stdout.matchAll(/^FAILED (.+)$/gm)) out.failures.push({ name: f[1] });
    out.ok = out.failed === 0;
    out.summary = out.total !== null ? `tests: ${out.total} run · ${out.passed ?? 0} passed · ${out.failed} failed · ${out.skipped} skipped (${(durationMs / 1000).toFixed(1)}s)` : 'pytest finished';
    return out;
  }
  if (kind === 'go') {
    for (const f of stdout.matchAll(/^--- FAIL: (\S+)/gm)) out.failures.push({ name: f[1] });
    out.ok = code === 0;
    out.failed = out.failures.length;
    out.summary = out.ok ? `go test OK (${(durationMs / 1000).toFixed(1)}s)` : `go test FAILED — ${out.failures.length} failing (${(durationMs / 1000).toFixed(1)}s)`;
    return out;
  }
  // npm/generic: verdict only, output tail carries the detail
  out.ok = code === 0;
  out.summary = out.ok ? `npm test passed (${(durationMs / 1000).toFixed(1)}s)` : `npm test FAILED (exit ${code}, ${(durationMs / 1000).toFixed(1)}s)`;
  return out;
}

/** Format the tool observation for the model. Pure. */
export function formatTestReport(res, { target = null, note = null } = {}) {
  const lines = [res.summary ?? (res.ok ? 'tests passed' : 'tests FAILED')];
  if (note) lines.push(`(note: ${note})`);
  if (res.failures?.length) {
    lines.push('FAILING:');
    for (const f of res.failures.slice(0, 20)) lines.push(`  ✖ ${f.name}`);
    if (res.failures.length > 20) lines.push(`  … (+${res.failures.length - 20} more)`);
    lines.push('Rerun just these: use the test tool with rerun_failures: true.');
  }
  if (res.timedOut) lines.push('The run was killed at the timeout — narrow the target (file::name) and retry.');
  return lines.join('\n');
}

const TEST_OBS_TAIL = 6000;

/** Create the `test` tool. Failure memory lives in the closure (per session). */
export function createTestTool({ root = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastFailures = null; // [{file, name} | {file, name: null}] for rerun_failures
  const runner = detectTestRunner(root);
  return {
    name: 'test',
    description:
      'Run the project tests with per-framework detection (node --test / pytest / go / npm). args: {"target":"test/app.test.js::test name"} for one file/test, {"rerun_failures":true} to rerun only the last failures, {} for the whole suite. Prefer this over bash npm test.',
    args: '{"target":"test/app.test.js::name | file | (empty)","rerun_failures":false}',
    render: (a) => `test ${a?.target ? a.target : a?.rerun_failures ? '(rerun failures)' : '(suite)'}`,
    maxCalls: 4,
    run: async ({ target = '', rerun_failures = false } = {}) => {
      if (!runner) {
        return 'ERROR: no test runner detected (no test/ dir with *.test.js, no package.json test script, no pytest/go markers).';
      }
      const { file, name } = parseTarget(target);
      let rerunFiles = null;
      let rerunPattern = null;
      if (rerun_failures) {
        if (!lastFailures?.length) return 'ERROR: no failures remembered — run the suite (or a target) first.';
        const files = [...new Set(lastFailures.map((f) => f.file).filter(Boolean))];
        const names = [...new Set(lastFailures.map((f) => f.name).filter(Boolean))];
        rerunFiles = files.length ? files : null;
        if (names.length) rerunPattern = names.map(escapeRe).join('|');
        if (runner.kind !== 'node' && runner.kind !== 'go') {
          // pytest/-k etc: narrow per-file; pattern support differs
          rerunPattern = null;
        }
      }
      const { args, note } = buildCommand(runner, { file, name, rerunFiles, rerunPattern });
      const t0 = Date.now();
      let res;
      try {
        // Strip the parent's node:test context marker — a `node --test`
        // child spawned from inside another node:test run would otherwise
        // detect "recursive run()" and skip every file.
        const childEnv = { ...process.env };
        delete childEnv.NODE_TEST_CONTEXT;
        const r = spawnSync(runner.cmd, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: childEnv });
        const durationMs = Date.now() - t0;
        const stdout = `${r.stdout || ''}\n${r.stderr || ''}`;
        res = parseResults(runner.kind, stdout, { durationMs, timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM', code: r.status ?? 1 });
        res.output = stdout.length > TEST_OBS_TAIL ? stdout.slice(-TEST_OBS_TAIL) : stdout;
      } catch (e) {
        return `ERROR: test run failed to start: ${e.message}`;
      }
      // Remember failures for rerun. Names carry over as a --test-name-pattern
      // (works suite-wide); a per-file list is only used when EVERY failure
      // came from a single targeted file.
      if (res.failures?.length) {
        lastFailures = res.failures.map((f) => ({ file: file || null, name: f.name }));
      } else if (!res.ok) {
        lastFailures = [{ file, name: null }];
      } else {
        lastFailures = null;
      }
      return `${formatTestReport(res, { target, note })}\n\n--- runner output (tail) ---\n${res.output}`;
    },
  };
}
