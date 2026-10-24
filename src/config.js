// config.js — load buddy.config.json (cwd first, then module dir), deep-merge
// over built-in defaults, apply BUDDY_* env overrides. Never throws.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG = {
  gatewayOrder: ['kilo', 'llm7', 'pollinations', 'duckai'],
  gateways: {
    kilo: { enabled: true, baseUrl: 'https://api.kilo.ai/api/openrouter', apiKey: 'anonymous', models: 'auto', preferredModels: [] },
    llm7: { enabled: true, baseUrl: 'https://api.llm7.io/v1', apiKey: 'unused', models: ['codestral-latest', 'gpt-oss:20b'] },
    pollinations: { enabled: true, baseUrl: 'https://text.pollinations.ai', apiKey: '', models: ['openai'] },
    duckai: { enabled: true, baseUrl: 'https://duckduckgo.com/duckchat', apiKey: '', models: ['gpt-4o-mini'] },
    ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434', apiKey: '', models: ['qwen2.5-coder:3b'] },
  },
  review: {
    maxDiffChars: 80000,
    maxFileChars: 30000,
    maxFindings: 8,
    requestChangesOnCritical: true,
    approveWhenClean: false,
    skipBots: true,
    skipDrafts: true,
    deepModeChangedLineThreshold: 200,
    deepMaxFiles: 3,
    excludeFiles: ['**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/secrets.*'],
    labels: { clean: 'buddy:clean', changes: 'buddy:changes-requested', critical: 'buddy:critical' },
  },
  circuitBreaker: { failureThreshold: 2, cooldownMs: 120000, maxRoundTrips: 2 },
  timeouts: { chatMs: 150000, httpMs: 30000 },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function findConfigFile(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(process.cwd(), 'buddy.config.json'));
  candidates.push(path.join(__dirname, '..', 'buddy.config.json'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function loadConfig({ file } = {}) {
  let user = {};
  const found = findConfigFile(file);
  if (found) {
    try {
      user = JSON.parse(fs.readFileSync(found, 'utf8'));
      console.error(`[buddy] config: ${found}`);
    } catch (e) {
      console.error(`[buddy] WARN: failed to parse ${found}: ${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);

  // Env overrides (handy in CI).
  if (process.env.BUDDY_GATEWAY_ORDER) {
    cfg.gatewayOrder = process.env.BUDDY_GATEWAY_ORDER.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.BUDDY_DISABLE_GATEWAYS) {
    for (const g of process.env.BUDDY_DISABLE_GATEWAYS.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (cfg.gateways[g]) cfg.gateways[g].enabled = false;
    }
  }
  return cfg;
}
