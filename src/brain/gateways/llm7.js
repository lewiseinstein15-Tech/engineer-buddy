// llm7.js — llm7.io free keyless API. Anonymous access uses the literal token
// "unused". Verified keyless 2026-10-25 (gpt-oss:20b end-to-end OK).
import { fetchWithTimeout, RateLimitError, BuddyError } from '../../util.js';
import { extractUsage, gwCtxLimit } from '../usage.js';
import { fetchStreaming, openAIStreamOrBuffer } from '../sse.js';

const STREAM_IDLE_MS = 45000;

// Conservative context window (tokens) for the free proxy tier — overridable
// via gateways.llm7.ctxLimit in buddy.config.json.
const DEFAULT_CTX_LIMIT = 32000;

export function createLlm7Gateway(cfg, timeouts) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['gpt-oss:20b'];
  return {
    name: 'llm7',
    ctxLimit: gwCtxLimit(cfg, DEFAULT_CTX_LIMIT),
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model, onDelta = null } = {}) {
      const chain = model ? [model, ...models.filter((m) => m !== model)] : models;
      let lastErr = null;
      const wantsStream = typeof onDelta === 'function';
      for (const m of chain) {
        let res;
        try {
          const init = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey || 'unused'}`,
            },
            body: JSON.stringify({
              model: m,
              messages,
              max_tokens: maxTokens,
              temperature,
              stream: wantsStream,
              ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
            }),
          };
          if (wantsStream) {
            ({ res } = await fetchStreaming(`${cfg.baseUrl}/chat/completions`, init, { timeoutMs }));
          } else {
            res = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, init, timeoutMs);
          }
        } catch (e) {
          lastErr = new BuddyError(`llm7: network error: ${e.message}`, { code: 'NETWORK', cause: e });
          continue;
        }
        if (res.status === 429 || res.status === 402) {
          const ra = Number(res.headers.get('retry-after')) || 60;
          throw new RateLimitError(`llm7: HTTP ${res.status}`, { retryAfterMs: ra * 1000, gateway: 'llm7' });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastErr = new BuddyError(`llm7: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
          if (/unavailable|not found|invalid model/i.test(body)) continue; // try next model in chain
          throw lastErr;
        }
        if (wantsStream) {
          const { text: sseText, usage: sseUsage, streamed, ttms } = await openAIStreamOrBuffer(res, onDelta, {
            idleMs: STREAM_IDLE_MS,
            totalMs: timeoutMs * 3,
          }).catch((e) => {
            throw new BuddyError(`llm7: stream error: ${e.message}`, { code: 'NETWORK', cause: e });
          });
          if (typeof sseText === 'string' && sseText.trim()) {
            const out = { text: sseText, model: m, gateway: 'llm7', usage: sseUsage }; // normalized by the stream reader
            if (streamed) {
              out.streamed = true;
              if (ttms != null) out.ttms = ttms;
            }
            return out;
          }
          lastErr = new BuddyError('llm7: empty response', { code: 'EMPTY_RESPONSE' });
          continue;
        }
        const json = await res.json().catch(() => null);
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text, model: json?.model || m, gateway: 'llm7', usage: extractUsage(json) };
        lastErr = new BuddyError('llm7: empty response', { code: 'EMPTY_RESPONSE', data: json });
      }
      throw lastErr || new BuddyError('llm7: all models failed', { code: 'ALL_MODELS_FAILED' });
    },
  };
}
