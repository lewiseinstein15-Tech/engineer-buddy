// git_write tool (v0.27.0) — approval-gated git writes + conflict assist.
// Real git repo fixtures, real merge/rebase conflicts, parsed ours/base/theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseConflictFile, conflictReport, conflictFiles, gitWriteOp, validBranchName, buildGitWriteTool, GIT_WRITE_OPS } from '../src/tools/gitwrite.js';
import { LocalScope, buildLocalTools, blockedBashReason } from '../src/tools/local.js';
import { subjectFor, evaluatePermission } from '../src/permissions.js';

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** Temp repo with an identity configured (the tool refuses to invent one). */
function gitRepo({ conflict = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-gw-'));
  sh('git init -q -b main', root);
  sh('git config user.name t && git config user.email t@t', root);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 1;\n');
  sh('git add -A && git commit -qm "first"', root);
  if (conflict) {
    // diverge: main edits line, feature branch edits the same line differently
    sh('git checkout -qb feature', root);
    fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "feature";\n');
    sh('git commit -aqm "feature edit"', root);
    sh('git checkout -q main', root);
    fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "main";\n');
    sh('git commit -aqm "main edit"', root);
  }
  return root;
}

// ── Parser ───────────────────────────────────────────────────────────────────

test('parseConflictFile: default style, diff3 style, multiple hunks, caps', () => {
  const def = parseConflictFile('a\n<<<<<<< HEAD\nkeep\n=======\ndrop\n>>>>>>> main\nz');
  assert.equal(def.hunks.length, 1);
  assert.deepEqual(def.hunks[0].ours.lines, ['keep']);
  assert.deepEqual(def.hunks[0].theirs.lines, ['drop']);
  assert.equal(def.hunks[0].base, null);
  assert.equal(def.hunks[0].line, 2);

  const d3 = parseConflictFile('<<<<<<< HEAD\nours A\n||||||| merged common ancestors\nbase A\n=======\ntheirs A\n>>>>>>> feature\n');
  assert.deepEqual(d3.hunks[0].base.lines, ['base A']);
  assert.deepEqual(d3.hunks[0].ours.lines, ['ours A']);
  assert.deepEqual(d3.hunks[0].theirs.lines, ['theirs A']);

  const two = parseConflictFile('<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> x\nmid\n<<<<<<< HEAD\n3\n=======\n4\n>>>>>>> y\n');
  assert.deepEqual(two.hunks.map((h) => h.line), [1, 7]);

  // marker-like content outside a conflict is NOT a hunk
  assert.deepEqual(parseConflictFile('======\nsome markdown\n').hunks, []);
  // markdown setext underline INSIDE a hunk is content, not a separator
  const md = parseConflictFile('<<<<<<< HEAD\nT\n===\n=======\nOther\n>>>>>>> b\n');
  assert.deepEqual(md.hunks[0].theirs.lines, ['Other']);
  assert.deepEqual(md.hunks[0].ours.lines, ['T', '===']);

  // maxLines cap per side
  const big = parseConflictFile('<<<<<<< HEAD\n' + Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n=======\nx\n>>>>>>> b\n', { maxLines: 5 });
  assert.equal(big.hunks[0].ours.lines.length, 5);
  assert.equal(big.hunks[0].ours.cut, 15);

  // unterminated marker: honest stop, no infinite loop
  const un = parseConflictFile('<<<<<<< HEAD\nnever closed\n');
  assert.equal(un.hunks.length, 1);
  assert.equal(un.truncated, true);
});

// ── Validation + permissions ─────────────────────────────────────────────────

test('validBranchName: permissive on slashes, refuses the stupid', () => {
  for (const ok of ['feature/x', 'main', 'v1.2.3', 'fix_underscore']) assert.equal(validBranchName(ok), true, ok);
  for (const bad of ['', '-flag', 'a..b', 'has space', 'ends/', '.hidden', 'lock.lock', 'x~1']) assert.equal(validBranchName(bad), false, bad);
});

test('subjectFor(git_write): "<op> <first target>" for natural rules', () => {
  assert.equal(subjectFor('git_write', { op: 'commit', message: 'x' }), 'commit');
  assert.equal(subjectFor('git_write', { op: 'stage', paths: ['src/a.js', 'b'] }), 'stage src/a.js');
  assert.equal(subjectFor('git_write', { op: 'stage', paths: 'a.js' }), 'stage a.js');
  assert.equal(subjectFor('git_write', { op: 'merge', branch: 'feature/x' }), 'merge feature/x');
  assert.equal(subjectFor('git_write', { op: 'restore', paths: '.' }), 'restore .');
  assert.equal(
    evaluatePermission({ allow: ['git_write(commit)'], deny: ['git_write(restore)'], defaultMode: 'ask' }, 'git_write', { op: 'commit', message: 'm' }),
    'allow'
  );
  assert.equal(
    evaluatePermission({ allow: ['git_write(commit)'], deny: ['git_write(restore)'], defaultMode: 'ask' }, 'git_write', { op: 'restore', paths: '.' }),
    'deny'
  );
  assert.equal(
    evaluatePermission({ allow: ['git_write(commit)'], defaultMode: 'ask' }, 'git_write', { op: 'merge', branch: 'x' }),
    'ask'
  );
});

test('git_write tool def: riskyWhen per op, preview sync, registered in buildLocalTools', async () => {
  const root = gitRepo();
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const gw = tools.find((t) => t.name === 'git_write');
  assert.ok(gw, 'git_write registered');
  assert.equal(gw.maxCalls, 8);
  assert.equal(gw.riskyWhen({ op: 'conflicts' }), false);
  for (const op of GIT_WRITE_OPS.filter((o) => o !== 'conflicts')) assert.equal(gw.riskyWhen({ op }), true, op);
  const pv = gw.preview({ op: 'commit', message: 'x' });
  assert.equal(typeof pv, 'string', 'preview is sync, not a promise');
  assert.match(gw.render({ op: 'merge', branch: 'f/x' }), /git_write merge f\/x/);
});

// ── Ops against real repos ───────────────────────────────────────────────────

test('git_write: stage → commit → log; refuses empty index; commit all stages untracked', () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 2;\n');

  const refused = gitWriteOp(root, 'commit', { message: 'nope' });
  assert.match(refused, /ERROR: nothing to commit/);

  assert.match(gitWriteOp(root, 'stage', { paths: ['app.js'] }), /OK stage/);
  const done = gitWriteOp(root, 'commit', { message: 'bump v to 2' });
  assert.match(done, /OK commit [0-9a-f]+ bump v to 2/);
  assert.match(done, /app\.js/);

  // message discipline (v0.36.0): a missing message DRAFTS one from the
  // staged diff (drafted marker + trailer); the old "refuse" contract is gone
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 3;\n');
  gitWriteOp(root, 'stage', { paths: ['app.js'] });
  const drafted = gitWriteOp(root, 'commit', {});
  assert.match(drafted, /OK commit [0-9a-f]+ /);
  assert.match(drafted, /drafted from the staged diff/);
  assert.match(drafted, /trailer: Co-Authored-By:/);

  // all:true sweeps untracked but NEVER .buddy/ (Buddy's own runtime state)
  fs.writeFileSync(path.join(root, 'new.txt'), 'hi\n');
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'audit.jsonl'), '{"at":"x"}\n');
  const all = gitWriteOp(root, 'commit', { message: 'sweep', all: true });
  assert.match(all, /OK commit/);
  assert.match(all, /new\.txt/);
  assert.doesNotMatch(all, /\.buddy/);
  assert.equal(sh('git log --oneline -1 --format=%s', root).trim(), 'sweep');
  const names = sh('git diff-tree --no-commit-id --name-only -r HEAD', root);
  assert.ok(names.includes('new.txt') && !names.includes('.buddy/audit.jsonl'), 'all:true excludes .buddy/');
});

test('git_write: branch + checkout + tag + stash/unstash + unstage + restore', () => {
  const root = gitRepo();
  assert.match(gitWriteOp(root, 'branch', { name: 'feature/x' }), /OK branch "feature\/x" created — you are now on it/);
  assert.equal(sh('git rev-parse --abbrev-ref HEAD', root).trim(), 'feature/x');
  assert.match(gitWriteOp(root, 'branch', { name: 'wip', checkout: false, from: 'main' }), /stays on current branch|OK branch/);
  assert.match(gitWriteOp(root, 'checkout', { ref: 'main' }), /OK checkout — now on main/);
  assert.match(gitWriteOp(root, 'branch', { name: 'bad name' }), /ERROR: invalid branch name/);
  assert.match(gitWriteOp(root, 'tag', { name: 'v1.0.0', message: 'first tag' }), /OK tag "v1\.0\.0" \(annotated\)/);
  assert.match(gitWriteOp(root, 'tag', { name: 'bad tag' }), /ERROR: invalid tag name/);

  // stash round-trip
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 99;\n');
  assert.match(gitWriteOp(root, 'stash', { message: 'wip' }), /OK stash/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const v = 1;\n');
  assert.match(gitWriteOp(root, 'unstash', {}), /OK unstash/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const v = 99;\n');

  // unstage keeps the working tree, drops the index entry
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 100;\n');
  gitWriteOp(root, 'stage', { paths: ['app.js'] });
  assert.match(gitWriteOp(root, 'unstage', { paths: ['app.js'] }), /OK unstage/);
  assert.equal(sh('git diff --cached --name-only', root).trim(), '');

  // restore discards tracked working-tree changes → HEAD content (v=1) is back
  assert.match(gitWriteOp(root, 'restore', { paths: ['app.js'] }), /OK restore/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const v = 1;\n');
  assert.match(gitWriteOp(root, 'restore', {}), /ERROR: restore needs paths/);
  // clean tree now — the empty-stash refusal belongs HERE
  assert.match(gitWriteOp(root, 'stash', {}), /ERROR: nothing to stash/);
});

test('git_write: clean merge, then CONFLICT drill — report, resolve, stage, commit, verify', () => {
  const root = gitRepo({ conflict: true }); // feature branch exists + diverged on the same line
  // clean case first: a branch that edits a DIFFERENT file merges without drama
  sh('git checkout -qb clean', root);
  fs.writeFileSync(path.join(root, 'extra.txt'), 'clean\n');
  sh('git add -A && git commit -qm "clean work"', root);
  sh('git checkout -q main', root);
  const clean = gitWriteOp(root, 'merge', { branch: 'clean' });
  assert.match(clean, /OK merge clean/);

  // conflict case
  const dirty = gitWriteOp(root, 'merge', { branch: 'feature' });
  assert.match(dirty, /CONFLICT: merge of "feature" stopped — 1 conflicted file\(s\)/);
  assert.match(dirty, /── app\.js \(UU — both modified\) ──/);
  assert.match(dirty, /ours +\| export const v = "main";/);
  assert.match(dirty, /theirs +\| export const v = "feature";/);
  assert.match(dirty, /How to land it/);

  // conflicts op reports the same state on demand (read-only, no gate)
  const rep = gitWriteOp(root, 'conflicts');
  assert.match(rep, /1 conflicted file\(s\)/);
  const cf = conflictFiles(root);
  assert.equal(cf.files[0].path, 'app.js');
  assert.equal(cf.files[0].code, 'UU');

  // resolve: edit the file (marker-free), stage, commit — git completes the merge
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "resolved";\n');
  gitWriteOp(root, 'stage', { paths: ['app.js'] });
  const landed = gitWriteOp(root, 'commit', { message: 'merge feature: resolve v' });
  assert.match(landed, /OK commit/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const v = "resolved";\n');
  assert.equal(sh('git log -1 --format=%P', root).trim().split(' ').length, 2, 'merge commit has two parents');
});

test('git_write: merge abort restores the pre-merge state; double-merge and unknown-op refused', () => {
  const root = gitRepo({ conflict: true });
  gitWriteOp(root, 'merge', { branch: 'feature' });
  assert.match(gitWriteOp(root, 'merge', { branch: 'feature' }), /ERROR: a merge is already in progress/);
  const aborted = gitWriteOp(root, 'abort', { kind: 'merge' });
  assert.match(aborted, /OK merge aborted/);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const v = "main";\n');
  assert.match(gitWriteOp(root, 'abort', {}), /ERROR: nothing to abort/);
  assert.match(gitWriteOp(root, 'merge', { branch: 'nosuchbranch' }), /ERROR: git merge/);
  assert.match(gitWriteOp(root, 'explode', {}), /ERROR: unknown git_write op "explode"/);
  const rep = conflictReport(root);
  assert.match(rep, /no conflicted files/);
});

test('git_write: rebase conflict → report → resolve → rebase_continue → finishes', () => {
  const root = gitRepo({ conflict: true });
  // branch from BEFORE main's edit (HEAD~1) so topic actually diverges from main
  sh('git checkout -qb topic HEAD~1', root);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "topic";\n');
  sh('git commit -aqm "topic edit"', root);
  const r = gitWriteOp(root, 'rebase', { upstream: 'main' });
  assert.match(r, /CONFLICT: rebase onto "main" stopped/);
  assert.match(r, /rebase_continue/);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "rebased";\n');
  gitWriteOp(root, 'stage', { paths: ['app.js'] });
  const cont = gitWriteOp(root, 'rebase_continue');
  assert.match(cont, /OK rebase continue/);
  const log = sh('git log --oneline -2 --format=%s', root);
  assert.match(log, /topic edit/);
  assert.match(gitWriteOp(root, 'rebase_continue'), /ERROR: no rebase in progress/);
  assert.match(gitWriteOp(root, 'rebase', {}), /ERROR: rebase needs an upstream/);
});

test('git_write: unstash conflict keeps the stash and reports; stash empty refused', () => {
  const root = gitRepo();
  sh('git checkout -qb other', root);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "other";\n');
  sh('git commit -aqm "other edit"', root);
  sh('git checkout -q main', root);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "mainside";\n');
  gitWriteOp(root, 'stash', { message: 'mainside' });
  // diverge on the same line, then pop → guaranteed unstash collision
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "diverged";\n');
  sh('git commit -aqm "diverged"', root);
  const r = gitWriteOp(root, 'unstash', {});
  assert.match(r, /CONFLICT: the unstash collided/);
  assert.match(r, /The stash was KEPT/);
  assert.match(r, /no inline markers|ours|── app\.js/); // report present
  const list = sh('git stash list', root).trim();
  assert.ok(list.length > 0, 'stash survived the collision');
  // resolve by hand: write the winning content, stage, commit (no merge state exists)
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = "unstash-resolved";\n');
  gitWriteOp(root, 'stage', { paths: ['app.js'] });
  assert.match(gitWriteOp(root, 'commit', { message: 'resolve unstash' }), /OK commit/);
  assert.ok(sh('git stash list', root).trim().length > 0, 'stash still kept after a conflicted pop');
});

test('git_write: honest identity error hint; previews for the gate', () => {
  const root = gitRepo();
  // strip identity → commit refuses with the config hint. GIT_CONFIG_GLOBAL=/dev/null
  // (read through process.env by runGit) neutralizes a global ~/.gitconfig identity.
  sh('git config --unset user.name && git config --unset user.email', root);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  try {
    fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 5;\n');
    gitWriteOp(root, 'stage', { paths: ['app.js'] });
    const r = gitWriteOp(root, 'commit', { message: 'who am i' });
    assert.match(r, /ERROR: git commit/);
    assert.match(r, /git config user\.name\/user\.email/);
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }

  const t = buildGitWriteTool({ root });
  assert.match(t.preview({ op: 'restore', paths: ['app.js'] }), /DISCARD uncommitted changes/);
  assert.match(t.preview({ op: 'commit', all: true }), /changed file\(s\) will be staged first/);
  assert.match(t.preview({ op: 'merge', branch: 'main' }), /merge main/);
  assert.equal(t.preview({ op: 'conflicts' }), null);
  // non-repo root degrades to honest ERRORs, never throws
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-nonrepo-'));
  assert.match(gitWriteOp(empty, 'conflicts'), /ERROR:/);
  assert.match(gitWriteOp(empty, 'commit', { message: 'x', all: true }), /not a git repository/);
  assert.match(gitWriteOp(empty, 'stage', { paths: ['a'] }), /not a git repository/);
});

test('bash blocklist still refuses git writes, now pointing at git_write', () => {
  assert.match(blockedBashReason('git commit -m x'), /git_write/);
  assert.match(blockedBashReason('git push origin main'), /git_write/);
  assert.match(blockedBashReason('git reset --hard HEAD~1'), /git_write/);
  assert.equal(blockedBashReason('git status'), null);
  assert.equal(blockedBashReason('git diff HEAD'), null);
});
