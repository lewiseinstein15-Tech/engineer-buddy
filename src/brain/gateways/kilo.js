// kilo.js — Kilo Gateway (the "OpenKilo" keyless free tier), OpenRouter-compatible.
//   POST {base}/v1/chat/completions  with  Authorization: Bearer anonymous
//   GET  {base}/v1/models            → dynamic free-model discovery
// Free models rotate; :free suffix + "auto" resolution keeps the bot working
// even when the catalog changes. Verified keyless 2026-10-25.
//
// v0.64.0 — THE CATALOG IS THE ENEMY (2026-10-31 live-wire probe, the "still
// not fixed / the type box is blinking" lesson): the free catalog now mixes
// REASONING models into the code-flavoured names, and kilo's old pickModel
// PREFERRED them (nvidia/nemotron-3.5-super-vl:free sorted first and matched
// the /nemotron/ codeish regex). A reasoning model streams its thinking as
// delta.reasoning_content — invisible to every content reader — and burns the
// ENTIRE output budget on it: the probe witnessed 5063 reasoning chars, ZERO
// content, finish_reason 'length', completion_tokens 1500, and ~135 seconds
// of total silence per call. From the user's chair: the type box sits there
// blinking for minutes, then the turn dies on failover churn. The wire probe
// also proved the relay DOES honor max_tokens (cut position scales 1500→3000),
// so the v0.63.0 boost was never the broken leg — the MODEL choice was.
//
// The fix is three disciplines, all inside this gateway:
//   1. CONTENT OR IT DIDN'T HAPPEN — an empty-content reply (with or without
//      reasoning chars) is never returned as success; the model is blacklisted
//      for BAD_TTL_MS and the SAME call rotates to the next candidate (bounded
//      at MAX_MODEL_ATTEMPTS — a bad catalog must not multiply latency
//      unboundedly). The inline HTTP-200 error envelope ({"error":{...code
//      502...}} inside a 200) is the same model-level failure.
//   2. REASONING-FLAVORED NAMES GO LAST — /reasoning|thinking|qwq|-r1|omni/
//      models are tried only after every plain candidate (a name cannot prove
//      behavior, but the catalog advertises what it knows; the blacklist catches
//      the liars like nemotron-3.5-super-vl after their first silent stall).
//   3. THE OPERATOR'S PREFERRED MODELS STILL WIN — gateways.kilo.preferredModels
//      is an explicit human declaration and is never demoted (the v0.43/v0.50
//      lesson: model quality is a human judgment the engine never guesses).
import { fetchWithTimeout, RateLimitError, BuddyError, debugLog } from '../../util.js';
import { extractUsage, gwCtxLimit } from '../usage.js';
import { fetchStreaming, openAIStreamOrBuffer } from '../sse.js';

// Streaming body watchdogs (v0.28.0): a relay that stops sending bytes must
// not hang the turn — abort after 45s of silence, 3× the headers timeout in
// total so even slow long generations stay bounded.
const STREAM_IDLE_MS = 45000;

// Conservative floor for OpenRouter-style free models (they vary 8k–128k) —
// overridable via gateways.kilo.ctxLimit in buddy.config.json.
const DEFAULT_CTX_LIMIT = 32000;

// v0.64.0 blacklist: a model that answered without content (or with an inline
// error) is parked for 10 minutes — the catalog rotates slower than that, so
// the next call tries someone else instead of re-running the same silent stall.
const BAD_TTL_MS = 10 * 60 * 1000;
const MAX_MODEL_ATTEMPTS = 3;

// Names that advertise reasoning/thinking behavior — demoted below plain
// candidates. Deliberately narrow: a false negative just means the blacklist
// learns it the hard way; a false positive would hide a good model forever.
const REASONING_FLAVOR_RE = /reasoning|thinking|qwq|-r1\b|omni/i;

let modelCache = { at: 0, ids: [] };
const MODEL_TTL_MS = 60 * 60 * 1000;

async function getFreeModels(cfg, httpMs) {
  if (cfg.models !== 'auto' || modelCache.ids.length) {
    if (Date.now() - modelCache.at < MODEL_TTL_MS || cfg.models !== 'auto') return modelCache.ids;
  }
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/v1/models`,
    { headers: { Authorization: `Bearer ${cfg.apiKey || 'anonymous'}` } },
    httpMs
  );
  if (!res.ok) throw new BuddyError(`kilo models list HTTP ${res.status}`, { code: 'HTTP_' + res.status });
  const json = await res.json();
  const ids = (json?.data || []).map((m) => m.id).filter(Boolean);
  modelCache = { at: Date.now(), ids };
  return ids;
}

const CODEISH_RE = /code|coder|codestral|devstral|qwen|deepseek|glm|nemotron|laguna|north/i;

/**
 * Next model to try (v0.64.0): the operator's preferredModels always win, then
 * non-blacklisted candidates with reasoning-flavored names DEMOTED to the tail,
 * then — only when every free model is blacklisted — the blacklist is ignored
 * (TTLs expire; a guaranteed refusal is worse than a retry).
 */
function nextCandidate(available, cfg, badUntil, exclude) {
  const free = available.filter((id) => id.endsWith(':free') && !exclude.has(id));
  if (!free.length) return null;
  const isBad = (id) => (badUntil.get(id) || 0) > Date.now();
  const fresh = free.filter((id) => !isBad(id));
  const pool = fresh.length ? fresh : free; // all-blacklisted → retry anyway
  for (const p of cfg.preferredModels || []) {
    if (pool.includes(p)) return p;
  }
  const plain = pool.filter((id) => !REASONING_FLAVOR_RE.test(id));
  const ordered = [...plain, ...pool.filter((id) => REASONING_FLAVOR_RE.test(id))];
  const codeish = ordered.find((id) => CODEISH_RE.test(id));
  return codeish || ordered[0] || null;
}

/** BuddyError marked as THIS model's failure — the caller blacklists + rotates. */
function modelBad(message, opts = {}) {
  const e = new BuddyError(message, opts);
  e.modelBad = true;
  return e;
}

export function createKiloGateway(cfg, timeouts) {
  // Per-instance blacklist: a fresh gateway (new session, tests) starts clean.
  const badUntil = new Map();
  return {
    name: 'kilo',
    ctxLimit: gwCtxLimit(cfg, DEFAULT_CTX_LIMIT),
    // Vision: best effort — the OpenRouter-style catalog mixes vision and
    // text-only free models; the API rejects image parts per-model and the
    // chain falls through. Disable with gateways.kilo.vision = false.
    vision: cfg.vision !== false,
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model, onDelta = null } = {}) {
      // Explicit model (router pin / gateway chain) is honored first — but an
      // auto-picked model rotates through candidates below (v0.64.0).
      const pinned = model && model !== 'auto' ? model : null;
      const exclude = new Set();
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
        let chosen;
        if (pinned) {
          chosen = pinned; // the pin leads on every attempt; rotation does not demote a human choice
        } else {
          const available = await getFreeModels(cfg, timeouts.httpMs);
          chosen = nextCandidate(available, cfg, badUntil, exclude);
          if (!chosen) {
            if (lastErr) throw lastErr;
            throw new BuddyError('kilo: no free models available right now', { code: 'NO_FREE_MODELS' });
          }
        }
        exclude.add(chosen);
        debugLog(`kilo: model=${chosen}${attempt ? ` (attempt ${attempt + 1})` : ''}`);
        try {
          return await this._callOnce(messages, { maxTokens, temperature, timeoutMs, onDelta }, chosen);
        } catch (e) {
          if (e instanceof RateLimitError) throw e; // gateway-wide parking is the router's call — never rotate, never blacklist
          if (e.modelBad) {
            badUntil.set(chosen, Date.now() + BAD_TTL_MS);
            debugLog(`kilo: ${chosen} blacklisted for ${BAD_TTL_MS / 1000}s — ${e.message}`);
            lastErr = e;
            if (pinned) throw e; // a pinned model's own failure cannot be rotated away
            continue; // same call, next candidate
          }
          throw e; // NETWORK / HTTP_5xx / stream watchdog — gateway-level, the router failovers
        }
      }
      throw lastErr || new BuddyError('kilo: all model attempts failed', { code: 'ALL_MODELS_FAILED' });
    },

    async _callOnce(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs, onDelta = null }, chosen) {
      const wantsStream = typeof onDelta === 'function';
      const body = {
        model: chosen,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: wantsStream,
        ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
      };

      let res;
      try {
        if (wantsStream) {
          // Streaming path (v0.28.0): fetchStreaming returns the AbortController
          // so the SSE reader's idle/total watchdogs abort the SAME request.
          ({ res } = await fetchStreaming(
            `${cfg.baseUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey || 'anonymous'}`,
                'HTTP-Referer': 'https://github.com/engineer-buddy',
                'X-Title': 'Engineer Buddy',
              },
              body: JSON.stringify(body),
            },
            { timeoutMs }
          ));
        } else {
          res = await fetchWithTimeout(
            `${cfg.baseUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey || 'anonymous'}`,
                'HTTP-Referer': 'https://github.com/engineer-buddy',
                'X-Title': 'Engineer Buddy',
              },
              body: JSON.stringify(body),
            },
            timeoutMs
          );
        }
      } catch (e) {
        throw new BuddyError(`kilo: network error: ${e.message}`, { code: 'NETWORK', cause: e });
      }

      if (res.status === 429 || res.status === 402) {
        const ra = Number(res.headers.get('retry-after')) || 60;
        throw new RateLimitError(`kilo: HTTP ${res.status}`, { retryAfterMs: ra * 1000, gateway: 'kilo' });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Model rotated away / bad model id — THIS model's failure: blacklist
        // + rotate to the next candidate (v0.64.0; was a one-shot alt retry).
        if ((res.status === 400 || res.status === 404) && /does not exist|not found|model/i.test(body)) {
          throw modelBad(`kilo: ${chosen} unavailable (HTTP ${res.status})`, { code: 'HTTP_' + res.status });
        }
        throw new BuddyError(`kilo: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
      }

      if (wantsStream) {
        // SSE when the relay honors stream:true; buffered-JSON fallback when
        // it silently ignores it — either way onDelta got the pieces that
        // actually arrived and the returned text is the full reply.
        const { text: sseText, usage: sseUsage, streamed, ttms, truncated, reasoningChars } = await openAIStreamOrBuffer(res, onDelta, {
          idleMs: STREAM_IDLE_MS,
          totalMs: timeoutMs * 3,
        }).catch((e) => {
          throw new BuddyError(`kilo: stream error: ${e.message}`, { code: 'NETWORK', cause: e });
        });
        if (typeof sseText === 'string' && sseText.trim()) {
          const out = { text: sseText, model: chosen, gateway: 'kilo', usage: sseUsage }; // normalized by the stream reader
          if (streamed) {
            out.streamed = true;
            if (ttms != null) out.ttms = ttms;
          }
          if (truncated) out.truncated = true; // finish_reason 'length' — the wire's own cut-off witness (v0.63.0)
          return out;
        }
        throw modelBad(this._emptyMsg(chosen, reasoningChars), { code: 'EMPTY_RESPONSE' });
      }

      const json = await res.json().catch(() => null);
      // Inline error envelope (v0.64.0): the relay answers HTTP 200 with
      // {"error":{"code":502,"message":"Inference connection error…"}} and NO
      // choices — witnessed live 2026-10-31 (provider_unavailable). This is
      // the model's upstream dying, not the gateway: blacklist + rotate.
      if (!json || (json.error && !Array.isArray(json.choices))) {
        const code = json?.error?.code ?? json?.error?.error_type ?? 'no-json';
        throw modelBad(`kilo: ${chosen} provider error (${String(code).slice(0, 60)})`, { code: 'PROVIDER_ERROR' });
      }
      const usage = extractUsage(json);
      // finish_reason 'length' = the relay cut the reply on max_tokens
      // (v0.63.0) — carried on the result so the chat loop can diagnose a
      // truncated tool call instead of calling it a formatting sneeze.
      const wasCut = json?.choices?.[0]?.finish_reason === 'length';
      // Reasoning witness (v0.64.0) — see sse.js; the buffered shape parks the
      // thinking on message.reasoning / message.reasoning_content.
      const msg = json?.choices?.[0]?.message;
      const reasoningChars =
        typeof msg?.reasoning === 'string' ? msg.reasoning.length : typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0;
      const text = msg?.content;
      if (typeof text === 'string' && text.trim()) {
        return { text, model: json?.model || chosen, gateway: 'kilo', usage, ...(wasCut ? { truncated: true } : {}) };
      }
      // Some models return content as an array of parts.
      if (Array.isArray(text)) {
        const joined = text.map((p) => p?.text || '').join('').trim();
        if (joined) return { text: joined, model: json?.model || chosen, gateway: 'kilo', usage, ...(wasCut ? { truncated: true } : {}) };
      }
      throw modelBad(this._emptyMsg(chosen, reasoningChars), { code: 'EMPTY_RESPONSE' });
    },

    /** The honest no-content diagnosis (v0.64.0): 'empty' vs 'eaten by reasoning'. */
    _emptyMsg(chosen, reasoningChars) {
      return reasoningChars > 0
        ? `kilo: ${chosen} produced NO content — the output budget was burned on ~${reasoningChars} chars of reasoning tokens (finish 'length' likely); model blacklisted for ${BAD_TTL_MS / 1000}s`
        : `kilo: ${chosen} returned no content; model blacklisted for ${BAD_TTL_MS / 1000}s`;
    },
  };
}
