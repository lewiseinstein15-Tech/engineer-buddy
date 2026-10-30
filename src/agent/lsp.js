// lsp.js — LSP client over stdio JSON-RPC (v0.17.0), zero dependencies.
//
// The single highest-leverage checklist item: diagnostics feed back to the
// model automatically after every edit, so breakage is caught WITHOUT
// running the test suite. Zero-dep means we spawn the repo's OWN language
// server if present and degrade gracefully if not:
//   ts/js  → typescript-language-server --stdio   (also tsserver-based)
//   python → pylsp
//   go     → gopls
//
// Protocol: LSP is JSON-RPC 2.0 over stdio with Content-Length headers —
// NOT newline-delimited like MCP, so the framing lives here. Requests are
// id-matched; server→client notifications (publishDiagnostics) are collected.
//
// Honest scope: definition/references/diagnostics/didOpen/didChange are the
// supported surface. Completions and rename stay open (small free models
// rarely benefit; the regex index already navigates).
//
// v0.62.0 (the capability audit's gap #6 — LSP default-on): the knob
// becomes REAL. `chat.lsp` in .buddy/settings.json now actually controls
// every surface (before this, the setting was parsed nowhere and the
// tools' own error message cited a config path that could not do what it
// claimed — a lying knob). Rules mirror chat.workspaceWatch (v0.60):
//   absent | true            → on (the default)
//   false | 'off' | 'false'  → off (lsp_* tools removed, no post-edit
//                              diagnostics, no spawn is ever attempted)
//   anything else            → junk: NAMED, not applied, default (on) holds
// plus per-language server overrides:
//   chat.lsp.servers: { "rs": ["rust-analyzer"], "js": ["/path/ls", "--stdio"] }
// an override ADDS an extension not in the default map or REPLACES the
// default command for a known one. Junk shapes are NAMED per-entry and the
// default applies — one bad entry never vetoes the good ones.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { truncate } from '../util.js';

// language server command per file extension
const SERVER_FOR_EXT = {
  js: ['typescript-language-server', '--stdio'],
  jsx: ['typescript-language-server', '--stdio'],
  ts: ['typescript-language-server', '--stdio'],
  tsx: ['typescript-language-server', '--stdio'],
  py: ['pylsp'],
  go: ['gopls'],
};

const LANG_ID = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', go: 'go' };

let nextId = 1;

/** Safe property read: a throwing getter is junk, never a crash. */
function safeGet(obj, key) {
  try { return obj == null ? undefined : obj[key]; } catch { return undefined; }
}

function plainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // Map/class instances are not config shapes
}

/**
 * Resolve the chat.lsp value (v0.62.0). Mirrors resolveWatchSetting:
 * junk is NAMED and the default (on) applies.
 * @returns {{on: boolean, note: string|null}}
 */
export function resolveLspSetting(v) {
  if (v === undefined || v === null || v === true) return { on: true, note: null };
  if (v === false || v === 'off' || v === 'false') return { on: false, note: null };
  if (plainObject(v)) {
    // An object shape is a config (e.g. { servers: {...} }) — LSP stays on;
    // the servers inside are validated separately by validateLspServers.
    return { on: true, note: null };
  }
  let shown = '?';
  try { shown = sanitizeLspText(JSON.stringify(String(v)).slice(0, 60)); } catch { /* keep '?' */ }
  return { on: true, note: `chat.lsp: ${shown} is junk — NAMED, not applied; LSP stays on (false | 'off' turns it off)` };
}

const EXT_KEY_RE = /^[a-z][a-z0-9]{0,7}$/;
const MAX_SERVER_OVERRIDES = 16;
const MAX_CMD_PARTS = 8;

/**
 * Validate chat.lsp.servers (v0.62.0): one object whose values are
 * non-empty arrays of non-empty strings (command + args). Every junk
 * entry is NAMED and skipped — the defaults cover the rest. Extension
 * keys must match /^[a-z][a-z0-9]{0,7}$/ (this also refuses
 * __proto__/constructor-style keys, so a hostile settings file cannot
 * grow the prototype chain through the override door).
 * @returns {{servers: Object<string,string[]>, notes: string[]}}
 */
export function validateLspServers(raw) {
  const servers = {};
  const notes = [];
  if (raw === undefined || raw === null) return { servers, notes };
  if (!plainObject(raw)) {
    let shown = '?';
    try { shown = sanitizeLspText(JSON.stringify(String(raw)).slice(0, 60)); } catch { /* keep '?' */ }
    notes.push(`chat.lsp.servers: ${shown} is not an object — NAMED, ignored; the default servers apply`);
    return { servers, notes };
  }
  let keys;
  try { keys = Object.keys(raw); } catch { return { servers, notes: [...notes, 'chat.lsp.servers: unreadable — NAMED, ignored'] }; }
  let accepted = 0;
  for (const key of keys) {
    if (accepted >= MAX_SERVER_OVERRIDES) {
      notes.push(`chat.lsp.servers: more than ${MAX_SERVER_OVERRIDES} entries — the rest are NAMED and ignored`);
      break;
    }
    if (typeof key !== 'string' || !EXT_KEY_RE.test(key)) {
      notes.push(`chat.lsp.servers.${sanitizeLspText(String(key).slice(0, 20))}: not a file extension — NAMED, ignored (use e.g. "ts", "py", "rs")`);
      continue;
    }
    const arr = safeGet(raw, key);
    if (!Array.isArray(arr) || arr.length === 0 || arr.length > MAX_CMD_PARTS) {
      notes.push(`chat.lsp.servers.${key}: command must be a non-empty array of strings (max ${MAX_CMD_PARTS} parts) — NAMED, ignored`);
      continue;
    }
    let ok = true;
    const cmd = [];
    for (const part of arr) {
      let s;
      try { s = typeof part === 'string' ? part : String(part); } catch { ok = false; break; }
      if (typeof part !== 'string' || !s.trim() || s.length > 256) { ok = false; break; } // a 1e6-char arg is an E2BIG at spawn time — refuse here
      cmd.push(s);
    }
    if (!ok) {
      notes.push(`chat.lsp.servers.${key}: every command part must be a non-empty string (max 256 chars) — NAMED, ignored`);
      continue;
    }
    servers[key] = cmd;
    accepted += 1;
  }
  return { servers, notes };
}

function encode(message) {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
}

/**
 * One language-server connection. Spawn is LAZY and per-language; a missing
 * binary is a clean `available:false`, never a crash.
 */
export class LspConnection {
  constructor(root, ext, { timeoutMs = 10000, cmd = null } = {}) {
    this.root = root;
    this.ext = ext;
    this.lang = LANG_ID[ext] || 'plaintext';
    // cmd override (v0.62.0): a validated chat.lsp.servers entry replaces
    // the default command for this extension; null falls back to the map.
    this.cmd = Array.isArray(cmd) && cmd.length ? [...cmd] : SERVER_FOR_EXT[ext] || null;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.diagnostics = new Map(); // uri -> items[]
    this.available = false;
    this.unavailableReason = '';
    this.opened = new Set();
    this.stopped = false;
    this._startAttempted = false;
  }

  async start() {
    if (this.stopped) return false;
    if (this.available) return true;
    if (this._startAttempted) return false; // one attempt per session — a missing binary is remembered
    this._startAttempted = true;
    if (!this.cmd) {
      this.unavailableReason = `no language server known for .${this.ext}`;
      return false;
    }
    const [command, ...args] = this.cmd;
    try {
      this.child = spawn(command, args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.unavailableReason = e.message;
      return false;
    }
    let spawnFailed = false;
    this.child.on('error', (e) => {
      spawnFailed = true;
      this.unavailableReason = `${command} not runnable: ${e.message}`;
      this.available = false;
      for (const [, p] of this.pending) p.reject(new Error(this.unavailableReason));
      this.pending.clear();
    });
    this.child.stderr.on('data', () => {}); // servers log loudly; drain
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.on('close', () => {
      this.available = false;
      for (const [, p] of this.pending) p.reject(new Error('language server exited'));
      this.pending.clear();
    });

    // Handshake. A wrong/missing binary usually exits or errors instantly —
    // race both against the timeout.
    try {
      const result = await this.request('initialize', {
        processId: process.pid,
        rootUri: `file://${this.root}`,
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
          },
        },
      }, 6000);
      this.available = !spawnFailed && !!result;
      if (!this.available) this.unavailableReason ||= 'initialize handshake got no result';
      if (this.available) {
        this.notify('initialized', {});
        // didOpen can only be answered after initialize resolves
        for (const uri of this.opened) this._sendOpen(uri);
      }
      return this.available;
    } catch (e) {
      this.available = false;
      this.unavailableReason = e.message;
      return false;
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // LSP framing: Content-Length: N\r\n\r\n<body>
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this._resync(headerEnd + 4); // header without a usable Content-Length — search after it
        continue;
      }
      const len = Number(m[1]);
      if (!Number.isFinite(len) || len < 0 || len > LspConnection.MAX_FRAME_BYTES) {
        this._resync(headerEnd + 4); // hostile claimed length — search after it
        continue;
      }
      if (this.buffer.length > LspConnection.MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0); // unbounded-growth guard
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + len) return; // body not here yet
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch { this._resync(); continue; } // a body that lied about its own framing
      if (msg?.method === 'textDocument/publishDiagnostics') {
        this.diagnostics.set(msg.params?.uri, msg.params?.diagnostics || []);
      } else if (msg?.id !== undefined && msg?.id !== null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
      }
    }
  }

  // A claimed Content-Length larger than any real frame is hostile — without
  // a cap it wedges the connection (the parser waits for a 1e9-byte body)
  // and grows the buffer without bound. Over the cap: resync at the next
  // header (frames are independent; the next valid one carries its own).
  static MAX_FRAME_BYTES = 10 * 1024 * 1024;

  /**
   * Lost-framing recovery (v0.62.0 red-team catch): a short-claimed length
   * (or an unparseable body) leaves residue in the buffer, and the next
   * VALID frame appended after it desyncs the stream forever. Resync scans
   * forward to the next plausible header start — every frame carries
   * 'Content-Length:' as its first header field, so a live server is found;
   * a dead one is bounded by the request timeouts, never a hang.
   */
  _resync(after = 0) {
    const s = this.buffer.toString('latin1');
    const hay = after > 0 ? s.slice(after) : s;
    const m = /content-length:/i.exec(hay);
    this.buffer = Buffer.alloc(0);
    if (m) this.buffer = Buffer.from(s.slice(after + m.index), 'latin1');
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.stopped) {
        reject(new Error('language server not running'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(encode(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params = {}) {
    try {
      this.child?.stdin.write(encode(JSON.stringify({ jsonrpc: '2.0', method, params })));
    } catch { /* dying server — requests will surface it */ }
  }

  _sendOpen(uri) {
    try {
      const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
      const text = fs.readFileSync(filePath, 'utf8');
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.lang, version: 1, text },
      });
    } catch { /* unreadable file — request will fail on its own */ }
  }

  /** Ensure the file is open in the server, then return its URI. */
  async open(rel) {
    const abs = path.resolve(this.root, rel);
    const uri = `file://${abs}`;
    if (!this.opened.has(uri)) {
      this.opened.add(uri);
      if (this.available) this._sendOpen(uri);
    }
    return uri;
  }

  async _ensure() {
    if (this.available) return;
    const ok = await this.start().catch(() => false);
    if (!ok) throw new Error(`language server for .${this.ext} unavailable — ${this.unavailableReason || 'install it (typescript-language-server / pylsp / gopls)'}`);
  }

  async definition(rel, line0, char0) {
    await this._ensure();
    const uri = await this.open(rel);
    return this.request('textDocument/definition', { textDocument: { uri }, position: { line: line0, character: char0 } });
  }

  async references(rel, line0, char0, { includeDecl = false } = {}) {
    await this._ensure();
    const uri = await this.open(rel);
    return this.request('textDocument/references', {
      textDocument: { uri },
      position: { line: line0, character: char0 },
      context: { includeDeclaration: includeDecl },
    });
  }

  /** Diagnostics for one file: ensure the server is up, open, wait for the push. */
  async diagnosticsFor(rel, { waitMs = 1200 } = {}) {
    if (!this.available) {
      const ok = await this.start(); // memoized — a missing binary pays once
      if (!ok) return [];
    }
    const abs = path.resolve(this.root, rel);
    const uri = `file://${abs}`;
    await this.open(rel);
    // A change nudges the server to re-publish even if it cached the doc.
    // An unreadable file (missing, deleted mid-flight, unreadable perms) is
    // honest empty — never a throw out of the hub (v0.62.0 red-team catch:
    // the ENOENT escaped this function and rejected the caller).
    let text;
    try { text = fs.readFileSync(abs, 'utf8').split('\n'); } catch { return this.diagnostics.get(uri) || []; }
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text: text.join('\n') }],
    });
    const deadline = Date.now() + waitMs;
    let items = this.diagnostics.get(uri);
    while (Date.now() < deadline) {
      items = this.diagnostics.get(uri);
      if (items) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return items || [];
  }

  stop() {
    this.stopped = true;
    try { this.child?.kill('SIGTERM'); } catch { /* gone */ }
    this.child = null;
    this.available = false;
  }
}

/** Which extension a path maps to under the DEFAULT map (null = unsupported).
 * Kept for back-compat — surfaces that hold a hub should prefer hub.extFor,
 * which honors chat.lsp.servers overrides. */
export function lspExtFor(rel) {
  const ext = path.extname(String(rel || '')).slice(1).toLowerCase();
  return SERVER_FOR_EXT[ext] ? ext : null;
}

/**
 * One LSP hub per session: lazily spawns one connection per language on
 * first use, cached. `status()` lists what is live / missing (for /context
 * or the /tools footer).
 */
export function createLspHub(root, { servers = {} } = {}) {
  // The merged extension map (v0.62.0): validated overrides REPLACE the
  // default command for a known extension or ADD a new one. Everything the
  // hub routes by — get(), extFor(), status() — reads this map, so an
  // override is honored on every path (before this, override-shaped
  // config could not have reached the hub at all).
  const merged = { ...SERVER_FOR_EXT };
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    for (const [ext, cmd] of Object.entries(servers)) {
      if (EXT_KEY_RE.test(ext) && Array.isArray(cmd) && cmd.length) merged[ext] = [...cmd];
    }
  }
  const conns = new Map(); // ext -> LspConnection
  let probe = null; // memoized availability report
  const get = (ext) => {
    if (!conns.has(ext)) conns.set(ext, new LspConnection(root, ext, { cmd: merged[ext] }));
    return conns.get(ext);
  };
  const extFor = (rel) => {
    try {
      const e = path.extname(String(rel || '')).slice(1).toLowerCase();
      return merged[e] ? e : null;
    } catch {
      return null; // a hostile path value (throwing toString) is unsupported, never a crash
    }
  };
  const extLabel = (rel) => {
    try { return `.${path.extname(String(rel || '')).slice(1) || '?'}`; } catch { return '(unreadable path)'; }
  };
  const hub = {
    /** Extension for a path under the MERGED map (null = unsupported). */
    extFor,
    async definition(rel, line, char) { const e = extFor(rel); return e ? get(e).definition(rel, line, char) : Promise.reject(new Error(`no language server known for ${extLabel(rel)} — set one under chat.lsp.servers`)); },
    async references(rel, line, char, opts) { const e = extFor(rel); return e ? get(e).references(rel, line, char, opts) : Promise.reject(new Error(`no language server known for ${extLabel(rel)} — set one under chat.lsp.servers`)); },
    async diagnosticsFor(rel, opts) { const e = extFor(rel); return e ? get(e).diagnosticsFor(rel, opts) : Promise.resolve([]); },
    status() {
      if (!probe) {
        const present = [];
        const missing = [];
        for (const [ext, cmd] of Object.entries(merged)) {
          try {
            const r = spawnSync(cmd[0], ['--version'], { timeout: 2000 });
            if (r.status === 0) present.push(ext);
            else missing.push(`${ext} (${cmd[0]})`);
          } catch {
            missing.push(`${ext} (${cmd[0]})`);
          }
        }
        probe = { present, missing };
      }
      return probe;
    },
    stop() { for (const c of conns.values()) c.stop(); },
  };
  return hub;
}

/**
 * Server-supplied text is DATA (v0.62.0): the chat.lsp.servers override
 * door can point at ANY binary, so a hostile language server is a real
 * surface. Whole ANSI/OSC sequences are stripped (an unterminated sequence
 * swallows to its terminator, the next ESC, or end-of-string — the
 * v0.55/v0.61 lesson carried to the LSP plane), control bytes dropped
 * (tab and newline survive), visible words survive — a hostile diagnostic
 * cannot paint a terminal or smuggle line machinery into an observation.
 */
export function sanitizeLspText(s) {
  let t;
  try { t = String(s ?? ''); } catch { t = '?'; } // a toString bomb is data, never a crash
  // eslint-disable-next-line no-control-regex
  return t
    .replace(/\u001B\][^\u0007]*?(?:\u0007|\u001B\\|(?=\u001B)|$)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*$/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ''); // keep \t (\u0009) and \n (\u000A)
}

/** Render LSP diagnostic items into a model-friendly capped string. */
export function formatDiagnostics(items, rel, { maxItems = 12 } = {}) {
  if (!items.length) return '';
  const sev = (s) => (s === 1 ? 'error' : s === 2 ? 'warning' : 'info');
  const lines = items.slice(0, maxItems).map((d) => {
    const pos = d.range?.start ? `${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1}` : '?';
    return `  ${rel}:${pos} ${sev(d.severity)}: ${truncate(sanitizeLspText(d.message || ''), 200).replace(/\n+/g, ' ')}`;
  });
  const more = items.length > maxItems ? `\n  … +${items.length - maxItems} more` : '';
  return `${lines.join('\n')}${more}`;
}
