// kilo.js — Kilo Gateway (the "OpenKilo" keyless free tier), OpenRouter-compatible.
//   POST {base}/v1/chat/completions  with  Authorization: Bearer anonymous
//   GET  {base}/v1/models            → dynamic free-model discovery
// Free models rotate; :free suffix + "auto" resolution keeps the bot working
// even when the catalog changes. Verified keyless 2026-10-25.
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

function pickModel(available, cfg) {
  const free = available.filter((id) => id.endsWith(':free'));
  for (const p of cfg.preferredModels || []) {
    if (free.includes(p)) return p;
  }
  // Prefer anything code-flavoured first, else the first free model.
  const codeish = free.find((id) => /code|coder|codestral|devstral|qwen|deepseek|glm|nemotron|laguna|north/i.test(id));
  return codeish || free[0] || null;
}

export function createKiloGateway(cfg, timeouts) {
  return {
    name: 'kilo',
    ctxLimit: gwCtxLimit(cfg, DEFAULT_CTX_LIMIT),
    // Vision: best effort — the OpenRouter-style catalog mixes vision and
    // text-only free models; the API rejects image parts per-model and the
    // chain falls through. Disable with gateways.kilo.vision = false.
    vision: cfg.vision !== false,
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model, onDelta = null } = {}) {
      let chosen = model || null;
      if (!chosen || chosen === 'auto') {
        const available = await getFreeModels(cfg, timeouts.httpMs);
        chosen = pickModel(available, cfg);
        if (!chosen) throw new BuddyError('kilo: no free models available right now', { code: 'NO_FREE_MODELS' });
      }
      debugLog(`kilo: model=${chosen}`);

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
        // Model rotated away — retry once with any other free model.
        if ((res.status === 400 || res.status === 404) && /does not exist|not found|model/i.test(body)) {
          const available = await getFreeModels(cfg, timeouts.httpMs);
          const alt = (cfg.preferredModels || []).concat(available.filter((i) => i.endsWith(':free'))).find((m) => m && m !== chosen);
          if (alt) return this.chat(messages, { maxTokens, temperature, timeoutMs, model: alt, onDelta });
        }
        throw new BuddyError(`kilo: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
      }

      if (wantsStream) {
        // SSE when the relay honors stream:true; buffered-JSON fallback when
        // it silently ignores it — either way onDelta got the pieces that
        // actually arrived and the returned text is the full reply.
        const { text: sseText, usage: sseUsage, streamed, ttms, truncated } = await openAIStreamOrBuffer(res, onDelta, {
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
        throw new BuddyError('kilo: empty response', { code: 'EMPTY_RESPONSE' });
      }

      const json = await res.json().catch(() => null);
      const usage = extractUsage(json);
      // finish_reason 'length' = the relay cut the reply on max_tokens
      // (v0.63.0) — carried on the result so the chat loop can diagnose a
      // truncated tool call instead of calling it a formatting sneeze.
      const wasCut = json?.choices?.[0]?.finish_reason === 'length';
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        return { text, model: json?.model || chosen, gateway: 'kilo', usage, ...(wasCut ? { truncated: true } : {}) };
      }
      // Some models return content as an array of parts.
      const parts = json?.choices?.[0]?.message?.content;
      if (Array.isArray(parts)) {
        const joined = parts.map((p) => p?.text || '').join('').trim();
        if (joined) return { text: joined, model: json?.model || chosen, gateway: 'kilo', usage, ...(wasCut ? { truncated: true } : {}) };
      }
      throw new BuddyError('kilo: empty response', { code: 'EMPTY_RESPONSE', data: json });
    },
  };
}
