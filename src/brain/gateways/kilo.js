// kilo.js — Kilo Gateway (the "OpenKilo" keyless free tier), OpenRouter-compatible.
//   POST {base}/v1/chat/completions  with  Authorization: Bearer anonymous
//   GET  {base}/v1/models            → dynamic free-model discovery
// Free models rotate; :free suffix + "auto" resolution keeps the bot working
// even when the catalog changes. Verified keyless 2026-10-25.
import { fetchWithTimeout, RateLimitError, BuddyError, debugLog } from '../../util.js';

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
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model } = {}) {
      let chosen = model || null;
      if (!chosen || chosen === 'auto') {
        const available = await getFreeModels(cfg, timeouts.httpMs);
        chosen = pickModel(available, cfg);
        if (!chosen) throw new BuddyError('kilo: no free models available right now', { code: 'NO_FREE_MODELS' });
      }
      debugLog(`kilo: model=${chosen}`);

      let res;
      try {
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
            body: JSON.stringify({ model: chosen, messages, max_tokens: maxTokens, temperature, stream: false }),
          },
          timeoutMs
        );
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
          if (alt) return this.chat(messages, { maxTokens, temperature, timeoutMs, model: alt });
        }
        throw new BuddyError(`kilo: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
      }

      const json = await res.json().catch(() => null);
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        return { text, model: json?.model || chosen, gateway: 'kilo' };
      }
      // Some models return content as an array of parts.
      const parts = json?.choices?.[0]?.message?.content;
      if (Array.isArray(parts)) {
        const joined = parts.map((p) => p?.text || '').join('').trim();
        if (joined) return { text: joined, model: json?.model || chosen, gateway: 'kilo' };
      }
      throw new BuddyError('kilo: empty response', { code: 'EMPTY_RESPONSE', data: json });
    },
  };
}
