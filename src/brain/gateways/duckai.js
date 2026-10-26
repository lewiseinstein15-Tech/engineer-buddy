// duckai.js — DuckDuckGo Duck.ai chat, keyless (x-vqd-4 handshake).
// Unofficial/undocumented: treat as best-effort; the router tolerates its
// failures. Verified handshake 200 on 2026-10-25.
//
// Flow:
//   1) GET  https://duckduckgo.com/duckchat/v1/status   (x-vqd-accept: 1) → x-vqd-4 token
//   2) POST https://duckduckgo.com/duckchat/v1/chat     (x-vqd-4: token) → SSE stream
import { fetchWithTimeout, RateLimitError, BuddyError } from '../../util.js';
import { fetchStreaming, sseData } from '../sse.js';

const STREAM_IDLE_MS = 45000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getVqd(httpMs) {
  const res = await fetchWithTimeout(
    `${BASE}/v1/status`,
    { headers: { 'x-vqd-accept': '1', 'User-Agent': UA, Accept: '*/*' } },
    httpMs
  );
  if (!res.ok) throw new BuddyError(`duckai: handshake HTTP ${res.status}`, { code: 'HTTP_' + res.status });
  const vqd = res.headers.get('x-vqd-4');
  if (!vqd) throw new BuddyError('duckai: no x-vqd-4 token in handshake', { code: 'NO_VQD' });
  return vqd;
}

let BASE = 'https://duckduckgo.com/duckchat';

export function createDuckAiGateway(cfg, timeouts) {
  if (cfg.baseUrl) BASE = cfg.baseUrl.replace(/\/$/, '');
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['gpt-4o-mini'];
  return {
    name: 'duckai',
    async chat(messages, { maxTokens = 2048, temperature = 0.2, timeoutMs = timeouts.chatMs, model, onDelta = null } = {}) {
      const m = model || models[0];
      const vqd = await getVqd(timeouts.httpMs);
      let res;
      if (typeof onDelta === 'function') {
        // Streaming path (v0.28.0): Duck.ai already answers SSE — consume the
        // body incrementally instead of buffering res.text().
        try {
          ({ res } = await fetchStreaming(
            `${BASE}/v1/chat`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                'User-Agent': UA,
                'x-vqd-4': vqd,
                'x-vqd-accept': '1',
              },
              body: JSON.stringify({ model: m, messages, stream: true }),
            },
            { timeoutMs }
          ));
        } catch (e) {
          throw new BuddyError(`duckai: network error: ${e.message}`, { code: 'NETWORK', cause: e });
        }
        if (res.status === 429 || res.status === 402) {
          throw new RateLimitError(`duckai: HTTP ${res.status}`, { retryAfterMs: 60000, gateway: 'duckai' });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new BuddyError(`duckai: HTTP ${res.status} ${body.slice(0, 160)}`, { code: 'HTTP_' + res.status });
        }
        let content = '';
        try {
          for await (const payload of sseData(res, { idleMs: STREAM_IDLE_MS, totalMs: timeoutMs * 3 })) {
            try {
              const j = JSON.parse(payload);
              if (typeof j?.message?.content === 'string' && j.message.content) {
                content += j.message.content;
                try {
                  onDelta(j.message.content);
                } catch { /* painter must not kill the stream */ }
              }
            } catch {
              /* skip malformed chunk */
            }
          }
        } catch (e) {
          throw new BuddyError(`duckai: stream error: ${e.message}`, { code: 'NETWORK', cause: e });
        }
        if (!content.trim()) throw new BuddyError('duckai: empty stream', { code: 'EMPTY_RESPONSE' });
        return { text: content.trim(), model: m, gateway: 'duckai', streamed: true };
      }
      try {
        res = await fetchWithTimeout(
          `${BASE}/v1/chat`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'User-Agent': UA,
              'x-vqd-4': vqd,
              'x-vqd-accept': '1',
            },
            body: JSON.stringify({ model: m, messages, stream: true }),
          },
          timeoutMs
        );
      } catch (e) {
        throw new BuddyError(`duckai: network error: ${e.message}`, { code: 'NETWORK', cause: e });
      }
      if (res.status === 429 || res.status === 402) {
        throw new RateLimitError(`duckai: HTTP ${res.status}`, { retryAfterMs: 60000, gateway: 'duckai' });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BuddyError(`duckai: HTTP ${res.status} ${body.slice(0, 160)}`, { code: 'HTTP_' + res.status });
      }

      const raw = await res.text().catch(() => '');
      // Parse SSE "data: {...}" chunks; also tolerate a plain JSON body.
      let content = '';
      if (raw.trim().startsWith('{')) {
        try {
          content = JSON.parse(raw)?.message?.content || '';
        } catch {
          /* fall through to SSE parse */
        }
      }
      if (!content) {
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (typeof j?.message?.content === 'string') content += j.message.content;
          } catch {
            /* skip malformed chunk */
          }
        }
      }
      if (!content.trim()) throw new BuddyError('duckai: empty stream', { code: 'EMPTY_RESPONSE' });
      return { text: content.trim(), model: m, gateway: 'duckai' };
    },
  };
}
