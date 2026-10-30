#!/usr/bin/env node
// mock-lsp.js — a committed zero-dependency language server speaking real
// LSP Content-Length framing over stdio (v0.62.0). The drill's OTHER END:
// it answers initialize, textDocument/definition, textDocument/references
// and pushes textDocument/publishDiagnostics on didOpen/didChange — and it
// appends every received method to a witness JSONL file, so the drill's
// gate proves the wire from the server's side (the client's word is not
// evidence; the server's counters are).
//
//   node examples/mock-lsp.js --stdio --witness /tmp/witness.jsonl
//   node examples/mock-lsp.js --stdio --hostile        (answers initialize only)
//   node examples/mock-lsp.js --stdio --silent         (no diagnostics push)
//
// LSP is language-agnostic — the canned payloads use generic file URIs, so
// the same mock serves any extension the config override points at it.
//
// NO fake-lsp-style NODE_TEST_CONTEXT guard here: this file lives in
// examples/ (never scanned by the test runner) and a guard would be HARMFUL
// — the runner's NODE_TEST_CONTEXT is inherited by spawned children, so a
// guard would make every real-wire spawn exit instantly (the v0.13.4
// testrunner lesson, relearned).
import fs from 'node:fs';

const argv = process.argv.slice(2);
const witnessPath = (() => {
  const i = argv.indexOf('--witness');
  return i >= 0 ? argv[i + 1] : null;
})();
const hostile = argv.includes('--hostile');
const silent = argv.includes('--silent');

function witness(row) {
  if (!witnessPath) return;
  try {
    fs.appendFileSync(witnessPath, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8');
  } catch { /* a dead witness never breaks the server */ }
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

const DIAGNOSTICS = [
  { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, source: 'mock-lsp', message: 'mock error: unexpected token in statement' },
  { range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } }, severity: 2, source: 'mock-lsp', message: 'mock warning: unused variable in scope' },
];

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd);
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) return;
    const len = Number(m[1]);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
    buffer = buffer.slice(headerEnd + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { witness({ kind: 'unparseable' }); continue; }
    witness({ kind: 'request', method: msg.method || null, id: msg.id ?? null });

    if (hostile && msg.method !== 'initialize') continue; // hostile: initialize only
    if (msg.method === 'initialize' && msg.id != null) {
      frame({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true } } });
    } else if (msg.method === 'textDocument/definition' && msg.id != null) {
      frame({
        jsonrpc: '2.0',
        id: msg.id,
        result: [{ uri: 'file:///mock/target.ext', range: { start: { line: 9, character: 4 }, end: { line: 9, character: 12 } } }],
      });
    } else if (msg.method === 'textDocument/references' && msg.id != null) {
      frame({
        jsonrpc: '2.0',
        id: msg.id,
        result: [
          { uri: 'file:///mock/a.ext', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } },
          { uri: 'file:///mock/b.ext', range: { start: { line: 7, character: 3 }, end: { line: 7, character: 9 } } },
        ],
      });
    } else if (!silent && (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange')) {
      // A publishDiagnostics push — the client collects it without an id.
      const uri = msg.params?.textDocument?.uri || 'file:///mock/unknown.ext';
      frame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: DIAGNOSTICS } });
    }
  }
});
witness({ kind: 'boot', pid: process.pid, hostile, silent });
// Keep alive until killed — with a TTL safety net. A --ttl (default 60s)
// caps the mock's lifetime so a client that forgets to stop() (e.g. a hub
// unreachable after a test) can never wedge the parent's event loop on
// open stdio pipes; .unref() means the timer itself keeps nothing alive.
const ttl = (() => {
  const i = argv.indexOf('--ttl');
  return i >= 0 ? Number(argv[i + 1]) : 60;
})();
if (Number.isFinite(ttl) && ttl > 0) {
  const t = setTimeout(() => process.exit(0), ttl * 1000);
  if (typeof t.unref === 'function') t.unref();
}
// Keep alive until killed.
setInterval(() => {}, 10_000);
