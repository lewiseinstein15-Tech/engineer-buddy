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
import { truncate, debugLog } from '../util.js';
import { enabledPlugins } from '../plugins.js';

export const MCP_CONFIG_PATH = '.buddy/mcp.json';
export const MCP_PROTOCOL_VERSION = '2024-11-05';

let nextId = 1;

function sanitizeName(s) {
  return String(s || 'server').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
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
   */
  constructor({ name, command, args = [], env = {}, initTimeoutMs = 15000, timeoutMs = 30000 } = {}) {
    this.name = sanitizeName(name);
    this.command = String(command || '');
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === 'object' ? env : {};
    this.initTimeoutMs = initTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.info = null; // serverInfo from initialize
    this.tools = []; // tool descriptions from tools/list
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.closed = false;
    this.buffer = '';
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
    if (msg?.id === undefined || msg?.id === null) return; // notification from server — ignored for now
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
          env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NO_COLOR: '1', ...this.env },
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

/** Read .buddy/mcp.json. Returns {mcpServers:{name:{command,args,env}}} or null. */
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
      if (cfg && typeof cfg === 'object' && cfg.command) {
        out[sanitizeName(name)] = {
          name: sanitizeName(name),
          command: String(cfg.command),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [String(k), String(v)])) : {},
        };
      }
    }
    return { mcpServers: out };
  }
  // Tolerant fallback: a bare {name: {command,...}} map also works.
  for (const [name, cfg] of Object.entries(parsed || {})) {
    if (cfg && typeof cfg === 'object' && cfg.command) {
      out[sanitizeName(name)] = {
        name: sanitizeName(name),
        command: String(cfg.command),
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [String(k), String(v)])) : {},
      };
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
export async function connectMcpServers(root = process.cwd(), { initTimeoutMs = 15000, home = os.homedir() } = {}) {
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
      if (!spec || typeof spec !== 'object' || !spec.command) {
        failed.push({ name: `plugin:${p.name}`, error: `mcp server "${name}" needs a "command"` });
        continue;
      }
      const clean = sanitizeName(name);
      if (servers[clean]) {
        failed.push({ name: `plugin:${p.name}`, error: `mcp server "${clean}" already defined — project config wins` });
        continue;
      }
      servers[clean] = {
        name: clean,
        command: String(spec.command),
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        env: spec.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [String(k), String(v)])) : {},
      };
    }
  }
  if (!Object.keys(servers).length) return { connected: [], failed };

  const results = await Promise.all(
    Object.values(servers).map(async (spec) => {
      const client = new McpClient({ ...spec, initTimeoutMs });
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
 */
export function buildMcpTools(connections = []) {
  const tools = [];
  for (const conn of connections) {
    for (const t of conn.tools || []) {
      const toolName = typeof t?.name === 'string' ? t.name : '';
      if (!toolName) continue;
      const fullName = `mcp__${conn.name}__${toolName}`;
      const description = String(t?.description || toolName).slice(0, 300);
      tools.push({
        name: fullName,
        description: `[mcp:${conn.name}] ${description}`,
        args: toolArgsHint(t?.inputSchema),
        risky: true,
        render: (a) => `${fullName} ${truncate(JSON.stringify(a ?? {}), 90)}`,
        run: async (args = {}) => {
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
  return tools;
}

/** Rows for the /mcp slash command table. */
export function describeMcpServers(connections = [], failed = []) {
  const rows = [];
  for (const c of connections) {
    rows.push(['✓', c.name, String((c.tools || []).length), truncate(c.client?.info?.name || c.client?.command || '-', 40)]);
  }
  for (const f of failed) {
    rows.push(['✗', f.name, '-', truncate(f.error || 'failed', 40)]);
  }
  return rows;
}
