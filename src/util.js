// util.js — shared primitives. Zero dependencies by design.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BuddyError extends Error {
  constructor(message, { code = 'ERROR', cause = null, data = null } = {}) {
    super(message);
    this.name = 'BuddyError';
    this.code = code;
    this.cause = cause;
    this.data = data;
  }
}

/** Thrown by gateways when they are rate limited; carries retryAfterMs so the
 * router can park the gateway instead of hammering it. */
export class RateLimitError extends BuddyError {
  constructor(message, { retryAfterMs = 30000, gateway = 'unknown', cause = null } = {}) {
    super(message, { code: 'RATE_LIMITED', cause });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.gateway = gateway;
  }
}

let verbose = false;
export function setVerbose(v) {
  verbose = Boolean(v);
}
export function isVerbose() {
  return verbose;
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}
export const log = (...a) => console.error(`[buddy ${ts()}]`, ...a);
export const warn = (...a) => console.error(`[buddy ${ts()}] WARN`, ...a);
export const debugLog = (...a) => {
  if (verbose) console.error(`[buddy ${ts()}] DEBUG`, ...a);
};

export function truncate(s, n = 500) {
  if (typeof s !== 'string') return String(s);
  return s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n} chars]`;
}

/** Parse a bare integer safely; returns fallback when NaN. */
export function toInt(v, fallback = null) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Robust JSON extraction from LLM output.
 * Free models love wrapping JSON in markdown fences, prose, or trailing
 * commentary. This finds the first balanced JSON object/array and parses it.
 * Returns { ok, value, error } — never throws.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, value: null, error: 'empty input' };
  }
  let s = text.trim();

  // 1. Direct parse (fast path).
  try {
    return { ok: true, value: JSON.parse(s), error: null };
  } catch {
    /* continue */
  }

  // 2. Strip markdown fences: ```json ... ``` (also handles stray fences).
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    try {
      return { ok: true, value: JSON.parse(fence[1].trim()), error: null };
    } catch {
      s = fence[1].trim();
    }
  }

  // 3. Balanced scan from the first { or [ — tracks strings/escapes so braces
  //    inside string literals do not break the depth counter.
  const starts = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') starts.push(i);
  }
  for (const start of starts) {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          try {
            return { ok: true, value: JSON.parse(candidate), error: null };
          } catch {
            // Try single-quote repair only for tiny obvious fixes.
            const repaired = candidate
              .replace(/,\s*([}\]])/g, '$1') // trailing commas
              .replace(/'/g, '"');
            try {
              return { ok: true, value: JSON.parse(repaired), error: null };
            } catch {
              break; // this start is hopeless; try the next
            }
          }
        }
      }
    }
  }
  return { ok: false, value: null, error: 'no balanced JSON found' };
}

/**
 * Repair the classic small-model JSON sneeze that extractJson cannot fix:
 * literal newlines/tabs/CRs INSIDE string values (invalid JSON — kilo's
 * v0.9.3 live test emitted a whole say-message with markdown headers and
 * real newlines). Finds the first balanced {…} candidate (string-aware, like
 * extractJson), escapes control characters inside string regions, parses.
 * Returns the parsed object or null — never throws.
 */
export function tryRepairJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Find the candidate's closing brace with string/escape tracking, so
  // braces inside string literals do not end the scan early.
  let end = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = s.slice(start, end + 1);
  // Walk the candidate and escape raw control chars inside string regions.
  let out = '';
  inStr = false;
  esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) {
        esc = false;
        out += c;
        continue;
      }
      if (c === '\\') {
        esc = true;
        out += c;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  try {
    const v = JSON.parse(out);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** tiny glob matcher supporting ** * ? — enough for excludeFiles lists. */
export function globMatches(pattern, path) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001') // `**/` → zero or more dirs (incl. none)
    .replace(/\*\*/g, '\u0002') // bare `**` → anything
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${re}$`).test(path);
}

/** Minimal fetch-with-timeout using AbortController. */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function maskSecret(s) {
  if (!s || typeof s !== 'string') return s;
  const n = s.length;
  if (n <= 8) return '*'.repeat(n);
  return s.slice(0, 3) + '*'.repeat(Math.min(12, n - 6)) + s.slice(-3);
}
