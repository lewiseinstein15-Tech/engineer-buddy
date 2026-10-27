// gitwrite-v036.test.js — the v0.36.0 git-native wave against REAL repos:
// the commit op's generate:true (drafted message + Co-Authored-By trailer on
// real commits), the push op (against a local BARE remote — offline, no
// credentials involved), and the pr flow end to end. Every mutating op here
// runs through gitWriteOp directly (the gate is the caller's concern —
// riskyWhen was already pinned by the existing gitwrite suite).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gitWriteOp, GIT_WRITE_OPS, buildGitWriteTool } from '../src/tools/gitwrite.js';
import { createWorktree, listWorktrees, removeWorktree, worktreeSlug, worktreeBranch, worktreePath } from '../src/tools/worktree.js';

const here = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const SH = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-gw36-'));
  SH(root, 'git', ['init', '-b', 'main']);
  SH(root, 'git', ['config', 'user.email', 't@t.dev']);
  SH(root, 'git', ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  SH(root, 'git', ['add', '-A']);
  SH(root, 'git', ['commit', '-m', 'seed']);
  return root;
}

function bareRemote(src) {
  const remote = src + '-remote.git';
  SH(src, 'git', ['clone', '--bare', src, remote]);
  SH(src, 'git', ['remote', 'add', 'origin', remote]);
  SH(src, 'git', ['push', '-u', 'origin', 'main']);
  return remote;
}

describe('the commit op drafts from the staged diff', () => {
  test('generate:true writes a conventional subject + trailer into the real commit', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'src.js'), 'export function slugify(x) {\n  return x.trim();\n}\n');
    fs.writeFileSync(path.join(root, 'slug.test.js'), 'import test from "node:test";\n');
    SH(root, 'git', ['add', '-A']);
    const out = gitWriteOp(root, 'commit', { generate: true });
    assert.match(out, /OK commit/);
    assert.match(out, /drafted from the staged diff/);
    assert.match(out, /trailer: Co-Authored-By:/);
    const body = SH(root, 'git', ['log', '-1', '--format=%B']);
    assert.match(body, /^(fix|feat|refactor|chore|test|docs)(\([^)]*\))?: /);
    assert.match(body, /^Co-Authored-By: Buddy </m);
  });

  test('an explicit message wins and still gets the trailer appended', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    SH(root, 'git', ['add', '-A']);
    const out = gitWriteOp(root, 'commit', { message: 'docs: say it my way' });
    assert.match(out, /OK commit/);
    const body = SH(root, 'git', ['log', '-1', '--format=%B']);
    assert.match(body, /^docs: say it my way/m);
    assert.match(body, /^Co-Authored-By: Buddy </m);
  });

  test('BUDDY_NO_COAUTHOR=1 leaves the trailer out entirely', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    SH(root, 'git', ['add', '-A']);
    const env = { BUDDY_NO_COAUTHOR: '1' };
    // gitWriteOp reads process.env for the trailer — inject without polluting
    const old = process.env.BUDDY_NO_COAUTHOR;
    process.env.BUDDY_NO_COAUTHOR = '1';
    try {
      const out = gitWriteOp(root, 'commit', { message: 'chore: no trailer please' });
      assert.match(out, /OK commit/);
      const body = SH(root, 'git', ['log', '-1', '--format=%B']);
      assert.doesNotMatch(body, /Co-Authored-By:/);
    } finally {
      if (old === undefined) delete process.env.BUDDY_NO_COAUTHOR;
      else process.env.BUDDY_NO_COAUTHOR = old;
    }
    assert.ok(env); // silence lint
  });
});

describe('the push op against a local bare remote', () => {
  test('push -u publishes the branch and reports the remote', () => {
    const root = fixture();
    bareRemote(root);
    fs.writeFileSync(path.join(root, 'work.txt'), 'v1\n');
    gitWriteOp(root, 'commit', { message: 'feat: real work' });
    const out = gitWriteOp(root, 'push', {});
    assert.match(out, /OK push — main → origin/);
    // the remote actually received it
    const remote = SH(root, 'git', ['remote', 'get-url', 'origin']);
    const heads = SH(path.dirname(remote) === root ? root : root, 'git', ['--git-dir', remote, 'for-each-ref', 'refs/heads/main', '--format=%(refname)']);
    assert.match(heads, /refs\/heads\/main/);
  });

  test('no remote → an honest refusal naming git remote -v', () => {
    const root = fixture();
    const out = gitWriteOp(root, 'push', {});
    assert.match(out, /ERROR: no remote "origin"/);
    assert.match(out, /no remotes configured/);
  });

  test('up to date → OK without contacting anything', () => {
    const root = fixture();
    bareRemote(root);
    const out = gitWriteOp(root, 'push', {});
    assert.match(out, /OK nothing to push|OK push/);
  });
});

describe('the pr flow — branch → stage → commit → push → handoff', () => {
  test('the whole flow lands on a real remote with a drafted message', () => {
    const root = fixture();
    const remote = bareRemote(root);
    fs.writeFileSync(path.join(root, 'src2.js'), 'export function routeSlug(x) {\n  return x || "unknown";\n}\n');
    fs.writeFileSync(path.join(root, 'src2.test.js'), 'import test from "node:test";\ntest("route", () => {});\n');
    const out = gitWriteOp(root, 'pr', { branch: 'fix/route-slug', base: 'main' });
    assert.match(out, /OK pr flow/);
    assert.match(out, /branch: main → fix\/route-slug/);
    // two NEW source files (src2.js + its test) → feat, subject from the dominant file
    assert.match(out, /commit: \w+ feat(\([^)]*\))?: add src2\.js/);
    assert.match(out, /push: fix\/route-slug → origin/);
    // the handoff is honest either way: a forge remote names the pr_create
    // call; a non-forge remote (this bare fixture) says why it can't resolve
    assert.match(out, /pr_create|gh: cannot read a GitHub\/GitLab repo/);
    // on the branch, with the trailer, and the remote has the branch
    assert.equal(SH(root, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/route-slug');
    const body = SH(root, 'git', ['log', '-1', '--format=%B']);
    assert.match(body, /^Co-Authored-By: Buddy </m);
    const remoteRef = SH(root, 'git', ['--git-dir', remote, 'for-each-ref', 'refs/heads/fix/route-slug', '--format=%(refname)']);
    assert.match(remoteRef, /fix\/route-slug/);
  });

  test('head === base is refused before anything runs', () => {
    const root = fixture();
    const out = gitWriteOp(root, 'pr', { branch: 'main', base: 'main' });
    assert.match(out, /ERROR: head and base are both "main"/);
  });

  test('the flow survives a push failure honestly (branch + commit kept)', () => {
    const root = fixture();
    bareRemote(root);
    // make the remote reject: push main forward behind git's back
    const remote = SH(root, 'git', ['remote', 'get-url', 'origin']);
    SH(root, 'git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', 'HEAD']);
    fs.writeFileSync(path.join(root, 'w.txt'), 'v\n');
    const out = gitWriteOp(root, 'pr', { branch: 'feat/x', base: 'main' });
    // a fresh branch pushing to a bare repo succeeds — force the failure by
    // pointing origin at a nonexistent path instead
    if (/OK pr flow/.test(out)) {
      SH(root, 'git', ['remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git')]);
      fs.writeFileSync(path.join(root, 'w2.txt'), 'v\n');
      const out2 = gitWriteOp(root, 'pr', { branch: 'feat/y', base: 'main' });
      assert.match(out2, /push failed/);
      assert.match(out2, /branch \+ commit exist locally/);
      assert.equal(SH(root, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/y');
    } else {
      assert.match(out, /push failed/);
    }
  });
});

describe('ops list + previews', () => {
  test('push and pr are registered ops', () => {
    assert.ok(GIT_WRITE_OPS.includes('push'));
    assert.ok(GIT_WRITE_OPS.includes('pr'));
  });

  test('the pr preview shows the whole plan without running anything', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'x.txt'), 'x\n');
    const tool = buildGitWriteTool({ root });
    const plan = tool.preview({ op: 'pr', branch: 'feat/preview', base: 'main' });
    assert.match(plan, /PR flow/);
    assert.match(plan, /branch main → feat\/preview/);
    assert.match(plan, /push -u origin feat\/preview/);
    assert.match(plan, /gh op:pr_create/);
  });

  test('the commit preview names the draft even for all:true (drill fix)', () => {
    // the v0.36.0 drill caught this: all:true returned early, so the gate
    // previewed "N file(s) will be staged" and NEVER the drafted message
    const root = fixture();
    fs.writeFileSync(path.join(root, 'a.js'), 'export const v = 1;\n');
    const tool = buildGitWriteTool({ root });
    const plan = tool.preview({ op: 'commit', generate: true, all: true });
    assert.match(plan, /will be staged first \(all:true\)/);
    assert.match(plan, /will draft the message after staging/);
    assert.match(plan, /Co-Authored-By:/);
    // staged (non-all) commits still preview the actual draft
    SH(root, 'git', ['add', '-A']);
    const plan2 = tool.preview({ op: 'commit', generate: true });
    assert.match(plan2, /will draft the message from the staged diff:/);
    assert.match(plan2, /Co-Authored-By:/);
  });

  test('pr flow skips the commit when the branch already carries new commits (drill fix)', () => {
    const root = fixture();
    const remote = bareRemote(root);
    SH(root, 'git', ['checkout', '-b', 'fix/already-done']);
    fs.writeFileSync(path.join(root, 'done.txt'), 'work\n');
    SH(root, 'git', ['add', '-A']);
    SH(root, 'git', ['commit', '-m', 'fix: already committed by hand']);
    const out = gitWriteOp(root, 'pr', { branch: 'fix/already-done', base: 'main' });
    assert.match(out, /OK pr flow/);
    assert.match(out, /commit: skipped — the branch already has 1 new commit\(s\) vs main/);
    assert.match(out, /push: fix\/already-done → origin/);
    const remoteRef = SH(root, 'git', ['--git-dir', remote, 'for-each-ref', 'refs/heads/fix/already-done', '--format=%(refname)']);
    assert.match(remoteRef, /fix\/already-done/);
  });

  test('pr flow refuses an empty PR honestly when the branch is even with base (drill fix)', () => {
    const root = fixture();
    bareRemote(root);
    const out = gitWriteOp(root, 'pr', { branch: 'fix/nothing', base: 'main' });
    assert.match(out, /ERROR: pr flow stopped at commit/);
    assert.match(out, /branch is even with main/);
    assert.match(out, /empty diff/);
  });

  test('staging survives a GITIGNORED .buddy (drill fix — the exclude pathspec form)', () => {
    // The live drill caught this: `git add -A -- . ':(exclude).buddy'` exits 1
    // whenever .buddy is actually ignored (a pathspec naming an ignored path
    // trips git's advice). The unit fixtures never had a gitignored .buddy —
    // only a real repo running the app does. Plain add -A + rm --cached
    // --ignore-unmatch must stage everything EXCEPT .buddy in both worlds.
    const root = fixture();
    fs.writeFileSync(path.join(root, '.gitignore'), '.buddy/\n');
    fs.mkdirSync(path.join(root, '.buddy', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, '.buddy', 'sessions', 'x.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, 'code.js'), 'export const v = 1;\n');
    const out = gitWriteOp(root, 'commit', { generate: true, all: true });
    assert.match(out, /OK commit/, out);
    const staged = SH(root, 'git', ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(staged.includes('code.js'), `code.js staged (got: ${staged.join(', ')})`);
    assert.ok(!staged.some((f) => f.startsWith('.buddy/')), `.buddy never staged (got: ${staged.join(', ')})`);
  });

  test('staging still excludes .buddy when it is NOT gitignored (the unstage half)', () => {
    const root = fixture(); // no .gitignore — .buddy would be swept in by add -A
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.buddy', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'export const w = 2;\n');
    const out = gitWriteOp(root, 'commit', { generate: true, all: true });
    assert.match(out, /OK commit/, out);
    const staged = SH(root, 'git', ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(staged.includes('app.js'));
    assert.ok(!staged.some((f) => f.startsWith('.buddy/')), `.buddy never staged (got: ${staged.join(', ')})`);
  });

  test('the --worktree kept-note rides an onExit hook, not dead post-repl code (drill fix)', () => {
    // the drill's worktree smoke caught this: /exit → the repl's close handler
    // process.exit(0)'s directly, so anything after startRepl NEVER ran and
    // the removal command could not print. Wiring: the hook is called inside
    // the close handler BEFORE the exit, and index.js hands it over.
    const replSrc = here('../src/terminal/repl.js');
    assert.match(replSrc, /if \(typeof onExit === 'function'\) \{\s*\n\s*try \{ onExit\(\); \} catch/);
    assert.match(replSrc, /process\.exit\(0\);\s*\n\s*\}\);/); // the hook precedes the exit in the same handler
    const indexSrc = here('../src/index.js');
    assert.match(indexSrc, /onExit: exitNote/);
    assert.doesNotMatch(indexSrc, /const exitCode = \(await startRepl\([^\n]+\)\) \?\? 0;\s*\n\s*if \(worktreeNote\) \{/); // the dead block is gone
    // review catch (v0.36.0): the ONE-SHOT path returns instead of exiting —
    // it must print the same kept-note (removal command) before returning.
    assert.match(indexSrc, /if \(worktreeNote\) printWorktreeNote\(worktreeNote\);\n\s*if \(!out\.said\)/);
    assert.match(indexSrc, /function printWorktreeNote\(wt\) \{/);
    assert.match(indexSrc, /exitNote = worktreeNote \? \(\) => printWorktreeNote\(worktreeNote\) : null/); // one shared note, both paths
  });
});

describe('worktree isolation', () => {
  test('slug + branch shapes', () => {
    const s = worktreeSlug(new Date('2026-10-27T11:45:03Z'), 'f218ba3abc');
    assert.match(s, /^\d{8}-\d{6}-f218ba3$/);
    assert.equal(worktreeBranch(s), `buddy/${s}`);
    assert.match(worktreePath('/repo', s), /\.buddy\/worktrees\/20261027-114503-f218ba3$/);
  });

  test('createWorktree makes a real tree on a buddy/* branch (original tree untouched)', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'user change\n'); // left dirty on purpose
    const wt = createWorktree(root, { slug: 'test-one' });
    assert.ok(wt.ok, wt.error);
    assert.match(wt.branch, /^buddy\/test-one$/);
    assert.ok(fs.existsSync(path.join(wt.path, 'README.md')), 'the worktree has the seed checkout');
    assert.equal(fs.readFileSync(path.join(root, 'dirty.txt'), 'utf8'), 'user change\n');
    const list = listWorktrees(root);
    assert.ok(list.some((w) => w.branch === 'buddy/test-one'));
    // a second create with the same slug gets -2
    const wt2 = createWorktree(root, { slug: 'test-one' });
    assert.ok(wt2.ok);
    assert.equal(wt2.branch, 'buddy/test-one-2');
    // remove both (clean trees — no force needed)
    assert.ok(removeWorktree(root, wt.path).ok);
    assert.ok(removeWorktree(root, wt2.path).ok);
  });

  test('removeWorktree refuses a dirty tree without force, names the choice', () => {
    const root = fixture();
    const wt = createWorktree(root, { slug: 'test-dirty' });
    assert.ok(wt.ok);
    fs.writeFileSync(path.join(wt.path, 'wip.txt'), 'uncommitted\n');
    const r = removeWorktree(root, wt.path);
    assert.equal(r.ok, false);
    assert.match(r.error, /uncommitted changes/);
    const rf = removeWorktree(root, wt.path, { force: true });
    assert.ok(rf.ok, rf.error);
  });

  test('outside a git repo → honest error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-nogit-'));
    const wt = createWorktree(tmp, { slug: 'x' });
    assert.equal(wt.ok, false);
    assert.match(wt.error, /not a git repository/);
  });
});
