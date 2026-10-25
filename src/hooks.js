// hooks.js — the deterministic guarantee layer (Claude Code parity).
//
// Harness² policy layering has three tiers: the hard block (never runs),
// the approval gate (human decides), and now HOOKS — user-defined shell
// commands at lifecycle points that make rules ENFORCEABLE by machine:
//   .buddy/settings.json →
//     { "hooks": {
//         "PreToolUse":  { "matcher": "bash", "command": "node check.js" },
//         "PostToolUse": [{ "matcher": "fs_write", "command": "node audit.js" }],
//         "pre_edit":    "node enforce-style.js"        // alias
//     }}
// Protocol: the hook command receives ONE JSON event on stdin:
//   { "event": "PreToolUse", "tool": "bash", "args": {...}, ...context }
// Exit codes: 0 = allow · 2 = BLOCK (stderr is fed back to the model —
// PreToolUse stops the tool; UserPromptSubmit refuses the prompt) ·
// any other exit = non-blocking error (logged, never crashes the loop).
// A 10s timeout kills runaway hooks. Aliases: pre_edit, post_edit,
// pre_command, post_command, on_error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { debugLog, truncate } from './util.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'SessionEnd',
  'OnError', // Buddy extension: fires when a tool returns an ERROR observation
];

/** Friendly aliases → canonical events (with implicit matchers when absent). */
export const HOOK_ALIASES = {
  pre_edit: { event: 'PreToolUse', matcher: 'fs_write|fs_replace|fs_append|multi_edit' },
  post_edit: { event: 'PostToolUse', matcher: 'fs_write|fs_replace|fs_append|multi_edit' },
  pre_command: { event: 'PreToolUse', matcher: 'bash' },
  post_command: { event: 'PostToolUse', matcher: 'bash' },
  on_error: { event: 'OnError', matcher: '' },
};

export const SETTINGS_FILE = '.buddy/settings.json';
export const HOOK_TIMEOUT_MS = 10000;

/** Load + validate hook config from .buddy/settings.json. Never throws. */
export function loadHooks(root) {
  const hooks = new Map(); // event -> [{matcher: RegExp|null, matcherSrc, command}]
  const warnings = [];
  const file = path.join(root, SETTINGS_FILE);
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push(`settings unreadable: ${e.message}`);
  }
  const cfgHooks = cfg?.hooks;
  if (cfgHooks === undefined) return { hooks, warnings, file };
  if (typeof cfgHooks !== 'object' || Array.isArray(cfgHooks) || cfgHooks === null) {
    warnings.push('hooks must be an object of event → command | [{matcher, command}]');
    return { hooks, warnings, file };
  }
  for (const [rawName, entries] of Object.entries(cfgHooks)) {
    const alias = HOOK_ALIASES[rawName];
    const name = alias ? alias.event : rawName;
    if (!HOOK_EVENTS.includes(name)) {
      warnings.push(`unknown hook event "${rawName}" (events: ${HOOK_EVENTS.join(', ')}; aliases: ${Object.keys(HOOK_ALIASES).join(', ')})`);
      continue;
    }
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      const command = typeof entry === 'string' ? entry : entry?.command;
      if (!command || typeof command !== 'string') {
        warnings.push(`hook "${rawName}" entry without a "command" — skipped`);
        continue;
      }
      const matcherSrc =
        typeof entry === 'object' && entry?.matcher != null && String(entry.matcher) !== ''
          ? String(entry.matcher)
          : alias?.matcher || '';
      let re = null;
      if (matcherSrc) {
        try {
          re = new RegExp(`^(?:${matcherSrc})$`);
        } catch {
          warnings.push(`hook "${rawName}" matcher "${matcherSrc}" is not a valid regex — skipped`);
          continue;
        }
      }
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push({ matcher: re, matcherSrc, command });
    }
  }
  return { hooks, warnings, file };
}

/** Run one hook command with the event JSON on stdin. Never throws. */
function runHookCmd(command, payload, { cwd, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(String(command), {
        shell: true,
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8', NO_COLOR: '1' },
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    const cap = (s, chunk) => (s.length < 8000 ? s + chunk : s);
    child.stdout.on('data', (d) => { out = cap(out, d.toString()); });
    child.stderr.on('data', (d) => { err = cap(err, d.toString()); });
    let done = false;
    const killer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ code: -1, stdout: out, stderr: `hook timed out after ${Math.round(timeoutMs / 1000)}s`, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve({ code: -1, stdout: out, stderr: e.message, timedOut: false });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout: out, stderr: err, timedOut: false });
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      /* hook ignores stdin — fine */
    }
  });
}

/** Match a hook entry against a tool name (matchers only exist for tool events). */
function hookApplies(h, event, tool) {
  if (!h.matcher) return true;
  if (!['PreToolUse', 'PostToolUse', 'OnError'].includes(event)) return true;
  return h.matcher.test(String(tool || ''));
}

/**
 * Runs configured hooks at lifecycle points. One instance per session;
 * never throws — a broken hook must never take the agent down.
 */
export class HookRunner {
  constructor({ root, loaded = null } = {}) {
    this.root = root;
    const l = loaded || loadHooks(root);
    this.hooks = l.hooks;
    this.warnings = l.warnings;
    this.file = l.file;
  }

  get size() {
    let n = 0;
    for (const v of this.hooks.values()) n += v.length;
    return n;
  }

  /** Flat [{event, matcher, command}] for /hooks. */
  list() {
    return [...this.hooks.entries()].flatMap(([event, hs]) =>
      hs.map((h) => ({ event, matcher: h.matcherSrc, command: h.command }))
    );
  }

  /**
   * Run every hook bound to `event` (in config order). First exit-2 wins:
   * { blocked: true, stderr, hook }. Other exits never block.
   */
  async run(event, payload = {}) {
    const hooks = this.hooks.get(event);
    if (!hooks?.length) return { blocked: false };
    for (const h of hooks) {
      if (!hookApplies(h, event, payload.tool)) continue;
      const r = await runHookCmd(h.command, { event, ...payload }, { cwd: this.root });
      if (r.code === 2) {
        debugLog(`hook ${event} (${h.command}) blocked: ${truncate(r.stderr || r.stdout, 160)}`);
        return {
          blocked: true,
          stderr: (r.stderr || r.stdout || 'blocked by hook').trim().slice(0, 500),
          hook: h.command,
        };
      }
      if (r.code !== 0) {
        debugLog(`hook ${event} (${h.command}) exited ${r.code} (non-blocking): ${truncate(r.stderr, 200)}`);
      }
    }
    return { blocked: false };
  }

  /** Fire without awaiting the result (SessionStart, Stop, OnError…). */
  fireAndForget(event, payload = {}) {
    this.run(event, payload).catch(() => {});
  }
}
