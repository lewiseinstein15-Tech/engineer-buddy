// Headless + session continuity (v0.18.0): --output-format json|stream-json,
// stdin pipe, -c continue / -r <name> resume, /rename named sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { latestSession, findSession, renameSession, listSessions } from '../src/session.js';
import { SessionRecorder } from '../src/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'index.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-headless-'));
}

function fakeSession(root, firstMessage, extraUser = []) {
  const rec = new SessionRecorder(root, firstMessage);
  rec.append({ type: 'user', text: firstMessage });
  rec.append({ type: 'say', text: 'first answer' });
  for (const u of extraUser) {
    rec.append({ type: 'user', text: u });
    rec.append({ type: 'say', text: `answer to ${u}` });
  }
  return rec;
}

test('latestSession returns the newest by filename sort', () => {
  const root = tmpRoot();
  fakeSession(root, 'older task');
  fs.writeFileSync(path.join(root, '.buddy', 'sessions', '9999-99-99T00-00-00-newest.jsonl'), '', 'utf8');
  const latest = latestSession(root);
  assert.match(latest, /newest\.jsonl$/);
});

test('findSession: exact name → suffix → substring; misses return null', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'fix the auth flow');
  const named = renameSession(root, rec.path, 'fix-auth');
  assert.ok(fs.existsSync(named));
  assert.equal(findSession(root, 'fix-auth'), named, 'exact name');
  assert.equal(findSession(root, 'FIX-AUTH'), named, 'case-insensitive');
  // a second session whose name contains the needle as suffix
  const rec2 = fakeSession(root, 'other');
  const named2 = renameSession(root, rec2.path, 'another-fix-auth');
  assert.equal(findSession(root, 'fix-auth'), named, 'exact still wins over suffix');
  assert.ok(findSession(root, 'another').endsWith('another-fix-auth.jsonl'));
  assert.equal(findSession(root, 'no-such-name-xyz'), null, 'miss');
  assert.equal(findSession(root, ''), null, 'empty needle');
});

test('renameSession: sanitizes, conflicts keep both files', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'a task here');
  const first = renameSession(root, rec.path, 'My Task!!');
  assert.match(first, /My-Task\.jsonl$/);
  // rename another session to the SAME name → conflict path
  const rec2 = fakeSession(root, 'second task');
  const second = renameSession(root, rec2.path, 'My Task!!');
  assert.notEqual(path.resolve(first), path.resolve(second), 'both survive');
  assert.equal(listSessions(root).length >= 2, true);
  assert.throws(() => renameSession(root, rec.path, '///'), /name can only contain/);
});

// ── CLI behavior (real child processes; no brain calls needed for arg paths) ─

test('CLI: bad --output-format exits 2 with the valid list', () => {
  const r = spawnSync(process.execPath, [CLI, '-p', 'x', '--output-format', 'xml', '--dir', tmpRoot()], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /text \| json \| stream-json/);
});

test('CLI: -r with no match exits 2; usage on empty stdin exits 2', () => {
  const root = tmpRoot();
  const r1 = spawnSync(process.execPath, [CLI, '-p', 'x', '-r', 'missing-name', '--dir', root], { encoding: 'utf8' });
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /no session matches/);
  const r2 = spawnSync(process.execPath, [CLI, '-p', '', '--dir', root], { encoding: 'utf8', input: '' });
  assert.equal(r2.status, 2);
});

test('CLI: -c with no sessions exits 2 honestly', () => {
  const root = tmpRoot();
  const r = spawnSync(process.execPath, [CLI, '-p', 'x', '-c', '--dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing to continue/);
});

test('CLI: named resume found via -r reaches the brain path (fails on gateways, not on args)', () => {
  const root = tmpRoot();
  const rec = fakeSession(root, 'original question');
  renameSession(root, rec.path, 'my-task');
  const r = spawnSync(process.execPath, [CLI, '-p', 'follow-up?', '-r', 'my-task', '--dir', root], {
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, BUDDY_DISABLE_GATEWAYS: 'kilo,llm7,pollinations,duckai,ollama' },
  });
  // All gateways disabled → the turn fails with ALL_GATEWAYS_FAILED (exit 0,
  // graceful by design) — the point is it got PAST session resolution.
  assert.notEqual(r.stderr, undefined);
  assert.ok(!/no session matches/.test(r.stderr), 'session was found');
}, { timeout: 100000 });
