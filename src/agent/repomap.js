// repomap.js — an aider-style repo map, zero dependencies (P1).
//
// Small free models burn 2-4 research steps on fs_list/fs_read just to learn
// what the repo LOOKS like. A compact map — file paths with their top-level
// symbols, ranked by git churn — gives the same orientation in ~2k chars of
// system prompt. This is a HINT, not the tree: files keep moving and the map
// is allowed to be slightly stale within a turn (the tools are the truth).
//
// Ranking borrows aider's idea: files the repo touches most (git churn over
// the last ~300 commits) come first, so the map that survives the char cap is
// biased toward the code that actually changes. No git → alphabetical.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalRepo } from '../tools/repo.js';

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt',
]);

const SYMBOL_PATTERNS = {
  js: [
    // indent-0 only: module-level symbols. Nested helpers are noise for a map.
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/,
  ],
  py: [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/],
  rs: [
    /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  ],
};
const langOf = (rel) => {
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  return SYMBOL_PATTERNS[ext] ? ext : null;
};

/** Top-level symbol names of one file (deduped, order preserved). */
export function extractSymbols(rel, content) {
  const lang = langOf(rel);
  if (!lang) return [];
  const pats = SYMBOL_PATTERNS[lang];
  const out = [];
  for (const line of String(content ?? '').split('\n').slice(0, 4000)) {
    for (const re of pats) {
      const m = re.exec(line);
      if (m && !out.includes(m[1])) {
        out.push(m[1]);
        break;
      }
    }
  }
  return out;
}

/** Path → commit-count over the recent log (null when git is unavailable). */
export function gitChurnMap(root, { maxCommits = 300, timeoutMs = 5000 } = {}) {
  try {
    const r = spawnSync('git', ['log', `-${maxCommits}`, '--name-only', '--pretty=format:'], {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) return null;
    const counts = new Map();
    for (const line of r.stdout.split('\n')) {
      const f = line.trim();
      if (!f || !f.includes('.')) continue;
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    return counts.size ? counts : null;
  } catch {
    return null;
  }
}

/** Files ranked aider-style: churn desc, then alphabetical. */
export function rankFiles(files, churn) {
  const churnOf = (f) => (churn?.get(f) || 0);
  return [...files].sort((a, b) => churnOf(b) - churnOf(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the map text.
 * @param files optional file list (tests); default: the LocalRepo walk.
 * @param churn optional Map<path, commits> (tests); default: git log.
 */
export function buildRepoMap(root, { files = null, churn = undefined, maxChars = 2800, maxFiles = 150, symbolsPerFile = 8 } = {}) {
  let list = files;
  if (!list) {
    try {
      const repo = new LocalRepo(root);
      list = repo.listFiles('', { max: 800, maxDepth: 6 }).filter((f) => CODE_EXT.has(path.extname(f).slice(1).toLowerCase()));
    } catch {
      return { text: '', files: 0, symbols: 0, truncated: false };
    }
  }
  const churnMap = churn === undefined ? gitChurnMap(root) : churn;
  const ranked = rankFiles(list.filter((f) => CODE_EXT.has(path.extname(f).slice(1).toLowerCase())), churnMap).slice(0, maxFiles);
  const lines = [];
  let symbols = 0;
  let truncated = false;
  let used = 0;
  for (const rel of ranked) {
    let content = '';
    try {
      const abs = path.resolve(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 400_000) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const syms = extractSymbols(rel, content).slice(0, symbolsPerFile);
    if (!syms.length) continue;
    const line = `${rel}: ${syms.join(', ')}`;
    if (used + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    symbols += syms.length;
    used += line.length + 1;
  }
  if (!lines.length) return { text: '', files: 0, symbols: 0, truncated: false };
  const header = `Repo map — ${lines.length} files${churnMap ? ', ranked by git churn' : ''}${truncated ? ' (capped — the most-changed files come first)' : ''}. A hint, not the tree: use fs_list/fs_read/fs_search for the current truth.`;
  const text = [header, ...lines].join('\n');
  return { text, files: lines.length, symbols, truncated };
}

/** Cached provider for the system prompt: rescans at most once per TTL. */
export function createRepoMapProvider(root, { maxChars = 2800, ttlMs = 60_000 } = {}) {
  let cache = null;
  let at = 0;
  const fn = () => {
    if (cache === null || Date.now() - at > ttlMs) {
      cache = buildRepoMap(root, { maxChars });
      at = Date.now();
    }
    return cache.text;
  };
  fn.refresh = () => {
    cache = null;
    at = 0;
  };
  fn.info = () => (cache || buildRepoMap(root, { maxChars }));
  return fn;
}
