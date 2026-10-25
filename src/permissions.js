// permissions.js — the rules engine (v0.19.0): policy instead of flat gates.
//
// Claude Code replaced yes/no prompts with RULES; this is Buddy's version.
// Settings live in `.buddy/settings.json` (project) and `~/.buddy/settings.json`
// (user) under `permissions`; user rules load first, project rules add on top
// (later rules win on conflict — deny always wins over allow regardless).
//
//   {
//     "permissions": {
//       "defaultMode": "ask",                  // ask | allow
//       "allow": ["Bash(git *)", "fs_write(docs/**)", "WebFetch(domain:github.com)"],
//       "deny":  ["Bash(rm *)", "fs_write(.env*)", "WebFetch(domain:evil.example)"]
//     }
//   }
//
// Rule grammar: `Tool(spec)` — spec is a shell-style glob against the tool's
// SUBJECT. Subjects: fs_* / multi_edit → the path argument; bash → the
// command line; WebFetch/WebSearch → `domain:<host>` or the URL; others →
// JSON of the args. A bare `Tool` (no parens) matches every call to it.
//
// Verdict order: DENY rules first (a deny is a deny even under yolo — the
// flat hard-block layer stays independent), then ALLOW rules, then
// defaultMode. Never throws: junk settings degrade to `{}` + warnings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RULE_RE = /^([A-Za-z_][\w$]*)(?:\((.*)\))?$/s;

/** Glob match with * and ** (segment-aware for paths). */
export function globMatch(pattern, subject) {
  const p = String(pattern ?? '');
  const s = String(subject ?? '');
  if (!p) return false;
  if (p === '*' || p === '**') return true;
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
  return new RegExp(`^${esc}$`, 'i').test(s);
}

/** The subject a rule evaluates against, per tool family. */
export function subjectFor(tool, args = {}) {
  switch (tool) {
    case 'fs_write':
    case 'fs_replace':
    case 'fs_append':
    case 'multi_edit':
    case 'fs_read':
    case 'fs_list':
    case 'fs_search':
    case 'glob':
      return String(args?.path ?? args?.dir ?? args?.pattern ?? '');
    case 'bash':
      return String(args?.command ?? '');
    case 'bash_bg':
      return String(args?.command ?? '');
    case 'WebFetch':
    case 'web_fetch':
      return String(args?.url ?? '');
    case 'WebSearch':
    case 'web_search':
      return String(args?.query ?? '');
    default:
      try { return JSON.stringify(args ?? {}); } catch { return ''; }
  }
}

/** Rule matching for one (tool, subject): a rule matches when the tool name
 *  matches (case-insensitive, `web_fetch` ≡ `WebFetch`) and the spec glob
 *  matches the subject. Domain specs match URL subjects by host suffix. */
/** Tool names normalize case AND underscores: web_fetch ≡ WebFetch ≡ WEB_FETCH. */
const normTool = (s) => String(s || '').toLowerCase().replace(/_/g, '');

function ruleMatches(rule, tool, args) {
  const m = RULE_RE.exec(String(rule ?? '').trim());
  if (!m) return false;
  const [, ruleTool, rawSpec] = m;
  const spec = (rawSpec ?? '').trim();
  if (normTool(ruleTool) !== normTool(tool)) return false;
  if (!spec) return true; // bare Tool — every call
  if (spec.startsWith('domain:')) {
    const want = spec.slice(7).toLowerCase();
    const url = subjectFor(tool, args);
    const host = (() => {
      try { return new URL(url).hostname.toLowerCase(); } catch { return String(url).toLowerCase(); }
    })();
    return host === want || host.endsWith(`.${want}`);
  }
  const subject = subjectFor(tool, args);
  return globMatch(spec, subject) || (tool.toLowerCase().startsWith('bash') && subject.startsWith(spec.replace(/\*+$/, '').trimEnd()) && spec.endsWith('*'));
}

/**
 * Load + merge settings. Order: user first, project second (project wins on
 * duplicate ALLOW rules; DENY wins globally regardless). Never throws.
 */
export function loadPermissions(root, { home = os.homedir() } = {}) {
  const warnings = [];
  const read = (file, source) => {
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const perms = parsed?.permissions;
      if (!perms || typeof perms !== 'object') return null;
      return {
        defaultMode: perms.defaultMode === 'allow' ? 'allow' : 'ask',
        allow: Array.isArray(perms.allow) ? perms.allow.map(String) : [],
        deny: Array.isArray(perms.deny) ? perms.deny.map(String) : [],
        additionalDirectories: Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories.map(String) : [],
      };
    } catch (e) {
      warnings.push(`${source} settings.json unreadable: ${e.message}`);
      return null;
    }
  };
  const user = read(path.join(home, '.buddy', 'settings.json'), 'user');
  const project = read(path.join(root, '.buddy', 'settings.json'), 'project');
  const merged = {
    defaultMode: project?.defaultMode ?? user?.defaultMode ?? 'ask',
    allow: [...(user?.allow || []), ...(project?.allow || [])],
    deny: [...(user?.deny || []), ...(project?.deny || [])],
    additionalDirectories: [...(user?.additionalDirectories || []), ...(project?.additionalDirectories || [])],
  };
  return { perms: merged, warnings };
}

/**
 * The one verdict that matters: 'deny' | 'allow' | 'ask'.
 * yolo flips remaining 'ask' to 'allow' — but never a deny.
 */
export function evaluatePermission(perms, tool, args, { yolo = false } = {}) {
  const p = perms || { allow: [], deny: [], defaultMode: 'ask' };
  for (const rule of p.deny || []) {
    if (ruleMatches(rule, tool, args)) return 'deny';
  }
  for (const rule of p.allow || []) {
    if (ruleMatches(rule, tool, args)) return 'allow';
  }
  return yolo ? 'allow' : 'ask';
}

/** Which rule (if any) decided — for /permissions test and audit rows. */
export function matchingRule(perms, tool, args, kind = 'deny') {
  for (const rule of perms?.[kind] || []) {
    if (ruleMatches(rule, tool, args)) return rule;
  }
  return null;
}

/** Append-only audit trail (.buddy/audit.jsonl). Best-effort by design. */
export function auditTrail(root, entry) {
  try {
    const dir = path.join(root, '.buddy');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* the audit trail must never break a turn */
  }
}
