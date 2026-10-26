// Git tool (v0.20.0) — read-only ops with parsed output; write ops refused
// by design (they belong to the bash approval gate). Real git repo fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { gitOp, buildGitTool, formatStatus, GIT_READ_OPS } from '../src/tools/gittool.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { PLAN_TOOLS } from '../src/tools/planmode.js';

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-git-'));
  const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  sh('git init -q');
  fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
  sh('git add . && git commit -qm "first"');
  fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
  return root;
}

test('formatStatus: branch header, tags, untracked as new', () => {
  const out = formatStatus('## main\n M a.js\n?? new.txt\n');
  assert.match(out, /main/);
  assert.match(out, /a\.js \(modified\)/);
  assert.match(out, /new\.txt \(new\)/);
  assert.equal(formatStatus(''), 'working tree clean — nothing to commit');
});

test('gitOp: status/diff/log/branch/show on a real repo', () => {
  const root = gitRepo();
  const st = gitOp(root, 'status');
  assert.match(st, /new\.txt/);
  assert.match(st, /a\.js/);
  const diff = gitOp(root, 'diff');
  assert.match(diff, /git diff/);
  assert.match(diff, /a\.js/);
  const log = gitOp(root, 'log', { count: 5 });
  assert.match(log, /first/);
  const branch = gitOp(root, 'branch');
  assert.match(branch, /\*/);
  const show = gitOp(root, 'show', { ref: 'HEAD' });
  assert.match(show, /first/);
  const patch = gitOp(root, 'diff_patch');
  assert.match(patch, /export const a = 2/);
});

test('gitOp: blame needs a path; unknown paths error honestly; dirty tree blame works', () => {
  const root = gitRepo();
  assert.match(gitOp(root, 'blame'), /ERROR: path required/);
  assert.match(gitOp(root, 'blame', { path: 'nope.js' }), /ERROR/);
  const bl = gitOp(root, 'blame', { path: 'a.js' });
  assert.match(bl, /\(t\)|t 20\d\d/, 'author column present');
});

test('write ops are refused by design, with the pointer to the bash gate', () => {
  const root = gitRepo();
  for (const op of ['commit', 'push', 'merge', 'rebase', 'reset']) {
    const out = gitOp(root, op);
    assert.match(out, /^ERROR: unknown git op/, `${op} refused`);
    assert.match(out, /bash tool|read-only ops/s);
  }
});

test('not-a-repo degrades to an honest error (never throws)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-nogit-'));
  assert.match(gitOp(root, 'status'), /not a git repository|ERROR/);
});

test('registry: the git tool is present, read-only (no gate), and in PLAN_TOOLS', async () => {
  assert.ok(GIT_READ_OPS.includes('diff_patch') && GIT_READ_OPS.length === 7);
  const root = gitRepo();
  const scope = new LocalScope(root);
  const tools = Object.fromEntries(buildLocalTools({ scope }).map((t) => [t.name, t]));
  assert.ok(tools.git, 'git tool registered');
  assert.equal(tools.git.risky, undefined, 'read-only → no approval gate');
  assert.ok(PLAN_TOOLS.has('git'), 'plan mode can research git state');
  const out = await tools.git.run({ op: 'status' });
  assert.match(out, /working tree|new\.txt/);
  assert.match(await tools.git.run({ op: 'push' }), /ERROR: unknown git op/);
});
