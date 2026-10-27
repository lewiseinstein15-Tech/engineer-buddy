// gitwrite.js — the approval-gated git WRITE tool (v0.27.0).
//
// History lesson: the read-only `git` tool (v0.20.0) deliberately refused
// writes, and the bash blocklist made git mutations impossible for the model
// ("the user commits"). That was the right call before Buddy had a proper
// write surface — and the wrong call forever. Every real coding loop ends in
// a commit. So writes get their own tool with the full safety stack instead
// of hiding in shell:
//
//   approval gate   — every mutating op fires the interactive gate (riskyWhen)
//   permissions     — subjects are "<op> <target>" so rules read naturally:
//                       allow: ["git_write(commit)", "git_write(stage *)"]
//                       deny:  ["git_write(restore)"]
//   preview         — the gate shows WHAT happens before it happens (staged
//                     stat for commit, incoming commits for merge, the diff
//                     being destroyed for restore)
//   conflict assist — merge/rebase that hit conflicts do NOT return shell
//                     soup: they parse the working tree into ours / base /
//                     theirs hunks so the model can propose a resolution,
//                     edit the files (gated fs tools), stage, and commit.
//                     Or `abort` to walk away clean.
//
// Ops (16): stage, unstage, commit (generate:true drafts from the diff +
//           Co-Authored-By), branch, checkout, merge, rebase, rebase_continue,
//           abort, stash, unstash, restore, tag, conflicts, push (gated,
//           never force by default), pr (branch → commit → push → the gh
//           pr_create handoff — the PR creation flow).
// Not here ON PURPOSE: pull/fetch (they rewrite the LOCAL state from the
// network — rebase/merge/abort already cover the local half; fetching is a
// read the user's terminal or the bot path owns), clean/reset --hard (use
// restore with a pathspec so the preview shows exactly what dies).
//
// All git invocations are non-interactive by construction: GIT_EDITOR=true,
// GIT_MERGE_AUTOEDIT=no, GIT_TERMINAL_PROMPT=0. spawnSync with a hard
// timeout — local git ops are sub-second; a 30s ceiling is a tripwire, not
// a workflow.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { truncate } from '../util.js';
import { draftCommitMessage, withTrailer } from './commitmsg.js';
import { resolveGh } from './ghapi.js';

const GIT_ENV = {
  GIT_EDITOR: 'true', // exits 0 immediately — rebase --continue never hangs
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_TERMINAL_PROMPT: '0', // never ask for credentials — fail honestly
  GIT_PAGER: 'cat',
  NO_COLOR: '1',
  LANG: 'C',
};

export const GIT_WRITE_OPS = [
  'stage', 'unstage', 'commit', 'branch', 'checkout', 'merge', 'rebase',
  'rebase_continue', 'abort', 'stash', 'unstash', 'restore', 'tag', 'conflicts',
  'push', 'pr',
];

/** Ops that are pure reads — they skip the approval gate entirely. */
const READ_OPS = new Set(['conflicts']);

function runGit(root, argv, timeoutMs = 30000) {
  const r = spawnSync('git', ['-C', root, ...argv], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  if (r.error) return { ok: false, code: -1, out: '', err: `git not runnable: ${r.error.message}` };
  return { ok: r.status === 0, code: r.status, out: r.stdout || '', err: (r.stderr || '').trim(), timedOut: Boolean(r.error?.killed) || r.status === null };
}

/** Light branch/ref-name validation — permissive (slashes fine), stupid-proof. */
export function validBranchName(name) {
  const s = String(name ?? '').trim();
  if (!s || s.length > 200) return false;
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('.') || s.startsWith('/') || s.endsWith('/')) return false;
  if (s.includes('..') || s.endsWith('.') || s.endsWith('.lock')) return false;
  if (s.includes('//')) return false;
  return true;
}

// ── Conflict parsing (the assist's core) ─────────────────────────────────────

const cap = (arr, max) => (arr.length > max ? { lines: arr.slice(0, max), cut: arr.length - max } : { lines: arr, cut: 0 });

/** Parse one file's conflict markers into structured hunks.
 *  Handles default style (ours/theirs) and diff3 (with ||||||| base).
 *  Markers are only honored where git puts them: `<<<<<<<`/`>>>>>>>` open and
 *  close, `=======` splits, `|||||||` starts the base — a markdown underline
 *  inside a hunk is content, not a separator. Pure function. */
export function parseConflictFile(content, { maxHunks = 8, maxLines = 12 } = {}) {
  const lines = String(content ?? '').split('\n');
  const hunks = [];
  let i = 0;
  let unterminated = false;
  while (i < lines.length && hunks.length < maxHunks) {
    if (!/^<{7}( |$)/.test(lines[i])) {
      i++;
      continue;
    }
    const startLine = i + 1; // 1-based
    const label = lines[i].replace(/^<{7}\s*/, '').trim() || 'ours';
    i++;
    const ours = [];
    const theirs = [];
    let base = null; // null = no ||||||| section (default merge style)
    let mode = 'ours';
    let closed = false;
    while (i < lines.length) {
      if (/^>{7}( |$)/.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      if ((mode === 'ours' || mode === 'base') && /^={7}$/.test(lines[i])) {
        mode = 'theirs'; // default style: ends ours · diff3 style: ends the base section
        i++;
        continue;
      }
      if (mode === 'ours' && /^\|{7}/.test(lines[i])) {
        mode = 'base';
        base = [];
        i++;
        continue;
      }
      (mode === 'ours' ? ours : mode === 'base' ? base : theirs).push(lines[i]);
      i++;
    }
    if (!closed) {
      unterminated = true; // marker soup — report what we captured and stop
    }
    const o = cap(ours, maxLines);
    const t = cap(theirs, maxLines);
    const b = base == null ? null : cap(base, maxLines);
    hunks.push({ line: startLine, label, ours: o, base: b, theirs: t });
    if (unterminated) break;
  }
  return { hunks, truncated: hunks.length > maxHunks || unterminated };
}

/** Status codes git uses for unmerged entries → human labels. */
const CONFLICT_CODES = {
  DD: 'both deleted',
  AU: 'added by us',
  UD: 'deleted by them',
  UA: 'added by them',
  DU: 'deleted by us',
  AA: 'both added',
  UU: 'both modified',
};

/** Conflicted files from `git status --porcelain=v1 -z` (NUL-safe for spaces). */
export function conflictFiles(root) {
  const r = runGit(root, ['status', '--porcelain=v1', '-z']);
  if (!r.ok) return { ok: false, error: r.err || 'git status failed', files: [] };
  const entries = r.out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    if (CONFLICT_CODES[code]) {
      files.push({ path: entries[i].slice(3), code, label: CONFLICT_CODES[code] });
    }
  }
  return { ok: true, files };
}

function sideBlock(name, side) {
  if (side == null) return `    ${name}: (not shown — default merge style records no base)`;
  const out = side.lines.map((l) => `    ${name.padEnd(6)} | ${l}`);
  if (side.cut) out.push(`    ${' '.repeat(name.length)}  … +${side.cut} more line(s)`);
  if (!side.lines.length) out.push(`    ${name.padEnd(6)} | (empty)`);
  return out.join('\n');
}

/** The full conflict report: files + ours/base/theirs hunks. Never throws. */
export function conflictReport(root, { maxFiles = 6 } = {}) {
  const { ok, files, error } = conflictFiles(root);
  if (!ok) return `ERROR: ${error}`;
  if (!files.length) return '(no conflicted files — the merge/rebase is not currently stopped on a conflict)';
  const shown = files.slice(0, maxFiles);
  const parts = [`${files.length} conflicted file(s):`];
  for (const f of shown) {
    parts.push(`\n── ${f.path} (${f.code} — ${f.label}) ──`);
    let content = '';
    try {
      content = fs.readFileSync(path.resolve(root, f.path), 'utf8');
    } catch {
      parts.push('  (file unreadable — it may be deleted on one side; decide keep/remove and stage or git rm)');
      continue;
    }
    const { hunks, truncated } = parseConflictFile(content);
    if (!hunks.length) {
      parts.push('  (no inline markers found — the conflict is add/add or delete/edit; compare both versions and write the winning content, then stage)');
      continue;
    }
    for (const h of hunks) {
      parts.push(`  hunk @line ${h.line} (theirs: ${h.label || 'incoming'}):`);
      parts.push(sideBlock('ours', h.ours));
      parts.push(sideBlock('base', h.base));
      parts.push(sideBlock('theirs', h.theirs));
    }
    if (truncated) parts.push('  … more hunks in this file (resolve top-down; the report caps at 8 per file)');
  }
  if (files.length > shown.length) parts.push(`\n… +${files.length - shown.length} more conflicted file(s)`);
  return parts.join('\n');
}

// ── Previews (sync, cheap — shown in the approval gate before it fires) ──────

function statOr(root, argv, empty) {
  const r = runGit(root, argv);
  const body = r.out.trim();
  if (!r.ok || !body) return empty;
  return truncate(body, 900);
}

function inProgress(root) {
  const g = (p) => {
    const r = runGit(root, ['rev-parse', '--git-path', p]);
    const rel = r.out.trim();
    return r.ok && rel && fs.existsSync(path.resolve(root, rel));
  };
  if (g('MERGE_HEAD')) return 'merge';
  if (g('rebase-merge') || g('rebase-apply')) return 'rebase';
  return null;
}

const firstTarget = (a) => {
  const t = a?.paths ?? a?.branch ?? a?.upstream ?? a?.ref ?? a?.name ?? '';
  const s = Array.isArray(t) ? t[0] : t;
  return s ? String(s) : '';
};

function previewFor(root, op, a = {}) {
  switch (op) {
    case 'stage':
      return statOr(root, ['diff', '--stat'], '(no tracked unstaged changes — untracked files are staged as-is)');
    case 'unstage':
      return statOr(root, ['diff', '--cached', '--stat'], '(nothing staged)');
    case 'commit': {
      // v0.36.0 drill fix: the all:true branch used to RETURN early, so the
      // gate never previewed the drafted message when the model (sensibly)
      // sent {generate:true, all:true} together. Now every commit preview
      // names the draft — from the staged diff when one exists, or honestly
      // "after staging" when all:true will build it.
      const parts = [];
      if (a.all) {
        const n = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
        parts.push(n ? `${n} changed file(s) will be staged first (all:true)` : '(nothing to commit — working tree clean)');
      } else {
        parts.push(statOr(root, ['diff', '--cached', '--stat'], '(nothing staged yet — the commit will be refused)'));
      }
      const gen = a.generate || !a.message;
      const trailer = withTrailer('', process.env);
      if (gen) {
        const draft = a.all ? null : draftMsg(root);
        if (draft) {
          parts.push(`will draft the message from the staged diff:\n  ${draft.title}${trailer ? `\n  (+ ${trailer})` : ''}${a.message ? '\n  (an explicit message was also given — it wins)' : ''}`);
        } else {
          parts.push(`will draft the message after staging${trailer ? ` (+ ${trailer})` : ''}${a.message ? ' (an explicit message was also given — it wins)' : ''}`);
        }
      }
      return parts.join('\n');
    }
    case 'branch':
      return `new branch from ${a.from ? String(a.from) : 'current HEAD'}${a.checkout === false ? ' (stays on current branch)' : ' (checks it out)'}`;
    case 'checkout': {
      const cur = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      const dirty = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
      return `${cur} → ${String(a.ref || '')}${dirty ? ` — WARNING: ${dirty} uncommitted change(s) may block or carry over` : ''}`;
    }
    case 'merge': {
      const log = statOr(root, ['log', '--oneline', '-n8', `HEAD..${String(a.branch || '')}`], null);
      if (log === null) return `merge ${String(a.branch || '')} into the current branch`;
      const n = log.split('\n').length;
      return `merge ${String(a.branch || '')} — ${n} incoming commit(s):\n${log}`;
    }
    case 'rebase': {
      const log = statOr(root, ['log', '--oneline', '-n8', `${String(a.upstream || '')}..HEAD`], null);
      if (log === null) return `rebase the current branch onto ${String(a.upstream || '')}`;
      const n = log.split('\n').length;
      return `rebase onto ${String(a.upstream || '')} — ${n} local commit(s) to replay:\n${log}`;
    }
    case 'rebase_continue': {
      const rep = conflictReport(root, { maxFiles: 0 });
      return rep.startsWith('(no conflicted') ? 'continue the in-progress rebase' : `resolve first — ${rep.split('\n')[0]}`;
    }
    case 'abort': {
      const kind = inProgress(root) || a.kind || '(nothing in progress)';
      return `abort the in-progress ${kind} — working tree returns to the pre-${kind} state`;
    }
    case 'stash': {
      const n = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
      return `stash ${n} changed file(s)${a.message ? ` — "${String(a.message).slice(0, 60)}"` : ''}`;
    }
    case 'unstash': {
      const list = runGit(root, ['stash', 'list']).out.trim().split('\n').filter(Boolean);
      const idx = Math.max(Number(a.index) || 0, 0);
      return list[idx] ? `pop ${list[idx]}` : '(no stash entries — the unstash will be refused)';
    }
    case 'restore': {
      const p = a.paths;
      const spec = Array.isArray(p) ? p.map(String) : [String(p ?? '')];
      return `DISCARD uncommitted changes to: ${spec.join(', ')} — gone for good:\n${statOr(root, ['diff', '--stat', '--', ...spec], '(only untracked/new files — nothing tracked to discard)')}`;
    }
    case 'tag':
      return `tag ${String(a.name || '')} at ${a.ref ? String(a.ref) : 'HEAD'}${a.message ? ' (annotated)' : ' (lightweight)'}`;
    case 'push': {
      const remote = String(a.remote || 'origin');
      const cur = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      const branch = String(a.branch || cur || '').trim();
      const remotes = runGit(root, ['remote']).out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!remotes.includes(remote)) return `no remote "${remote}" — the push will be refused (${remotes.length ? `found: ${remotes.join(', ')}` : 'no remotes configured'})`;
      const ahead = runGit(root, ['rev-list', '--count', `${remote}/${branch}..${branch}`]).out.trim();
      if (a.force_with_lease) return `push --force-with-lease ${branch} → ${remote} (REWRITES the remote branch — lease-guarded)`;
      if (ahead === '0') return `nothing to push — ${branch} is up to date with ${remote}/${branch}`;
      return `push ${ahead || '?'} commit(s) → ${remote}/${branch} (sets upstream; never force)`;
    }
    case 'pr': {
      const cur = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      const branch = String(a.branch || '').trim() || cur;
      const base = String(a.base || '').trim() || 'main';
      if (branch === base) return `head and base are both "${branch}" — the flow will refuse; pass {"branch": "..."}`;
      const dirty = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
      const draft = draftMsg(root);
      return [
        'PR flow — every step runs in order, stop at the first failure:',
        `  1. branch ${cur} → ${branch}${branch !== cur ? ` (from ${base})` : ' (already on it)'}`,
        `  2. stage ${dirty || 0} changed file(s) (.buddy/ excluded)`,
        `  3. commit: ${draft ? draft.title : String(a.message || '(drafted from the staged diff)')}${withTrailer('', process.env) ? `\n     (+ ${withTrailer('', process.env)})` : ''}`,
        `  4. push -u origin ${branch} (plain push, never force)`,
        `  5. handoff: gh op:pr_create {"branch":"${branch}","base":"${base}"}`,
      ].join('\n');
    }
    default:
      return null; // conflicts is read-only — no gate, no preview
  }
}

// ── The op runner ────────────────────────────────────────────────────────────

function errHint(r, op) {
  const msg = truncate(r.err || `exit ${r.code}`, 400);
  if (/Please tell me who you are|user\.name|user\.email/i.test(msg)) {
    return `ERROR: git ${op}: ${msg}\nHint: the repo has no git identity — ask the user to run "git config user.name/user.email" (Buddy never invents one).`;
  }
  return `ERROR: git ${op}: ${msg}`;
}

function pathsArg(a, what) {
  const p = a?.[what];
  const list = Array.isArray(p) ? p.map((x) => String(x)) : p ? [String(p)] : [];
  if (!list.length || list.some((x) => !x.trim())) return null;
  return list;
}

function shortstat(root) {
  const r = runGit(root, ['show', '--shortstat', '--format=', 'HEAD']).out.trim();
  return r || '';
}

/**
 * Draft a commit message from the STAGED state (v0.36.0). Returns null when
 * nothing is staged. Feeds draftCommitMessage() with the per-file shape
 * (new/deleted flags + add/del counts) and the full staged diff so the hunk
 * headers can name the enclosing functions.
 */
function draftMsg(root) {
  const names = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return null;
  const numstat = runGit(root, ['diff', '--cached', '--numstat']).out;
  const status = runGit(root, ['diff', '--cached', '--name-status']).out;
  const added = {}, deleted = {};
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) added[m[3]] = m[1] === '-' ? 0 : Number(m[1]);
    if (m) deleted[m[3]] = m[2] === '-' ? 0 : Number(m[2]);
  }
  const isNew = new Set(), isGone = new Set();
  for (const line of status.split('\n')) {
    const m = line.match(/^([ADT])\t(.+)$/);
    if (m?.[1] === 'A') isNew.add(m[2]);
    if (m?.[1] === 'D') isGone.add(m[2]);
  }
  const files = names.map((p) => ({ path: p, add: added[p] || 0, del: deleted[p] || 0, isNew: isNew.has(p), isDeleted: isGone.has(p) }));
  const diff = runGit(root, ['diff', '--cached'], 30000).out;
  return draftCommitMessage({ diff, files });
}

/** One git invocation with a result-shaped return (used by the pr flow). */
function step(root, argv, timeoutMs = 30000) {
  const r = runGit(root, argv, timeoutMs);
  return { ok: r.ok, out: r.out, err: r.err };
}

/**
 * Stage everything except .buddy (v0.36.0 drill fix). The old form —
 * `git add -A -- . ':(exclude).buddy'` — FAILS in any repo where .buddy is
 * actually gitignored: a pathspec that names an ignored path trips git's
 * ignored-paths advice and exits 1 ("The following paths are ignored …").
 * Plain `git add -A` respects .gitignore on its own; the unstage step covers
 * repos that DON'T ignore .buddy (their .buddy/ would otherwise be added —
 * sessions, worktrees and all). --ignore-unmatch keeps the cleanup a no-op
 * (exit 0) when .buddy was never staged.
 */
function stageAll(root) {
  const add = runGit(root, ['add', '-A']);
  if (!add.ok) return add;
  const rm = runGit(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.buddy']);
  return rm.ok ? add : rm;
}

const conflictNext = (kind, extra) =>
  `\n\nHow to land it:\n` +
  `  1. For each file above, edit the content (fs_read/fs_replace) — keep one side or combine both, REMOVE every marker line (<<<<<<<, =======, >>>>>>>).\n` +
  `  2. git_write {op:"stage", paths:[…]} for each resolved file.\n` +
  `  3. ${extra}\n` +
  `Or give up: git_write {op:"abort", kind:"${kind}"} returns the repo to the pre-${kind} state.`;

/** One op → model-friendly string. Never throws. */
export function gitWriteOp(root, op, a = {}) {
  if (!GIT_WRITE_OPS.includes(op)) {
    return `ERROR: unknown git_write op "${op}" — ops: ${GIT_WRITE_OPS.join(', ')}`;
  }
  if (!runGit(root, ['rev-parse', '--git-dir']).ok) {
    return `ERROR: ${root} is not a git repository — git_write works inside an existing repo (ask the user to git init, or run from the repo root)`;
  }
  const inProg = inProgress(root);

  switch (op) {
    case 'conflicts':
      return conflictReport(root);

    case 'stage': {
      const paths = pathsArg(a, 'paths');
      if (!paths) return 'ERROR: stage needs paths — a string, an array of paths, or ["."] for everything';
      const r = runGit(root, ['add', '--', ...paths]);
      if (!r.ok) return errHint(r, 'stage');
      const n = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean).length;
      return `OK stage — ${n} file(s) now staged.`;
    }

    case 'unstage': {
      const paths = pathsArg(a, 'paths') || ['.'];
      const r = runGit(root, ['restore', '--staged', '--', ...paths]);
      if (!r.ok) return errHint(r, 'unstage');
      return `OK unstage — ${paths.join(', ')} is/are out of the index (working-tree content untouched).`;
    }

    case 'commit': {
      // all:true sweeps the tree EXCEPT .buddy/ — Buddy's own runtime state
      // (audit, events, checkpoints, harness) never rides into the user's
      // history by accident. Committing it deliberately is still possible:
      // stage .buddy/... explicitly and commit without all.
      if (a.all) stageAll(root);
      const files = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
      if (!files.length) return 'ERROR: nothing to commit — stage changes first (op:"stage") or pass all:true. The working tree being dirty is not enough; git commits the INDEX.';
      // v0.36.0: the message may be drafted from the staged diff. An explicit
      // message ALWAYS wins; generate:true (or a missing message) drafts one.
      let msg = String(a.message ?? '').trim();
      let body = String(a.body ?? '').trim();
      let drafted = null;
      if (!msg) {
        drafted = draftMsg(root);
        if (!drafted) return 'ERROR: nothing to draft from — the staged diff is empty; pass a message or stage changes first';
        msg = drafted.title;
        body = drafted.body;
      }
      if (msg.length > 200) return 'ERROR: commit message over 200 chars — keep the summary line short, put detail in body';
      body = withTrailer(body, process.env); // Co-Authored-By (env-configurable)
      const argv = ['commit', '-m', msg];
      if (body) argv.push('-m', body);
      const r = runGit(root, argv);
      if (!r.ok) return errHint(r, 'commit');
      const head = runGit(root, ['log', '-1', '--format=%h %s']).out.trim();
      const stat = shortstat(root);
      return `OK commit ${head}${stat ? ` — ${stat}` : ''}${drafted ? '\ndrafted from the staged diff — edit with git commit --amend if you can say it better' : ''}${/Co-Authored-By:/i.test(body) ? `\ntrailer: ${body.split('\n').find((l) => /^Co-Authored-By:/i.test(l)).trim()}` : ''}\nfiles: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` … +${files.length - 12} more` : ''}`;
    }

    case 'branch': {
      const name = String(a.name ?? '').trim();
      if (!validBranchName(name)) return `ERROR: invalid branch name "${String(a.name ?? '').slice(0, 40)}" — no spaces, .., ~^:?*[, must not start with - or /`;
      const argv = a.checkout === false ? ['branch', name] : ['checkout', '-b', name];
      if (a.from) argv.push(String(a.from));
      const r = runGit(root, argv);
      if (!r.ok) return errHint(r, 'branch');
      return `OK branch "${name}" created${a.checkout === false ? '' : ' — you are now on it'}.`;
    }

    case 'checkout': {
      const ref = String(a.ref ?? '').trim();
      if (!ref) return 'ERROR: checkout needs a ref (branch, tag, or commit sha)';
      const r = runGit(root, ['checkout', ref]);
      if (!r.ok) return errHint(r, 'checkout');
      const now = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      return `OK checkout — now on ${now}.${inProg ? `\nNOTE: a ${inProg} is still in progress.` : ''}`;
    }

    case 'merge': {
      const branch = String(a.branch ?? '').trim();
      if (!branch) return 'ERROR: merge needs a branch (or ref) to merge INTO the current one';
      if (inProg === 'merge') return 'ERROR: a merge is already in progress — resolve it (op:"conflicts" shows the state) or op:"abort" first';
      const r = runGit(root, ['merge', '--no-edit', branch]);
      if (r.ok) {
        const stat = shortstat(root);
        return `OK merge ${branch}${stat ? ` — ${stat}` : ''}\n${truncate(r.out.trim(), 600)}`;
      }
      const { files } = conflictFiles(root);
      if (files.length) {
        return `CONFLICT: merge of "${branch}" stopped — ${files.length} conflicted file(s).\n\n${conflictReport(root)}${conflictNext('merge', 'git_write {op:"commit", message:"…"} — git completes the merge with your message.')}`;
      }
      return errHint(r, 'merge');
    }

    case 'rebase': {
      const upstream = String(a.upstream ?? '').trim();
      if (!upstream) return 'ERROR: rebase needs an upstream (the branch/commit to replay the current branch ONTO)';
      if (inProg) return `ERROR: a ${inProg} is already in progress — finish it (op:"conflicts") or op:"abort" first`;
      const r = runGit(root, ['rebase', upstream]);
      if (r.ok) {
        const n = runGit(root, ['log', '--oneline', '-n3']).out.trim();
        return `OK rebase onto ${upstream} — history rewritten.\n${n}`;
      }
      const { files } = conflictFiles(root);
      if (files.length) {
        return `CONFLICT: rebase onto "${upstream}" stopped — ${files.length} conflicted file(s).\n\n${conflictReport(root)}${conflictNext('rebase', 'git_write {op:"rebase_continue"} — replays the rest of your commits.')}`;
      }
      return errHint(r, 'rebase');
    }

    case 'rebase_continue': {
      if (inProg !== 'rebase') return inProg ? `ERROR: not in a rebase — a ${inProg} is in progress (use op:"abort", kind:"${inProg}")` : 'ERROR: no rebase in progress — nothing to continue';
      const r = runGit(root, ['rebase', '--continue']);
      const { files } = conflictFiles(root);
      if (files.length) {
        return `CONFLICT: rebase stopped again on the next commit — ${files.length} conflicted file(s).\n\n${conflictReport(root)}${conflictNext('rebase', 'git_write {op:"rebase_continue"}.')}`;
      }
      if (!r.ok) return errHint(r, 'rebase_continue');
      const n = runGit(root, ['log', '--oneline', '-n3']).out.trim();
      return `OK rebase continue — replay finished.\n${n}`;
    }

    case 'abort': {
      const kind = a.kind && ['merge', 'rebase'].includes(String(a.kind)) ? String(a.kind) : inProg;
      if (!kind) return 'ERROR: nothing to abort — no merge or rebase is in progress (pass kind:"merge"|"rebase" only if you know better than the repo)';
      const r = runGit(root, [kind, '--abort']);
      if (!r.ok) return errHint(r, 'abort');
      return `OK ${kind} aborted — the working tree is back to the pre-${kind} state (your own uncommitted edits from before it started are still there).`;
    }

    case 'stash': {
      const dirty = runGit(root, ['status', '--porcelain']).out.trim();
      if (!dirty) return 'ERROR: nothing to stash — the working tree is clean';
      const argv = ['stash', 'push'];
      if (a.message) argv.push('-m', String(a.message).slice(0, 100));
      const r = runGit(root, argv);
      if (!r.ok) return errHint(r, 'stash');
      const subject = runGit(root, ['stash', 'list', '-n1']).out.trim();
      return `OK stash — working tree clean now.\n${subject}`;
    }

    case 'unstash': {
      const index = Math.max(Number(a.index) || 0, 0);
      const r = runGit(root, ['stash', 'pop', `stash@{${index}}`]);
      const { files } = conflictFiles(root);
      if (files.length) {
        // NOTE: a stash-pop conflict sets NO merge state — there is nothing to
        // abort. The stash entry is kept until the conflict is resolved away.
        return `CONFLICT: the unstash collided with current work — ${files.length} conflicted file(s). The stash was KEPT (pop only drops it on a clean apply).\n\n${conflictReport(root)}\n\nHow to land it: edit each file (keep one side or combine), REMOVE the marker lines, op:"stage" the resolved files, then op:"commit". If you wanted the stash gone instead, resolve and then drop it from the user's terminal (git stash drop) — Buddy never discards stash entries silently.`;
      }
      if (!r.ok) return errHint(r, 'unstash');
      return `OK unstash — stash@{${index}} applied and dropped.`;
    }

    case 'restore': {
      const paths = pathsArg(a, 'paths');
      if (!paths) return 'ERROR: restore needs paths (string or array) — it DISCARDS uncommitted changes to them, so be explicit; "." discards everything tracked';
      const r = runGit(root, ['checkout', '--', ...paths]);
      if (!r.ok) return errHint(r, 'restore');
      return `OK restore — uncommitted changes to ${paths.join(', ')} are gone (last committed content is back).`;
    }

    case 'tag': {
      const name = String(a.name ?? '').trim();
      if (!validBranchName(name)) return `ERROR: invalid tag name "${String(a.name ?? '').slice(0, 40)}"`;
      const argv = a.message ? ['tag', '-a', name, '-m', String(a.message).slice(0, 500)] : ['tag', name];
      if (a.ref) argv.push(String(a.ref));
      const r = runGit(root, argv);
      if (!r.ok) return errHint(r, 'tag');
      return `OK tag "${name}"${a.message ? ' (annotated)' : ''} at ${a.ref ? String(a.ref) : 'HEAD'}.`;
    }

    case 'push': {
      // v0.36.0 — the boundary moved when the gh tool put remote writes
      // behind approval gates: push gets the same treatment. Preview shows
      // remote/branch/ahead; force is refused unless force_with_lease is
      // asked for EXPLICITLY (and it still goes through the same gate).
      const remote = String(a.remote || 'origin');
      const cur = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      const branch = String(a.branch || cur || '').trim();
      if (!branch || branch === 'HEAD') return 'ERROR: push needs a branch (detached HEAD — pass {"branch": "..."})';
      const remotes = runGit(root, ['remote']).out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!remotes.includes(remote)) {
        return `ERROR: no remote "${remote}" — git remote -v lists what exists (${remotes.length ? `found: ${remotes.join(', ')}` : 'no remotes configured'})`;
      }
      const r = runGit(root, a.force_with_lease ? ['push', '--force-with-lease', remote, branch, '--follow-tags'] : ['push', '-u', remote, branch, '--follow-tags']);
      if (!r.ok) {
        const hint = /rejected|fetch first|non-fast-forward/i.test(r.err + r.out)
          ? ' — the remote moved ahead: pull/rebase first (your terminal: git pull --rebase), or pass force_with_lease:true to overwrite it deliberately (the gate will warn again)'
          : '';
        return `ERROR: push failed${hint}\n${truncate((r.err || r.out).trim(), 400)}`;
      }
      const url = runGit(root, ['remote', 'get-url', remote]).out.trim();
      return `OK push — ${branch} → ${remote}${/up-to-date|Everything up-to-date/i.test(r.out) ? ' (was already up to date)' : ' (upstream set)'}\nremote: ${truncate(url, 100)}`;
    }

    case 'pr': {
      // v0.36.0 — the PR creation flow: branch → stage → commit (drafted
      // message + trailer) → push -u → the gh pr_create handoff. One gate
      // previews the WHOLE plan before anything runs; every step's git
      // output is captured and the flow stops at the first failure.
      const log = [];
      const cur = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
      const branch = String(a.branch || '').trim() || cur;
      const base = String(a.base || '').trim() || 'main';
      if (branch === base) return `ERROR: head and base are both "${branch}" — a PR needs a differently named branch (pass {"branch": "..."})`;

      // 1. branch (skip when already on it)
      if (branch !== cur) {
        const exists = runGit(root, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
        const r = exists ? step(root, ['checkout', branch]) : step(root, ['checkout', '-b', branch, ...(a.base && a.base !== cur ? [a.base] : [])]);
        log.push(`branch: ${r.ok ? `${cur} → ${branch}${exists ? ' (existing)' : ' (new, from ' + (a.base || cur) + ')'}` : 'FAILED'}`);
        if (!r.ok) return `ERROR: pr flow stopped at branch — ${truncate(r.err || r.out, 200)}\n${log.join('\n')}`;
      } else {
        log.push(`branch: already on ${branch}`);
      }

      // 2. stage (all:true semantics — same .buddy exclusion as commit)
      const stagedBefore = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
      const dirty = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean);
      if (a.all !== false && dirty.length) {
        const r = stageAll(root);
        log.push(`stage: ${r.ok ? `${dirty.length} changed file(s)` : 'FAILED'}`);
        if (!r.ok) return `ERROR: pr flow stopped at stage — ${truncate(r.err || r.out, 200)}\n${log.join('\n')}`;
      } else {
        log.push(`stage: ${stagedBefore.length ? 'using what is staged' : 'nothing dirty, nothing staged'}`);
      }

      // 3. commit (generate unless an explicit message came in). v0.36.0
      // drill fix: when nothing is left to stage, the branch state decides —
      // commits already on the branch (ahead of base) skip the commit step
      // (pushing IS the PR); a branch EVEN with base would open an empty PR,
      // which is refused with that explanation, not a vague stage error.
      const staged = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
      let msg = String(a.message ?? '').trim();
      let body = String(a.body ?? '').trim();
      let drafted = null;
      if (!staged.length && !msg) {
        const ahead = runGit(root, ['rev-list', '--count', `${base}..HEAD`]).out.trim();
        if (ahead !== '0') {
          log.push(`commit: skipped — the branch already has ${ahead} new commit(s) vs ${base} (pushing is the PR)`);
        } else {
          return `ERROR: pr flow stopped at commit — the branch is even with ${base} (no new commits, nothing to stage): opening this PR would be an empty diff. Do the work on ${branch} first — or leave it uncommitted and run the flow so it can stage + commit for you.\n${log.join('\n')}`;
        }
      } else {
        if (!msg) {
          drafted = draftMsg(root);
          if (!drafted) return `ERROR: pr flow stopped at commit — nothing staged to commit or draft from\n${log.join('\n')}`;
          msg = drafted.title;
          body = drafted.body;
        }
        body = withTrailer(body, process.env);
        const cr = step(root, ['commit', '-m', msg.slice(0, 200), ...(body ? ['-m', body.slice(0, 2000)] : [])]);
        const head = cr.ok ? runGit(root, ['log', '-1', '--format=%h %s']).out.trim() : 'FAILED';
        log.push(`commit: ${head}${drafted ? ' (drafted)' : ''}`);
        if (!cr.ok) return `ERROR: pr flow stopped at commit — ${truncate(cr.err || cr.out, 200)}\n${log.join('\n')}`;
      }

      // 4. push -u
      const pr = step(root, ['push', '-u', String(a.remote || 'origin'), branch], 60000);
      log.push(`push: ${pr.ok ? `${branch} → ${a.remote || 'origin'}` : 'FAILED'}`);
      const pushNote = pr.ok ? '' : `\npush failed: ${truncate((pr.err || pr.out).trim(), 300)}\n(the branch + commit exist locally — push from your terminal, then create the PR)`;

      // 5. the gh handoff (best effort — the gh tool may not resolve here)
      let handoff = '';
      try {
        const g = resolveGh({ root });
        handoff = g.error
          ? `gh: ${g.error}`
          : `next: the gh tool → {"op":"pr_create","title":"${String(a.title || msg).replace(/"/g, "'").slice(0, 90)}","branch":"${branch}","base":"${base}"${a.body ? `,"body":"…"` : ''}}`;
      } catch {
        handoff = 'gh handoff unavailable';
      }
      log.push(handoff);
      return `OK pr flow${pushNote}\n${log.join('\n')}`;
    }

    default:
      return `ERROR: unhandled op "${op}"`;
  }
}

/** Registry-ready tool def. Same contract as buildGitTool. */
export function buildGitWriteTool({ root = process.cwd(), maxCalls = 8 } = {}) {
  return {
    name: 'git_write',
    description:
      'GATED git writes: stage, unstage, commit (generate:true drafts a conventional message from the staged diff + Co-Authored-By), branch, checkout, merge, rebase (+continue), abort, stash, unstash, restore (discard!), tag, conflicts (read-only report), push (plain, never force), pr (branch → stage → commit → push → the gh pr_create handoff). Every mutating op asks the user first with a preview of exactly what happens; merge/rebase conflicts come back as ours/base/theirs hunks — edit the files, stage, then commit (merge) or rebase_continue.',
    args:
      '{"op":"commit","generate":true,"all":true}  ·  {"op":"pr","branch":"fix/x","base":"main"}  ·  {"op":"push"}  ·  {"op":"stage","paths":["src/app.js"]}  ·  {"op":"conflicts"}',
    maxCalls,
    riskyWhen: (a) => !READ_OPS.has(String(a?.op || '')),
    render: (a) => `git_write ${a?.op || '?'}${firstTarget(a) ? ` ${firstTarget(a)}` : ''}`,
    preview: (a) => {
      try {
        return previewFor(root, String(a?.op || ''), a || {});
      } catch {
        return null; // a broken preview must never block the gate
      }
    },
    run: async (a = {}) => gitWriteOp(root, String(a?.op || ''), a),
  };
}
