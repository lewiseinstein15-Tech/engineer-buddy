// sse.js — zero-dependency stream readers for chat gateway streaming (v0.28.0).
//
// The checklist §7 "streaming thought process" needs gateways that hand the
// TUI tokens AS THEY ARRIVE instead of one buffered blob. Three wire shapes
// exist in the chain today:
//   1. OpenAI-style SSE  (kilo / llm7 / pollinations `/openai`) —
//      `data: {"choices":[{"delta":{"content":"…"}}]}` lines + a final chunk
//      carrying `usage` (when stream_options.include_usage is honored) and
//      `data: [DONE]`.
//   2. Duck.ai SSE — same envelope, content at `message.content`.
//   3. Ollama NDJSON — one JSON object per line, `message.content` deltas,
//      final line with done:true + prompt_eval_count/eval_count.
//
// All readers are abort-safe: a watchdog aborts the fetch when no bytes
// arrive for `idleMs` (a stalled relay must not hang a turn — the old
// buffered path only capped time-to-headers, the body read was unbounded),
// plus an optional hard total cap. Aborts surface as BuddyError(NETWORK) so
// the router's failover treats them like any other transport failure.

import { BuddyError } from '../util.js';
import { extractUsage } from './usage.js';
import { Readable } from 'node:stream';

/**
 * Fetch for streaming chats: same headers-phase timeout contract as
 * fetchWithTimeout, but the AbortController is returned so the body readers
 * below can own the idle/total watchdogs on the SAME signal (the buffered
 * path never had a body cap — a stalled relay could hang a turn forever).
 * @returns {Promise<{res: Response, aborter: AbortController}>}
 */
export async function fetchStreaming(url, init = {}, { timeoutMs = 60000 } = {}) {
  const aborter = new AbortController();
  const timer = setTimeout(
    () => aborter.abort(new Error(`no response headers within ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    const res = await fetch(url, { ...init, signal: aborter.signal });
    return { res, aborter };
  } finally {
    clearTimeout(timer);
  }
}

/** Body iteration that works on every fetch body shape we can meet. */
function bodyIterator(body) {
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body;
  return Readable.fromWeb(body);
}

/**
 * Yield decoded text chunks from a fetch Response body as they arrive.
 * @param {Response} res
 * @param {object} opts { idleMs=45000, totalMs=null, signal=null, aborter=null }
 *   aborter: AbortController whose .abort() the watchdog fires on stall.
 */
export async function* bodyChunks(res, { idleMs = 45000, totalMs = null, aborter = null } = {}) {
  if (!res.body) throw new BuddyError('gateway stream: response has no body', { code: 'NO_BODY' });
  const decoder = new TextDecoder();
  let idle = null;
  let total = null;
  const stop = () => {
    if (idle) clearTimeout(idle);
    if (total) clearTimeout(total);
    idle = total = null;
  };
  const stall = () => {
    stop();
    try {
      aborter?.abort(new Error(`stream stalled (no bytes for ${idleMs}ms)`));
    } catch { /* already aborted */ }
  };
  if (aborter) idle = setTimeout(stall, idleMs);
  if (totalMs) total = setTimeout(stall, totalMs);
  try {
    for await (const buf of bodyIterator(res.body)) {
      if (idle) { clearTimeout(idle); idle = setTimeout(stall, idleMs); }
      if (buf) yield decoder.decode(buf, { stream: true });
    }
    yield decoder.decode(); // flush any split multibyte tail
  } finally {
    stop();
  }
}

/**
 * Yield `data:` payload strings from an SSE body. Comment lines (`:`),
 * `event:` and `id:` fields are ignored; the stream ends at `data: [DONE]`.
 * Handles \r\n and split lines across chunk boundaries.
 */
export async function* sseData(res, opts = {}) {
  let line = '';
  for await (const chunk of bodyChunks(res, opts)) {
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf('\n', i);
      if (nl === -1) {
        line += chunk.slice(i);
        break;
      }
      line += chunk.slice(i, nl);
      i = nl + 1;
      const trimmed = line.replace(/\r$/, '');
      line = '';
      if (!trimmed || trimmed.startsWith(':')) continue; // comment / keepalive
      if (!trimmed.startsWith('data:')) continue; // event:/id:/unknown fields
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      if (payload) yield payload;
    }
  }
}

/** Extract the content delta from one OpenAI-style SSE payload (or null). */
function openAiDeltaOf(payload) {
  try {
    const j = JSON.parse(payload);
    const d = j?.choices?.[0]?.delta;
    let text = null;
    if (typeof d?.content === 'string') text = d.content;
    else if (Array.isArray(d?.content)) text = d.content.map((p) => p?.text || '').join('');
    // finish_reason rides the last content chunk (v0.63.0): 'length' means the
    // relay cut the reply on the output budget — the wire's own truncation
    // witness, surfaced so the chat loop can diagnose instead of mislabeling
    // a cut-off reply as a formatting sneeze.
    return { text, usage: j?.usage ?? null, finish: j?.choices?.[0]?.finish_reason ?? null };
  } catch {
    return { text: null, usage: null, finish: null };
  }
}

/**
 * Consume an OpenAI-style SSE stream, calling onDelta(fragment) per content
 * chunk. Returns { text, usage, chunks, ttms } — ttms = ms to first delta.
 * Usage comes from the trailing usage-only chunk (include_usage) when the
 * gateway honors it.
 */
export async function streamOpenAI(res, onDelta, opts = {}) {
  const t0 = Date.now();
  let text = '';
  let usage = null;
  let chunks = 0;
  let ttms = null;
  let finish = null;
  for await (const payload of sseData(res, opts)) {
    const { text: delta, usage: u, finish: f } = openAiDeltaOf(payload);
    if (u) usage = extractUsage({ usage: u }); // normalized here — callers pass it straight through
    if (f) finish = f; // last chunk wins
    if (typeof delta === 'string' && delta) {
      if (ttms === null) ttms = Date.now() - t0;
      chunks++;
      text += delta;
      try {
        onDelta?.(delta);
      } catch { /* a slow painter must never kill the stream */ }
    }
  }
  return { text, usage, chunks, ttms, finish };
}

/** Extract the content delta from one Ollama NDJSON line (or null). */
function ollamaDeltaOf(payload) {
  try {
    const j = JSON.parse(payload);
    const text = typeof j?.message?.content === 'string' ? j.message.content : null;
    return { text, done: Boolean(j?.done), final: j?.done ? j : null };
  } catch {
    return { text: null, done: false, final: null };
  }
}

/**
 * Consume an Ollama NDJSON chat stream. Returns { text, usage, chunks, ttms }
 * — usage mapped from the final done:true line's counters into the OpenAI-ish
 * shape extractUsage already understands.
 */
export async function streamNDJSON(res, onDelta, opts = {}) {
  const t0 = Date.now();
  let text = '';
  let chunks = 0;
  let ttms = null;
  let final = null;
  for await (const payload of bodyChunks(res, opts)) {
    for (const line of payload.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const { text: delta, done, final: f } = ollamaDeltaOf(t);
      if (f) final = f;
      if (typeof delta === 'string' && delta) {
        if (ttms === null) ttms = Date.now() - t0;
        chunks++;
        text += delta;
        try {
          onDelta?.(delta);
        } catch { /* painter must not kill the stream */ }
      }
      if (done) return { text, usage: mapOllamaUsage(final), chunks, ttms };
    }
  }
  return { text, usage: mapOllamaUsage(final), chunks, ttms };
}

function mapOllamaUsage(final) {
  if (!final) return null;
  const prompt = Number(final.prompt_eval_count) || 0;
  const completion = Number(final.eval_count) || 0;
  // Already in the normalized shape extractUsage produces elsewhere —
  // callers pass it straight through (usage.js cannot see these keys via
  // its usage-wrapper path without this mapping).
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

/**
 * One entry point for OpenAI-style relays: consume `res` as SSE when the
 * gateway actually streamed, else fall back to the classic buffered JSON
 * body (relays that ignore stream:true must keep working untouched).
 * Returns { text, usage, streamed, ttms }.
 */
export async function openAIStreamOrBuffer(res, onDelta, opts = {}) {
  const ctype = String(res.headers?.get?.('content-type') || '');
  if (/text\/event-stream/i.test(ctype)) {
    const { text, usage, ttms, finish } = await streamOpenAI(res, onDelta, opts);
    return { text, usage, streamed: true, ttms, truncated: finish === 'length' };
  }
  const json = await res.json().catch(() => null);
  const msg = json?.choices?.[0]?.message;
  const text =
    typeof msg?.content === 'string'
      ? msg.content
      : Array.isArray(msg?.content)
        ? msg.content.map((p) => p?.text || '').join('')
        : null;
  // finish_reason 'length' = the relay cut the reply on max_tokens (v0.63.0).
  return { text, usage: json?.usage ?? null, streamed: false, ttms: null, truncated: json?.choices?.[0]?.finish_reason === 'length' };
}
