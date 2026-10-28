// reporters.js — named API request presets (v0.26.0), the "custom reporters"
// from the checklist: one JSON file per reporter in `.buddy/reporters/`.
//
//   .buddy/reporters/ci.json
//   {
//     "description": "Latest CI runs for this repo",
//     "request": {
//       "method": "GET",
//       "url": "https://api.github.com/repos/owner/repo/actions/runs?per_page=5",
//       "headers": { "Accept": "application/vnd.github+json" },
//       "auth": { "type": "bearer", "env": "GITHUB_TOKEN" }
//     }
//   }
//
//   /report ci          → runs it, prints the response, attaches it to the
//                         next task (same pattern as /docs)
//
// A reporter is a saved ARGUMENTS preset for the http tool — nothing more,
// nothing less. Auth stays env-ref based (the file never contains secrets;
// a literal token/key/password field makes the reporter invalid). Junk files
// degrade to warnings — one broken reporter must not hide the others.
import fs from 'node:fs';
import path from 'node:path';
import { runHttpRequest, HTTP_METHODS } from './http.js';

const REPORTERS_DIR = '.buddy/reporters';
const MAX_REPORTERS = 20;

function sanitizeName(stem) {
  return String(stem || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Validate one reporter JSON object → { ok, reporter?, error? }. Pure. */
export function validateReporter(raw, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not a JSON object' };
  const req = raw.request;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, error: 'missing "request" object' };
  const url = String(req.url || '').trim();
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'request.url must be http(s)' };
  } catch {
    return { ok: false, error: 'request.url is not a valid absolute URL' };
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) return { ok: false, error: `request.method "${method}" is not allowed` };
  const auth = req.auth;
  if (auth != null) {
    if (typeof auth !== 'object' || Array.isArray(auth)) return { ok: false, error: 'request.auth must be an object' };
    if (auth.token != null || auth.password != null || auth.apiKey != null) {
      return { ok: false, error: 'secrets never live in reporter files — use {"type":"bearer","env":"MY_TOKEN"}' };
    }
    if (!['bearer', 'basic', 'header'].includes(String(auth.type || '').toLowerCase())) {
      return { ok: false, error: 'request.auth.type must be bearer | basic | header' };
    }
  }
  const name = sanitizeName(raw.name || fallbackName);
  if (!name) return { ok: false, error: 'reporter name is empty' };
  return {
    ok: true,
    reporter: {
      name,
      description: String(raw.description || '').slice(0, 120),
      request: { ...req, method, url },
    },
  };
}

/**
 * Load every reporter in <root>/.buddy/reporters/*.json, plus any extraDirs
 * (plugin reporters, v0.39.0 §3). Never throws. First definition of a name
 * wins (project dir is scanned first — plugins extend, never replace).
 * @returns {{ reporters: Array, warnings: string[] }}
 */
export function loadReporters(root, { dir = null, extraDirs = [] } = {}) {
  const warnings = [];
  const bases = [...(dir ? [dir] : [path.join(root, REPORTERS_DIR)]), ...extraDirs.map((d) => (typeof d === 'string' ? d : d?.dir)).filter(Boolean)];
  let files = [];
  for (const base of bases) {
    let found = [];
    try {
      found = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
    } catch {
      continue; // no reporters dir — normal
    }
    // sort WITHIN each base — the bases themselves stay in priority order
    // (project dir first, plugin dirs after), which the first-wins rule
    // below depends on. A global path sort would let ".buddy/plugins/…"
    // beat ".buddy/reporters/…" alphabetically.
    files.push(...found.map((f) => path.join(base, f)).sort());
  }
  const reporters = [];
  const seen = new Set();
  for (const f of files) {
    if (reporters.length >= MAX_REPORTERS) {
      warnings.push(`reporter cap (${MAX_REPORTERS}) reached — remaining files ignored`);
      break;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const v = validateReporter(raw, path.basename(f, '.json'));
      if (!v.ok) {
        warnings.push(`${f}: ${v.error}`);
        continue;
      }
      if (seen.has(v.reporter.name)) {
        warnings.push(`${f}: duplicate reporter name "${v.reporter.name}" — ignored`);
        continue;
      }
      seen.add(v.reporter.name);
      reporters.push(v.reporter);
    } catch (e) {
      warnings.push(`${f}: unreadable (${String(e?.message || e).slice(0, 80)})`);
    }
  }
  return { reporters, warnings };
}

/** Find one loaded reporter by name (exact → prefix). */
export function findReporter(reporters, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return reporters.find((r) => r.name === n) || reporters.find((r) => r.name.startsWith(n)) || null;
}

/** Run a loaded reporter through the same engine as the http tool. */
export async function runReporter(reporter, opts = {}) {
  return runHttpRequest(reporter.request, opts);
}
