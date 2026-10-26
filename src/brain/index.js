// brain/index.js — registers all keyless gateway adapters and builds a
// GatewayRouter from config. Adding a provider = one adapter file + one
// registerGateway() call here.
import { registerGateway, buildGateways, GatewayRouter } from './router.js';
import { createKiloGateway } from './gateways/kilo.js';
import { createLlm7Gateway } from './gateways/llm7.js';
import { createPollinationsGateway } from './gateways/pollinations.js';
import { createDuckAiGateway } from './gateways/duckai.js';
import { createOllamaGateway } from './gateways/ollama.js';
import { fetchWithTimeout } from '../util.js';

registerGateway('kilo', createKiloGateway);
registerGateway('llm7', createLlm7Gateway);
registerGateway('pollinations', createPollinationsGateway);
registerGateway('duckai', createDuckAiGateway);
registerGateway('ollama', createOllamaGateway);

// Offline-first (v0.25.0): probe local Ollama with a SHORT timeout — this
// only runs when every keyless gateway already failed, so one quick probe
// before an honest error beats a long hang before one. A machine running
// Ollama keeps a working brain on a plane; everyone else gets the same
// error as before, ~1.6s later.
export async function probeOllama(cfg, { timeoutMs = 1600 } = {}) {
  const base = String(cfg?.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, {}, timeoutMs);
    return res.ok; // any 2xx means a local brain is alive
  } catch {
    return false;
  }
}

export function buildRouter(config) {
  const gateways = buildGateways(config);
  const router = new GatewayRouter(gateways, {
    gatewayOrder: config.gatewayOrder,
    ...config.circuitBreaker,
    // Offline fallback: only wired when ollama is NOT already enabled (if it
    // is, it's already in the chain — nothing to fall back TO).
    offlineFallback:
      config.gateways?.ollama && !config.gateways.ollama.enabled
        ? async () => {
            const alive = await probeOllama(config.gateways.ollama);
            if (!alive) return null;
            return createOllamaGateway(config.gateways.ollama, config.timeouts);
          }
        : null,
  });
  return router;
}

export { GatewayRouter };
