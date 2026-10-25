// pollinations.js — Pollinations.ai text API, keyless anonymous tier.
//   POST {base}/openai  {"model":"openai","messages":[...]}
// Anonymous tier: ~1 request / 30s per IP. On FREE_LIMIT the API answers 402
// with "Retry after Ns" — we surface that as RateLimitError so the router
// parks Pollinations for exactly that long and moves on. Verified 2026-10-25.
import { fetchWithTimeout, RateLimitError, BuddyError } from '../../util.js';
import { extractUsage, gwCtxLimit } from '../usage.js';

// Anonymous tier is the tightest window in the chain — overridable via
// gateways.pollinations.ctxLimit in buddy.config.json.
const DEFAULT_CTX_LIMIT = 8000;

export function createPollinationsGateway(cfg, timeouts) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['openai'];
  return {
    name: 'pollinations',
    ctxLimit: gwCtxLimit(cfg, DEFAULT_CTX_LIMIT),
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model } = {}) {
      const m = model || models[0];
      let res;
      try {
        res = await fetchWithTimeout(
          `${cfg.baseUrl}/openai`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature, stream: false }),
          },
          timeoutMs
        );
      } catch (e) {
        throw new BuddyError(`pollinations: network error: ${e.message}`, { code: 'NETWORK', cause: e });
      }

      if (res.status === 429 || res.status === 402) {
        const body = await res.text().catch(() => '');
        let waitS = Number(res.headers.get('retry-after')) || 35;
        const parsed = body.match(/retry after (\d+)s/i) || body.match(/"retry after (\d+)/i);
        if (parsed) waitS = Number(parsed[1]) + 2;
        throw new RateLimitError(`pollinations: FREE_LIMIT (${waitS}s)`, { retryAfterMs: waitS * 1000, gateway: 'pollinations' });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BuddyError(`pollinations: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
      }

      const raw = await res.text().catch(() => '');
      try {
        const json = JSON.parse(raw);
        const msg = json?.choices?.[0]?.message;
        const text = typeof msg?.content === 'string' && msg.content.trim()
          ? msg.content
          : Array.isArray(msg?.content)
            ? msg.content.map((p) => p?.text || '').join('').trim()
            : null;
        if (text) return { text, model: json?.model || m, gateway: 'pollinations', usage: extractUsage(json) };
        if (typeof json === 'string' && json.trim()) return { text: json, model: m, gateway: 'pollinations' };
        throw new BuddyError('pollinations: empty response', { code: 'EMPTY_RESPONSE', data: json });
      } catch (e) {
        if (e instanceof BuddyError) throw e;
        // Plain-text responses are valid on the simple endpoint.
        if (raw.trim()) return { text: raw.trim(), model: m, gateway: 'pollinations' };
        throw new BuddyError('pollinations: unparsable response', { code: 'UNPARSABLE' });
      }
    },
  };
}
