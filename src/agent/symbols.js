// symbols.js — cross-file symbol index + def→ref graph (v0.16.0).
//
// The repo map (v0.12.1) shows module-level symbols but defers the def→ref
// graph to "the symbol index below". This is that index. Zero dependencies:
// regex defs at any indent (function/class/def/fn/func), relative-import
// resolution for the import graph, and word-boundary reference scanning.
//
// Powers four read-only tools:
//   symbol_search — fuzzy find a definition (exact → prefix → substring)
//   go_to_def     — jump to the definition (ambiguous names list candidates)
//   find_refs     — every word-boundary reference, def line tagged
//   impact        — "what breaks if I change this": importers + referrers
//
// Honest limits (stated in tool output where relevant): regex-based, not a
// compiler; references include comments; dynamic/duck-typed calls are found
// only when the name appears verbatim. Index is cached with a TTL like the
// repo map.
import fs from 'node:fs';
import path from 'node:path';
import { LocalRepo } from '../tools/repo.js';

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt',
]);

// Def patterns at ANY indent (the map only takes indent-0; navigation wants
// nested helpers too). `kind` tags the output.
const DEF_PATTERNS = {
  js: [
    { re: /(?:^|[^\w$])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /(?:^|[^\w$])(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  ],
  py: [
    { re: /(?:^|\s)(?:async\s+)?def\s+(\w+)/, kind: 'function' },
    { re: /(?:^|\s)class\s+(\w+)/, kind: 'class' },
  ],
  go: [{ re: /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' }],
  rs: [
    { re: /(?:^|\s)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /(?:^|\s)(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: 'type' },
  ],
};

const langOf = (rel) => {
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  return DEF_PATTERNS[ext] ? ext : null;
};

/** Definitions in one file: [{name, file, line, kind, sig}]. */
export function extractDefs(rel, content) {
  const lang = langOf(rel);
  if (!lang) return [];
  const out = [];
  const lines = String(content ?? '').split('\n').slice(0, 4000);
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of DEF_PATTERNS[lang]) {
      const m = re.exec(lines[i]);
      if (m) {
        out.push({ name: m[1], file: rel, line: i + 1, kind, sig: lines[i].trim().slice(0, 160) });
        break; // one def per line
      }
    }
  }
  return out;
}

const JS_SPEC_ENDINGS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];

/** Relative imports of one file resolved against the repo file set. */
export function extractImports(rel, content, fileSet) {
  const lang = langOf(rel);
  if (!lang) return [];
  const specs = [];
  const lines = String(content ?? '').split('\n').slice(0, 4000);
  for (const line of lines) {
    let m;
    if ((m = /(?:import|export)\s[^;'"]*['"]([^'"]+)['"]/.exec(line)) || (m = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line)) || (m = /(?:^|\s)from\s+([.\w][\w.]*)\s+import\s/.exec(line))) {
      specs.push(m[1]);
    }
  }
  const resolved = new Set();
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel.split(path.sep).join('/')), spec.split(path.sep).join('/')));
      for (const ending of JS_SPEC_ENDINGS) {
        const candidate = `${base}${ending}`;
        if (fileSet.has(candidate)) { resolved.add(candidate); break; }
      }
    } else if (lang === 'py' && spec.startsWith('.')) {
      // handled above — unreachable, kept for clarity
    } else if (lang === 'py') {
      // absolute python import → try the direct file/module path
      const candidate = `${spec.split('.')[0]}.py`;
      if (fileSet.has(candidate)) resolved.add(candidate);
    }
    // bare js specifiers (packages) can't be resolved zero-dep — ignored
  }
  return [...resolved];
}

/** Word-boundary references of `name` across the code files (line hits). */
export function findRefsIn(files, root, name, { maxHits = 60, maxFiles = 20 } = {}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { hits: [], files: 0, truncated: false };
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
  const hits = [];
  let truncated = false;
  let fileCount = 0;
  for (const rel of files) {
    if (hits.length >= maxHits || fileCount >= maxFiles) { truncated = true; break; }
    let content = '';
    try {
      const abs = path.resolve(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 400_000) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n').slice(0, 4000);
    let fileHit = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        fileHit = true;
        if (hits.length < maxHits) hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
        else truncated = true;
      }
    }
    if (fileHit) fileCount++;
  }
  return { hits, files: fileCount, truncated };
}

/**
 * Build the full index: defs + the import graph (who imports whom).
 * @param files optional explicit file list (tests); default LocalRepo walk.
 */
export function buildSymbolIndex(root, { files = null, maxFiles = 900 } = {}) {
  let list = files;
  if (!list) {
    try {
      const repo = new LocalRepo(root);
      list = repo.listFiles('', { max: maxFiles, maxDepth: 8 }).filter((f) => CODE_EXT.has(path.extname(f).slice(1).toLowerCase()));
    } catch {
      return { defs: [], importers: new Map(), imports: new Map(), files: 0 };
    }
  }
  const defs = [];
  const imports = new Map(); // file -> Set<resolved files it imports>
  for (const rel of list) {
    let content = '';
    try {
      const abs = path.resolve(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 400_000) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    defs.push(...extractDefs(rel, content));
    const imps = extractImports(rel, content, new Set(list));
    if (imps.length) imports.set(rel, new Set(imps));
  }
  const importers = new Map(); // file -> Set<files importing it>
  for (const [from, tos] of imports) {
    for (const to of tos) {
      if (!importers.has(to)) importers.set(to, new Set());
      importers.get(to).add(from);
    }
  }
  return { defs, imports, importers, files: list.length };
}

/** Cached provider (same TTL discipline as the repo map). */
export function createSymbolIndexProvider(root, { ttlMs = 60_000 } = {}) {
  let cache = null;
  let at = 0;
  const fn = () => {
    if (cache === null || Date.now() - at > ttlMs) {
      cache = buildSymbolIndex(root);
      at = Date.now();
    }
    return cache;
  };
  fn.refresh = () => { cache = null; at = 0; };
  return fn;
}

/** symbol_search ranking: exact name → prefix → substring; then by file. */
export function searchDefs(defs, needle, { limit = 20 } = {}) {
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return [];
  const rank = (d) => {
    const name = d.name.toLowerCase();
    if (name === n) return 0;
    if (name.startsWith(n)) return 1;
    if (name.includes(n)) return 2;
    return 9;
  };
  return defs
    .map((d) => ({ d, r: rank(d) }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || (a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0) || (a.d.file < b.d.file ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.d);
}

export function formatDef(d) {
  return `${d.file}:${d.line} [${d.kind}] ${d.name}${d.sig ? ` — ${d.sig}` : ''}`;
}
