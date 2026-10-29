// mcphttp.js — remote MCP transports with auth that cannot leak (v0.48.0).
//
// §11 "MCP auth hardening — OAuth/mTLS for remote MCP transports; rate
// limits per server." The stdio host (src/tools/mcp.js) speaks to LOCAL
// servers; this module speaks to REMOTE ones over HTTP(S) — the Streamable
// HTTP shape of MCP: one JSON-RPC POST per message, responses come back as
// application/json or as a text/event-stream, and a session id issued by the
// server is echoed on every later request.
//
// Zero dependencies: node:http / node:https directly, because TLS options
// (ca/cert/key for mTLS) must be first-class and global fetch cannot carry a
// custom CA. One-way dependency: src/tools/mcp.js imports THIS module; this
// module imports nothing from it (no cycles).
//
// THE SECRET-HYGIENE CONTRACT (the wave's reason to exist):
//   - credentials live in the ENVIRONMENT, referenced from config by NAME
//     (tokenEnv / clientSecretEnv / ${VAR} inside header values);
//   - a config file that embeds a literal secret is REFUSED, a URL that
//     embeds credentials is REFUSED, tls.insecure is REFUSED — hardening
//     means some doors do not exist, not that they are merely locked;
//   - a missing env var is an honest connect failure — the literal ${VAR}
//     text is NEVER sent on the wire;
//   - credential VALUES never appear in any error, table row, or event:
//     auth failures name the header/config and the HTTP status, and response
//     BODIES are never quoted in errors at all (a hostile server that echoes
//     your token back in a 401 body leaks nothing);
//   - /mcp rows show maskAuth() summaries — header names, never values.
//
// Rate limits are per server (per connection, shared by all of its tools):
// a sliding-window budget checked before every bridged call. Exhaustion is
// an honest in-band ERROR observation — never an auto-sleep, never a throw.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { truncate, debugLog } from './util.js';

export const MCP_HTTP_PROTOCOL_VERSION = '2024-11-05';
// A hostile or broken remote cannot turn narration into an OOM vector: the
// same flood discipline the stdio transport applies to notifications applies
// to SSE events, and response bytes are capped outright.
export const MAX_NOTIFICATIONS = 200;
export const MAX_SSE_BYTES = 2 * 1024 * 1024;      // an SSE response may stream, bounded
export const MAX_BODY_BYTES = 8 * 1024 * 1024;     // a JSON response is bounded outright
export const REMOTE_DEFAULT_RATE = { max: 120, perMinutes: 1 }; // runaway-cost guard for remote servers

let nextId = 1;

/**
 * Sliding-window rate limiter. Injectable clock for tests. The hit list is
 * bounded by max (old entries are dropped on every check) — a flood cannot
 * grow it.
 */
export class RateLimiter {
  constructor({ max, perMinutes = 1, now = Date.now } = {}) {
    this.max = Math.floor(Number(max));
    this.perMinutes = Number(perMinutes);
    if (!Number.isFinite(this.max) || this.max <= 0) throw new Error('rateLimit.max must be a positive number');
    if (!Number.isFinite(this.perMinutes) || this.perMinutes <= 0) throw new Error('rateLimit.perMinutes must be a positive number');
    if (this.max > 100000) throw new Error('rateLimit.max is capped at 100000');
    if (this.perMinutes > 1440) throw new Error('rateLimit.perMinutes is capped at 1440 (one day)');
    this.windowMs = this.perMinutes * 60000;
    this.hits = [];
    this._now = typeof now === 'function' ? now : Date.now;
  }

  /** Take one budget slot. {ok:true} or {ok:false, retryAfterMs>0}. Never throws. */
  tryTake(nowMs = null) {
    try {
      const t = Number(nowMs ?? this._now());
      if (!Number.isFinite(t)) return { ok: false, retryAfterMs: this.windowMs };
      this.hits = this.hits.filter((h) => t - h < this.windowMs);
      if (this.hits.length >= this.max) {
        const retryAfterMs = Math.max(1, this.hits[0] + this.windowMs - t);
        return { ok: false, retryAfterMs };
      }
      this.hits.push(t);
      return { ok: true };
    } catch {
      return { ok: true }; // limiter breakage must never take the tool path down
    }
  }
}

/**
 * Expand ${NAME} references from the environment. Missing names are an
 * ERROR (the caller fails the connect honestly) — the literal ${NAME} text
 * must never reach the wire, because a broken credential placeholder sent
 * to a remote host is still a leak-shaped event.
 */
export function expandEnvVars(value, env = process.env) {
  const src = String(value ?? '');
  const missing = [];
  const out = src.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env?.[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return '';
    }
    return String(v);
  });
  if (missing.length) {
    throw new Error(`references missing environment variable(s): ${[...new Set(missing)].join(', ')} — set them before connecting; the placeholder is never sent`);
  }
  if (out.includes('${')) {
    // An unclosed or malformed placeholder is a config error, not a literal:
    // anything that looks like interpolation must either resolve or refuse.
    throw new Error('contains an unresolvable ${...} placeholder (missing closing brace or invalid name) — refusing to send it');
  }
  return out;
}

/** One header value, injection-checked: no CR/LF/NUL, no control chars, bounded. */
function checkHeaderValue(name, value) {
  const v = String(value ?? '');
  if (v.length > 4096) throw new Error(`header "${name}" is too long (4096 cap)`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) throw new Error(`header "${name}" contains control characters (CR/LF injection refused) — the header name is shown, the value never is`);
  return v;
}

/**
 * Resolve the mTLS option block: file paths → PEM contents. Validation
 * errors are honest and name the FILE, never file contents. `insecure` is
 * refused by validateRemoteSpec — certificate validation cannot be disabled
 * through config, so it is not even an option here.
 */
export function buildTlsOptions(tls, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  if (!tls || typeof tls !== 'object') return null;
  const out = {};
  for (const k of ['ca', 'cert', 'key']) {
    if (tls[k] === undefined || tls[k] === null) continue;
    if (typeof tls[k] !== 'string' || !tls[k].trim()) throw new Error(`tls.${k} must be a file path (string)`);
    try {
      out[k] = readFile(tls[k]);
    } catch (e) {
      throw new Error(`tls.${k}: cannot read "${tls[k]}": ${e?.code || e?.message || e}`);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Config validation for a remote server entry. Every refusal is a door that
 * does not exist (see the contract at the top). Returns a sanitized copy —
 * the copy keeps NAMES (env var names, header names, tokenUrl host), never
 * credential values, and is safe to keep on the client and render.
 */
export function validateRemoteSpec(spec = {}) {
  const url = String(spec.url ?? '');
  if (!url) throw new Error('remote mcp server needs a "url"');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`remote mcp url is not a valid URL: ${truncate(url, 80)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`remote mcp url must be http(s) — got "${u.protocol}"`);
  }
  if (u.username || u.password) {
    throw new Error('url must not embed credentials (user:pass@host) — values in URLs leak into logs; put credentials in headers/auth config, referenced from the environment');
  }
  const headers = {};
  if (spec.headers && typeof spec.headers === 'object') {
    for (const [k, v] of Object.entries(spec.headers)) {
      if (typeof v !== 'string') throw new Error(`header "${k}" must be a string value`);
      checkHeaderValue(k, v); // shape-check the raw form here; expansion re-checks later
      headers[String(k)] = v;
    }
  }
  let auth = null;
  if (spec.auth && typeof spec.auth === 'object') {
    const t = String(spec.auth.type || '');
    if (t === 'bearer') {
      if (spec.auth.token) throw new Error('auth.token in config is refused — use tokenEnv; config files leak');
      if (!spec.auth.tokenEnv) throw new Error('auth.type "bearer" needs tokenEnv — the token lives in the environment, never in the config file');
      auth = { type: 'bearer', tokenEnv: String(spec.auth.tokenEnv) };
    } else if (t === 'oauth2') {
      if (!spec.auth.tokenUrl) throw new Error('auth.type "oauth2" needs tokenUrl');
      if (!spec.auth.clientId) throw new Error('auth.type "oauth2" needs clientId');
      if (spec.auth.clientSecret) throw new Error('auth.clientSecret in config is refused — use clientSecretEnv; config files leak');
      if (!spec.auth.clientSecretEnv) throw new Error('auth.type "oauth2" needs clientSecretEnv — the secret lives in the environment, never in the config file');
      const tu = String(spec.auth.tokenUrl);
      let turl;
      try {
        turl = new URL(tu);
      } catch {
        throw new Error(`oauth2 tokenUrl is not a valid URL: ${truncate(tu, 80)}`);
      }
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(turl.hostname);
      if (turl.protocol !== 'https:' && !(turl.protocol === 'http:' && loopback)) {
        throw new Error(`oauth2 tokenUrl must be https (http is allowed only for loopback dev endpoints) — got "${turl.protocol}//${turl.hostname}"`);
      }
      auth = { type: 'oauth2', tokenUrl: tu, clientId: String(spec.auth.clientId), clientSecretEnv: String(spec.auth.clientSecretEnv), scope: spec.auth.scope ? String(spec.auth.scope) : null, tokenHost: turl.host };
    } else {
      throw new Error(`unknown auth.type "${truncate(t, 30)}" — supported: bearer, oauth2`);
    }
  }
  if (spec.tls !== undefined && spec.tls !== null && (typeof spec.tls !== 'object' || Array.isArray(spec.tls))) {
    throw new Error('tls must be an object {ca?, cert?, key?} of PEM file paths');
  }
  if (spec.tls && spec.tls.insecure !== undefined) {
    throw new Error('tls.insecure is not supported — certificate validation cannot be disabled through config');
  }
  let rateLimit = null;
  if (spec.rateLimit !== undefined && spec.rateLimit !== null) {
    if (typeof spec.rateLimit !== 'object') throw new Error('rateLimit must be an object {max, perMinutes}');
    rateLimit = { max: spec.rateLimit.max, perMinutes: spec.rateLimit.perMinutes ?? 1 };
  }
  return { url, headers, auth, tls: spec.tls || null, rateLimit };
}

/**
 * Human summary of a server's auth for /mcp rows and errors: NAMES only,
 * never values. The whole point of this function is that there is no code
 * path that needs the raw credential in a string.
 */
export function maskAuth(spec = {}) {
  const parts = [];
  if (spec.auth?.type === 'bearer') parts.push(`bearer via env ${spec.auth.tokenEnv}`);
  else if (spec.auth?.type === 'oauth2') parts.push(`oauth2 client-credentials (token from env ${spec.auth.clientSecretEnv})`);
  const nHeaders = Object.keys(spec.headers || {}).length;
  if (nHeaders) parts.push(`${nHeaders} custom header${nHeaders > 1 ? 's' : ''}`);
  if (spec.tls && (spec.tls.ca || spec.tls.cert || spec.tls.key)) parts.push('mTLS');
  if (!parts.length) parts.push('no auth');
  return parts.join(' · ');
}

/**
 * One remote MCP server connection (Streamable HTTP transport). Duck-types
 * the stdio McpClient surface (name/start/request/callTool/stop/tools/info/
 * closed) so connectMcpServers, buildMcpTools and /mcp treat both alike.
 *
 * Requests are id-matched; overlapping calls are safe. A 401 with an oauth2
 * config triggers exactly ONE token refresh + retry per request — a server
 * that rejects fresh credentials gets an honest error, never a loop.
 */
export class HttpMcpClient {
  constructor({
    name, url, headers = {}, auth = null, tls = null, rateLimit = null,
    initTimeoutMs = 15000, timeoutMs = 30000, onNotification = null,
    env = process.env, readFile = null, postImpl = null,
  } = {}) {
    if (!name || typeof name !== 'string') throw new Error('remote mcp server needs a name');
    this.spec = validateRemoteSpec({ url, headers, auth, tls, rateLimit });
    this.name = name; // pre-sanitized by the caller (mcp.js sanitizeName)
    this.url = this.spec.url;
    this.initTimeoutMs = initTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.onNotification = typeof onNotification === 'function' ? onNotification : null;
    this._env = env && typeof env === 'object' ? env : process.env;
    this._readFile = readFile || ((p) => fs.readFileSync(p, 'utf8'));
    this._post = postImpl || null; // test seam: inject the raw HTTP POST
    this.info = null;
    this.tools = [];
    this.closed = false;
    this.notifCount = 0; // flood-cap window, reset per request
    this.sessionId = null;
    this._token = null; // {value, expiresAt} for oauth2
    this.rateLimiter = this.spec.rateLimit ? new RateLimiter(this.spec.rateLimit) : null;
  }

  /** Route one notification to the narration tap — capped, never throws. */
  _note(msg) {
    if (!this.onNotification) return;
    try {
      const method = typeof msg?.method === 'string' ? msg.method : '';
      if (!method.startsWith('notifications/')) return;
      this.notifCount += 1;
      if (this.notifCount <= MAX_NOTIFICATIONS) {
        const p = msg?.params && typeof msg.params === 'object' ? msg.params : {};
        this.onNotification({ server: this.name, phase: method === 'notifications/progress' ? 'progress' : 'log', data: truncate(typeof p.data === 'string' ? p.data : JSON.stringify(p.data ?? ''), 200) });
      }
    } catch { /* a bad notification must never break the transport */ }
  }

  /**
   * Resolve credentials ONCE at start: bearer token from env, custom header
   * values with ${VAR} expansion. Missing env → honest failure HERE, so no
   * request is ever sent with a placeholder. Resolved values are kept on
   * `this` only as transport-internal state — nothing renders them.
   */
  _resolveCredentials() {
    const out = {};
    for (const [k, v] of Object.entries(this.spec.headers)) {
      out[k] = checkHeaderValue(k, expandEnvVars(v, this._env));
    }
    if (this.spec.auth?.type === 'bearer') {
      const tok = this._env[this.spec.auth.tokenEnv];
      if (!tok) throw new Error(`bearer auth references missing environment variable ${this.spec.auth.tokenEnv} — set it before connecting`);
      out.Authorization = checkHeaderValue('Authorization', `Bearer ${tok}`);
      this._bearerFromEnv = true;
    }
    return out;
  }

  _oauthTokenRequest() {
    const secret = this._env[this.spec.auth.clientSecretEnv];
    if (!secret) throw new Error(`oauth2 client credentials reference missing environment variable ${this.spec.auth.clientSecretEnv} — set it before connecting`);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.spec.auth.clientId,
      client_secret: secret,
      ...(this.spec.auth.scope ? { scope: this.spec.auth.scope } : {}),
    });
    return this._rawPost(this.spec.auth.tokenUrl, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }, this.initTimeoutMs);
  }

  /** Fetch (or force-refresh) the oauth2 token. Values stay in memory only. */
  async _refreshToken({ force = false } = {}) {
    if (this.spec.auth?.type !== 'oauth2') return false;
    if (!force && this._token && Date.now() < this._token.expiresAt) return true;
    const res = await this._oauthTokenRequest();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`oauth2 token request to ${this.spec.auth.tokenHost} failed (HTTP ${res.status}) — check the client credentials; the secret is never logged`);
    }
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`oauth2 token endpoint at ${this.spec.auth.tokenHost} did not return JSON`);
    }
    const tok = parsed?.access_token;
    if (!tok || typeof tok !== 'string') throw new Error(`oauth2 token endpoint at ${this.spec.auth.tokenHost} returned no access_token`);
    const ttl = Number.isFinite(Number(parsed.expires_in)) && Number(parsed.expires_in) > 30 ? Number(parsed.expires_in) - 30 : 270;
    this._token = { value: tok, expiresAt: Date.now() + ttl * 1000, gen: (this._token?.gen || 0) + 1 };
    return true;
  }

  /**
   * The raw HTTP POST. Returns {status, headers, text}. Response bodies are
   * captured for parsing but NEVER quoted into error strings by the caller.
   */
  _rawPost(target, body, headers, timeoutMs) {
    if (this._post) return this._post(target, body, headers, timeoutMs); // injected (tests)
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        reject(new Error(`bad url: ${e.message}`));
        return;
      }
      const isHttps = u.protocol === 'https:';
      let tlsOpts = null;
      try {
        tlsOpts = isHttps ? buildTlsOptions(this.spec.tls, this._readFile) : null;
      } catch (e) {
        reject(e);
        return;
      }
      const req = (isHttps ? https : http).request(u, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        ...(tlsOpts || {}),
      }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            req.destroy(new Error(`response exceeds ${MAX_BODY_BYTES} bytes — refused (a hostile body is not an OOM vector)`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(e));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
      req.on('error', (e) => reject(e));
      req.write(body);
      req.end();
    });
  }

  /**
   * POST one JSON-RPC message and resolve the matching response — through
   * application/json or a text/event-stream. Auth errors carry
   * `.authStatus` so request() can decide on the single oauth2 retry.
   */
  async _roundTrip(body, timeoutMs) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this._resolvedHeaders || {}),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (body.method !== 'initialize') headers['mcp-protocol-version'] = MCP_HTTP_PROTOCOL_VERSION;
    const res = await this._rawPost(this.url, JSON.stringify(body), headers, timeoutMs);
    this._lastResponseHeaders = res.headers; // start() reads the session id off the initialize response
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`remote server "${this.name}" rejected the credentials (HTTP ${res.status}) — check the auth config (${maskAuth(this.spec)}); credential values are never logged, response bodies are never quoted`);
      e.authStatus = res.status;
      throw e;
    }
    if (res.status === 404 && this.sessionId) {
      throw new Error(`remote server "${this.name}" no longer knows this session (HTTP 404) — reconnect to get a fresh one`);
    }
    if (res.status === 429) {
      const ra = parseInt(res.headers?.['retry-after'], 10);
      throw new Error(`remote server "${this.name}" is rate limiting us (HTTP 429${Number.isFinite(ra) ? `, server asks to retry after ${ra}s` : ''}) — backing off is the caller's decision, no auto-sleep`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`remote server "${this.name}" returned HTTP ${res.status} — response bodies are never quoted into errors`);
    }
    const ct = String(res.headers?.['content-type'] || '');
    if (ct.includes('text/event-stream')) {
      return this._consumeSse(res.text, body.id);
    }
    if (!ct.includes('json')) {
      throw new Error(`remote server "${this.name}" answered with Content-Type "${truncate(ct || '(none)', 40)}" — expected json or event-stream`);
    }
    return this._dispatchParsed(JSON.parse(res.text), body.id);
  }

  /** Parse an SSE payload: flood-capped notifications, then the id-matched response. */
  _consumeSse(text, id) {
    if (text.length > MAX_SSE_BYTES) {
      throw new Error(`remote server "${this.name}" streamed an SSE response over ${MAX_SSE_BYTES} bytes — refused`);
    }
    this.notifCount = 0;
    let sawResponse = false;
    let result = null;
    const frames = String(text).split(/\r?\n\r?\n/);
    for (const frame of frames) {
      const dataLines = frame.split(/\r?\n/).filter((l) => l.startsWith('data:'));
      if (!dataLines.length) continue;
      const payload = dataLines.map((l) => l.slice(5).trimStart()).join('\n');
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        continue; // keep-alive comments / junk frames — noise, not fatal
      }
      if (msg && typeof msg.method === 'string' && msg.method.startsWith('notifications/')) {
        this._note(msg); // counted + capped like the stdio transport
        continue;
      }
      if (msg && msg.id === id && !sawResponse) {
        sawResponse = true;
        result = msg;
      }
    }
    if (!sawResponse) throw new Error(`remote server "${this.name}" streamed an SSE response that never contained the reply to request ${id}`);
    return this._dispatchParsed(result, id);
  }

  /** Shared result/error routing (mirrors the stdio _handleLine semantics). */
  _dispatchParsed(msg, id) {
    if (msg?.error) {
      const e = new Error(`MCP error ${msg.error.code}: ${msg.error.message || 'unknown'}`);
      e.rpcCode = msg.error.code;
      throw e;
    }
    return msg?.result ?? {};
  }

  /** JSON-RPC request with timeout and the bounded oauth2 401-retry. */
  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) throw new Error(`server "${this.name}" is not running`);
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    try {
      return await this._roundTrip(body, timeoutMs);
    } catch (e) {
      if (e?.authStatus === 401 && this.spec.auth?.type === 'oauth2') {
        // Exactly one refresh + retry per request: a server that rejects a
        // FRESH token is telling the truth — surface it honestly, no loop.
        await this._refreshToken({ force: true });
        this._resolvedHeaders.Authorization = checkHeaderValue('Authorization', `Bearer ${this._token.value}`);
        return this._roundTrip(body, timeoutMs);
      }
      throw e;
    }
  }

  /** Fire-and-forget notification POST — non-2xx is tolerated by design. */
  async _sendNotification(notification) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this._resolvedHeaders || {}),
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      await this._rawPost(this.url, JSON.stringify(notification), headers, this.timeoutMs);
    } catch (e) {
      debugLog(`mcp ${this.name}: notification ${notification?.method} not acknowledged (${truncate(String(e?.message || e), 80)}) — notifications expect no response`);
    }
  }

  /**
   * Resolve credentials + TLS files, run the initialize handshake, capture
   * and sanitize the session id, announce initialization, list tools.
   */
  async start() {
    try {
      this._resolvedHeaders = this._resolveCredentials();
    } catch (e) {
      this.closed = true;
      throw new Error(`remote server "${this.name}" not started: ${e.message}`);
    }
    if (this.spec.auth?.type === 'oauth2') {
      try {
        await this._refreshToken();
        this._resolvedHeaders.Authorization = checkHeaderValue('Authorization', `Bearer ${this._token.value}`);
      } catch (e) {
        this.closed = true;
        throw new Error(`remote server "${this.name}" not started: ${e.message}`);
      }
    }
    // Per-request timeouts are enforced socket-side inside _rawPost
    // (req.setTimeout → destroy), so a hung remote cannot hang the start.
    try {
      const result = await this.request('initialize', {
        protocolVersion: MCP_HTTP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'engineer-buddy', version: '0.8.0' },
      }, this.initTimeoutMs);
      this.info = result?.serverInfo || null;
      const sid = this._lastResponseHeaders?.['mcp-session-id'];
      if (typeof sid === 'string' && sid) {
        // A hostile session id must not become a header-injection vector.
        this.sessionId = sid.replace(/[^\x21-\x7e]/g, '').slice(0, 200) || null;
      }
      await this._sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
      try {
        const listed = await this.request('tools/list', {}, this.initTimeoutMs);
        this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
      } catch (e) {
        debugLog(`mcp ${this.name}: tools/list failed — ${e.message}`);
        this.tools = [];
      }
      return this.info;
    } catch (e) {
      this.closed = true;
      throw e;
    }
  }

  callTool(name, args = {}, timeoutMs = this.timeoutMs) {
    return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  stop() {
    this.closed = true;
  }
}
