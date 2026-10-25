// usage.js — token accounting primitives shared by gateways, router, chat and /cost.
//
// Two honest sources of truth, in order of preference:
//   1. Gateway-reported usage (OpenAI-style `usage` block, Ollama counters).
//   2. The chars ÷ 4 estimate — the universal fallback for scrapers and
//      gateways that don't report (duckai's SSE stream never will).
// /cost labels which source it used so the numbers are never silently fake.

/** chars → tokens, the universal estimate (ceil so we never under-report). */
export function estimateTokens(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 4);
}

/**
 * Pull token usage out of a gateway JSON body. Handles the shapes seen in
 * the wild:
 *   - OpenAI-compatible: usage.{prompt_tokens,completion_tokens,total_tokens}
 *   - camelCase variants: usage.{promptTokens,completionTokens}
 *   - Ollama native: {prompt_eval_count, eval_count}
 * Returns { promptTokens, completionTokens, totalTokens } or null.
 */
export function extractUsage(json) {
  if (!json || typeof json !== 'object') return null;
  const u = json.usage && typeof json.usage === 'object' ? json.usage : null;
  const prompt = num(u?.prompt_tokens ?? u?.promptTokens ?? json.prompt_eval_count);
  const completion = num(u?.completion_tokens ?? u?.completionTokens ?? u?.eval_count ?? json.eval_count);
  if (prompt === null && completion === null) return null;
  let total = num(u?.total_tokens ?? u?.totalTokens);
  if (total === null) total = (prompt || 0) + (completion || 0);
  return { promptTokens: prompt || 0, completionTokens: completion || 0, totalTokens: total };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Resolve a gateway's context limit (tokens): config override wins, else the built-in default. */
export function gwCtxLimit(cfg, fallback) {
  const n = Number(cfg?.ctxLimit);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
