// web.js — Buddy's keyless window to the internet: web_fetch + web_search.
//
// Zero dependencies: Node >= 20 ships `fetch` (undici) built in.
// Search is keyless: DuckDuckGo's HTML endpoints (html. → lite. fallback),
// parsed with regex — no API key, no SDK, no npm packages.
//
// Safety model (matches the harness guardrail discipline):
//   scheme allowlist   — only http(s); file://, ftp://, data: rejected
//   SSRF guard         — localhost / private / link-local / metadata IPs blocked
//   read-only          — neither tool mutates anything, so no approval gate
//   capped + timed     — every fetch has a hard timeout and a char cap
//
// `fetchImpl` is injectable so tests run fully offline.

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©',
  reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', laquo: '«', raquo: '»',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£',
};

/** Decode HTML entities (named + numeric). Exported for tests. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Convert HTML to readable plain text (regex-based, no DOM). Exported for tests. */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  // Block-level boundaries become newlines.
  s = s.replace(/<\/(?:p|div|section|article|header|main|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl)>/gi, '\n');
  s = s.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:td|th)>/gi, ' ');
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\u00a0/g, ' ');
  // Tidy whitespace: never touch content inside code-ish blank lines.
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

/** True when a hostname must not be fetched (SSRF guard). Exported for tests.
 *  v0.42.0 fix (red team): WHATWG URL keeps BRACKETS in hostname for IPv6
 *  ("[fd00::1]") — strip them first or every private/link-local v6 range
 *  (fc00::/7, fe80::/10) slips through the prefix regexes below. */
export function blockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[+/, '').replace(/\]+$/, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
  const m = h.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) {
    const [a, b] = m[1].split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // cloud metadata endpoints
  }
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true; // IPv6 private/link-local
  return false;
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim());
}

/** Unwrap DuckDuckGo redirect links (//duckduckgo.com/l/?uddg=<enc>) to real URLs. */
function unwrapDdg(href) {
  let h = String(href || '').trim();
  if (!h) return '';
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      h = decodeURIComponent(m[1]);
    } catch {
      return '';
    }
  } else if (h.startsWith('//')) {
    h = `https:${h}`;
  }
  if (!/^https?:\/\//i.test(h)) return '';
  try {
    const u = new URL(h);
    if (blockedHost(u.hostname)) return '';
    return u.href;
  } catch {
    return '';
  }
}

/** Parse DuckDuckGo results (html endpoint + lite endpoint shapes). Exported for tests. */
export function parseDdgResults(html, { limit = 5 } = {}) {
  const anchors = [];
  const anchorRes = [
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    /<a[^>]*href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g,
  ];
  for (const re of anchorRes) {
    let m;
    while ((m = re.exec(String(html ?? ''))) !== null) anchors.push({ href: m[1], title: m[2] });
    if (anchors.length) break;
  }
  const snippets = [];
  const snippetRes = [
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,
    /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g,
  ];
  for (const re of snippetRes) {
    let m;
    while ((m = re.exec(String(html ?? ''))) !== null) snippets.push(stripTags(m[1]));
    if (snippets.length) break;
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < anchors.length && out.length < limit; i++) {
    const url = unwrapDdg(anchors[i].href);
    const title = stripTags(anchors[i].title);
    if (!url || !title) continue;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title, snippet: snippets[i] || '' });
  }
  return out;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Build the keyless web tools.
 * @param {object} opts
 * @param {function} [opts.fetchImpl]   fetch-compatible fn (defaults to globalThis.fetch)
 * @param {number}   [opts.timeoutMs]   per-request timeout (default 25000)
 * @param {number}   [opts.maxChars]    default content cap for web_fetch (default 12000)
 * @returns tools with {name, description, args, run, render}
 */
export function buildWebTools({ fetchImpl = globalThis.fetch, timeoutMs = 25000, maxChars = 12000 } = {}) {
  async function get(url, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onOuterAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      return await fetchImpl(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  return [
    {
      name: 'web_search',
      description:
        'Search the web (keyless, no API needed). Returns ranked title + URL + snippet results. Use it first to find the right documentation/blog URL, then read pages with web_fetch.',
      args: '{"query":"nodejs fs promises api docs","n":5}',
      render: (a) => `web_search ${JSON.stringify(a?.query ?? '')}`,
      run: async ({ query, n } = {}) => {
        const q = String(query || '').trim();
        if (!q) return 'ERROR: query required';
        if (q.length > 300) return 'ERROR: query too long (max 300 chars)';
        const want = clamp(Number(n) || 5, 1, 10);
        const endpoints = [
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
        ];
        let results = [];
        for (const ep of endpoints) {
          try {
            const res = await get(ep);
            if (!res.ok) continue;
            const html = String(await res.text()).slice(0, 500000);
            results = parseDdgResults(html, { limit: want });
            if (results.length) break;
          } catch {
            /* endpoint failed — try the next one */
          }
        }
        if (!results.length) {
          return `ERROR: no results for "${q}" — the keyless search endpoint may be rate-limiting right now. Try web_fetch directly on a known documentation URL instead.`;
        }
        return `SEARCH "${q}" — top ${results.length} results (keyless DuckDuckGo):\n${results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
          .join('\n')}`;
      },
    },
    {
      name: 'web_fetch',
      description:
        'Read a web page (docs, blog posts, raw text/JSON). Read-only. HTML is converted to plain text; content is capped — raise max_chars (up to 50000) if the page was truncated.',
      args: '{"url":"https://nodejs.org/api/fs.html","max_chars":12000}',
      render: (a) => `web_fetch ${a?.url || ''}`,
      run: async ({ url, max_chars } = {}, ctx = {}) => {
        const u = String(url || '').trim();
        let parsed;
        try {
          parsed = new URL(u);
        } catch {
          return 'ERROR: url must be a valid absolute http(s) URL';
        }
        if (!/^https?:$/.test(parsed.protocol)) return 'ERROR: only http(s) URLs are allowed';
        if (blockedHost(parsed.hostname)) return 'ERROR: requests to local/internal addresses are blocked';
        const cap = clamp(Math.round(Number(max_chars) || maxChars), 500, 50000);
        try {
          const res = await get(parsed.href, ctx.signal);
          const status = res.status;
          if (!res.ok) return `ERROR: HTTP ${status} for ${parsed.href}`;
          const ctype = String(res.headers?.get?.('content-type') || '');
          const raw = String(await res.text()).slice(0, 400000);
          const isHtml = ctype.includes('html') || /<\/(?:html|body|div|p|head)\b/i.test(raw.slice(0, 2000));
          const text = isHtml ? htmlToText(raw) : raw;
          const body =
            text.length > cap
              ? `${text.slice(0, cap)}\n… (truncated — ${text.length} chars total; call again with a higher max_chars, up to 50000)`
              : text;
          return `FETCHED ${parsed.href} (HTTP ${status}${ctype ? `, ${ctype.split(';')[0]}` : ''}):\n${body || '(empty page)'}`;
        } catch (e) {
          if (e?.name === 'AbortError') return `ERROR: fetch timed out after ${timeoutMs / 1000}s — the site may be slow or unreachable`;
          return `ERROR: fetch failed — ${e?.message || e}`;
        }
      },
    },
  ];
}
