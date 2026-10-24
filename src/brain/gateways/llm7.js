// llm7.js — llm7.io free keyless API. Anonymous access uses the literal token
// "unused". Verified keyless 2026-10-25 (gpt-oss:20b end-to-end OK).
import { fetchWithTimeout, RateLimitError, BuddyError } from '../../util.js';

export function createLlm7Gateway(cfg, timeouts) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['gpt-oss:20b'];
  return {
    name: 'llm7',
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model } = {}) {
      const chain = model ? [model, ...models.filter((m) => m !== model)] : models;
      let lastErr = null;
      for (const m of chain) {
        let res;
        try {
          res = await fetchWithTimeout(
            `${cfg.baseUrl}/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey || 'unused'}`,
              },
              body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature, stream: false }),
            },
            timeoutMs
          );
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
        const json = await res.json().catch(() => null);
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text, model: json?.model || m, gateway: 'llm7' };
        lastErr = new BuddyError('llm7: empty response', { code: 'EMPTY_RESPONSE', data: json });
      }
      throw lastErr || new BuddyError('llm7: all models failed', { code: 'ALL_MODELS_FAILED' });
    },
  };
}
