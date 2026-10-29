// effort.js — multi-model routing policy (v0.56.0, §11): which gateway leads
// the chain for THIS step — strongest for planning, fastest for chores — with
// `/effort low|medium|high` as the user's dial over the auto behavior.
//
// The division of knowledge is the contract:
//   - The OPERATOR declares what the engine cannot measure:
//     `gateways.<name>.tier: 'strong' | 'general' | 'fast'` in
//     buddy.config.json. Model QUALITY is a human judgment — the v0.43/v0.50
//     lesson (cloud/frontier): never fake knowledge the machine does not
//     have. Undeclared tiers mean the feature is INERT: the chain stays
//     exactly what config/pin made it.
//   - The ENGINE contributes the one thing it CAN measure: latency (the EMA
//     since v0.25.0). It only breaks ties INSIDE the declared 'fast' tier —
//     an EMA can never promote a gateway the operator did not call fast.
//   - The engine's own promise is narrow and pinned by tests: routeForStep
//     returns a PERMUTATION of the order it is given — no gateway invented,
//     none dropped, duplicates preserved as-is. Hostile NAME filtering is
//     the ROUTER's job (it owns the registry); this module only reorders.
//
// Facts, not content: when a routed chain differs from the base order, the
// caller logs ONE `route` event (class / effort / chain names) — gateway
// names and step classes only, never message text.

export const TIERS = ['strong', 'general', 'fast'];

/** Number() that cannot throw (Symbol / hostile valueOf degrade to NaN). */
function safeNum(v) {
  try {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

/** Canonical tier or null (junk is NAMED by the caller, never applied). */
export function normalizeTier(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return TIERS.includes(s) ? s : null;
}

/** 'auto' | 'off' | null. Absent/empty = 'auto' (the default posture). */
export function normalizeRoutingMode(v) {
  if (v === undefined || v === null || v === '') return 'auto';
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === 'auto' || s === 'off' ? s : null;
}

/**
 * classifyStep — the two-class world the checklist drew, decided BEFORE the
 * call (routing happens first, so only pre-call facts may vote):
 *   index      — 1-based brain-call index within the turn
 *   planMode   — plan mode active (research + a final plan)
 *   lastTool   — the tool the PREVIOUS step executed
 *   remaining  — steps left in the budget, counting this one
 * 'planning': the first call of a turn (orientation), a step that follows a
 * todo call (continuing the plan), plan-mode wrap pressure (the plan is due
 * now), or the final budgeted step (the report IS synthesis).
 * 'chore': mechanical middle steps — tool-in, observation-out.
 * Junk inputs degrade deterministically (never throws, never guesses up).
 */
export function classifyStep(opts = {}) {
  const { index = 1, planMode = false, lastTool = null, remaining = 2 } = opts || {};
  const i = safeNum(index);
  const rem = safeNum(remaining);
  const first = i === 1;
  const continuingPlan = lastTool === 'todo';
  const planWrap = Boolean(planMode) && Number.isFinite(rem) && rem <= 2;
  const final = Number.isFinite(rem) && rem === 1;
  return first || continuingPlan || planWrap || final ? 'planning' : 'chore';
}

/** Read the EMA out of a Map (router.latency) or a plain snapshot object. */
function emaOf(latency, name) {
  try {
    if (!latency) return NaN;
    const v = typeof latency.get === 'function' ? latency.get(name) : latency[name];
    if (v && typeof v === 'object') {
      const e = safeNum(v.ema);
      return e > 0 ? e : NaN;
    }
    const n = safeNum(v);
    return n > 0 ? n : NaN;
  } catch {
    return NaN; // a hostile latency store biases nothing and breaks nothing
  }
}

/**
 * fast-first: the declared 'fast' tier leads, ordered by the measured EMA
 * (unknown latencies after known ones, ties and unknowns keep relative
 * order); everything else follows in its given order.
 */
export function fastFirst(order, tiers = {}, latency = null) {
  const fast = order.filter((n) => tiers[n] === 'fast');
  const rest = order.filter((n) => tiers[n] !== 'fast');
  const keyed = fast.map((n, i) => ({ n, i, ema: emaOf(latency, n) }));
  keyed.sort((a, b) => {
    const ka = Number.isFinite(a.ema);
    const kb = Number.isFinite(b.ema);
    if (ka && kb && a.ema !== b.ema) return a.ema - b.ema;
    if (ka !== kb) return ka ? -1 : 1;
    return a.i - b.i;
  });
  return [...keyed.map((k) => k.n), ...rest];
}

/** strong-first: the declared 'strong' tier leads in order; rest follows. */
export function strongFirst(order, tiers = {}) {
  const strong = order.filter((n) => tiers[n] === 'strong');
  const rest = order.filter((n) => tiers[n] !== 'strong');
  return [...strong, ...rest];
}

/**
 * routeForStep — pure, total, permutation-preserving.
 *   effort 'high'  → strong-first for EVERY step (quality everywhere)
 *   effort 'low'   → fast-first for EVERY step (speed everywhere)
 *   effort other   → per-step auto: planning → strong-first, chore → fast-first
 * A pinned gateway (explicit /model choice) is ABSOLUTE: it leads, and the
 * routing bias applies to the tail only — the user's pin can never be
 * demoted by heuristics. Unknown pinned names are ignored.
 */
export function routeForStep(args = {}) {
  const { cls = 'chore', effort = 'medium', order = [], tiers = {}, latency = null, pinned = null } = args || {};
  if (!Array.isArray(order) || !order.length) return [];
  const bias =
    effort === 'high' ? 'strong'
    : effort === 'low' ? 'fast'
    : (cls === 'planning' ? 'strong' : 'fast');
  const route = (list) => (bias === 'strong' ? strongFirst(list, tiers) : fastFirst(list, tiers, latency));
  if (pinned && order.includes(pinned)) {
    return [pinned, ...route(order.filter((n) => n !== pinned))];
  }
  return route(order);
}

/**
 * makeStepRouter — the bridge the loops use: a fn(stepCtx) => chain|null.
 * mode 'off' (or junk that never became 'auto') → null: the caller passes no
 * chain and the wire never learns routing existed. 'auto' → routeForStep
 * over the LIVE order (getOrder), returning the chain only when it genuinely
 * differs from the base order — a no-op reorder is null, not noise.
 */
export function makeStepRouter({ mode = 'auto', tiers = {}, latency = null, pinned = null, getOrder = null, getEffort = null } = {}) {
  if (mode !== 'auto') return null;
  return (stepCtx = {}) => {
    try {
      const order = typeof getOrder === 'function' ? getOrder() : null;
      if (!Array.isArray(order) || !order.length) return null;
      const { cls, index, planMode, lastTool, remaining } = stepCtx || {};
      const klass = cls || classifyStep({ index, planMode, lastTool, remaining });
      const chain = routeForStep({
        cls: klass,
        effort: typeof getEffort === 'function' ? getEffort() : 'medium',
        order,
        tiers,
        latency: typeof latency === 'function' ? latency() : latency,
        pinned,
      });
      if (chain.length !== order.length) return null; // impossible by contract; belt and suspenders
      for (let i = 0; i < chain.length; i++) if (chain[i] !== order[i]) return chain;
      return null;
    } catch {
      return null; // routing may never break the loop — any hostile input degrades to the default chain
    }
  };
}
