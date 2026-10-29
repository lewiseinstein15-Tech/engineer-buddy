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
import { estimateTokens } from './usage.js';

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
   * @param {object} opts { gatewayOrder, failureThreshold, cooldownMs, maxRoundTrips,
   *   offlineFallback: async () => adapter|null — engaged ONCE after every
   *   gateway failed every round trip; a truthy adapter is registered and
   *   gets one full extra round (offline-first: ollama on a plane, v0.25.0) }
   */
  constructor(gateways, { gatewayOrder = [], failureThreshold = 2, cooldownMs = 120000, maxRoundTrips = 2, offlineFallback = null } = {}) {
    this.gateways = gateways;
    this.order = (gatewayOrder.length ? gatewayOrder : [...gateways.keys()]).filter((n) => gateways.has(n));
    if (!this.order.length) this.order = [...gateways.keys()];
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.maxRoundTrips = maxRoundTrips;
    this.offlineFallback = offlineFallback;
    this.state = new Map(); // name -> { failures, openUntil }
    for (const n of this.order) this.state.set(n, { failures: 0, openUntil: 0 });
    this.lastUsed = null;
    this.pinned = null; // v0.56.0: the explicit /model <name> choice — routing never demotes it
    this.latency = new Map(); // name -> EMA ms (self-healing routing, v0.25.0)
    this.offlineFallbackUsed = false; // one engagement per router — a dead machine stays dead
  }

  /** Fold one latency observation into the EMA (α = 0.3). Never throws. */
  noteLatency(name, ms) {
    const v = Number(ms);
    if (!name || !Number.isFinite(v) || v <= 0) return;
    const clamped = Math.min(Math.max(v, 5), 300000);
    const prev = this.latency.get(name);
    const ema = prev === undefined ? clamped : Math.round(prev * 0.7 + clamped * 0.3);
    this.latency.set(name, ema);
  }

  /** { name -> ema } view for persistence (routing-memory.js). */
  latencySnapshot() {
    return Object.fromEntries([...this.latency.entries()].map(([k, v]) => [k, { ema: v }]));
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
    const skipped = []; // gateways never tried this call — circuit open OR window too small
    // Context-limit enforcement (P1): a gateway whose window cannot hold the
    // request is skipped BEFORE we burn an attempt (and a timeout) on a call
    // the server will only reject. Request size is chars ÷ 4 — the same
    // estimate the compaction budget uses. When NO gateway fits, limits are
    // relaxed and the biggest windows are tried first: a maybe-rejected call
    // beats never calling at all.
    const reqChars = (Array.isArray(messages) ? messages : []).reduce((n, m) => {
      // Vision content arrays: only TEXT parts count — base64 payloads would
      // poison the token estimate (the transcript placeholder already did).
      const c = m?.content;
      if (Array.isArray(c)) return n + c.reduce((k, p) => k + (p?.type === 'text' ? String(p.text).length : 0), 0);
      return n + (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length);
    }, 0);
    const reqTok = estimateTokens(reqChars);
    // Vision routing (v0.13.3): a request carrying images goes to gateways
    // that can see first — a text-only model would reject or ignore them.
    const wantsVision = (Array.isArray(messages) ? messages : []).some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')
    );
    // Multi-model routing (v0.56.0): a per-call chain from the effort policy
    // REPLACES the base order for THIS call only. Hostile names are filtered
    // here — the router owns the registry, so it owns the filtering (non-
    // strings, unknown names, duplicates, '__proto__' never became a Map
    // key anyway). An all-junk chain degrades to the default order; circuit
    // breakers, ctx windows and vision-first compose ON TOP unchanged.
    let base = this.order;
    if (Array.isArray(opts.chain) && opts.chain.length) {
      const seen = new Set();
      const filtered = [];
      for (const n of opts.chain) {
        if (typeof n !== 'string' || seen.has(n) || !this.gateways.has(n)) continue;
        seen.add(n);
        filtered.push(n);
      }
      if (filtered.length) base = filtered;
    }
    let chain = base;
    if (wantsVision) {
      const canSee = base.filter((n) => this.gateways.get(n)?.vision);
      if (canSee.length && canSee.length < base.length) {
        chain = [...canSee, ...base.filter((n) => !canSee.includes(n))];
        debugLog(`router: image request — vision gateways first (${canSee.join(', ')})`);
      }
    }
    // Non-vision gateways get a string-only view: text parts joined, images
    // replaced by an honest omission note (a text-only API would 400 on
    // image parts — stripping beats crashing).
    const stripImages = (msgs) =>
      msgs.map((m) => {
        if (!Array.isArray(m.content)) return m;
        const text = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
        return { ...m, content: `${text}\n[image omitted — this gateway cannot see images]` };
      });
    const limitOf = (name) => this.gateways.get(name)?.ctxLimit || null;
    const fits = (name) => {
      const lim = limitOf(name);
      return !lim || reqTok <= lim;
    };
    const fitting = chain.filter(fits);
    let ignoreLimits = false;
    let effOrder = this.order;
    if (chain.length && !fitting.length) {
      ignoreLimits = true;
      effOrder = [...chain].sort((a, b) => (limitOf(b) || Infinity) - (limitOf(a) || Infinity));
      debugLog(`router: no gateway window holds ~${reqTok} tok — trying biggest windows first (limits relaxed)`);
    }
    // Walk the FULL chain order: fitting gateways are tried, oversized ones
    // are skipped in-loop WITH a recorded reason (the final error must show
    // every gateway and why it never answered — the v0.9.6 lesson).
    const loopOrder = ignoreLimits ? effOrder : chain;
    for (let round = 1; round <= this.maxRoundTrips; round++) {
      for (const name of loopOrder) {
        if (this._isOpen(name)) {
          const secs = Math.ceil((this.state.get(name).openUntil - Date.now()) / 1000);
          debugLog(`router: skip ${name} (circuit open for ${secs}s)`);
          // Surface the skip in the final error (v0.9.6 live test: the
          // brain-offline line showed kilo/pollinations/duckai but never
          // llm7 — its circuit was open, so it silently vanished from the
          // report and Lewis had no idea whether llm7 was even tried).
          if (!skipped.some((s) => s.gateway === name)) {
            skipped.push({ gateway: name, ok: false, latencyMs: 0, error: `circuit open (retry in ~${Math.max(secs, 1)}s)` });
          }
          continue;
        }
        if (!ignoreLimits && !fits(name)) {
          const lim = limitOf(name);
          debugLog(`router: skip ${name} (request ~${reqTok} tok > window ~${lim})`);
          if (!skipped.some((s) => s.gateway === name)) {
            skipped.push({ gateway: name, ok: false, latencyMs: 0, error: `context too big: request ~${Math.round(reqTok / 100) / 10}k tok > window ~${Math.round(lim / 100) / 10}k (gateways.<name>.ctxLimit)` });
          }
          continue;
        }
        const gw = this.gateways.get(name);
        const prepared = wantsVision && !gw.vision ? stripImages(messages) : messages;
        const t0 = Date.now();
        try {
          debugLog(`router: round ${round} trying ${name}…`);
          const out = await gw.chat(prepared, opts);
          const latencyMs = Date.now() - t0;
          this._recordSuccess(name);
          this.noteLatency(name, latencyMs);
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
            const next = loopOrder.find((n) => n !== name && !this._isOpen(n) && (ignoreLimits || fits(n)));
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
    // Offline-first (v0.25.0): every keyless gateway failed — maybe the
    // network is gone entirely. Engage the fallback factory ONCE (probe
    // localhost ollama, wired in brain/index.js); if a local brain answers,
    // register it into the chain and give it one full round. A failed probe
    // returns null and we fall through to the honest error.
    if (this.offlineFallback && !this.offlineFallbackUsed) {
      this.offlineFallbackUsed = true;
      try {
        const adapter = await this.offlineFallback();
        if (adapter?.chat) {
          const name = adapter.name || 'offline';
          this.gateways.set(name, adapter);
          if (!this.order.includes(name)) this.order.push(name);
          this.state.set(name, { failures: 0, openUntil: 0 });
          debugLog(`router: offline fallback engaged → ${name}, one extra round`);
          for (let round = 1; round <= this.maxRoundTrips; round++) {
            const t0 = Date.now();
            try {
              const out = await adapter.chat(messages, opts);
              const latencyMs = Date.now() - t0;
              this._recordSuccess(name);
              this.noteLatency(name, latencyMs);
              return { ...out, gateway: name, latencyMs, attempts, round, offline: true };
            } catch (e) {
              attempts.push({ gateway: name, ok: false, latencyMs: Date.now() - t0, error: e.message || String(e) });
            }
          }
        }
      } catch (e) {
        debugLog(`router: offline fallback probe failed: ${e.message}`);
      }
    }
    // Final report covers EVERY gateway in the chain: tried-and-failed AND
    // skipped (circuit open). One line, no gaps — plus an actionable wait
    // hint when rate limits are involved (v0.9.6 live test: kilo parked for
    // its exact Retry-After while the model kept retrying into a wall).
    const seen = new Map();
    for (const a of [...attempts, ...skipped]) if (!seen.has(a.gateway)) seen.set(a.gateway, a);
    const summary = this.order
      .filter((n) => seen.has(n))
      .map((n) => `${n}: ${seen.get(n).error}`)
      .join(' | ');
    const rateLimitedEntry = [...seen.values()].find((a) => /rate-limited/.test(a.error));
    let hint = '';
    if (rateLimitedEntry) {
      const waitSecs = Math.max(
        0,
        ...loopOrder.map((n) => Math.ceil((this.state.get(n).openUntil - Date.now()) / 1000))
      );
      hint = ` — wait ~${Math.max(waitSecs, 5)}s for the rate limit to lift, then say "continue"`;
    }
    throw new BuddyError(`all gateways failed after ${this.maxRoundTrips} round-trips — ${summary}${hint}`, {
      code: 'ALL_GATEWAYS_FAILED',
      data: { attempts, skipped },
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
