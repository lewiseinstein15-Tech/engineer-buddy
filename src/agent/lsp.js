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

function encode(message) {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
}

/**
 * One language-server connection. Spawn is LAZY and per-language; a missing
 * binary is a clean `available:false`, never a crash.
 */
export class LspConnection {
  constructor(root, ext, { timeoutMs = 10000 } = {}) {
    this.root = root;
    this.ext = ext;
    this.lang = LANG_ID[ext] || 'javascript';
    this.cmd = SERVER_FOR_EXT[ext] || null;
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
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buffer.length < headerEnd + 4 + len) return; // body not here yet
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch { continue; }
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
    const text = fs.readFileSync(abs, 'utf8').split('\n');
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

/** Which extension a path maps to (null = no language server support). */
export function lspExtFor(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return SERVER_FOR_EXT[ext] ? ext : null;
}

/**
 * One LSP hub per session: lazily spawns one connection per language on
 * first use, cached. `status()` lists what is live / missing (for /context
 * or the /tools footer).
 */
export function createLspHub(root) {
  const conns = new Map(); // ext -> LspConnection
  let probe = null; // memoized availability report
  const get = (ext) => {
    if (!conns.has(ext)) conns.set(ext, new LspConnection(root, ext));
    return conns.get(ext);
  };
  const hub = {
    async definition(rel, line, char) { return get(lspExtFor(rel)).definition(rel, line, char); },
    async references(rel, line, char, opts) { return get(lspExtFor(rel)).references(rel, line, char, opts); },
    async diagnosticsFor(rel, opts) { return get(lspExtFor(rel)).diagnosticsFor(rel, opts); },
    status() {
      if (!probe) {
        const present = [];
        const missing = [];
        for (const [ext, cmd] of Object.entries(SERVER_FOR_EXT)) {
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

/** Render LSP diagnostic items into a model-friendly capped string. */
export function formatDiagnostics(items, rel, { maxItems = 12 } = {}) {
  if (!items.length) return '';
  const sev = (s) => (s === 1 ? 'error' : s === 2 ? 'warning' : 'info');
  const lines = items.slice(0, maxItems).map((d) => {
    const pos = d.range?.start ? `${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1}` : '?';
    return `  ${rel}:${pos} ${sev(d.severity)}: ${truncate(String(d.message || ''), 200).replace(/\n+/g, ' ')}`;
  });
  const more = items.length > maxItems ? `\n  … +${items.length - maxItems} more` : '';
  return `${lines.join('\n')}${more}`;
}
