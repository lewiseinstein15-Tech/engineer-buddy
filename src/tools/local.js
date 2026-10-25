// local.js — Buddy Code's hands: filesystem + shell tools scoped to cwd.
//
// Policy layering (Harness² guardrail discipline):
//   hard block  — non-negotiable, never runs (destructive shell, secret reads)
//   soft gate   — risky tools (writes, bash) go through an approval callback
//   budget      — per-turn call caps live in agent/chat.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BuddyError, truncate } from '../util.js';
import { LocalRepo } from './repo.js';
import { isAgentDeniedPath } from '../harness/scaffold.js';
import { renderTextDiff, renderDiff, diffLines } from '../terminal/difflib.js';
import { snapshotPaths } from '../agent/checkpoints.js';

// ── Edit previews (shown before approval, Claude-Code style) ────────────────

function currentContent(scope, rel) {
  try {
    const r = scope.read(rel, 60000);
    return r?.content ?? '';
  } catch {
    return ''; // new file or unreadable — empty old side
  }
}

function previewWrite(scope, rel, content) {
  const before = currentContent(scope, rel);
  if (!before) {
    const lines = String(content ?? '').split('\n').slice(0, 10);
    const body = renderDiff(lines.map((s) => ({ t: '+', s })), { maxLines: 10 });
    return `${body}\n  │ ${lines.length > 10 ? '… (new file)' : '(new file)'}`.trimEnd();
  }
  return renderTextDiff(before, content, { maxLines: 16 });
}

function previewReplace(scope, rel, find, replace) {
  const before = currentContent(scope, rel);
  if (!before || !before.includes(String(find))) return null; // preview pointless — run() will error
  return renderTextDiff(String(find), String(replace ?? ''), { maxLines: 16 });
}

function previewAppend(content) {
  return renderDiff(diffLines('', String(content ?? '')), { maxLines: 10 });
}

// ── Bash policy ──────────────────────────────────────────────────────────────

/** Hard-blocked shell shapes. Returns a reason string, or null when allowed. */
export function blockedBashReason(cmd) {
  if (typeof cmd !== 'string') return 'command must be a string';
  const c = cmd.trim().replace(/\s+/g, ' ');
  if (!c) return 'empty command';
  if (c.length > 500) return 'command too long (>500 chars)';
  // Operators and substitution — one simple command only.
  if (/[|;&`$()<>]/.test(c)) return 'pipes, redirects, chains, and command substitution are not allowed — run one simple command (output and stderr are captured automatically — no 2>&1 or | head needed)';
  // Destructive / privileged.
  if (/(^|\s)(sudo|doas|su)(\s|$)/.test(c)) return 'privilege escalation is not allowed';
  if (/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/.test(c)) return 'rm -r / rm -f is not allowed — ask the user to remove directories';
  if (/\b(mkfs|shutdown|reboot|halt|poweroff|fdisk|dd)\b/.test(c)) return 'destructive system command is not allowed';
  if (/\b(curl|wget|nc|netcat|ssh|scp|ftp|telnet)\b/.test(c)) return 'network commands are not allowed in bash — fetch content through the user instead';
  if (/\b(chmod|chown|ln|mount|umount)\b/.test(c)) return 'permission/link/mount changes are not allowed';
  if (/\beval\b|\bexec\b/.test(c)) return 'eval/exec is not allowed';
  if (/\bgit\s+(push|reset|rebase|merge|clean|filter-branch|checkout\s+--\s+\.|amend)/.test(c)) return 'history- or remote-changing git is not allowed (only read-only git: status/diff/log/branch/show)';
  if (/\bgit\s+commit\b/.test(c)) return 'git commit is not allowed — the user commits; you only report what changed';
  if (/^:(\(\)\s*\{.*)?\|/.test(c)) return 'fork bomb pattern is not allowed';
  return null;
}

const GIT_READ_RE = /^git (status|diff|log|branch|show|remote|tag)( .*)?$/;

/** Run one allowlist-checked simple command. Never throws.
 * opts.signal — AbortSignal: kills the child and resolves with interrupted:true.
 * opts.trusted — skip the policy blocklist (ONLY for the user's own `!` shell
 * passthrough, where the human typed the command). */
export function runBash(cmd, { cwd = process.cwd(), timeoutMs = 180000, maxOutputChars = 8000, env = {}, signal = null, trusted = false } = {}) {
  return new Promise((resolve) => {
    const blocked = trusted ? null : blockedBashReason(cmd);
    if (blocked) {
      resolve({ ok: false, code: -1, stdout: '', stderr: `BLOCKED: ${blocked}`, durationMs: 0, timedOut: false, command: cmd, blocked: true });
      return;
    }
    const command = String(cmd).trim().replace(/\s+/g, ' ');
    const t0 = Date.now();
    let timedOut = false;
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        detached: process.platform !== 'win32', // own process group → we can kill sh AND its children
        env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8', NO_COLOR: '1', ...env },
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message, durationMs: 0, timedOut: false, command });
      return;
    }
    let out = '';
    let err = '';
    const cap = (s, chunk) => (s.length < maxOutputChars ? s + chunk : s);
    child.stdout.on('data', (d) => { out = cap(out, d.toString()); });
    child.stderr.on('data', (d) => { err = cap(err, d.toString()); });
    // Kill the WHOLE process group — `sh -c "sleep 5"` otherwise leaves sleep
    // running and the pipe open long after sh is dead.
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    // Abort support: a user Ctrl+C kills the running command immediately.
    const onAbort = () => killTree();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const killer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(killer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: !timedOut && code === 0, code, stdout: truncate(out, maxOutputChars), stderr: truncate(err, maxOutputChars), durationMs: Date.now() - t0, timedOut, interrupted: Boolean(signal?.aborted), command });
    };
    child.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, code: -1, stdout: truncate(out, maxOutputChars), stderr: e.message, durationMs: Date.now() - t0, timedOut, command }); });
    child.on('close', finish);
  });
}

// ── Local scope (cwd-rooted file ops) ────────────────────────────────────────

/** Segment-based secret detection: .env, .env.*, *.pem, *.key, *.p12, secrets.*, *credentials*. */
export function isSecretPath(rel) {
  return String(rel)
    .split('/')
    .some((seg) => /^(\.env(\..*)?)$|\.pem$|\.key$|\.p12$|^secrets\.|credentials/.test(seg));
}

export class LocalScope {
  constructor(root = process.cwd()) {
    this.repo = new LocalRepo(root);
    this.root = this.repo.root;
  }

  /** Reject protected/secret paths up front. */
  _guard(rel) {
    const p = String(rel || '');
    if (!p || p.startsWith('/') || p.includes('..')) throw new BuddyError(`unsafe path "${p}"`, { code: 'UNSAFE_PATH' });
    if (isSecretPath(p)) throw new BuddyError(`refusing to touch likely secrets: ${p}`, { code: 'SECRET_PATH' });
    if (isAgentDeniedPath(p)) throw new BuddyError(`path is protected by policy: ${p}`, { code: 'DENIED_PATH' });
    return p;
  }

  read(rel, maxChars = 30000) {
    this._guard(rel);
    const r = this.repo.readFile(rel, maxChars);
    if (!r) throw new BuddyError(`cannot read ${rel} (missing, binary, or too large)`, { code: 'NO_FILE' });
    return r;
  }

  list(dir = '', opts = {}) {
    this._guard(dir || '.');
    if (dir) {
      // A missing directory used to return "(empty)" — kilo lost a step to
      // that in the v0.9.6 live test (fs_list tools → (empty)). Errors now.
      let st = null;
      try {
        st = fs.statSync(this.repo.resolveSafe(dir));
      } catch {
        /* handled below */
      }
      if (!st || !st.isDirectory()) throw new BuddyError(`no such directory: ${dir}`, { code: 'NO_DIR' });
    }
    return this.repo.listFiles(dir, { max: 250, ...opts });
  }

  search(needle, opts = {}) {
    // NOTE: deliberately NO _guard here — the needle is TEXT to find inside
    // files, not a path. "/stats" and "../todo" are legitimate search strings
    // (kilo lost a research step to 'ERROR: unsafe path "/stats"' in the
    // v0.9.4 live test). Only sanity-check that there is something to find.
    const q = String(needle ?? '').trim();
    if (!q) throw new BuddyError('search: needle required', { code: 'BAD_NEEDLE' });
    return this.repo.search(q, { max: 15, ...opts });
  }

  /** Snapshot a file into .buddy/checkpoints BEFORE the agent mutates it.
   *  Best effort — a checkpoint failure must never block the write. */
  _snap(rel, tool) {
    try {
      snapshotPaths(this.root, [rel], { tool });
    } catch {
      /* best effort */
    }
  }

  /** Overwrite or create a file (agent-scoped, policy-checked). */
  write(rel, content) {
    this._guard(rel);
    const abs = this.repo.resolveSafe(rel);
    fs_mkdir(abs);
    const before = (() => { try { return require_read(abs); } catch { return ''; } })();
    this._snap(rel, 'fs_write');
    fs_write(abs, content);
    return { path: rel, op: before ? 'rewrite' : 'create', bytes: content.length };
  }

  /** Replace an exact unique snippet. */
  replace(rel, find, replace) {
    this._guard(rel);
    const abs = this.repo.resolveSafe(rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      throw new BuddyError(`replace: file not found: ${rel}`, { code: 'NO_FILE' });
    }
    const findStr = String(find);
    const count = content.split(findStr).length - 1;
    if (count === 0) throw new BuddyError(`replace: snippet not found in ${rel} — fs_read the file and retry`, { code: 'NO_MATCH' });
    if (count > 1) throw new BuddyError(`replace: snippet matches ${count} times in ${rel} — include more context to make it unique`, { code: 'AMBIGUOUS' });
    this._snap(rel, 'fs_replace');
    fs.writeFileSync(abs, content.replace(findStr, String(replace)), 'utf8');
    return { path: rel, op: 'replace' };
  }

  append(rel, content) {
    this._guard(rel);
    const abs = this.repo.resolveSafe(rel);
    fs_mkdir(abs);
    let before = '';
    try { before = require_read(abs); } catch { /* new */ }
    this._snap(rel, 'fs_append');
    fs.writeFileSync(abs, (before && !before.endsWith('\n') ? before + '\n' : before) + String(content), 'utf8');
    return { path: rel, op: before ? 'append' : 'create' };
  }
}

// tiny fs helpers kept inline to mirror LocalRepo style
function fs_mkdir(abs) { fs.mkdirSync(path.dirname(abs), { recursive: true }); }
function require_read(abs) { return fs.readFileSync(abs, 'utf8'); }
function fs_write(abs, content) { fs.writeFileSync(abs, String(content), 'utf8'); }

// ── Tool definitions for the chat loop ───────────────────────────────────────

function fmtResult(r) {
  if (r.ok) return `exit 0 (${(r.durationMs / 1000).toFixed(1)}s)\n${r.stdout || '(no stdout)'}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
  return `exit ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} in ${(r.durationMs / 1000).toFixed(1)}s\n${r.stdout ? `[stdout]\n${r.stdout}\n` : ''}${r.stderr ? `[stderr]\n${r.stderr}` : ''}`;
}

/**
 * Build the local tool set.
 * @returns tools with {name, description, args, run, risky?, render?}
 */
export function buildLocalTools({ scope, bashTimeoutMs = 180000, todoState = { latest: null } } = {}) {
  return [
    {
      name: 'todo',
      description:
        'Track a dependency-aware plan (todo v2). Call FIRST with the plan (all pending), then update statuses (in_progress / done) as you work. Items may declare "blocked_by" (ids that must be done first) — blocked items cannot start or finish until every blocker is done; the reply lists READY NOW items, start with those. Max 8 items, short texts. An empty items array clears the plan.',
      args: '{"items":[{"id":"1","text":"read the failing test","status":"in_progress"},{"id":"2","text":"patch it","status":"pending","blocked_by":["1"]}]}',
      render: (a) => `todo (${(a?.items || []).length} items)`,
      run: async ({ items } = {}) => {
        if (!Array.isArray(items)) return 'ERROR: items must be an array of {"id":..., "text":..., "status":"pending|in_progress|done", "blocked_by":["<id>"]}';
        if (!items.length) {
          todoState.latest = null;
          return 'PLAN cleared — send a new plan whenever you need one.';
        }
        const norm = items.slice(0, 8).map((it, i) => ({
          id: it?.id != null && String(it.id).trim() ? String(it.id).trim() : String(i + 1),
          text: String(it?.text ?? `item ${i + 1}`).slice(0, 120),
          status: ['pending', 'in_progress', 'done'].includes(it?.status) ? it.status : 'pending',
          blocked_by:
            it?.blocked_by == null
              ? []
              : (Array.isArray(it.blocked_by) ? it.blocked_by : [it.blocked_by]).map((s) => String(s).trim()).filter(Boolean),
          ...(it?.notes ? { notes: String(it.notes).slice(0, 80) } : {}),
        }));
        // ── DAG validation (todo v2) — a broken plan is refused, not stored.
        const ids = new Set(norm.map((it) => it.id));
        const dup = norm.find((it, i) => norm.findIndex((x) => x.id === it.id) !== i);
        if (dup) return `ERROR: duplicate item id "${dup.id}" — ids must be unique`;
        for (const it of norm) {
          if (it.blocked_by.includes(it.id)) return `ERROR: item "${it.id}" cannot block itself`;
          const unknown = it.blocked_by.filter((b) => !ids.has(b));
          if (unknown.length) return `ERROR: item "${it.id}" blocked_by unknown id ${unknown.map((u) => `"${u}"`).join(', ')} — valid ids: ${[...ids].join(', ')}`;
        }
        const violations = [];
        for (const it of norm) {
          if (it.status === 'pending' || !it.blocked_by.length) continue;
          const open = it.blocked_by.map((b) => norm.find((x) => x.id === b)).filter((x) => x && x.status !== 'done');
          if (open.length) violations.push(`"${it.id}" (${it.status}) is blocked by ${open.map((x) => `"${x.id}" (${x.status})`).join(', ')}`);
        }
        if (violations.length) {
          return `ERROR: blocked_by violated — a blocked item cannot start or finish until every blocker is done. ${violations.slice(0, 3).join('; ')}. Fix the statuses or the blocked_by lists.`;
        }
        todoState.latest = norm;
        const mark = (s) => (s === 'done' ? 'x' : s === 'in_progress' ? '~' : ' ');
        const lines = norm.map((it) => {
          let line = `- [${mark(it.status)}] #${it.id} ${it.text}`;
          if (it.blocked_by.length) line += ` (after #${it.blocked_by.join(', #')})`;
          if (it.notes) line += ` - ${it.notes}`;
          return line;
        });
        const ready = norm.filter((it) => it.status === 'pending' && it.blocked_by.every((b) => norm.find((x) => x.id === b)?.status === 'done'));
        const readyLine = ready.length && norm.some((it) => it.status !== 'pending')
          ? `\nREADY NOW: ${ready.map((it) => `#${it.id}`).join(', ')} — unblocked, start here.`
          : '';
        return `PLAN (${norm.filter((x) => x.status === 'done').length}/${norm.length} done):\n${lines.join('\n')}${readyLine}\nKeep statuses updated as you progress.`;
      },
    },
    {
      name: 'fs_list',
      description: 'List files in a directory of this repo.',
      args: '{"dir":"src"}',
      render: (a) => `fs_list ${a?.dir || '.'}`,
      run: async ({ dir = '' } = {}) => scope.list(dir).join('\n') || '(empty)',
    },
    {
      name: 'fs_read',
      description: 'Read a file (capped). Read before editing anything.',
      args: '{"path":"src/file.js"}',
      render: (a) => `fs_read ${a?.path}`,
      run: async ({ path: p }) => {
        const r = scope.read(p);
        return `FILE ${p}${r.truncated ? ' (truncated)' : ''}:\n${r.content}`;
      },
    },
    {
      name: 'fs_search',
      description: 'Search the repo (substring or regex). Cheapest way to locate code.',
      args: '{"needle":"pattern","regex":false}',
      render: (a) => `fs_search ${JSON.stringify(a?.needle ?? '')}`,
      run: async ({ needle, regex = false } = {}) => {
        const hits = scope.search(String(needle), { regex: Boolean(regex) });
        return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') || '(no matches)';
      },
    },
    {
      name: 'fs_write',
      description: 'Create or fully rewrite a file. Prefer fs_replace for existing files.',
      args: '{"path":"src/file.js","content":"full new file content"}',
      risky: true,
      render: (a) => `fs_write ${a?.path}`,
      preview: (a) => previewWrite(scope, a?.path, a?.content),
      run: async ({ path: p, content }) => {
        if (typeof content !== 'string' || !content.trim()) return 'ERROR: content required';
        const r = scope.write(p, content);
        return `OK ${r.op} ${r.path} (${r.bytes} bytes)`;
      },
    },
    {
      name: 'fs_replace',
      description: 'Replace an exact unique snippet in a file.',
      args: '{"path":"src/file.js","find":"exact existing snippet","replace":"new snippet"}',
      risky: true,
      render: (a) => `fs_replace ${a?.path}`,
      preview: (a) => previewReplace(scope, a?.path, a?.find, a?.replace),
      run: async ({ path: p, find, replace }) => {
        if (typeof find !== 'string' || !find) return 'ERROR: find required';
        const r = scope.replace(p, find, String(replace ?? ''));
        return `OK replaced snippet in ${r.path}`;
      },
    },
    {
      name: 'fs_append',
      description: 'Append lines to the end of a file.',
      args: '{"path":"notes.md","content":"text"}',
      risky: true,
      render: (a) => `fs_append ${a?.path}`,
      preview: (a) => previewAppend(a?.content),
      run: async ({ path: p, content }) => {
        if (typeof content !== 'string' || !content.trim()) return 'ERROR: content required';
        const r = scope.append(p, content);
        return `OK ${r.op} ${r.path}`;
      },
    },
    {
      name: 'bash',
      description:
        'Run ONE simple command (no pipes/redirects/chains/sudo/network/git-write). Use for tests, builds, version checks, read-only git (status/diff/log/branch/show).',
      args: '{"command":"npm test"}',
      risky: true,
      render: (a) => `bash ${a?.command}`,
      run: async ({ command }, ctx = {}) => fmtResult(await runBash(command, { cwd: scope.root, timeoutMs: bashTimeoutMs, signal: ctx.signal })),
    },
  ];
}
