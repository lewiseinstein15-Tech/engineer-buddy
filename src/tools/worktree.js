// worktree.js — `--worktree` isolation (v0.36.0, checklist §9).
//
// An agent run that mutates the working tree shares one risk with the user:
// they are standing in the SAME tree. `buddy --worktree` gives the run its
// own git worktree — a fresh checkout of HEAD in `.buddy/worktrees/<slug>/`
// on a `buddy/<slug>` branch — so Buddy's edits, stages, and commits never
// touch the user's dirty state, and the diff between the two is reviewable
// with plain git (`git diff main..buddy/<slug>`).
//
// Deliberately simple: git worktree add/remove through spawnSync, honest
// errors, no daemon, no cleanup daemon either — the worktree OUTLIVES the
// run (the exit note prints the exact removal command; deleting a tree that
// still holds unmerged work is the user's call, not ours).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** "2026-10-27 11:45:03" + "f218ba3" → "20261027-114503-f218ba3" */
export function worktreeSlug(date, sha = '') {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const clean = String(sha || '').trim().replace(/^@/, '');
  return clean ? `${stamp}-${clean.slice(0, 7)}` : stamp;
}

export function worktreeBranch(slug) {
  return `buddy/${String(slug).replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

/** Where the tree lives: <root>/.buddy/worktrees/<slug>. */
export function worktreePath(root, slug) {
  return path.join(root, '.buddy', 'worktrees', String(slug).replace(/[^a-zA-Z0-9._-]/g, '-'));
}

function git(root, argv, timeoutMs = 30000) {
  const r = spawnSync('git', ['-C', root, ...argv], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', LANG: 'C' },
  });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: ((r.stderr || '') + (r.error?.message || '')).trim() };
}

/**
 * Create the isolation worktree. Branch collisions get -2, -3, … suffixes.
 * A dirty ORIGINAL tree is fine — the worktree checks out HEAD fresh and
 * the user's uncommitted changes stay where they are.
 */
export function createWorktree(root, { slug = worktreeSlug(new Date(), git(root, ['rev-parse', '--short', 'HEAD']).out) } = {}) {
  const s = String(slug || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!git(root, ['rev-parse', '--git-dir']).ok) {
    return { ok: false, error: 'not a git repository — --worktree needs one (run inside a repo)' };
  }
  const base = git(root, ['rev-parse', '--show-toplevel']);
  if (!base.ok) return { ok: false, error: `cannot find the repo root — ${base.err}` };
  const wtRoot = path.join(base.out, '.buddy', 'worktrees');
  const branch = worktreeBranch(s);
  fs.mkdirSync(wtRoot, { recursive: true });
  let name = s, n = 2;
  while (git(root, ['rev-parse', '--verify', `refs/heads/${worktreeBranch(name)}`]).ok) {
    name = `${s}-${n++}`;
  }
  const wtPath = path.join(wtRoot, name);
  const r = git(root, ['worktree', 'add', wtPath, '-b', worktreeBranch(name)]);
  if (!r.ok) return { ok: false, error: `git worktree add failed — ${r.err}` };
  return { ok: true, path: wtPath, branch: worktreeBranch(name), slug: name };
}

/** Remove a worktree Buddy created (refuses trees with uncommitted changes unless force). */
export function removeWorktree(root, wtPath, { force = false } = {}) {
  const r = git(root, ['worktree', 'remove', wtPath, ...(force ? ['--force'] : [])]);
  if (!r.ok) {
    const dirty = /dirty|modified/i.test(r.err);
    return { ok: false, error: dirty ? `worktree has uncommitted changes — pass force:true (or keep it: ${wtPath})` : r.err };
  }
  return { ok: true };
}

/** `git worktree list --porcelain` → [{path, head, branch}] (main tree flagged). */
export function listWorktrees(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) out.push(cur); cur = { path: line.slice(9) }; }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare' && cur) cur.bare = true;
  }
  if (cur) out.push(cur);
  return out;
}
