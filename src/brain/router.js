// router.js — the Brain's failover engine.
//
// Design goals (from the spec): keyless-only providers; it never fails; it
// never gets stuck on a quota. Achieved with:
//   1. Ordered failover across N independent keyless gateways
//   2. A circuit breaker: N consecutive failures open the gateway for a
//      cooldown; rate-limited gateways are parked for their exact Retry-After
//   3. Round-trips: if every gateway in the chain is tried, loop again (with
//      breaker state respected) until maxRoundTrips is exhausted
//   4. Full attempt telemetry so reviews can cite which brain answered.

import { BuddyError, RateLimitError, debugLog, sleep } from '../util.js';

const GATEWAY_FACTORIES = {};

export function registerGateway(name, factory) {
  GATEWAY_FACTORIES[name] = factory;
}

export function buildGateways(config) {
  const { timeouts } = config;
  const out = new Map();
  for (const [name, cfg] of Object.entries(config.gateways || {})) {
    if (!cfg?.enabled) continue;
    const factory = GATEWAY_FACTORIES[name];
    if (!factory) continue;
    try {
      out.set(name, factory(cfg, timeouts));
    } catch (e) {
      console.error(`[buddy] WARN failed to init gateway ${name}: ${e.message}`);
    }
  }
  return out;
}

export class GatewayRouter {
  /**
   * @param {Map<string, object>} gateways name -> gateway adapter
   * @param {object} opts { gatewayOrder, failureThreshold, cooldownMs, maxRoundTrips }
   */
  constructor(gateways, { gatewayOrder = [], failureThreshold = 2, cooldownMs = 120000, maxRoundTrips = 2 } = {}) {
    this.gateways = gateways;
    this.order = (gatewayOrder.length ? gatewayOrder : [...gateways.keys()]).filter((n) => gateways.has(n));
    if (!this.order.length) this.order = [...gateways.keys()];
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.maxRoundTrips = maxRoundTrips;
    this.state = new Map(); // name -> { failures, openUntil }
    for (const n of this.order) this.state.set(n, { failures: 0, openUntil: 0 });
    this.lastUsed = null;
  }

  _isOpen(name) {
    const s = this.state.get(name);
    return s && Date.now() < s.openUntil;
  }

  _recordSuccess(name) {
    this.state.set(name, { failures: 0, openUntil: 0 });
    this.lastUsed = name;
  }

  _recordFailure(name, { rateLimited = false, retryAfterMs = null } = {}) {
    const s = this.state.get(name) || { failures: 0, openUntil: 0 };
    if (rateLimited) {
      s.openUntil = Date.now() + (retryAfterMs ?? this.cooldownMs);
      s.failures = this.failureThreshold; // park it fully
    } else {
      s.failures += 1;
      if (s.failures >= this.failureThreshold) s.openUntil = Date.now() + this.cooldownMs;
    }
    this.state.set(name, s);
  }

  /** Ask the brain once. Fails only if EVERY gateway fails every round trip. */
  async chat(messages, opts = {}) {
    const attempts = [];
    for (let round = 1; round <= this.maxRoundTrips; round++) {
      for (const name of this.order) {
        if (this._isOpen(name)) {
          debugLog(`router: skip ${name} (circuit open for ${Math.ceil((this.state.get(name).openUntil - Date.now()) / 1000)}s)`);
          continue;
        }
        const gw = this.gateways.get(name);
        const t0 = Date.now();
        try {
          debugLog(`router: round ${round} trying ${name}…`);
          const out = await gw.chat(messages, opts);
          const latencyMs = Date.now() - t0;
          this._recordSuccess(name);
          return { ...out, gateway: name, latencyMs, attempts, round };
        } catch (e) {
          const latencyMs = Date.now() - t0;
          const isRate = e instanceof RateLimitError;
          this._recordFailure(name, isRate ? { rateLimited: true, retryAfterMs: e.retryAfterMs } : {});
          attempts.push({
            gateway: name,
            ok: false,
            latencyMs,
            error: isRate ? `rate-limited (${Math.round((e.retryAfterMs || 0) / 1000)}s)` : (e.message || String(e)),
          });
          debugLog(`router: ${name} failed → ${attempts[attempts.length - 1].error}`);
          if (isRate && round < this.maxRoundTrips) {
            const next = this.order.find((n) => n !== name && !this._isOpen(n));
            if (!next) {
              // Everyone else is parked too — wait for the shortest park time.
              const waitMs = Math.min(...this.order.map((n) => Math.max(0, this.state.get(n).openUntil - Date.now())).filter((v) => v > 0), 30000);
              if (waitMs > 0) {
                debugLog(`router: all circuits open, waiting ${Math.ceil(waitMs / 1000)}s`);
                await sleep(waitMs);
              }
            }
          }
        }
      }
    }
    const summary = attempts.map((a) => `${a.gateway}: ${a.error}`).join(' | ');
    throw new BuddyError(`all gateways failed after ${this.maxRoundTrips} round-trips — ${summary}`, {
      code: 'ALL_GATEWAYS_FAILED',
      data: attempts,
    });
  }

  healthSnapshot() {
    return this.order.map((name) => {
      const s = this.state.get(name) || {};
      return {
        name,
        circuitOpen: this._isOpen(name),
        failures: s.failures || 0,
        openForSecs: this._isOpen(name) ? Math.ceil((s.openUntil - Date.now()) / 1000) : 0,
      };
    });
  }
}
