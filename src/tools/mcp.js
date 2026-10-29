// mcp.js — Model Context Protocol client, zero-dependency stdio transport.
//
// Buddy becomes an MCP HOST (Claude Code's .mcp.json equivalent): external
// tool servers are spawned as child processes and spoken to with JSON-RPC 2.0
// over stdin/stdout (newline-delimited — the MCP stdio transport). Every tool
// a server exposes is bridged into Buddy's tool registry as
//   mcp__<server>__<tool>
// so the brain can call it exactly like a native tool.
//
// Config: .buddy/mcp.json in the workspace
//   {
//     "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] },
//       "fetch":      { "command": "uvx", "args": ["mcp-server-fetch"], "env": {"KEY":"v"} }
//     }
//   }
//
// Safety model (harness guardrail discipline):
//   - servers are user-configured (running them is the user's explicit choice)
//   - bridged tools are `risky` → first use goes through the approval gate,
//     "always" is remembered per session (Claude Code's per-tool consent)
//   - every request is timeout-capped; a dead server degrades to ERROR
//     observations and never crashes the main loop
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truncate, debugLog, baseSpawnEnv } from '../util.js';
import { enabledPlugins } from '../plugins.js';
import { HttpMcpClient, RateLimiter, maskAuth } from '../mcphttp.js';

export const MCP_CONFIG_PATH = '.buddy/mcp.json';
export const MCP_PROTOCOL_VERSION = '2024-11-05';
// A flooding server gets its first MAX_NOTIFICATIONS through per request
// window; the rest are dropped (counted, never buffered) — narration must
// never become an OOM vector.
export const MAX_NOTIFICATIONS = 200;
// Bridged tool names must survive the `mcp__<server>__<tool>` join without
// corrupting cards or registries: a hostile server name/tool is skipped
// honestly (lands in the invalid list), never bridged.
export const TOOL_NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

let nextId = 1;

/**
 * Parse one server notification (v0.44.0: the unified protocol streams in
 * BOTH directions) into a narration event. Returns null for anything that is
 * not a recognized notification — unknown methods are forward-compatible
 * noise and stay ignored. Pure; exported for tests.
 */
export function parseNotification(msg, serverName = '?') {
  const method = typeof msg?.method === 'string' ? msg.method : '';
  if (!method.startsWith('notifications/')) return null;
  const p = msg?.params && typeof msg.params === 'object' ? msg.params : {};
  if (method === 'notifications/progress') {
    return {
      kind: 'progress',
      ev: {
        server: serverName,
        phase: 'progress',
        progress: Number.isFinite(Number(p.progress)) ? Number(p.progress) : null,
        total: Number.isFinite(Number(p.total)) && Number(p.total) > 0 ? Number(p.total) : null,
        message: truncate(String(p.message ?? ''), 120),
      },
    };
  }
  if (method === 'notifications/message') {
    const LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);
    return {
      kind: 'log',
      ev: {
        server: serverName,
        phase: 'log',
        level: LEVELS.has(String(p.level)) ? String(p.level) : 'info',
        logger: truncate(String(p.logger ?? ''), 40),
        data: truncate(typeof p.data === 'string' ? p.data : JSON.stringify(p.data ?? ''), 200),
      },
    };
  }
  return null;
}

// Reserved JS-mechanics names: a config or plugin server with one of these
// names would set `out[name] = …` straight into the object's prototype
// machinery (the red team proved `__proto__` silently vanishes — it sets
// [[Prototype]] instead of an own key). They are renamed, deterministically,
// before they can ever become a key.
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeName(s) {
  const clean = String(s || 'server').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return RESERVED_NAMES.has(clean) ? `${clean}-reserved` : clean;
}

function toolArgsHint(inputSchema) {
  // Turn a JSON Schema into the compact args hint the protocol preamble shows.
  try {
    const props = inputSchema?.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : null;
    if (!props || !Object.keys(props).length) return '{}';
    const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
    const obj = {};
    for (const [k, v] of Object.entries(props)) obj[k] = required.has(k) ? `<${v?.type || 'value'}>` : `<${v?.type || 'value'}|optional>`;
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

/**
 * One MCP server connection (stdio transport). Requests are id-matched so
 * overlapping calls are safe; a closed/crashed process rejects pending and
 * future requests until stopped (callers degrade that to ERROR strings).
 */
export class McpClient {
  /**
   * @param {object} p
   * @param {string} p.name        server name (from config key)
   * @param {string} p.command     executable to spawn
   * @param {string[]} [p.args]    argv for the executable
   * @param {object} [p.env]       extra environment variables
   * @param {number} [p.initTimeoutMs]  initialize handshake budget (default 15000)
   * @param {number} [p.timeoutMs]     per-request budget (default 30000)
   * @param {function} [p.onNotification] narration tap for server→client
   *   notifications ({server, phase:'progress'|'log', ...}) — flood-capped,
   *   a hostile or broken server can never crash the transport through it.
   */
  constructor({ name, command, args = [], env = {}, initTimeoutMs = 15000, timeoutMs = 30000, onNotification = null, rateLimit = null } = {}) {
    this.name = sanitizeName(name);
    this.command = String(command || '');
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === 'object' ? env : {};
    this.initTimeoutMs = initTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.onNotification = typeof onNotification === 'function' ? onNotification : null;
    // v0.48.0 — optional per-server rate budget (sliding window). null = no
    // limit, the long-standing stdio behavior; remote servers default to a
    // budget set in connectMcpServers.
    this.rateLimiter = rateLimit ? new RateLimiter(rateLimit) : null;
    this.child = null;
    this.info = null; // serverInfo from initialize
    this.tools = []; // tool descriptions from tools/list
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.closed = false;
    this.buffer = '';
    this.notifCount = 0; // flood cap window (reset per request)
  }

  /** Route one notification to the narration tap — capped, never throws. */
  _note(msg) {
    if (!this.onNotification) return;
    try {
      const parsed = parseNotification(msg, this.name);
      if (!parsed) return; // unknown notification — forward-compatible silence
      this.notifCount += 1;
      if (this.notifCount <= MAX_NOTIFICATIONS) this.onNotification(parsed.ev);
    } catch {
      /* a bad notification must never break the transport */
    }
  }

  _send(obj) {
    if (!this.child || this.closed) throw new Error(`server "${this.name}" is not running`);
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      return; // non-JSON stdout noise — servers sometimes print banners
    }
    // Notifications are routed by METHOD, never by id — a notification that
    // carries a pending request's id is still a notification and must never
    // resolve or reject that request (red-team pinned).
    if (typeof msg?.method === 'string' && msg.method.startsWith('notifications/')) {
      this._note(msg);
      return;
    }
    if (msg?.id === undefined || msg?.id === null) return; // id-less non-notification noise
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message || 'unknown'}`));
    else p.resolve(msg.result);
  }

  /**
   * JSON-RPC request with timeout. Rejects (never throws into the caller's
   * stack) — callers wrap with .catch() to degrade gracefully.
   */
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child) {
        reject(new Error(`server "${this.name}" is not running`));
        return;
      }
      const id = nextId++;
      this.notifCount = 0; // fresh flood-cap window per request
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" to "${this.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Spawn the server and perform the MCP initialize handshake + initialized
   * notification. Resolves with serverInfo.
   */
  start() {
    return new Promise((resolve, reject) => {
      if (!this.command) {
        reject(new Error('mcp server config needs a "command"'));
        return;
      }
      let child;
      try {
        child = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...baseSpawnEnv(), ...this.env },
        });
      } catch (e) {
        reject(e);
        return;
      }
      this.child = child;

      const fail = (err) => {
        if (this.closed) return;
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(err);
      };

      child.on('error', (e) => fail(new Error(`cannot start "${this.command}": ${e.message}`)));
      child.on('close', (code) => fail(new Error(`server "${this.name}" exited (code ${code})`)));
      child.stderr.on('data', () => {
        /* server logs are drained, never surfaced (kept out of the model's context) */
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          this._handleLine(line);
        }
      });

      // Handshake: initialize → result → notifications/initialized → tools/list.
      const initTimer = setTimeout(() => fail(new Error(`server "${this.name}" did not answer initialize within ${this.initTimeoutMs}ms`)), this.initTimeoutMs);
      this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'engineer-buddy', version: '0.8.0' },
      }, this.initTimeoutMs)
        .then(async (result) => {
          this.info = result?.serverInfo || null;
          try {
            this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          } catch {
            /* transport dying — the close handler will surface it */
          }
          clearTimeout(initTimer);
          try {
            const listed = await this.request('tools/list', {}, this.initTimeoutMs);
            this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
          } catch (e) {
            debugLog(`mcp ${this.name}: tools/list failed — ${e.message}`);
            this.tools = [];
          }
          resolve(this.info);
        })
        .catch((e) => {
          clearTimeout(initTimer);
          fail(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  /** Call a tool on this server. Returns the raw result object. */
  callTool(name, args = {}, timeoutMs = this.timeoutMs) {
    return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  /** Stop the server and reject anything still pending. */
  stop() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`server "${this.name}" stopped`));
    }
    this.pending.clear();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      this.child = null;
    }
  }
}

/**
 * One server entry from any config source. v0.48.0: an entry is EITHER a
 * local stdio server (command) OR a remote one (url — validated later by
 * HttpMcpClient, whose refusals land in connectMcpServers' failed list
 * honestly). Everything is passed through as-is; the transports own their
 * config contracts.
 */
function normalizeServerEntry(name, cfg) {
  const clean = sanitizeName(name);
  const base = { name: clean };
  if (cfg.url) {
    const entry = { ...base, url: String(cfg.url) };
    if (cfg.headers !== undefined) entry.headers = cfg.headers;
    if (cfg.auth !== undefined) entry.auth = cfg.auth;
    if (cfg.tls !== undefined) entry.tls = cfg.tls;
    return entry;
  }
  if (!cfg.command) return null;
  return {
    ...base,
    command: String(cfg.command),
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    env: cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [String(k), String(v)])) : {},
  };
}

function entryExtras(cfg) {
  // Transport-shared optional config, passed through for both kinds.
  const out = {};
  if (cfg.rateLimit !== undefined) out.rateLimit = cfg.rateLimit;
  return out;
}

/** Read .buddy/mcp.json (v0.48.0: command OR url entries). */
export function loadMcpConfig(root = process.cwd()) {
  const file = path.join(root, MCP_CONFIG_PATH);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no config — the normal case, zero overhead
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${MCP_CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : null;
  const out = {};
  if (servers) {
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) {
        out[sanitizeName(name)] = { ...normalizeServerEntry(name, cfg), ...entryExtras(cfg) };
      }
    }
    return { mcpServers: out };
  }
  // Tolerant fallback: a bare {name: {command|url,...}} map also works.
  for (const [name, cfg] of Object.entries(parsed || {})) {
    if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) {
      out[sanitizeName(name)] = { ...normalizeServerEntry(name, cfg), ...entryExtras(cfg) };
    }
  }
  return { mcpServers: out };
}

/**
 * Connect to every configured server (in parallel, capped by init timeout).
 * Plugin mcp.json fragments (v0.39.0 §3) merge in after the project config —
 * a name collision or a broken fragment lands in `failed` honestly and never
 * blocks startup. Never throws — failures land in `failed` so one bad server
 * never blocks startup. Returns { connected: [{name, client, tools}], failed: [{name, error}] }.
 */
export async function connectMcpServers(root = process.cwd(), { initTimeoutMs = 15000, home = os.homedir(), onNotification = null } = {}) {
  let cfg;
  try {
    cfg = loadMcpConfig(root);
  } catch (e) {
    return { connected: [], failed: [{ name: MCP_CONFIG_PATH, error: e.message }] };
  }
  const servers = { ...(cfg?.mcpServers || {}) };
  const failed = [];
  // Plugin fragments: each enabled plugin may carry its own mcp.json.
  // Project config wins on a server-name collision (plugin copy skipped).
  const { plugins, warnings: pluginWarnings } = enabledPlugins({ root, home });
  for (const w of pluginWarnings) failed.push({ name: 'plugins', error: truncate(w, 160) });
  for (const p of plugins) {
    const fragPath = path.join(p.dir, 'mcp.json');
    let raw;
    try {
      raw = fs.readFileSync(fragPath, 'utf8');
    } catch {
      continue; // no fragment — normal
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      failed.push({ name: `plugin:${p.name}`, error: `mcp.json is not valid JSON: ${truncate(String(e.message), 120)}` });
      continue;
    }
    const frag = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
    for (const [name, spec] of Object.entries(frag)) {
      if (!spec || typeof spec !== 'object' || (!spec.command && !spec.url)) {
        failed.push({ name: `plugin:${p.name}`, error: `mcp server "${name}" needs a "command" or a "url"` });
        continue;
      }
      const clean = sanitizeName(name);
      if (servers[clean]) {
        failed.push({ name: `plugin:${p.name}`, error: `mcp server "${clean}" already defined — project config wins` });
        continue;
      }
      servers[clean] = { ...normalizeServerEntry(name, spec), ...entryExtras(spec) };
    }
  }
  if (!Object.keys(servers).length) return { connected: [], failed };

  const results = await Promise.all(
    Object.values(servers).map(async (spec) => {
      // v0.48.0 — remote servers ride the HTTP transport; a remote without an
      // explicit budget gets the default one (a runaway loop against someone
      // else's machine must cost neither them nor us more than the budget).
      // Local stdio servers keep the long-standing unlimited default.
      const rateLimit = spec.url
        ? (spec.rateLimit ?? { max: 120, perMinutes: 1 })
        : spec.rateLimit ?? null;
      let client;
      try {
        client = spec.url
          ? new HttpMcpClient({ ...spec, rateLimit, initTimeoutMs, onNotification })
          : new McpClient({ ...spec, rateLimit, initTimeoutMs, onNotification });
      } catch (e) {
        // Config-validation refusals (literal secrets, tls.insecure, URL
        // credentials…) land here — honest, named, never blocking the rest.
        return { ok: false, entry: { name: sanitizeName(spec?.name || 'server'), error: truncate(String(e?.message || e), 200) } };
      }
      try {
        await client.start();
        return { ok: true, entry: { name: client.name, client, tools: client.tools } };
      } catch (e) {
        client.stop();
        return { ok: false, entry: { name: client.name, error: truncate(String(e?.message || e), 200) } };
      }
    })
  );

  // Merge-phase failures (plugin collisions, junk fragments) AND spawn-phase
  // failures both land in `failed` — one must never erase the other.
  return {
    connected: results.filter((r) => r.ok).map((r) => r.entry),
    failed: [...failed, ...results.filter((r) => !r.ok).map((r) => r.entry)],
  };
}

/**
 * Bridge connected MCP servers into the tool registry. Every exposed tool
 * becomes `mcp__<server>__<tool>`, marked risky (first use hits the approval
 * gate — Claude Code's per-tool consent, remembered as "always").
 * v0.44.0: tool names are validated (a hostile server cannot bridge a name
 * that corrupts registries/cards) and invalid ones are reported, not bridged.
 */
export function buildMcpTools(connections = []) {
  const tools = [];
  const invalid = [];
  for (const conn of connections) {
    for (const t of conn.tools || []) {
      const toolName = typeof t?.name === 'string' ? t.name : '';
      if (!toolName || !TOOL_NAME_OK.test(toolName)) {
        if (toolName) invalid.push(`${conn.name}/${toolName}`);
        continue;
      }
      const fullName = `mcp__${conn.name}__${toolName}`;
      const description = String(t?.description || toolName).slice(0, 300);
      const rl = conn.client?.rateLimiter || null;
      tools.push({
        name: fullName,
        description: `[mcp:${conn.name}] ${description}`,
        args: toolArgsHint(t?.inputSchema),
        risky: true,
        render: (a) => `${fullName} ${truncate(JSON.stringify(a ?? {}), 90)}`,
        run: async (args = {}) => {
          // v0.48.0 — the per-server budget is checked BEFORE the wire. All
          // of one server's tools share it. Exhaustion is an honest in-band
          // observation; the model can back off; nothing auto-sleeps.
          if (rl) {
            const take = rl.tryTake();
            if (!take.ok) {
              const secs = Math.max(1, Math.ceil(take.retryAfterMs / 1000));
              return `ERROR (mcp:${conn.name}): rate limited — the per-server budget (${rl.max} calls / ${rl.perMinutes} min) is exhausted; retry in ~${secs}s (sliding window). No call was made.`;
            }
          }
          try {
            const res = await conn.client.callTool(toolName, args);
            const content = Array.isArray(res?.content) ? res.content : [];
            const text = content
              .map((c) => (c?.type === 'text' ? String(c.text ?? '') : c?.type ? `[${c.type} content]` : ''))
              .filter(Boolean)
              .join('\n')
              .trim();
            if (res?.isError) return `ERROR (mcp:${conn.name}): ${truncate(text || 'tool reported an error', 4000)}`;
            return truncate(text || '(empty result)', 12000);
          } catch (e) {
            return `ERROR (mcp:${conn.name}): ${truncate(String(e?.message || e), 300)} — is the server still running? Check /mcp.`;
          }
        },
      });
    }
  }
  tools.invalid = invalid; // honestly surfaced, never silently dropped
  return tools;
}

/** Rows for the /mcp slash command table. Remote rows show host + masked auth — never a credential value. */
export function describeMcpServers(connections = [], failed = []) {
  const rows = [];
  for (const c of connections) {
    let info;
    if (c.client?.url) {
      let host = '-';
      try { host = new URL(c.client.url).host; } catch { /* junk urls cannot reach here — validated at start */ }
      info = `${host} (${maskAuth(c.client.spec)})`;
    } else {
      info = c.client?.info?.name || c.client?.command || '-';
    }
    rows.push(['✓', c.name, String((c.tools || []).length), truncate(info, 40)]);
  }
  for (const f of failed) {
    rows.push(['✗', f.name, '-', truncate(f.error || 'failed', 40)]);
  }
  return rows;
}
