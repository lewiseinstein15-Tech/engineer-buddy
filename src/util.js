// util.js — shared primitives. Zero dependencies by design.
import os from 'node:os';

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

/**
 * Cross-platform HOME fallback for spawned children (v0.57.0 windows
 * hardening). The historic `HOME: process.env.HOME || '/tmp'` wrote a POSIX
 * path into a Windows child's environment — there is no /tmp there and the
 * value is a lie. Priority: HOME (POSIX always; Git Bash sessions set it) →
 * USERPROFILE (the native Windows home) → os.tmpdir() (always exists in both
 * worlds). Injectable env/tmp for tests; never throws, never returns a
 * non-string, never returns an empty string.
 */
export function homeFallback(env = process.env, { tmp } = {}) {
  const own = (o, k) => {
    try {
      return o != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    } catch {
      return undefined; // hostile object (throwing trap) → treated as absent
    }
  };
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : null);
  try {
    // OWN-KEY reads only (the house rule): a polluted Object.prototype.HOME
    // can never win — inherited junk is not this child's environment.
    return pick(own(env, 'HOME')) || pick(own(env, 'USERPROFILE')) || pick(tmp) || os.tmpdir();
  } catch {
    return os.tmpdir(); // hostile env object (throwing Proxy etc.) → the safe answer
  }
}

/**
 * The ONE base env for every spawn site: PATH verbatim, HOME via
 * homeFallback (Windows-correct), UTF-8 locale, colors off. Callers spread
 * their extras ON TOP (caller env > base), the exact shape every tool family
 * already built by hand — six duplicated `HOME || '/tmp'` sites collapsed
 * into this definition (v0.57.0).
 */
export function baseSpawnEnv(env = process.env, opts = {}) {
  const home = homeFallback(env, opts); // defensive inside — never throws
  let p;
  try {
    p = env != null && Object.prototype.hasOwnProperty.call(env, 'PATH')
      ? env.PATH // verbatim passthrough; a hostile env degrades to "no PATH", never a crash
      : undefined;
  } catch {
    p = undefined;
  }
  return { PATH: p, HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1' };
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

// Terminal tools whose string payload is safe to rebuild blind: worst case is
// a slightly mangled message shown to the user — never a mangled file write.
// fs_write/edit-style tools are deliberately NOT recoverable this way.
const RECOVERABLE_TOOLS = new Set(['say', 'finish', 'exit_plan']);

/** Decode one sloppy JSON string body: copy existing escape pairs (\n, \",
 *  \\ …) verbatim, escape raw quotes, raw backslashes and control characters.
 *  Returns the decoded value or null — never throws. */
function decodeSloppyString(raw) {
  let body = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n !== undefined && '"\\/bfnrtu'.includes(n)) { body += c + n; i++; }
      else body += '\\\\'; // raw backslash — escape it, next char is handled normally
      continue;
    }
    if (c === '"') body += '\\"';
    else if (c === '\n') body += '\\n';
    else if (c === '\r') body += '\\r';
    else if (c === '\t') body += '\\t';
    else body += c;
  }
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return null;
  }
}

/**
 * Last-resort shape-aware recovery for replies whose string payload derailed
 * every string-aware scanner: raw quotes inside a string value (kilo's v0.9.5
 * live test: a say quoting `"/stats"`) or MIXED escaping in shell commands
 * (v0.29.1 drill lesson: a bash call that escaped `node -e \"` but later wrote
 * raw `join(" ")` — extractJson's balanced scan closes the string early, and
 * control-char escaping cannot realign it).
 *
 * Terminal tools (say/finish/exit_plan) rebuild their flat payload. bash
 * rebuilds args.command — a command is approval-gated and audited, unlike a
 * file write, and an aborted turn loses ALL the work, so a faithful rebuild
 * is the lesser risk. fs_write/edit-style tools are deliberately NOT
 * recoverable this way — a mangled file write is worse than a failed turn.
 * Returns the parsed object or null — never throws.
 */
export function recoverShapedReply(text) {
  const s = String(text ?? '');
  const tm = s.match(/"(?:tool|name)"\s*:\s*"([a-zA-Z_]+)"/);
  if (!tm) return null;
  const tool = tm[1];
  if (tool !== 'bash' && !RECOVERABLE_TOOLS.has(tool)) return null;
  const keyOrder =
    tool === 'exit_plan' ? ['plan', 'summary'] : tool === 'bash' ? ['command'] : ['message', 'summary', 'text'];
  const out = { tool };
  let gotPayload = false;
  for (const key of keyOrder) {
    const km = new RegExp(`"${key}"\\s*:`).exec(s);
    if (!km) continue;
    const open = s.indexOf('"', km.index + km[0].length);
    if (open === -1) continue;
    const close = s.lastIndexOf('"');
    if (close <= open) continue;
    // bash guard: the span must end at the JSON's structural tail. If there
    // is prose (or more JSON) after the last quote, the span is a guess —
    // refuse and let the protocol retry handle it.
    if (tool === 'bash' && !/^[\s,"}\]]*$/.test(s.slice(close + 1))) continue;
    let inner = s.slice(open + 1, close);
    // If another "key": follows inside the span (payload listed before other
    // keys), cut the content at the boundary quote.
    const nextKey = inner.match(/"\s*,\s*"(?:tool|args|name|message|summary|plan|text|result|command)"\s*:/);
    if (nextKey) inner = inner.slice(0, nextKey.index);
    // bash tail: a model that closed the shell quote with `\"}}` meant that
    // escaped pair as BOTH the payload's closing quote and the JSON closer.
    // The span cut leaves an odd trailing backslash + loses the quote —
    // rebalance: drop the stray escape and restore the closing quote. An
    // even run is a real escaped backslash and stays.
    if (tool === 'bash' && /\\+$/.test(inner)) {
      const run = /\\+$/.exec(inner)[0];
      if (run.length % 2 === 1) inner = inner.slice(0, -run.length) + '"';
    }
    const value = decodeSloppyString(inner);
    if (value === null) continue;
    out[key] = value;
    if (key !== 'summary') gotPayload = true;
  }
  if (!gotPayload) return null;
  if (tool === 'exit_plan') {
    if (!out.plan) out.plan = out.summary ?? '';
    if (!out.summary) out.summary = String(out.plan).split('\n')[0].trim().slice(0, 80) || 'plan';
  }
  if (tool === 'bash') {
    // Quote-parity rebalance: models that conflate the shell-closing quote
    // with the JSON closer (`... "done")"}}`) leave the command with an ODD
    // number of double quotes — the last one was spent as the JSON closer.
    // Restore it. An even count (or zero, e.g. plain `ls -la`) is intact.
    const q = (out.command.match(/"/g) || []).length;
    if (q % 2 === 1) out.command += '"';
    return { tool: 'bash', args: { command: out.command } };
  }
  return out;
}

/**
 * Repair the classic small-model JSON sneezes that extractJson cannot fix:
 * (1) literal newlines/tabs/CRs INSIDE string values (kilo's v0.9.3 live
 * test: a whole say-message with markdown headers and real newlines), and
 * (2) raw double quotes inside string values (kilo's v0.9.5 live test: a say
 * quoting `"/stats"` from search results — string-aware scanning derails, so
 * the shape-aware recoverShapedReply rebuilds the terminal payload instead).
 * Finds the first balanced {…} candidate (string-aware, like extractJson),
 * escapes control characters inside string regions, parses; on any failure
 * falls back to recoverShapedReply. Returns the parsed object or null —
 * never throws.
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
  if (end === -1) return recoverShapedReply(s);
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
    return recoverShapedReply(s);
  }
}

/**
 * Heuristic: does this reply look like a JSON tool call that was CUT OFF by
 * the output token limit (v0.63.0 live-test lesson: a 4.4KB fs_write payload
 * at the default 1500-token budget never closes its string, the relay reports
 * finish_reason "length" — and some relays don't even report that, so the
 * shape has to speak for itself)?
 *
 * String-aware scan from the first '{' (braces inside string literals do not
 * move the depth counter). Truncated means: the scan ran off the end of the
 * input while still inside a string or with open brackets, AND the head
 * carries a "tool" key (prose that merely contains a '{' is never diagnosed).
 * A balanced outer object is NOT truncation — if extractJson still failed on
 * one, it is a sloppy-JSON content problem and tryRepairJson's job.
 * Never throws.
 */
export function looksTruncatedJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return false;
  if (!s.slice(start, start + 400).includes('"tool"')) return false;
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
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth <= 0) return false; // the outer object closed — not truncation
    }
  }
  return inStr || esc || depth > 0;
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
