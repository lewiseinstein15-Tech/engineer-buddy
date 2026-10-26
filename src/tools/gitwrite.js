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
// Ops (14): stage, unstage, commit, branch, checkout, merge, rebase,
//           rebase_continue, abort, stash, unstash, restore, tag, conflicts
// Not here ON PURPOSE: push/pull/fetch (credentials + remote state belong to
// the user's terminal or the bot path in git.js), clean/reset --hard (use
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
    case 'commit':
      if (a.all) {
        const n = runGit(root, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
        return n ? `${n} changed file(s) will be staged first (all:true)` : '(nothing to commit — working tree clean)';
      }
      return statOr(root, ['diff', '--cached', '--stat'], '(nothing staged yet — the commit will be refused)');
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
      if (a.all) runGit(root, ['add', '-A', '--', '.', ':(exclude).buddy']);
      const files = runGit(root, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
      if (!files.length) return 'ERROR: nothing to commit — stage changes first (op:"stage") or pass all:true. The working tree being dirty is not enough; git commits the INDEX.';
      const msg = String(a.message ?? '').trim();
      if (!msg) return 'ERROR: commit needs a message (one line — say what and why, not just "update")';
      if (msg.length > 200) return 'ERROR: commit message over 200 chars — keep the summary line short, put detail in body';
      const argv = ['commit', '-m', msg];
      if (a.body) argv.push('-m', String(a.body).slice(0, 2000));
      const r = runGit(root, argv);
      if (!r.ok) return errHint(r, 'commit');
      const head = runGit(root, ['log', '-1', '--format=%h %s']).out.trim();
      const stat = shortstat(root);
      return `OK commit ${head}${stat ? ` — ${stat}` : ''}\nfiles: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` … +${files.length - 12} more` : ''}`;
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

    default:
      return `ERROR: unhandled op "${op}"`;
  }
}

/** Registry-ready tool def. Same contract as buildGitTool. */
export function buildGitWriteTool({ root = process.cwd(), maxCalls = 8 } = {}) {
  return {
    name: 'git_write',
    description:
      'GATED git writes: stage, unstage, commit, branch, checkout, merge, rebase (+continue), abort, stash, unstash, restore (discard!), tag, conflicts (read-only report). Every mutating op asks the user first with a preview of exactly what happens; merge/rebase conflicts come back as ours/base/theirs hunks — edit the files, stage, then commit (merge) or rebase_continue. No push/pull here: remotes and credentials are the user\u2019s business.',
    args:
      '{"op":"commit","message":"fix: guard division by zero","all":true}  ·  {"op":"stage","paths":["src/app.js"]}  ·  {"op":"merge","branch":"feature/x"}  ·  {"op":"conflicts"}  ·  {"op":"abort","kind":"merge"}',
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
