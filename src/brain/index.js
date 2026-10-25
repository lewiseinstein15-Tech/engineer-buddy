// brain/index.js — registers all keyless gateway adapters and builds a
// GatewayRouter from config. Adding a provider = one adapter file + one
// registerGateway() call here.
import { registerGateway, buildGateways, GatewayRouter } from './router.js';
import { createKiloGateway } from './gateways/kilo.js';
import { createLlm7Gateway } from './gateways/llm7.js';
import { createPollinationsGateway } from './gateways/pollinations.js';
import { createDuckAiGateway } from './gateways/duckai.js';
import { createOllamaGateway } from './gateways/ollama.js';

registerGateway('kilo', createKiloGateway);
registerGateway('llm7', createLlm7Gateway);
registerGateway('pollinations', createPollinationsGateway);
registerGateway('duckai', createDuckAiGateway);
registerGateway('ollama', createOllamaGateway);

export function buildRouter(config) {
  const gateways = buildGateways(config);
  const router = new GatewayRouter(gateways, {
    gatewayOrder: config.gatewayOrder,
    ...config.circuitBreaker,
  });
  return router;
}

export { GatewayRouter };
