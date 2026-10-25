// Checkpoints & /rewind (v0.9.7) — automatic pre-mutation snapshots.
//
// Why: kilo's v0.9.6 live test ended with a half-applied fs_replace that left
// src/tools/local.js broken and the brain offline before it could recover.
// Every fs_write/fs_replace/fs_append now snapshots its target to a
// content-addressed .buddy/checkpoints/ store; /rewind restores files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  snapshotPaths,
  restoreCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  MAX_MANIFESTS,
} from '../src/agent/checkpoints.js';
import { LocalScope, buildLocalTools, blockedBashReason } from '../src/tools/local.js';
import { createChat } from '../src/agent/chat.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';
import { SLASH_COMMANDS } from '../src/terminal/repl.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ckpt-'));
}

function fakeRouter(script) {
  return {
    chat: async () => {
      const text = script.length ? script.shift() : '{"tool":"say","message":"(done)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
}

// ── snapshotPaths: content-addressed store ──────────────────────────────────

test('snapshotPaths stores content-addressed objects and a manifest', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'v1');
  const m1 = snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  assert.ok(m1 && m1.endsWith('.json'), 'manifest filename returned');
  assert.ok(fs.existsSync(path.join(root, '.buddy', 'checkpoints', m1)));
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'checkpoints', 'objects')).length, 1, 'one object for one unique content');
  fs.writeFileSync(path.join(root, 'a.md'), 'v2');
  snapshotPaths(root, ['a.md'], { tool: 'fs_replace' });
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'checkpoints', 'objects')).length, 2, 'new content → new object');
  fs.rmSync(root, { recursive: true, force: true });
});

test('identical content is deduped to one object', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'same');
  fs.writeFileSync(path.join(root, 'b.md'), 'same');
  snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  snapshotPaths(root, ['b.md'], { tool: 'fs_write' });
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'checkpoints', 'objects')).length, 1, 'same bytes → same hash → one object');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── restoreCheckpoint ────────────────────────────────────────────────────────

test('restoreCheckpoint reverts a mutated file to the snapshotted state', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'v1');
  const m = snapshotPaths(root, ['a.md'], { tool: 'fs_replace' });
  fs.writeFileSync(path.join(root, 'a.md'), 'half-applied garbage from a dead turn');
  const res = restoreCheckpoint(root, m);
  assert.deepEqual(res.restored, ['a.md']);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'v1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing target files are recorded (existed:false) so restore deletes them', () => {
  const root = tmpRoot();
  const m = snapshotPaths(root, ['notes/new.md'], { tool: 'fs_write' });
  assert.ok(m, 'an existed:false entry still produces a manifest');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'new.md'), 'created by the agent');
  const res = restoreCheckpoint(root, m);
  assert.deepEqual(res.removed, ['notes/new.md']);
  assert.equal(fs.existsSync(path.join(root, 'notes', 'new.md')), false, 'rewind deletes the agent-created file');
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore refuses traversal paths from a hand-edited manifest', () => {
  const root = tmpRoot();
  const dir = path.join(root, '.buddy', 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ time: 't', tool: 'x', files: [{ path: '../escaped.md', hash: null, existed: false }] }));
  const res = restoreCheckpoint(root, 'evil.json');
  assert.deepEqual(res.lost, ['../escaped.md']);
  assert.equal(fs.existsSync(path.join(root, 'escaped.md')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── restore is UNDO: the applied manifest is consumed (v0.11.1 live bug) ─────
// Lewis's live run: two "/rewind 1" calls printed the SAME message because
// the restored manifest stayed on disk and was re-restored forever.

test('/rewind 1 twice walks back TWO undo steps (stack is consumed)', () => {
  const root = tmpRoot();
  snapshotPaths(root, ['rew.txt'], { tool: 'fs_write' }); // file did not exist yet
  fs.writeFileSync(path.join(root, 'rew.txt'), 'v1');
  snapshotPaths(root, ['rew.txt'], { tool: 'fs_replace' }); // pre-state v1
  fs.writeFileSync(path.join(root, 'rew.txt'), 'v2');
  const l1 = listCheckpoints(root, 1);
  assert.equal(l1[0].tool, 'fs_replace');
  const r1 = restoreCheckpoint(root, l1[0].file);
  assert.deepEqual(r1.restored, ['rew.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'rew.txt'), 'utf8'), 'v1');
  const l2 = listCheckpoints(root, 1);
  assert.equal(l2[0].tool, 'fs_write', 'second /rewind 1 lands on the NEXT manifest, not fs_replace again');
  const r2 = restoreCheckpoint(root, l2[0].file);
  assert.deepEqual(r2.removed, ['rew.txt']);
  assert.equal(fs.existsSync(path.join(root, 'rew.txt')), false, 'agent-created file is removed');
  assert.equal(listCheckpoints(root, 10).length, 0, 'both manifests consumed — stack is empty');
  fs.rmSync(root, { recursive: true, force: true });
});

test('consuming a manifest prunes its orphan objects; unreadable manifests never wedge the stack', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'v1');
  const m = snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  fs.writeFileSync(path.join(root, 'a.md'), 'v2');
  restoreCheckpoint(root, m);
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'checkpoints', 'objects')).length, 0, 'object unreferenced after consume → pruned');
  fs.writeFileSync(path.join(root, '.buddy', 'checkpoints', 'junk.json'), '{not json');
  const r = restoreCheckpoint(root, 'junk.json');
  assert.deepEqual(r.lost, ['(manifest unreadable)']);
  assert.equal(fs.existsSync(path.join(root, '.buddy', 'checkpoints', 'junk.json')), false, 'corrupt manifest is consumed too');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── listCheckpoints + retention ──────────────────────────────────────────────

test('listCheckpoints is newest-first — "/rewind 1" is the latest', () => {
  const root = tmpRoot();
  for (const [i, tool] of ['t1', 't2', 't3'].entries()) {
    fs.writeFileSync(path.join(root, `f${i}.md`), `content ${i}`);
    snapshotPaths(root, [`f${i}.md`], { tool });
  }
  const list = listCheckpoints(root, 10);
  assert.equal(list.length, 3);
  assert.equal(list[0].tool, 't3', 'newest first');
  assert.equal(list[2].tool, 't1');
  assert.deepEqual(listCheckpoints(root, 2).map((c) => c.tool), ['t3', 't2']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('retention prunes manifests beyond the cap and orphan objects with them', () => {
  const root = tmpRoot();
  for (let i = 0; i <= MAX_MANIFESTS; i++) {
    fs.writeFileSync(path.join(root, 'a.md'), `content-${i}`);
    snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  }
  const manifests = fs.readdirSync(path.join(root, '.buddy', 'checkpoints')).filter((f) => f.endsWith('.json'));
  assert.ok(manifests.length <= MAX_MANIFESTS, `manifests pruned to ${MAX_MANIFESTS}`);
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'checkpoints', 'objects')).length, MAX_MANIFESTS, 'orphan objects pruned, one per kept manifest');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pruneCheckpoints also cleans a stray unreferenced object', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'x');
  snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  fs.writeFileSync(path.join(root, '.buddy', 'checkpoints', 'objects', 'deadbeef'), 'junk');
  pruneCheckpoints(root);
  assert.equal(fs.existsSync(path.join(root, '.buddy', 'checkpoints', 'objects', 'deadbeef')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('.buddy paths and oversize files are never snapshotted', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'ok.md'), 'fine');
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'state.json'), 'internal');
  fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  const m = snapshotPaths(root, ['.buddy/state.json', 'big.md', 'ok.md'], { tool: 'fs_write' });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.buddy', 'checkpoints', m), 'utf8'));
  assert.deepEqual(manifest.files.map((f) => f.path), ['ok.md'], 'only the small in-repo file is snapshotted');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── local.js wiring: every mutating scope method snapshots automatically ─────

test('scope.write / replace / append snapshot their target before mutating', () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  scope.write('a.md', 'v1');
  scope.append('a.md', 'more');
  scope.replace('a.md', 'more', 'extra');
  const list = listCheckpoints(root, 3);
  assert.deepEqual(list.map((c) => c.tool), ['fs_replace', 'fs_append', 'fs_write'], 'newest first, one per mutation');
  restoreCheckpoint(root, list[0].file);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'v1\nmore', 'rewinding fs_replace returns the post-append state');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── chat-level: a gated fs_write turn leaves a restorable checkpoint ─────────

test('a fs_write turn leaves a restorable checkpoint (end to end)', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const chat = createChat({
    router: fakeRouter(['{"tool":"fs_write","args":{"path":"notes/x.md","content":"hello"}}']),
    tools,
    harness,
    approval: async () => 'yes',
  });
  await chat.turn('create the file');
  const list = listCheckpoints(root, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].tool, 'fs_write');
  assert.equal(list[0].files[0].path, 'notes/x.md');
  assert.equal(list[0].files[0].existed, false, 'the file did not exist before the agent');
  const res = restoreCheckpoint(root, list[0].file);
  assert.deepEqual(res.removed, ['notes/x.md']);
  assert.equal(fs.existsSync(path.join(root, 'notes', 'x.md')), false, 'rewind deletes the agent-created file');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── /rewind registration + v0.9.6 live-test tool fixes ──────────────────────

test('/rewind is a registered slash command', () => {
  assert.ok(SLASH_COMMANDS.includes('rewind'));
});

test('fs_list on a missing directory errors instead of returning (empty)', () => {
  const root = tmpRoot();
  const scope = new LocalScope(root);
  assert.throws(() => scope.list('nope'), /no such directory: nope/);
  fs.mkdirSync(path.join(root, 'emptydir'));
  assert.equal(scope.list('emptydir').join('\n') || '(empty)', '(empty)', 'a real empty dir still says (empty)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('bash pipe-block message hints that output is captured automatically', () => {
  assert.match(blockedBashReason('ls | head'), /output and stderr are captured automatically/);
  assert.equal(blockedBashReason('ls'), null);
});
