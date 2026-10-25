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

// ── Branch / fork / share / import (v0.21.0) ─────────────────────────────────

/** Escape a string for safe interpolation into HTML. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Self-contained single-file HTML transcript (zero-dep, /share): every event
 * of a session, inline CSS, no external resources — open it anywhere.
 */
export function exportHtml(file, { title = '', workspace = '' } = {}) {
  let events = [];
  try {
    events = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    /* unreadable → empty transcript */
  }
  const name = title || path.basename(file, '.jsonl');
  const rows = events
    .map((e) => {
      const at = e.at ? new Date(e.at).toLocaleTimeString() : '';
      if (e.type === 'user') return `<div class="row user"><span class="who">you</span><div class="bubble">${esc(e.text)}</div><span class="at">${at}</span></div>`;
      if (e.type === 'say') return `<div class="row buddy"><span class="who">buddy</span><div class="bubble">${esc(e.text)}</div><span class="at">${at}</span></div>`;
      if (e.type === 'tool') return `<div class="row tool"><span class="who">tool</span><div class="bubble"><code>${esc(e.tool)} ${esc(e.args?._preview || JSON.stringify(e.args || {}).slice(0, 160))}</code>${e.observation ? `<pre>${esc(String(e.observation).slice(0, 400))}</pre>` : ''}</div><span class="at">${at}</span></div>`;
      if (e.type === 'shell') return `<div class="row tool"><span class="who">shell</span><div class="bubble"><code>! ${esc(e.command)}</code></div><span class="at">${at}</span></div>`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px; background: #111612; color: #e6e6e6; }
  h1 { font-size: 18px; border-bottom: 1px solid #2a2f2a; padding-bottom: 8px; }
  .meta { color: #8a8f8a; font-size: 12px; margin-bottom: 20px; }
  .row { display: flex; gap: 10px; margin: 10px 0; align-items: flex-start; }
  .who { flex: 0 0 52px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8a8f8a; padding-top: 8px; }
  .user .who { color: #7fc97f; }
  .buddy .who { color: #79b8ff; }
  .bubble { flex: 1; background: #1b201b; border: 1px solid #2a2f2a; border-radius: 8px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .tool .bubble { opacity: .85; font-size: 13px; }
  .bubble pre { margin: 6px 0 0; font-size: 12px; color: #b8bdb8; max-height: 160px; overflow: hidden; }
  .bubble code { color: #d7ba7d; font-size: 12px; }
  .at { flex: 0 0 auto; font-size: 10px; color: #565b56; padding-top: 10px; }
</style></head>
<body>
<h1>${esc(name)}</h1>
<div class="meta">Engineer Buddy session · ${events.length} events${workspace ? ` · ${esc(workspace)}` : ''} · exported ${new Date().toISOString()}</div>
${rows || '<p class="meta">(empty session)</p>'}
</body></html>`;
}

/** /share — write the HTML export; returns the written path. */
export function writeHtmlExport(root, file, opts = {}) {
  const dir = path.join(root, EXPORTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(file, '.jsonl')}.html`);
  fs.writeFileSync(out, exportHtml(file, opts), 'utf8');
  return out;
}

/** /fork — copy a session file to a new name; returns the new path. */
export function forkSession(root, file, name = '') {
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const clean = String(name || '').trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = path.basename(file, '.jsonl');
  let target = path.join(dir, `${clean || `${base}-fork`}.jsonl`);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${clean || `${base}-fork`}-${n}.jsonl`);
    n += 1;
  }
  fs.copyFileSync(file, target);
  return target;
}

/** buddy import <file> — validate a session JSONL and copy it into .buddy/sessions/. */
export function importSession(root, srcPath) {
  const abs = path.resolve(String(srcPath || ''));
  // Identity check first: re-importing something already in sessions/ is a
  // caller mistake even when the file is empty (a fresh recorder writes '' ).
  const dir = sessionsDir(root);
  if (path.dirname(abs) === path.resolve(dir)) throw new Error('source is already in .buddy/sessions');
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${abs}: ${e.message}`);
  }
  const lines = raw.split('\n').filter(Boolean);
  let good = 0;
  for (const l of lines) {
    try { JSON.parse(l); good += 1; } catch { /* tolerate junk lines like loadSession */ }
  }
  if (!good) throw new Error('not a session file — no JSONL lines parsed');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(abs).endsWith('.jsonl') ? path.basename(abs) : `${path.basename(abs)}.jsonl`);
  if (path.resolve(target) === abs) throw new Error('source is already in .buddy/sessions');
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(dir, `${stamp}-${path.basename(target)}`), raw, 'utf8');
    return { target: path.join(dir, `${stamp}-${path.basename(target)}`), events: good, renamed: true };
  }
  fs.writeFileSync(target, raw, 'utf8');
  return { target, events: good, renamed: false };
}
