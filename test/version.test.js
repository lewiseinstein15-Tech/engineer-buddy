// `buddy --version` — the flag every CLI owes. The flags-first dispatch (v0.24.2)
// routes any dash-prefixed first token into cmdChat's STRICT parseArgs, which never
// knew the `version` option — so `buddy --version` died with
// ERR_PARSE_ARGS_UNKNOWN_OPTION (a raw TypeError stack via warn(), exit 2) instead
// of printing the version. Caught live: `node src/index.js --version` after the
// v0.64.0 pull. Fixed at BOTH doors:
//   - main() answers `--version` / `-v` before ANY dispatch (bare semver on stdout,
//     machine-parseable — the banner on stderr is for humans, this is for scripts);
//   - cmdChat() accepts `version` anywhere in its vector and prints + exits BEFORE
//     loadConfig/buildRouter (a version probe needs neither config nor network).
// Pins that carry the house rules:
//   - the printed version equals package.json's version — repl.js derives VERSION
//     from there, so this pin breaks the day the field goes stale again;
//   - stdout carries the semver and stderr stays CLEAN (no banner, no warn stack);
//   - a mid-vector `--version` (`-p "x" --version`, `chat --version`) never reaches
//     the strict parser as an unknown flag and never starts the REPL/one-shot;
//   - `-h` still lands on usage() (exit 2, banner on stderr) — the version gate
//     must not swallow help, and usage now documents the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ENTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'index.js');
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version;

const cli = (args) => spawnSync(process.execPath, [ENTRY, ...args], {
  encoding: 'utf8', timeout: 30000, cwd: path.dirname(ENTRY),
  env: { ...process.env, NO_COLOR: '1' },
});

test('--version prints the bare semver on stdout, exit 0, clean stderr', () => {
  const r = cli(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG_VERSION);
  assert.equal(r.stderr, '');
});

test('-v is the same surface', () => {
  const r = cli(['-v']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG_VERSION);
  assert.equal(r.stderr, '');
});

test('--version LATE in a one-shot vector prints and exits before any crash', () => {
  const r = cli(['-p', 'say hi', '--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG_VERSION);
  assert.ok(!/ERR_PARSE_ARGS/.test(r.stderr || ''), 'the strict parser must never see it as unknown');
});

test('--version after the chat command word routes through cmdChat honestly', () => {
  const r = cli(['chat', '--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), PKG_VERSION);
  assert.equal(r.stderr, '');
});

test('the version surface never goes stale: it equals package.json', () => {
  const r = cli(['--version']);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, 'bare semver, nothing else');
  assert.equal(r.stdout.trim(), PKG_VERSION);
});

test('-h still lands on usage() — the gate must not swallow help', () => {
  const r = cli(['-h']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Engineer Buddy v/);
  assert.match(r.stderr, /print the version and exit/);
});
