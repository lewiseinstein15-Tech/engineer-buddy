// session.js — conversation persistence for Buddy Code.
// Transcripts live in .buddy/sessions/<ts>-<slug>.jsonl (one event per line).
// Exports (human-readable markdown) go to .buddy/exports/.
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR, EXPORTS_DIR } from './harness/defaults.js';

function slugify(s, max = 32) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'session';
}

function sessionsDir(root) {
  return path.join(root, SESSIONS_DIR);
}

/** Append-only JSONL transcript recorder. */
export class SessionRecorder {
  constructor(root, firstMessage) {
    this.dir = sessionsDir(root);
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.file = path.join(this.dir, `${stamp}-${slugify(firstMessage)}.jsonl`);
    fs.writeFileSync(this.file, '', 'utf8');
  }

  append(event) {
    try {
      fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
    } catch {
      /* never break a session over the transcript */
    }
  }

  get path() {
    return this.file;
  }
}

/** List saved sessions, newest first. */
export function listSessions(root) {
  const dir = sessionsDir(root);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Most recent session in this directory (buddy -c). */
export function latestSession(root) {
  return listSessions(root)[0] || null;
}

/** Find a session by exact name, name suffix, or substring (buddy -r). */
export function findSession(root, needle) {
  const all = listSessions(root);
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return null;
  const slug = n.replace(/\s+/g, '-');
  return (
    all.find((f) => path.basename(f).toLowerCase() === `${n}.jsonl`) ||
    all.find((f) => path.basename(f).toLowerCase().endsWith(`-${slug}.jsonl`)) ||
    all.find((f) => path.basename(f).toLowerCase().includes(slug)) ||
    null
  );
}

/** Rename a session file (buddy /rename). Returns the new path. */
export function renameSession(root, file, name) {
  const clean = String(name || '').trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!clean) throw new Error('name can only contain letters, digits, - and _');
  const dir = sessionsDir(root);
  let target = path.join(dir, `${clean}.jsonl`);
  if (path.resolve(target) !== path.resolve(file) && fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    target = path.join(dir, `${stamp}-${clean}.jsonl`); // conflict → keep both
  }
  fs.renameSync(file, target);
  return target;
}

/** Load a session file into a compact handoff transcript. */
export function loadSession(file) {
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // one corrupt line must not kill the whole session
      }
    })
    .filter(Boolean);
  // Rebuild a light conversation: user turns + buddy replies (tool noise is
  // summarized by the compaction path, not replayed verbatim).
  const pairs = [];
  let pendingUser = null;
  for (const e of events) {
    if (e.type === 'user') pendingUser = e.text;
    else if (e.type === 'say' && pendingUser !== null) {
      pairs.push({ user: pendingUser, buddy: e.text });
      pendingUser = null;
    }
  }
  return { file, pairs };
}

/** Rebuild resume messages for createChat's history. */
export function resumeMessages(session) {
  const out = [];
  for (const { user, buddy } of session.pairs) {
    out.push({ role: 'user', content: user });
    out.push({ role: 'assistant', content: JSON.stringify({ tool: 'say', message: buddy }) });
  }
  return out;
}

// ── Session introspection + markdown export (/sessions, /export) ───────────

/** Quick metadata for the session picker. */
export function sessionInfo(file) {
  const { pairs } = loadSession(file);
  let firstUser = '(empty)';
  try {
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const l of raw) {
      try {
        const e = JSON.parse(l);
        if (e.type === 'user' && e.text) {
          firstUser = e.text;
          break;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* unreadable */
  }
  let mtime = null;
  try {
    mtime = fs.statSync(file).mtime.toISOString();
  } catch {
    /* gone */
  }
  return { file, name: path.basename(file), firstUser, turns: pairs.length, mtime };
}

/** Render a saved JSONL transcript as readable markdown. */
export function exportMarkdown(file, { workspace = '' } = {}) {
  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const info = sessionInfo(file);
  const lines = [
    `# Buddy Code transcript — ${info.name}`,
    '',
    workspace ? `- workspace: \`${workspace}\`` : null,
    `- exported: ${new Date().toISOString()}`,
    `- turns: ${info.turns}`,
    '',
  ].filter((x) => x !== null);
  let turn = 0;
  let pendingUser = null;
  const toolTally = new Map();
  const flushTools = () => {
    if (!toolTally.size) return;
    const tally = [...toolTally.entries()].map(([t, n]) => `${t}${n > 1 ? `×${n}` : ''}`).join(', ');
    lines.push(``, `*(${[...toolTally.values()].reduce((a, b) => a + b, 0)} tool call${[...toolTally.values()].reduce((a, b) => a + b, 0) === 1 ? '' : 's'}: ${tally})*`);
    toolTally.clear();
  };
  for (const e of events) {
    if (e.type === 'user') {
      if (pendingUser !== null) flushTools();
      turn += 1;
      pendingUser = String(e.text ?? '');
      lines.push(``, `## Turn ${turn}`, '', `**You:** ${pendingUser}`, '');
    } else if (e.type === 'tool') {
      toolTally.set(e.tool, (toolTally.get(e.tool) || 0) + 1);
    } else if (e.type === 'say') {
      lines.push(`**Buddy:** ${String(e.text ?? '').replace(/\n/g, '  \n')}`, '');
      pendingUser = null;
      flushTools();
    }
  }
  flushTools();
  return lines.join('\n') + '\n';
}

/** Write a markdown export; returns the written path. */
export function writeExport(root, file, { workspace = '' } = {}) {
  const dir = path.join(root, EXPORTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(file, '.jsonl')}.md`);
  fs.writeFileSync(out, exportMarkdown(file, { workspace }), 'utf8');
  return out;
}
