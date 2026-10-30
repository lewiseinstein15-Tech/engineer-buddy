// v062.test.js — the capability audit's gap #6: LSP default-on, the knob
// becomes REAL. Covers: chat.lsp resolution (junk NAMED, default holds),
// chat.lsp.servers validation (per-entry isolation, prototype-pollution
// refusal), the merged-map hub (overrides honored on every routing path),
// and the knob-actually-works regression (chat.lsp: false removes the
// lsp_* tools — before v0.62.0 the knob was parsed nowhere and the tools'
// own error message cited a config path that could not do what it claimed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LspConnection,
  createLspHub,
  resolveLspSetting,
  validateLspServers,
  formatDiagnostics,
} from '../src/agent/lsp.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK_LSP = path.join(here, '..', 'examples', 'mock-lsp.js');
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-lsp62-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── resolveLspSetting: the chat.lsp knob ────────────────────────────────────

test('resolveLspSetting: absent/null/true → on, no note', () => {
  for (const v of [undefined, null, true]) {
    const r = resolveLspSetting(v);
    assert.equal(r.on, true, String(v));
    assert.equal(r.note, null, String(v));
  }
});

test('resolveLspSetting: false | off | false-string → off, no note', () => {
  for (const v of [false, 'off', 'false']) {
    const r = resolveLspSetting(v);
    assert.equal(r.on, false, String(v));
    assert.equal(r.note, null, String(v));
  }
});

test('resolveLspSetting: an object config shape → on (servers validated separately)', () => {
  const r = resolveLspSetting({ servers: {} });
  assert.equal(r.on, true);
  assert.equal(r.note, null);
});

test('resolveLspSetting: junk is NAMED and the default (on) holds', () => {
  for (const v of [42, 'yes', [], 0, 1]) {
    const r = resolveLspSetting(v);
    assert.equal(r.on, true, String(v));
    assert.match(r.note || '', /chat\.lsp: .* is junk — NAMED, not applied/);
    assert.match(r.note || '', /false \| 'off' turns it off/);
  }
});

test('resolveLspSetting: every junk primitive names itself without crashing', () => {
  // The junk path only ever String()s primitives — objects are config
  // shapes and take the other branch structurally, so a toString bomb can
  // never fire here. The REAL bomb surface is a command part (below).
  for (const v of [0, -1, 1.5, '', 'on', 'true', Symbol('x')]) {
    const r = resolveLspSetting(v);
    assert.equal(r.on, true, String(String(v)));
    assert.match(r.note || '', /is junk — NAMED/);
  }
});

// ── validateLspServers: the override door ───────────────────────────────────

test('validateLspServers: absent/null → nothing, no notes', () => {
  for (const v of [undefined, null]) {
    const r = validateLspServers(v);
    assert.deepEqual(r.servers, {});
    assert.deepEqual(r.notes, []);
  }
});

test('validateLspServers: a valid override is accepted verbatim', () => {
  const r = validateLspServers({ rs: ['rust-analyzer'], js: ['node', MOCK_LSP, '--stdio'] });
  assert.deepEqual(r.servers, { rs: ['rust-analyzer'], js: ['node', MOCK_LSP, '--stdio'] });
  assert.deepEqual(r.notes, []);
});

test('validateLspServers: a non-object is NAMED and ignored whole', () => {
  for (const v of [42, 'rust-analyzer', [], true]) {
    const r = validateLspServers(v);
    assert.deepEqual(r.servers, {});
    assert.match(r.notes[0] || '', /chat\.lsp\.servers: .* not an object — NAMED, ignored/);
  }
});

test('validateLspServers: junk extension keys are NAMED per-entry, skipped', () => {
  const r = validateLspServers({ 'a-b': ['x'], UPPER: ['x'], toolongkey1: ['x'], '': ['x'], 42: ['x'] });
  assert.deepEqual(r.servers, {});
  assert.equal(r.notes.length, 5);
  for (const n of r.notes) assert.match(n, /not a file extension — NAMED, ignored/);
});

test('validateLspServers: __proto__/constructor keys cannot grow the prototype chain', () => {
  // JSON.parse makes __proto__ an own property — the override door must not
  // let it through the regex gate.
  const hostile = JSON.parse('{"__proto__": {"js": ["evil"]}, "constructor": ["evil2"], "rs": ["rust-analyzer"]}');
  const r = validateLspServers(hostile);
  assert.deepEqual(r.servers, { rs: ['rust-analyzer'] });
  const probe = {};
  assert.equal(probe.js, undefined); // no pollution
  assert.equal(probe.rs, undefined);
});

test('validateLspServers: junk command shapes are NAMED, skipped', () => {
  const r = validateLspServers({
    py: 'pylsp', // not an array
    go: [], // empty
    ts: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], // > 8 parts
  });
  assert.deepEqual(r.servers, {});
  assert.equal(r.notes.length, 3);
  for (const n of r.notes) assert.match(n, /NAMED, ignored/);
});

test('validateLspServers: every command part must be a non-empty string', () => {
  const r = validateLspServers({ py: ['pylsp', ''], go: ['gopls', 42], rs: ['rust-analyzer', null] });
  assert.deepEqual(r.servers, {});
  assert.equal(r.notes.length, 3);
});

test('validateLspServers: a throwing getter kills only its own entry', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'js', { enumerable: true, get() { throw new Error('boom'); } });
  hostile.rs = ['rust-analyzer'];
  const r = validateLspServers(hostile);
  assert.deepEqual(r.servers, { rs: ['rust-analyzer'] });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /chat\.lsp\.servers\.js/);
});

test('validateLspServers: per-entry isolation — one bad entry never vetoes the good ones', () => {
  const r = validateLspServers({ rs: ['rust-analyzer'], py: 'junk', go: ['gopls'] });
  assert.deepEqual(r.servers, { rs: ['rust-analyzer'], go: ['gopls'] });
  assert.equal(r.notes.length, 1);
});

test('validateLspServers: more than 16 entries — the rest are NAMED', () => {
  const raw = {};
  for (let i = 0; i < 20; i++) raw[`x${i}`.padEnd(4, 'z')] = ['cmd'];
  const r = validateLspServers(raw);
  assert.equal(Object.keys(r.servers).length, 16);
  assert.match(r.notes[r.notes.length - 1], /more than 16 entries/);
});

test('validateLspServers: a toString bomb as a command part is contained per-part', () => {
  const bomb = { toString() { throw new Error('boom'); } };
  const r = validateLspServers({ py: ['pylsp', bomb], rs: ['rust-analyzer'] });
  assert.deepEqual(r.servers, { rs: ['rust-analyzer'] });
  assert.match(r.notes[0] || '', /chat\.lsp\.servers\.py/);
});

// ── the hub: overrides honored on every routing path ────────────────────────

test('hub.extFor honors overrides for NEW extensions and keeps defaults', () => {
  const hub = createLspHub(mkRoot(), { servers: { rs: ['rust-analyzer'] } });
  assert.equal(hub.extFor('src/a.rs'), 'rs'); // added by override
  assert.equal(hub.extFor('src/a.ts'), 'ts'); // default kept
  assert.equal(hub.extFor('src/a.rb'), null); // unknown stays unknown
  assert.equal(hub.extFor(null), null);
  assert.equal(hub.extFor(''), null);
});

test('hub defensive merge: junk override shapes cannot corrupt the merged map', () => {
  const hub = createLspHub(mkRoot(), { servers: { __proto__: { js: ['evil'] }, rs: 'not-an-array' } });
  assert.equal(hub.extFor('src/a.js'), 'js'); // default for js survives
  assert.equal(hub.extFor('src/a.rs'), null); // junk entry ignored
});

test('LspConnection: cmd override replaces the default, bare constructor unchanged', () => {
  const c1 = new LspConnection(mkRoot(), 'rs', { cmd: ['node', MOCK_LSP, '--stdio'] });
  assert.deepEqual(c1.cmd, ['node', MOCK_LSP, '--stdio']);
  const c2 = new LspConnection(mkRoot(), 'ts'); // back-compat: no override
  assert.deepEqual(c2.cmd, ['typescript-language-server', '--stdio']);
  const c3 = new LspConnection(mkRoot(), 'ts', { cmd: null });
  assert.deepEqual(c3.cmd, ['typescript-language-server', '--stdio']);
});

test('LspConnection: unknown extension without override is honest absence', () => {
  const c = new LspConnection(mkRoot(), 'rb');
  assert.equal(c.cmd, null);
  assert.equal(c.lang, 'plaintext');
});

test('REAL WIRE: an override steers a NEW extension to the committed mock server', async () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() {}\n');
  const hub = createLspHub(root, { servers: { rs: ['node', MOCK_LSP, '--stdio'] } });
  try {
    const items = await hub.diagnosticsFor('main.rs', { waitMs: 5000 });
    assert.equal(items.length, 2);
    assert.equal(items[0].severity, 1);
    assert.match(items[0].message, /mock error/);
    assert.equal(items[1].severity, 2);
    assert.match(items[1].message, /mock warning/);
  } finally {
    hub.stop();
  }
});

test('REAL WIRE: definition round-trip through the override', async () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() {}\n');
  const hub = createLspHub(root, { servers: { rs: ['node', MOCK_LSP, '--stdio'] } });
  try {
    const res = await hub.definition('main.rs', 0, 4);
    const locs = Array.isArray(res) ? res : [res];
    assert.equal(locs.length, 1);
    assert.equal(locs[0].uri, 'file:///mock/target.ext');
    assert.equal(locs[0].range.start.line, 9);
  } finally {
    hub.stop();
  }
});

test('HONEST ABSENCE: an extension whose default server is missing degrades silently', async () => {
  const hub = createLspHub(mkRoot());
  try {
    const items = await hub.diagnosticsFor('x.go', { waitMs: 500 });
    assert.deepEqual(items, []); // gopls absent in CI — honest absence, never a throw
  } finally {
    hub.stop();
  }
});

// ── buildLocalTools: the knob actually works ────────────────────────────────

function toolNames(root, opts = {}) {
  const scope = new LocalScope(root);
  return new Set(buildLocalTools({ scope, ...opts }).map((t) => t.name));
}

test('buildLocalTools: default (no config) carries all three lsp_* tools', () => {
  const names = toolNames(mkRoot());
  for (const n of ['lsp_diagnostics', 'lsp_goto_def', 'lsp_refs']) assert.ok(names.has(n), n);
});

test('THE KNOB WORKS: chat.lsp:false equivalent removes every lsp_* tool', () => {
  const names = toolNames(mkRoot(), { lspEnabled: false });
  for (const n of ['lsp_diagnostics', 'lsp_goto_def', 'lsp_refs']) assert.ok(!names.has(n), `${n} must be absent`);
  // the rest of the kit is untouched
  assert.ok(names.has('fs_write'));
  assert.ok(names.has('bash'));
});

test('THE KNOB WORKS: lspEnabled:false + junk servers still removes, never crashes', () => {
  const names = toolNames(mkRoot(), { lspEnabled: false, lspServers: { bad: 'shape' } });
  assert.ok(!names.has('lsp_diagnostics'));
});

test('buildLocalTools: lspServers junk at the door cannot crash assembly', () => {
  // validateLspServers runs upstream (makeScopeAndTools), but the hub must
  // also survive anything that slips past.
  const names = toolNames(mkRoot(), { lspServers: { __proto__: { js: ['evil'] }, rs: 42 } });
  assert.ok(names.has('lsp_diagnostics'));
  assert.ok(names.has('fs_write'));
});

test('formatDiagnostics: still capped and shaped (back-compat)', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ severity: 1, range: { start: { line: i, character: 0 } }, message: `err ${i}` }));
  const out = formatDiagnostics(items, 'a.ts', { maxItems: 3 });
  assert.match(out, /a\.ts:1:1 error: err 0/);
  assert.match(out, /\+12 more/);
});

test('REAL WIRE through buildLocalTools tools: lsp_diagnostics over the override', async () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() {}\n');
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope, lspServers: { rs: ['node', MOCK_LSP, '--stdio'] } });
  const tool = tools.find((t) => t.name === 'lsp_diagnostics');
  assert.ok(tool, 'lsp_diagnostics present');
  const out = await tool.run({ path: 'main.rs' });
  assert.match(out, /2 diagnostics for main\.rs/);
  assert.match(out, /mock error: unexpected token/);
  assert.match(out, /mock warning: unused variable/);
});

test('lsp tools on an unsupported extension name the override door', async () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'x.rb'), 'puts 1\n');
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const diag = tools.find((t) => t.name === 'lsp_diagnostics');
  const out = await diag.run({ path: 'x.rb' });
  assert.match(out, /no language server support for x\.rb/);
  assert.match(out, /chat\.lsp\.servers/);
});

test('THE KNOB WORKS (registry level): the disabled-hub error string is now unreachable', async () => {
  // Before v0.62.0, chat.lsp:false left the lsp_* tools REGISTERED and they
  // answered 'ERROR: LSP disabled (chat.lsp: false)' at run time — a
  // teasing door. Now the tool is gone from the registry entirely; this
  // pins the stronger contract.
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'x.ts'), 'let x = 1;\n');
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope, lspEnabled: false });
  assert.equal(tools.find((t) => t.name === 'lsp_diagnostics'), undefined);
  assert.equal(tools.find((t) => t.name === 'lsp_goto_def'), undefined);
  assert.equal(tools.find((t) => t.name === 'lsp_refs'), undefined);
});

test('settings round-trip: chat.lsp lands in .buddy/settings.json and reads back', async () => {
  const { setChatSetting, getChatSetting } = await import('../src/settings.js');
  const root = mkRoot();
  setChatSetting(root, 'lsp', false);
  assert.equal(getChatSetting(root, 'lsp'), false);
  setChatSetting(root, 'lsp', { servers: { rs: ['rust-analyzer'] } });
  const raw = getChatSetting(root, 'lsp');
  assert.deepEqual(raw.servers, { rs: ['rust-analyzer'] });
  assert.equal(resolveLspSetting(raw).on, true);
  const v = validateLspServers(raw.servers);
  assert.deepEqual(v.servers, { rs: ['rust-analyzer'] });
});

test('no unhandled surprises: hub.stop() is idempotent', async () => {
  const hub = createLspHub(mkRoot(), { servers: { rs: ['node', MOCK_LSP, '--stdio'] } });
  await hub.diagnosticsFor('a.rs', { waitMs: 3000 }).catch(() => []);
  hub.stop();
  hub.stop();
  await sleep(10);
  assert.ok(true);
});
