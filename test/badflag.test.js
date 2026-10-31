// Bad-flag teaching refusals — the catch-site under main(). Before this wave a
// typo'd flag died as a raw TypeError through Node's parse_args internals:
//   [buddy …] WARN TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option
//   '--nonsense'. To specify a positional argument starting with a '-' …
//   at checkOptionUsage (node:internal/util/parse_args/parse_args:102:13) …
// a stack the user never asked for and cannot act on. Now: the flag is NAMED,
// the door (-h) is pointed at, the '--' escape for dash-leading VALUES is taught,
// and the process exits 2 with ZERO stack frames. One catch site covers every
// subcommand parser — they all bubble to main()'s catch.
// Pins that carry the house rules:
//   - both reachable codes are taught: ERR_PARSE_ARGS_UNKNOWN_OPTION (typo'd
//     flag) and ERR_PARSE_ARGS_INVALID_OPTION_VALUE (string flag, no value);
//   - the refusal fires MID-VECTOR too (cmdChat's strict parser, flags-first
//     route) — `buddy -p "x" --nonsense` teaches, never crashes;
//   - the refusal fires through OTHER subcommand parsers (init) — the catch
//     site is command-agnostic, proven on a second parser;
//   - stderr carries NO 'node:internal' frames and NO raw ERR_PARSE_ARGS text;
//   - the honest refusals that predate this wave are untouched (watch treats a
//     stray token as its workspace root and refuses on the stat — named, clean,
//     no teaching overlap, no stack).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ENTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'index.js');

const cli = (args) => spawnSync(process.execPath, [ENTRY, ...args], {
  encoding: 'utf8', timeout: 30000, cwd: os.tmpdir(), // tmp cwd: a stray scaffold can never touch the repo
  env: { ...process.env, NO_COLOR: '1' },
});

const noStack = (r, label) => {
  assert.ok(!/node:internal/.test(r.stderr || ''), `${label}: NO Node internals on stderr`);
  assert.ok(!/ERR_PARSE_ARGS/.test(r.stderr || ''), `${label}: NO raw parseArgs code on stderr`);
};

test("an unknown long flag is named and taught — '--nonsense'", () => {
  const r = cli(['--nonsense']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag '--nonsense' — 'buddy -h' lists the commands/);
  noStack(r, 'long flag');
});

test("an unknown short flag is named and taught — '-z'", () => {
  const r = cli(['-z']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag '-z'/);
  noStack(r, 'short flag');
});

test("a missing option value is named and taught — '--dir' with nothing after it", () => {
  const r = cli(['--dir']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /flag '--dir' needs a value — place it right after the flag/);
  noStack(r, 'missing value');
});

test("the teaching fires MID-VECTOR too — '-p x --nonsense' never reaches the stack", () => {
  const r = cli(['-p', 'x', '--nonsense']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag '--nonsense'/);
  noStack(r, 'mid-vector');
});

test("the refusal teaches the '--' escape for dash-leading VALUES", () => {
  const r = cli(['--nonsense']);
  assert.match(r.stderr, /dash-leading VALUE goes after '--'/, 'the POSIX escape is on the card');
});

test('the catch site is command-agnostic — init’s parser teaches the same way', () => {
  const r = cli(['init', '--nonsense']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag '--nonsense'/);
  noStack(r, 'init parser');
});

test('pre-existing honest refusals are untouched — watch still refuses on its own terms', () => {
  const r = cli(['watch', '--nonsense']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot stat workspace root/, 'watch’s OWN named refusal, not the teaching');
  assert.ok(!/unknown flag/.test(r.stderr || ''), 'no teaching overlap on watch’s surface');
  noStack(r, 'watch refusal');
});
