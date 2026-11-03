// sessionsidx.js — Wave 5 session search (the serve-rebuild plan, t9).
// Index: .buddy/index/sessions.idx — JSONL, cursor-built, crash-safe,
// no LLM in the loop. One `file` entry per transcript plus a `head` line;
// the cursor is the per-entry byte `offset` of the last indexed newline,
// so a rebuild only reads what was appended since the last pass.
//
// Crash rules (the plan's non-negotiables):
//   - a torn tail line in a transcript is never indexed — the reader only
//     consumes up to the last newline and drops the fragment;
//   - a torn tail in the index itself is dropped on read;
//   - the index is replaced atomically (tmp + rename), never edited in place;
//   - a transcript that shrank or changed under us is reindexed from zero.
import fs from 'node:fs';
import path from 'node:path';
import { listSessions } from './session.js';

const INDEX_VERSION = 1;
const MAX_TERMS = 3000;   // per session — bounds the index, keeps queries O(tokens)
const MIN_WORD = 2;
const MAX_WORD = 32;
const MAX_FIELD = 500;    // per-event capture cap

// Function words match everything and would flatten the ranking.
const STOP = new Set(
  ('a an and are as at be but by for from has have he her his i if in into is it its ' +
    'me my not of on or our she so than that the their them then there these they this ' +
    'to was we were what when where which who will with you your do does did can could ' +
    'should would about after all also am any because been before being between both').split(' ')
);

export function indexPath(root) {
  return path.join(root, '.buddy', 'index', 'sessions.idx');
}

/** Lowercase word tokens, stopword-free, length-bounded. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= MIN_WORD && w.length <= MAX_WORD && !STOP.has(w));
}

/**
 * Read the transcript from byte `start`, returning ONLY complete lines
 * (up to and including the last '\n'). Anything after it — a torn tail
 * from a crash mid-append — is dropped and excluded from the returned
 * end offset, so the next pass re-reads it.
 */
function readCompleteLines(file, start) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (start >= size) return { chunk: '', end: size };
    const len = size - start;
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, start);
    const s = buf.toString('utf8', 0, got);
    const nl = s.lastIndexOf('\n');
    if (nl === -1) return { chunk: '', end: start }; // whole tail is one torn fragment
    const chunk = s.slice(0, nl + 1);
    return { chunk, end: start + Buffer.byteLength(chunk, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** What a transcript line contributes to the index: conversation text only.
 * Tool observations are the noise the compaction path summarizes — indexing
 * 10k file dumps would flood the term budget and evict the real words. */
function eventTerms(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'user' || event.type === 'say' || event.type === 'say_thinking') {
    return typeof event.text === 'string' ? event.text.slice(0, MAX_FIELD) : '';
  }
  return '';
}

function termsFromChunk(chunk) {
  const terms = new Set();
  let turns = 0;
  let firstUser = null;
  for (const line of chunk.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // one corrupt line must not kill the index (same rule as loadSession)
    }
    if (e.type === 'user' && typeof e.text === 'string' && e.text.trim()) {
      turns += 1;
      if (firstUser === null) firstUser = e.text.slice(0, MAX_FIELD);
    }
    for (const t of tokenize(eventTerms(e))) terms.add(t);
  }
  return { terms, turns, firstUser };
}

function mergeTerms(oldTerms, add) {
  const merged = new Set(oldTerms);
  for (const t of add) merged.add(t);
  // Over budget → keep the earliest (Set preserves insertion order). Stable:
  // a term already indexed is never evicted by later traffic.
  const arr = [...merged];
  return arr.length <= MAX_TERMS ? arr : arr.slice(0, MAX_TERMS);
}

/** Read the index file. A torn tail line (or any bad line) is dropped. */
export function readIndex(root) {
  const entries = new Map();
  let head = null;
  let dropped = 0;
  let raw;
  try {
    raw = fs.readFileSync(indexPath(root), 'utf8');
  } catch {
    return { entries, head, dropped: 0, exists: false };
  }
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  else if (lines.length) lines.pop(); // no trailing newline → the last line is torn; drop it
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    if (obj.kind === 'head') head = obj;
    else if (obj.kind === 'file' && obj.name) entries.set(obj.name, obj);
  }
  return { entries, head, dropped, exists: true };
}

function writeIndex(root, entries) {
  const file = indexPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ v: INDEX_VERSION, kind: 'head', built: new Date().toISOString(), entries: entries.size }),
    ...[...entries.values()].map((e) => JSON.stringify(e)),
    '', // trailing newline: the marker that nothing is torn
  ];
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, file); // atomic swap — a crash leaves the old index intact
}

/**
 * Cheap fingerprint of a transcript prefix (djb2 over the first n bytes).
 * The window is the size at BUILD time (capped at 512): under the
 * append-only contract the first prev.size bytes never change, so the
 * same window must hash the same after an append. A rewrite that alters
 * the opening bytes breaks the match and forces a full reindex instead
 * of a corrupt incremental pass.
 */
function headHash(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    let h = 5381;
    for (let i = 0; i < got; i += 1) h = ((h * 33) ^ buf[i]) >>> 0;
    return h;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const HEAD_WINDOW = 512;

function entryHead(file, size) {
  return headHash(file, Math.min(HEAD_WINDOW, size)); // null on unreadable files — never blocks indexing
}

/**
 * Cursor-built incremental index pass. Returns {files, unchanged, changed,
 * fresh, bytes, tookMs}. Pass {rebuild:true} to ignore the cursor and
 * reindex every transcript from zero.
 */
export function buildIndex(root, { rebuild = false } = {}) {
  const t0 = Date.now();
  const files = listSessions(root);
  const old = rebuild ? new Map() : readIndex(root).entries;
  const entries = new Map();
  let unchanged = 0;
  let changed = 0;
  let fresh = 0;
  let bytes = 0;

  for (const file of files) {
    const name = path.basename(file);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue; // vanished mid-pass — it was never there
    }
    const mtime = Math.round(st.mtimeMs);
    const prev = old.get(name);

    if (prev && prev.size === st.size && prev.mtime === mtime && prev.offset <= st.size) {
      entries.set(name, prev); // nothing appended since the last pass
      unchanged += 1;
      continue;
    }

    let entry;
    if (
      prev &&
      st.size > prev.size &&
      prev.offset <= st.size &&
      prev.head !== undefined &&
      headHash(file, Math.min(HEAD_WINDOW, prev.size)) === prev.head // the prefix we indexed is intact
    ) {
      // incremental: read only the appended tail
      const { chunk, end } = readCompleteLines(file, prev.offset);
      const { terms, turns, firstUser } = termsFromChunk(chunk);
      entry = {
        v: INDEX_VERSION,
        kind: 'file',
        name,
        size: st.size,
        mtime,
        offset: end,
        head: prev.head,
        turns: (prev.turns || 0) + turns,
        first: prev.first || firstUser || '(empty)',
        terms: mergeTerms(prev.terms || [], terms),
        at: new Date().toISOString(),
      };
      bytes += end - prev.offset;
      changed += 1;
    } else {
      // new file, shrank, rewrote, or moved under us — reindex from zero
      const { chunk, end } = readCompleteLines(file, 0);
      const { terms, turns, firstUser } = termsFromChunk(chunk);
      entry = {
        v: INDEX_VERSION,
        kind: 'file',
        name,
        size: st.size,
        mtime,
        offset: end,
        head: entryHead(file, st.size),
        turns,
        first: firstUser || '(empty)',
        terms: mergeTerms([], terms),
        at: new Date().toISOString(),
      };
      bytes += end;
      fresh += 1;
    }
    entries.set(name, entry);
  }

  if (changed || fresh || rebuild || !readIndex(root).exists) writeIndex(root, entries);
  return { files: files.length, unchanged, changed, fresh, bytes, tookMs: Date.now() - t0 };
}

/** Full rebuild from zero (doctor path; the t9 drill's "rebuild works"). */
export function rebuildIndex(root) {
  return buildIndex(root, { rebuild: true });
}

/**
 * Search indexed sessions by terms. No LLM, no transcript reads — the
 * query runs a cheap cursor pass (stat-compare per file) and touches
 * only the index, so it stays fast on 10k-line histories.
 * Ranking: +3 per token hit in the first user task, +1 in the body.
 */
export function searchIndex(root, query) {
  const t0 = Date.now();
  const q = String(query ?? '').trim();
  if (!q) return { hits: [], tookMs: Date.now() - t0, tokens: [] };
  buildIndex(root); // refresh the cursor — unchanged files cost one stat each
  const { entries } = readIndex(root);
  const tokens = [...new Set(tokenize(q))];
  if (!tokens.length) return { hits: [], tookMs: Date.now() - t0, tokens: [] };

  const hits = [];
  for (const e of entries.values()) {
    const body = new Set(e.terms || []);
    const first = new Set(tokenize(e.first));
    let score = 0;
    const matched = [];
    for (const t of tokens) {
      const inFirst = first.has(t);
      const inBody = body.has(t);
      if (!inFirst && !inBody) continue;
      score += inFirst ? 3 : 1;
      matched.push(t);
    }
    if (score > 0) hits.push({ name: e.name, path: e.name, score, matched, first: e.first, turns: e.turns, mtime: e.mtime });
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return { hits, tookMs: Date.now() - t0, tokens };
}
