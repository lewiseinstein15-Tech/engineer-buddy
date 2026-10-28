// customcommands.js — Build 15 (P1): user-defined slash commands.
//
// A markdown file in .buddy/commands/<name>.md (project) or ~/.buddy/commands/
// (user) becomes /<name> — a reusable prompt template, Claude Code style.
// Frontmatter keys: description, argument-hint, allowed-tools (comma list).
// Placeholders: $ARGUMENTS (the whole tail), $1..$9 (positional). With no
// placeholder the argument tail is appended to the body.
//
// Zero-dep, lazy-loaded (the dispatcher rescans the two dirs on every
// custom lookup — a miss happens at most once per input line, so freshness
// beats a cache that can go stale).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truncate } from '../util.js';
import { enabledPlugins, pluginKindDirs } from '../plugins.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/i;

/** Parse `---\nkey: value\n---` frontmatter. Returns { meta, body }. */
export function parseFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return { meta: {}, body: s.trim() };
  const end = s.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: s.trim() };
  const head = s.slice(3, end).split('\n');
  const meta = {};
  for (const line of head) {
    const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: s.slice(end + 4).trim() };
}

function loadDir(dir, source = dir) {
  const out = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out; // no such dir — normal
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const allowedTools = String(meta['allowed-tools'] || meta.allowedtools || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.set(name, {
      name,
      description: String(meta.description || ''),
      argumentHint: String(meta['argument-hint'] || meta.argumenthint || ''),
      allowedTools,
      body,
      source,
    });
  }
  return out;
}

/**
 * Load custom commands from <root>/.buddy/commands + ~/.buddy/commands plus
 * every enabled plugin's commands/ dir (v0.39.0 §3). Project wins over
 * plugins, plugins win over user on a name clash; names colliding with
 * built-in slash commands are skipped with a reason (the built-in always
 * wins). Returns { commands: Map<name, cmd>, skipped: [{name, reason}] }.
 */
export function loadCustomCommands(root, { home = null, builtins = [] } = {}) {
  const skipped = [];
  const homeDir = home || os.homedir();
  const user = loadDir(path.join(homeDir, '.buddy', 'commands'));
  // Plugin layer between user and project — the user's own always wins.
  const { plugins } = enabledPlugins({ root, home: homeDir });
  const pluginMaps = pluginKindDirs(plugins, 'commands').map((d) => loadDir(d.dir, d.plugin));
  const project = loadDir(path.join(root, '.buddy', 'commands'));
  const merged = new Map([...user, ...pluginMaps.flatMap((m) => [...m]), ...project]); // later wins
  const builtinSet = new Set(builtins);
  const commands = new Map();
  for (const [name, cmd] of merged) {
    if (builtinSet.has(name)) {
      skipped.push({ name, reason: 'built-in command takes precedence' });
      continue;
    }
    commands.set(name, cmd);
  }
  return { commands, skipped };
}

/**
 * Expand a command template into the prompt Buddy runs.
 * $ARGUMENTS → the raw tail; $1..$9 → positional words (missing → '');
 * no placeholder at all → the tail is appended to the body.
 */
export function applyCustomCommand(cmd, argsString = '') {
  const args = String(argsString || '').trim();
  let body = String(cmd?.body || '');
  if (!/\$ARGUMENTS|\$[1-9]/.test(body)) {
    return args ? `${body}\n\n${args}`.trim() : body;
  }
  body = body.replace(/\$ARGUMENTS/g, args);
  const words = args.split(/\s+/).filter(Boolean);
  body = body.replace(/\$([1-9])/g, (_, n) => words[Number(n) - 1] || '');
  return body.trim();
}

/** Pure renderer for the /help "custom commands" section. */
export function renderCustomCommandHelp(commands) {
  const list = [...commands.values()];
  if (!list.length) return '';
  const rows = list.map((cmd) => {
    const hint = cmd.argumentHint ? ` <${cmd.argumentHint}>` : '';
    return `  ${cmd.name}${hint}`.padEnd(2 + Math.max(12, cmd.name.length + hint.length + 2)) + (cmd.description || truncate(cmd.body.replace(/\s+/g, ' '), 60));
  });
  return `\nCustom commands (.buddy/commands/*.md, project overrides user):\n${rows.join('\n')}\n`;
}
