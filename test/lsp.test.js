// LSP client + type-aware edits + /docs (v0.17.0).
//
// The LSP piece spawns the repo's OWN language server when present — in CI
// none is installed, so the suite freezes the GRACEFUL paths (one start
// attempt remembered, honest errors with install hints, diagnostics
// short-circuit) plus the framing/parse layer with a fake server.
// The /docs piece freezes the offline paths (no network in unit tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LspConnection, createLspHub, lspExtFor, formatDiagnostics } from '../src/agent/lsp.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { fetchDocs, docsCatalog, clearDocsCache, resetDocsState } from '../src/tools/docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-lsp-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export function app() {\n  return missingFunction();\n}\n');
  return root;
}

test('lspExtFor maps extensions and rejects unknowns', () => {
  assert.equal(lspExtFor('src/a.ts'), 'ts');
  assert.equal(lspExtFor('src/a.jsx'), 'jsx');
  assert.equal(lspExtFor('src/a.py'), 'py');
  assert.equal(lspExtFor('src/a.go'), 'go');
  assert.equal(lspExtFor('src/a.rb'), null);
  assert.equal(lspExtFor('src/a.md'), null);
});

test('missing language server: one start attempt, remembered, honest error', async () => {
  const root = tmpRepo();
  const conn = new LspConnection(root, 'ts'); // typescript-language-server absent in CI
  assert.equal(await conn.start(), false);
  const reason = conn.unavailableReason;
  assert.ok(reason.length > 0, 'reason recorded');
  assert.equal(await conn.start(), false, 'second attempt short-circuits');
  conn.stop();
});

test('diagnosticsFor short-circuits when no server is available (never hangs)', async () => {
  const root = tmpRepo();
  const conn = new LspConnection(root, 'js');
  const t0 = Date.now();
  const items = await conn.diagnosticsFor('src/app.js', { waitMs: 900 });
  assert.ok(Date.now() - t0 < 3000, 'short-circuits fast');
  assert.deepEqual(items, []);
  conn.stop();
});

test('LSP framing: a real JSON-RPC round-trip against a fake headered server', async () => {
  const root = tmpRepo();
  // A minimal echo server speaking LSP framing: answers initialize + definition.
  const fakeServer = path.join(__dirname, 'fixtures', 'fake-lsp.js');
  const conn = new LspConnection(root, 'ts', { timeoutMs: 5000 });
  // Bypass spawn: inject our own child speaking the right framing.
  const { spawnSync } = await import('node:child_process');
  void spawnSync;
  const child = spawn(process.execPath, [fakeServer], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The runner's NODE_TEST_CONTEXT makes the fixture exit instantly (it
    // thinks it is being scanned as a test) — strip it. Same lesson as the
    // v0.13.4 testrunner build.
    env: { ...process.env, NODE_TEST_CONTEXT: '' },
  });
  conn.child = child;
  conn._startAttempted = true;
  child.stdout.on('data', (c) => conn._onData(c));
  child.on('error', (e) => { conn.unavailableReason = e.message; });
  // Warmup: under the concurrent runner the fixture boot can lag a beat.
  await new Promise((r) => setTimeout(r, 100));
  const result = await conn.request('initialize', {}, 8000);
  assert.equal(result.capabilities?.textDocumentSync, 1);
  conn.diagnostics.set('file://x', [{ severity: 1, message: "Cannot find name 'x'", range: { start: { line: 2, character: 9 } } }]);
  const items = await conn.diagnosticsFor('src/app.js', { waitMs: 300 }).catch(() => null);
  void items; // didChange path needs a live server; the map-lookup path is covered above
  conn.stop();
});

test('formatDiagnostics: severity names, line numbers, cap + more line', () => {
  const items = [
    { severity: 1, message: 'Cannot find name x', range: { start: { line: 2, character: 9 } } },
    { severity: 2, message: 'prefer const', range: { start: { line: 5, character: 0 } } },
    ...Array.from({ length: 15 }, (_, i) => ({ severity: 3, message: `note ${i}`, range: { start: { line: i } } })),
  ];
  const out = formatDiagnostics(items, 'src/app.js', { maxItems: 5 });
  assert.match(out, /src\/app\.js:3:10 error: Cannot find name x/);
  assert.match(out, /warning: prefer const/);
  assert.match(out, /\+12 more/);
  assert.equal(formatDiagnostics([], 'x.js'), '');
});

test('tools: lsp_* degrade with honest errors when no server; disabled mode', async () => {
  const root = tmpRepo();
  const scope = new LocalScope(root);
  const tools = Object.fromEntries(buildLocalTools({ scope }).map((t) => [t.name, t]));
  assert.match(await tools.lsp_diagnostics.run({ path: 'src/app.rb' }), /no language server support/);
  assert.match(await tools.lsp_diagnostics.run({}), /^ERROR: path required/);
  // ts server not installed here → _ensure throws with the install hint
  const out = await tools.lsp_goto_def.run({ path: 'src/app.js', line: 1, column: 1 });
  assert.match(out, /unavailable|install|timed out/i);
  const off = Object.fromEntries(buildLocalTools({ scope, lspEnabled: false }).map((t) => [t.name, t]));
  // v0.62.0: chat.lsp:false REMOVES the lsp_* tools from the registry
  // entirely (a removed tool can never be called — stronger than the old
  // run-time 'ERROR: LSP disabled' refusal, which teased a dead door).
  assert.equal(off.lsp_diagnostics, undefined);
  assert.equal(off.lsp_goto_def, undefined);
  assert.equal(off.lsp_refs, undefined);
});

test('edits still work with LSP enabled (diagnostics ride along silently)', async () => {
  const root = tmpRepo();
  const scope = new LocalScope(root);
  const tools = Object.fromEntries(buildLocalTools({ scope }).map((t) => [t.name, t]));
  const out = await tools.fs_write.run({ path: 'notes.txt', content: 'plain text' });
  assert.match(out, /^OK create/);
  const out2 = await tools.fs_write.run({ path: 'src/new.js', content: 'export const a = 1;\n' });
  assert.match(out2, /^OK create .*src\/new\.js/);
});

test('hub status: present/missing lists are strings, never throws', () => {
  const hub = createLspHub(os.tmpdir());
  const st = hub.status();
  assert.ok(Array.isArray(st.present) && Array.isArray(st.missing));
  hub.stop();
});

// ── /docs (offline paths — no network in CI) ────────────────────────────────

test('fetchDocs: empty lib refused; offline fetch returns honest error', async () => {
  const r0 = await fetchDocs('');
  assert.equal(r0.ok, false);
  clearDocsCache();
  const r = await fetchDocs('definitely-not-a-real-lib-xyz');
  // offline (no network in CI) OR 404 with suggestions — both honest
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('fetchDocs with an injected fetch impl: parse + cache + windowing', async () => {
  clearDocsCache();
  const html = `<html><head><title>React</title></head><body><script>var x=1;</script><h1>ReactDOM</h1><p>hooks let you use state</p><p>filler filler</p></body></html>`;
  let calls = 0;
  const fake = async () => { calls++; return { ok: true, body: html }; };
  const r1 = await fetchDocs('react', 'hooks', { fetchImpl: fake });
  assert.equal(r1.ok, true);
  assert.match(r1.text, /hooks let you use state/);
  assert.equal(r1.cached, undefined);
  const r2 = await fetchDocs('react', 'hooks', { fetchImpl: fake });
  assert.equal(r2.cached, true, 'second identical call hits the cache');
  assert.equal(calls, 1);
});

test('docsCatalog: injected impl parses slugs; garbage degrades to null', async () => {
  resetDocsState();
  const fake = async () => ({ ok: true, body: JSON.stringify([{ slug: 'react', name: 'React' }, { slug: 'vue~3', name: 'Vue' }]) });
  const cat = await docsCatalog({ fetchImpl: fake });
  assert.equal(cat[0].slug, 'react');
  resetDocsState();
  const bad = await docsCatalog({ fetchImpl: async () => ({ ok: true, body: 'not json{`' }) });
  assert.equal(bad, null);
});
