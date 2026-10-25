// session.js — conversation persistence for Buddy Code.
// Transcripts live in .buddy/sessions/<ts>-<slug>.jsonl (one event per line).
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './harness/defaults.js';

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

/** Load a session file into a compact handoff transcript. */
export function loadSession(file) {
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
