// docs.js — /docs <lib> documentation lookup (v0.17.0), zero dependencies.
//
// devdocs.io hosts the official docs of ~400 libraries/frameworks. Fetch the
// library page, strip to text, and window around the query term. The catalog
// (docs.json) doubles as the "did you mean" list for unknown slugs. Cached
// per (lib, query) in a session-scoped Map.
import { htmlToText, decodeEntities } from './web.js';

const cache = new Map(); // key -> {text, url, at}

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'engineer-buddy' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** The devdocs catalog, normalized: [{slug, name, type}] — cached 1h. */
let catalog = null;
let catalogAt = 0;
export async function docsCatalog({ max = 500, fetchImpl = null } = {}) {
  if (catalog && Date.now() - catalogAt < 3600_000) return catalog;
  const url = 'https://devdocs.io/docs.json';
  const r = fetchImpl ? await fetchImpl(url) : await fetchText(url);
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.body);
    catalog = parsed
      .filter((d) => d && d.slug)
      .map((d) => ({ slug: String(d.slug), name: String(d.name || d.slug), type: String(d.type || '') }))
      .slice(0, max);
    catalogAt = Date.now();
    return catalog;
  } catch {
    return null;
  }
}

/** Window the text around the first query hit (±12 lines). */
function windowAround(text, query) {
  if (!query) return text;
  const lines = text.split('\n');
  const q = query.toLowerCase();
  const idx = lines.findIndex((l) => l.toLowerCase().includes(q));
  if (idx < 0) return text;
  const from = Math.max(0, idx - 12);
  return [...(from > 0 ? [`… (skipped ${from} lines)`] : []), ...lines.slice(from, from + 40)].join('\n');
}

/**
 * Fetch docs for a library slug, optionally windowed on a query term.
 * Returns {ok, text, url} | {ok:false, error, suggestions?}.
 */
export async function fetchDocs(lib, query = '', { maxChars = 3000, fetchImpl = null } = {}) {
  const slug = String(lib || '').trim().toLowerCase();
  if (!slug) return { ok: false, error: 'library name required — try /docs react hooks' };
  const key = `${slug}::${String(query).trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, text: hit.text, url: hit.url, cached: true };

  const url = `https://devdocs.io/${encodeURIComponent(slug)}/`;
  const r = fetchImpl ? await fetchImpl(url) : await fetchText(url);
  if (!r.ok) {
    if (r.status === 404) {
      const cat = await docsCatalog();
      const suggestions = cat ? cat.filter((d) => d.slug.includes(slug) || d.name.toLowerCase().includes(slug)).slice(0, 8).map((d) => d.slug) : [];
      return { ok: false, error: `devdocs.io has no "${slug}" page`, suggestions };
    }
    return { ok: false, error: `devdocs.io unreachable (${r.error || `HTTP ${r.status}`})` };
  }
  const text = htmlToText(r.body).slice(0, maxChars * 4);
  const windowed = windowAround(text, query).slice(0, maxChars);
  cache.set(key, { text: windowed, url });
  if (cache.size > 30) cache.delete(cache.keys().next().value); // FIFO cap
  return { ok: true, text: windowed, url };
}

export function clearDocsCache() {
  cache.clear();
}

/** Test hook: also forget the memoized catalog. */
export function resetDocsState() {
  cache.clear();
  catalog = null;
  catalogAt = 0;
}

// decodeEntities is re-exported for tests that check entity handling paths.
export { decodeEntities };
