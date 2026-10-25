// ollama.js — local Ollama as the offline last resort. Keyless by nature.
// Disabled by default (CI runners have no Ollama); enable for local/air-gapped
// use so the brain literally never fails.
import { fetchWithTimeout, BuddyError } from '../../util.js';

export function createOllamaGateway(cfg, timeouts) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['qwen2.5-coder:3b'];
  return {
    name: 'ollama',
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model } = {}) {
      const m = model || models[0];
      let res;
      try {
        res = await fetchWithTimeout(
          `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m, messages, stream: false, options: { temperature, num_predict: maxTokens } }),
          },
          timeoutMs
        );
      } catch (e) {
        throw new BuddyError(`ollama: unreachable (${e.message})`, { code: 'NETWORK', cause: e });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BuddyError(`ollama: HTTP ${res.status} ${body.slice(0, 200)}`, { code: 'HTTP_' + res.status });
      }
      const json = await res.json().catch(() => null);
      const text = json?.message?.content;
      if (typeof text === 'string' && text.trim()) return { text, model: m, gateway: 'ollama' };
      throw new BuddyError('ollama: empty response', { code: 'EMPTY_RESPONSE' });
    },
  };
}
