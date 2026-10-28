// http.js — the HTTP client tool (v0.26.0; vault refs since v0.41.0): APIs beyond plain web_fetch.
//
// web_fetch reads PAGES (HTML → text, no method, no auth). Real integrations
// need more: POST/PUT/PATCH/DELETE, custom headers, JSON bodies, retries,
// and AUTH. The auth story is the part Buddy refuses to get wrong:
//
//   Secrets are passed as REFERENCES, never literals:
//     {"auth":{"type":"bearer","env":"GITHUB_TOKEN"}}      ← env var
//     {"auth":{"type":"bearer","ref":"pass:github/token"}}  ← vault (v0.41.0)
//   The value is resolved at call time (env lookup / `pass show` / `op read`)
//   and lands ONLY in the outgoing request header — never in args (so never
//   in the transcript, the audit trail, or the model's context). Passing
//   {"token":"ghp_…"} literally is refused with a pointer to the ref forms.
//
// Safety model (same discipline as web.js):
//   scheme allowlist  — http(s) only
//   SSRF guard        — localhost / private / link-local / metadata IPs blocked
//   read methods safe — GET/HEAD/OPTIONS run without the approval gate
//   mutations gated   — POST/PUT/PATCH/DELETE set riskyWhen → approval gate
//   capped + timed    — per-attempt timeout, response char cap
//   retries           — network errors / 5xx / 429 with capped backoff
//
// `fetchImpl` is injectable so tests run fully offline.
import { blockedHost } from './web.js';
import { resolveSecretRef } from './secret.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const AUTH_TYPES = new Set(['bearer', 'basic', 'header']);
/** Request headers that get echoed into the observation (response headers subset). */
const SHOW_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'retry-after', 'location', 'server', 'date'];

/** Auth headers from an ALREADY-RESOLVED secret value. Returns {headers} or
 *  {error}. NEVER puts the secret value into the returned error text. */
function authHeadersFor(type, value, customName) {
  if (type === 'bearer') return { headers: { authorization: `Bearer ${value}` } };
  if (type === 'header') {
    const name = String(customName || 'X-API-Key').trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { error: `auth.header name "${name.slice(0, 24)}" is not a valid header name` };
    return { headers: { [name.toLowerCase()]: value } };
  }
  // basic — value holds "user:password"
  const sep = value.indexOf(':');
  if (sep < 0) return { error: 'basic auth expects the value to contain "user:password"' };
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return { headers: { authorization: `Basic ${encoded}` } };
}

/** Validate the auth SHAPE (type + no literals). Returns {type, customName} or {error}. */
function validateAuthShape(auth) {
  const a = typeof auth === 'object' ? auth : {};
  const type = String(a.type || '').toLowerCase();
  if (!AUTH_TYPES.has(type)) {
    return { error: `auth.type must be one of bearer | basic | header (got "${String(a.type || '').slice(0, 24)}")` };
  }
  if (a.token != null || a.password != null || a.apiKey != null) {
    return { error: 'secrets are never passed in args — use {"type":"bearer","env":"MY_TOKEN"} or {"type":"bearer","ref":"pass:…"} so the value stays out of the transcript' };
  }
  return { type, customName: a.name, hasEnv: a.env != null, hasRef: a.ref != null };
}

/** Build auth headers from an env-ref spec. Returns { headers } or { error }.
 *  NEVER puts the secret value into the returned error text. */
export function resolveAuthHeaders(auth, env = process.env) {
  if (auth == null) return { headers: {} };
  const shape = validateAuthShape(auth);
  if (shape.error) return { error: shape.error };
  if (shape.hasRef) {
    return { error: 'vault refs resolve asynchronously — this resolver handles env auth only; runHttpRequest resolves refs automatically' };
  }
  const envName = String(auth?.env || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return { error: 'auth.env must name an environment variable (e.g. "GITHUB_TOKEN")' };
  const value = env?.[envName];
  if (typeof value !== 'string' || !value) return { error: `environment variable ${envName} is not set — export it, then retry (the secret itself never appears in this conversation)` };
  return authHeadersFor(shape.type, value, shape.customName);
}

/** Env OR vault ref. The ref (env:/pass:/op://) is resolved at call time;
 *  the value lives only inside the built header. */
export async function resolveAuthHeadersAsync(auth, env = process.env, resolveRef = resolveSecretRef) {
  if (auth == null) return { headers: {} };
  const shape = validateAuthShape(auth);
  if (shape.error) return { error: shape.error };
  if (shape.hasEnv && shape.hasRef) {
    return { error: 'use ONE of auth.env or auth.ref — not both' };
  }
  if (shape.hasRef) {
    const r = await resolveRef(String(auth.ref));
    if (r.error) return { error: r.error };
    return authHeadersFor(shape.type, r.value, shape.customName);
  }
  return resolveAuthHeaders(auth, env);
}

/** One HTTP attempt with timeout + outer-abort wiring. */
async function attempt(fetchImpl, url, init, timeoutMs, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { redirect: 'follow', signal: ac.signal, ...init });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one http tool call. Returns a formatted observation string (never throws).
 * @param {object} args  {method,url,headers,query,body,auth,retries,max_chars}
 * @param {object} opts  {fetchImpl,timeoutMs,env,signal}
 */
export async function runHttpRequest(args = {}, { fetchImpl = globalThis.fetch, timeoutMs = 15000, env = process.env, signal, resolveRef } = {}) {
  const method = String(args?.method || 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    return `ERROR: method "${method.slice(0, 12)}" not allowed — use one of ${[...HTTP_METHODS].join('/')}`;
  }
  let parsed;
  try {
    parsed = new URL(String(args?.url || '').trim());
  } catch {
    return 'ERROR: url must be a valid absolute http(s) URL';
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'ERROR: only http(s) URLs are allowed';
  if (blockedHost(parsed.hostname)) return 'ERROR: requests to local/internal addresses are blocked';

  // Query object → URL params (explicit params win over ones already in the URL).
  if (args?.query && typeof args.query === 'object' && !Array.isArray(args.query)) {
    for (const [k, v] of Object.entries(args.query).slice(0, 20)) {
      parsed.searchParams.set(String(k).slice(0, 64), String(v).slice(0, 512));
    }
  }

  const headers = {};
  if (args?.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [k, v] of Object.entries(args.headers).slice(0, 16)) {
      if (/^[A-Za-z0-9-]+$/.test(String(k))) headers[String(k).toLowerCase()] = String(v).slice(0, 1024);
    }
  }
  const auth = await resolveAuthHeadersAsync(args?.auth, env, resolveRef);
  if (auth.error) return `ERROR: ${auth.error}`;
  Object.assign(headers, auth.headers);

  // Body: object → JSON (content-type set unless the caller did), string → as-is.
  let body;
  if (args?.body != null && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (typeof args.body === 'object') {
      body = JSON.stringify(args.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else if (typeof args.body === 'string') {
      body = args.body.slice(0, 200_000);
      if (!headers['content-type']) headers['content-type'] = 'text/plain';
    }
  }

  const cap = clamp(Math.round(Number(args?.max_chars) || 6000), 300, 50000);
  const retries = clamp(Math.round(Number(args?.retries ?? 2)), 0, 4);
  const attempts = retries + 1;
  const started = Date.now();
  let lastErr = '';
  let lastStatus = 0;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(Math.min(300 * 2 ** (i - 1), 2000));
    try {
      const res = await attempt(fetchImpl, parsed.href, { method, headers, body }, timeoutMs, signal);
      const status = res.status;
      lastStatus = status;
      const ok = res.ok;
      const retryable = status === 429 || status >= 500;
      const ctype = String(res.headers?.get?.('content-type') || '');
      const shown = SHOW_RESPONSE_HEADERS.map((h) => res.headers?.get?.(h)).some(Boolean);
      const headLines = SHOW_RESPONSE_HEADERS.filter((h) => res.headers?.get?.(h)).map((h) => `${h}: ${res.headers.get(h)}`);
      let text = '';
      try {
        text = String(await res.text()).slice(0, 400_000);
      } catch {
        text = '';
      }
      let out = text;
      if (ctype.includes('json') || /^[\s]*[[{]/.test(text.slice(0, 40))) {
        try {
          out = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* keep raw text */
        }
      }
      const totalMs = Date.now() - started;
      const result =
        `HTTP ${status} ${method} ${parsed.href}` +
        ` (${(totalMs / 1000).toFixed(1)}s, attempt ${i + 1}${attempts > 1 ? `/${attempts}` : ''})` +
        `${ctype ? `\n${headLines.join('\n')}` : ''}` +
        `\n\n${out.length > cap ? `${out.slice(0, cap)}\n… (truncated — ${out.length} chars total; retry with a higher max_chars, up to 50000)` : out || '(empty body)'}`;
      if (!ok && retryable && i < attempts - 1) {
        lastErr = `HTTP ${status}`;
        continue;
      }
      const tail = !ok && retryable ? `\n\n(retries exhausted — ${attempts} attempt${attempts === 1 ? '' : 's'}, last HTTP ${status}; not retrying again)` : '';
      return result + tail;
    } catch (e) {
      if (e?.name === 'AbortError') {
        return signal?.aborted
          ? 'ERROR: http call aborted (the turn was interrupted)'
          : `ERROR: request timed out after ${timeoutMs / 1000}s per attempt — the host may be slow or unreachable`;
      }
      lastErr = String(e?.message || e).slice(0, 200);
      if (i >= attempts - 1) break;
    }
  }
  return lastStatus
    ? `ERROR: ${method} ${parsed.href} failed after ${attempts} attempt${attempts === 1 ? '' : 's'} — last status ${lastStatus}`
    : `ERROR: ${method} ${parsed.href} failed after ${attempts} attempt${attempts === 1 ? '' : 's'} — ${lastErr || 'network error'}`;
}

/**
 * Build the http tool. `reporters` (optional, from loadReporters) enrich the
 * description so the model knows which named presets exist.
 */
export function buildHttpTool({ fetchImpl = globalThis.fetch, timeoutMs = 15000, env = process.env, reporters = [] } = {}) {
  const reporterNames = (Array.isArray(reporters) ? reporters : []).map((r) => r.name).filter(Boolean);
  return {
    name: 'http',
    get description() {
      const rep = reporterNames.length
        ? ` Named API reporters configured for this project: ${reporterNames.join(', ')} (the user can run them with /report <name>; you can also send the same request yourself).`
        : '';
      return `HTTP client for APIs: any method, custom headers, JSON bodies, auth via references (bearer/basic/header with env:"MY_TOKEN" or ref:"pass:…"/"op://…" — the secret never appears in args or transcripts), retries on 5xx/429. Mutating methods (POST/PUT/PATCH/DELETE) require user approval.${rep}`;
    },
    args: '{"method":"GET","url":"https://api.github.com/repos/owner/repo/issues?per_page=5","headers":{"Accept":"application/vnd.github+json"},"auth":{"type":"bearer","env":"GITHUB_TOKEN"},"body":null,"retries":2,"max_chars":6000} — vault refs: {"auth":{"type":"bearer","ref":"pass:github/token"}}',
    riskyWhen: (a) => !SAFE_METHODS.has(String(a?.method || 'GET').toUpperCase()),
    render: (a) => `http ${String(a?.method || 'GET').toUpperCase()} ${a?.url || ''}`,
    run: async (args, ctx = {}) => runHttpRequest(args, { fetchImpl, timeoutMs, env, signal: ctx.signal }),
  };
}
