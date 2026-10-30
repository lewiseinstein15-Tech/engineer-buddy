#!/usr/bin/env node
// v0.62.0 RED TEAM PASS (war-room Play 4) — try to break the LSP default-on
// plane before it ships: RESOLVER UNDER FIRE (hostile chat.lsp values —
// toString bombs, ANSI-painted junk (the note itself must not be a terminal
// paint), huge strings, symbols), VALIDATOR UNDER FIRE (prototype-pollution
// through chat.lsp.servers.__proto__, Buffer/Map/class-instance shapes, a
// 1e5-entry flood capped at 16 with per-entry isolation, 1e6-char command
// parts refused as E2BIG, throwing getters killing only their own entry),
// THE KNOB VIA REAL ASSEMBLY (makeScopeAndTools over a real .buddy/
// settings.json — chat.lsp:false must REMOVE the lsp_* tools, 'off' must
// match, junk must be NAMED with the default holding), HOSTILE SERVERS ON
// THE WIRE (initialize-only fake, a --silent mock, a non-existent binary,
// a binary that exits instantly — every leg bounded and honest, never a
// hang), ARG WEAPONS (toString bombs, throwing getters, NaN/Infinity/-0/
// 1e21/objects as path/line/column — teaching refusals, zero unhandled
// rejections), FRAMING PARSER UNDER FIRE (garbage chunks, header without
// Content-Length, a 1e9 claimed length, split frames, unparseable bodies —
// the parser survives and the next valid frame still parses), CONTENT
// WEAPONS (ANSI/OSC/control bytes stripped as wholes by sanitizeLspText,
// CJK/RTL/emoji survive, a toString-bomb message renders as '?'), and
// HUB WEAPONS (null/bomb paths contained, stop() then request rejects). A
// stray throw, one leaked control byte, one polluted prototype, or one
// unbounded wait would have blocked the ship.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LspConnection, createLspHub, resolveLspSetting, validateLspServers,
  sanitizeLspText, formatDiagnostics,
} from '../src/agent/lsp.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
// The REAL assembly path — the same function the REPL and one-shot run.
import { makeScopeAndTools } from '../src/terminal/repl.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(here);
const MOCK_LSP = path.join(REPO, 'examples', 'mock-lsp.js');
const FAKE_LSP = path.join(REPO, 'test', 'fixtures', 'fake-lsp.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt62-'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const hasEsc = (s) => /[\u001B\u0000-\u0008\u000B-\u001F\u007F]/.test(String(s));
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rt62-ws-'));
const setSettings = (ws, chatPatch) => {
  fs.mkdirSync(path.join(ws, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.buddy', 'settings.json'), JSON.stringify({ chat: chatPatch }, null, 2), 'utf8');
};
const names = (tools) => new Set(tools.map((t) => t.name));
const contained = async (fn) => {
  try { const r = await fn(); return { threw: false, r }; }
  catch (e) { return { threw: true, e }; }
};
const bomb = { toString() { throw new Error('boom'); } };
const getterBomb = (key, val) => {
  const o = {};
  Object.defineProperty(o, key, { enumerable: true, get() { throw new Error('boom'); } });
  if (val !== undefined) o.extra = val;
  return o;
};

// ── A. RESOLVER UNDER FIRE ──────────────────────────────────────────────────
{
  const r1 = resolveLspSetting(bomb);
  ok(r1.on === true && r1.note === null, 'RESOLVER: an object-shaped bomb is a config shape, no crash, no note');
  const r2 = resolveLspSetting('x'.repeat(10000));
  ok(r2.on === true && r2.note.length < 200, 'RESOLVER: a 10k-char junk value is NAMED with a bounded note');
  const r3 = resolveLspSetting('\u001B[31mpainted\u001B[0m');
  ok(r3.on === true && !hasEsc(r3.note), 'RESOLVER: an ANSI-painted junk value cannot paint the note');
  const r4 = resolveLspSetting(Symbol('x'));
  ok(r4.on === true && !hasEsc(r4.note), 'RESOLVER: a Symbol junk value is NAMED without crashing');
  const r5 = resolveLspSetting(['a', bomb]);
  ok(r5.on === true && !hasEsc(r5.note), 'RESOLVER: an array of junk is one junk note, not an explosion');
  const r6 = resolveLspSetting(getterBomb('valueOf'));
  ok(r6.on === true, 'RESOLVER: a throwing-getter object takes the config branch, never a crash');
}

// ── B. VALIDATOR UNDER FIRE ─────────────────────────────────────────────────
{
  const hostile = JSON.parse('{"__proto__":{"js":["evil"]},"constructor":["evil2"],"rs":["rust-analyzer"]}');
  const r = validateLspServers(hostile);
  ok(r.servers.rs && !Object.prototype.hasOwnProperty.call(r.servers, 'js') && !Object.prototype.hasOwnProperty.call(r.servers, 'constructor'), 'VALIDATOR: __proto__/constructor keys refused, the good entry survives');
  const probe = {};
  ok(probe.js === undefined && probe.rs === undefined, 'VALIDATOR: no prototype pollution through the override door');
  ok(!Object.prototype.js, 'VALIDATOR: Object.prototype untouched');

  const b = Buffer.from([1, 2, 3]);
  const rb = validateLspServers(b);
  ok(Object.keys(rb.servers).length === 0 && rb.notes.length >= 1, 'VALIDATOR: a Buffer shape is refused per-entry, never a crash');

  const rm = validateLspServers(new Map([['js', ['evil']]]));
  ok(rm.notes.length === 1 && rm.notes[0].includes('not an object'), 'VALIDATOR: a Map is not an object — refused whole');

  class LS { constructor() { this.js = ['evil']; } }
  const rc = validateLspServers(new LS());
  ok(!rc.servers.js, 'VALIDATOR: a class instance cannot inject through the door');

  const flood = {};
  for (let i = 0; i < 100000; i++) flood[`x${i}`.padEnd(8, 'z')] = ['cmd'];
  const t0 = Date.now();
  const rf = validateLspServers(flood);
  const dt = Date.now() - t0;
  ok(Object.keys(rf.servers).length === 16 && dt < 2000, `VALIDATOR: a 1e5-entry flood caps at 16 fast (${dt}ms)`);
  ok(rf.notes.some((n) => n.includes('more than 16 entries')), 'VALIDATOR: the cap names itself');

  const giant = validateLspServers({ js: ['node', 'x'.repeat(1000000), '--stdio'] });
  ok(!giant.servers.js && giant.notes[0].includes('max 256 chars'), 'VALIDATOR: a 1e6-char command part is refused (E2BIG door shut)');

  const mixed = validateLspServers(getterBomb('js', ['node']));
  ok(!mixed.servers.js && mixed.servers.extra && mixed.notes.length === 1, 'VALIDATOR: a throwing getter kills only its own entry');

  const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  const rp = contained(() => validateLspServers(proxy));
  const rpv = await rp;
  ok(!rpv.threw, 'VALIDATOR: a Proxy with a throwing ownKeys is contained');
}

// ── C. THE KNOB VIA REAL ASSEMBLY (makeScopeAndTools over real settings) ────
{
  // default: absent settings → on, tools present
  const ws1 = mkRoot();
  const a1 = await makeScopeAndTools({ root: ws1 });
  ok(a1.lsp.on === true && a1.lsp.notes.length === 0, 'KNOB: default (no settings) is on with zero notes');
  ok(names(a1.tools).has('lsp_diagnostics') && names(a1.tools).has('lsp_goto_def') && names(a1.tools).has('lsp_refs'), 'KNOB: default registers all three lsp_* tools');
  a1.shells?.stopAll?.(); a1.mcp?.close?.();

  // off: chat.lsp:false → tools REMOVED from the registry
  const ws2 = mkRoot();
  setSettings(ws2, { lsp: false });
  const a2 = await makeScopeAndTools({ root: ws2 });
  ok(a2.lsp.on === false && a2.lsp.notes.length === 0, 'KNOB: chat.lsp:false resolves off, cleanly');
  ok(!names(a2.tools).has('lsp_diagnostics') && !names(a2.tools).has('lsp_goto_def') && !names(a2.tools).has('lsp_refs'), 'KNOB: chat.lsp:false REMOVES every lsp_* tool from the registry');
  ok(names(a2.tools).has('fs_write') && names(a2.tools).has('bash'), 'KNOB: the rest of the kit is untouched by the kill-switch');
  a2.shells?.stopAll?.(); a2.mcp?.close?.();

  // off via 'off'
  const ws3 = mkRoot();
  setSettings(ws3, { lsp: 'off' });
  const a3 = await makeScopeAndTools({ root: ws3 });
  ok(a3.lsp.on === false, "KNOB: chat.lsp:'off' resolves off");
  ok(!names(a3.tools).has('lsp_diagnostics'), "KNOB: 'off' removes the tools");
  a3.shells?.stopAll?.(); a3.mcp?.close?.();

  // junk: NAMED, default holds
  const ws4 = mkRoot();
  setSettings(ws4, { lsp: 42 });
  const a4 = await makeScopeAndTools({ root: ws4 });
  ok(a4.lsp.on === true && a4.lsp.notes.some((n) => n.includes('is junk — NAMED')), 'KNOB: junk chat.lsp is NAMED and the default holds');
  ok(names(a4.tools).has('lsp_diagnostics'), 'KNOB: junk keeps the tools registered');
  a4.shells?.stopAll?.(); a4.mcp?.close?.();

  // hostile servers through the REAL file: pollution refused, good entry lives
  const ws5 = mkRoot();
  setSettings(ws5, { lsp: JSON.parse('{"servers":{"__proto__":{"js":["evil"]},"rs":["rust-analyzer"]}}') });
  const a5 = await makeScopeAndTools({ root: ws5 });
  ok(a5.lsp.on === true, 'KNOB: an object chat.lsp keeps LSP on');
  ok(a5.lsp.notes.some((n) => n.includes('__proto__')), 'KNOB: the __proto__ override entry is NAMED in the notes');
  const hub5 = createLspHub(ws5, { servers: a5.lsp.servers });
  ok(hub5.extFor('a.rs') === 'rs' && hub5.extFor('a.js') === 'js', 'KNOB: the merged map carries the good override and the default');
  hub5.stop(); a5.shells?.stopAll?.(); a5.mcp?.close?.();
}

// ── D. HOSTILE SERVERS ON THE WIRE (bounded, honest) ────────────────────────
{
  // initialize-only server: diagnostics honest-empty within the wait cap
  const ws = mkRoot();
  fs.writeFileSync(path.join(ws, 'app.js'), 'let x = 1;\n');
  const hub1 = createLspHub(ws, { servers: { js: ['node', FAKE_LSP] } });
  const t0 = Date.now();
  const items1 = await hub1.diagnosticsFor('app.js', { waitMs: 1200 });
  const dt1 = Date.now() - t0;
  ok(Array.isArray(items1) && items1.length === 0, `HOSTILE WIRE: an initialize-only server degrades to honest empty (${items1.length} items)`);
  ok(dt1 < 8000, `HOSTILE WIRE: the degrade is bounded (${dt1}ms, wait cap honored)`);
  hub1.stop();

  // a --silent mock answers definition but pushes no diagnostics
  const ws2 = mkRoot();
  fs.writeFileSync(path.join(ws2, 'main.rs'), 'fn main() {}\n');
  const hub2 = createLspHub(ws2, { servers: { rs: ['node', MOCK_LSP, '--silent', '--ttl', '30'] } });
  const items2 = await hub2.diagnosticsFor('main.rs', { waitMs: 1200 });
  ok(Array.isArray(items2) && items2.length === 0, 'HOSTILE WIRE: a silent server is honest empty');
  const def = await contained(() => hub2.definition('main.rs', 0, 4));
  ok(!def.threw && def.r && (Array.isArray(def.r) ? def.r[0]?.uri : def.r?.uri) === 'file:///mock/target.ext', 'HOSTILE WIRE: silent mode still answers definition (paths independent)');
  hub2.stop();

  // a non-existent binary: honest unavailable, never a crash
  const ws3 = mkRoot();
  fs.writeFileSync(path.join(ws3, 'main.rs'), 'fn main() {}\n');
  const hub3 = createLspHub(ws3, { servers: { rs: ['/nonexistent/binary/ls62'] } });
  const items3 = await hub3.diagnosticsFor('main.rs', { waitMs: 800 });
  ok(Array.isArray(items3) && items3.length === 0, 'HOSTILE WIRE: a non-existent binary degrades to honest empty');
  const c3 = new LspConnection(ws3, 'rs', { cmd: ['/nonexistent/binary/ls62'] });
  const started = await c3.start();
  ok(started === false && /not runnable|ENOENT|spawn/i.test(c3.unavailableReason), `HOSTILE WIRE: unavailable reason is honest (${c3.unavailableReason.slice(0, 60)})`);
  hub3.stop(); c3.stop();

  // a binary that exits instantly: pending requests reject, tool degrades
  const c4 = new LspConnection(ws3, 'rs', { cmd: ['node', '-e', 'process.exit(1)'] });
  const req4 = await contained(() => c4.request('initialize', {}, 2000));
  ok(req4.threw, 'HOSTILE WIRE: an instantly-dead server rejects the handshake (contained)');
  c4.stop();

  // a hostile server that never answers definition: bounded timeout
  const c5 = new LspConnection(mkRoot(), 'rs', { cmd: ['node', MOCK_LSP, '--hostile', '--ttl', '30'], timeoutMs: 1200 });
  await c5.start();
  const d5 = await contained(() => c5.definition('main.rs', 0, 4));
  ok(d5.threw && /timed out/i.test(d5.e?.message || ''), 'HOSTILE WIRE: a definition-holding server times out bounded (1.2s cap)');
  c5.stop();
}

// ── E. ARG WEAPONS (every run contained, teaching refusals) ─────────────────
{
  const ws = mkRoot();
  fs.writeFileSync(path.join(ws, 'main.rs'), 'fn main() {}\n');
  const scope = new LocalScope(ws);
  const tools = Object.fromEntries(buildLocalTools({ scope, lspServers: { rs: ['node', MOCK_LSP, '--ttl', '30'] } }).map((t) => [t.name, t]));
  const diag = tools.lsp_diagnostics, def = tools.lsp_goto_def, refs = tools.lsp_refs;

  const argCases = [
    ['diagnostics bomb path', () => diag.run({ path: bomb })],
    ['diagnostics getter path', () => diag.run(getterBomb('path'))],
    ['diagnostics object path', () => diag.run({ path: { a: 1 } })],
    ['diagnostics ESC path', () => diag.run({ path: 'a\u001B[31m.js' })],
    ['diagnostics null', () => diag.run(null)],
    ['diagnostics undefined', () => diag.run(undefined)],
    ['definition bomb line', () => def.run({ path: 'main.rs', line: bomb })],
    ['definition NaN line', () => def.run({ path: 'main.rs', line: NaN })],
    ['definition Infinity line', () => def.run({ path: 'main.rs', line: Infinity })],
    ['definition 1e21 line', () => def.run({ path: 'main.rs', line: 1e21 })],
    ['definition -0 column', () => def.run({ path: 'main.rs', line: 1, column: -0 })],
    ['definition bomb path', () => def.run({ path: bomb, line: 1 })],
    ['refs bomb path', () => refs.run({ path: bomb, line: 1 })],
    ['refs getter path', () => refs.run(getterBomb('line'))],
  ];
  for (const [name, fn] of argCases) {
    const r = await contained(fn);
    ok(!r.threw, `ARGS: ${name} — contained (no unhandled rejection)`);
  }
  const missing = await def.run({});
  ok(/ERROR: path and line required/.test(missing), 'ARGS: missing line is a teaching refusal');
  const junkCol = await def.run({ path: 'main.rs', line: 1, column: bomb });
  ok(typeof junkCol === 'string', 'ARGS: a bomb column is contained to a string');
}

// ── F. FRAMING PARSER UNDER FIRE ────────────────────────────────────────────
{
  const conn = new LspConnection(mkRoot(), 'rs', { cmd: ['node', MOCK_LSP, '--ttl', '30'] });
  const feed = (buf) => conn._onData(Buffer.from(buf, 'utf8'));
  let threw = false;
  try {
    feed('garbage without any header\r\n\r\nand more');
    feed('\r\n\r\n');
    feed('Content-Length: 999999999\r\n\r\n{');
    feed('Content-Length: abc\r\n\r\njunk');
    const full = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: {} });
    const framed = `Content-Length: ${Buffer.byteLength(full)}\r\n\r\n${full}`;
    feed(framed.slice(0, 30));
    feed(framed.slice(30)); // split across chunks
    feed(`Content-Length: 5\r\n\r\n{{{{{`);
    feed(`Content-Length: 2\r\n\r\n{"id":{"obj":1},"result":1}`);
  } catch { threw = true; }
  ok(!threw, 'FRAMING: hostile chunks never throw');
  // the next VALID response frame still parses — inject a dummy child so
  // request() queues (the parser is the unit under test, not the spawn)
  conn.child = { stdin: { write() {} } };
  conn.stopped = false;
  let resolved = false;
  const p = conn.request('initialize', {}, 2000).then(() => { resolved = true; }, () => {});
  const resp = JSON.stringify({ jsonrpc: '2.0', id: [...conn.pending.keys()][0], result: { capabilities: {} } });
  feed(`Content-Length: ${Buffer.byteLength(resp)}\r\n\r\n${resp}`);
  await p;
  ok(resolved, 'FRAMING: after hostile chunks the next valid frame still resolves');
  conn.stop();
}

// ── G. CONTENT WEAPONS (sanitizeLspText) ────────────────────────────────────
{
  ok(sanitizeLspText('\u001B[31mred\u001B[0m plain') === 'red plain', 'CONTENT: CSI paint stripped whole');
  ok(sanitizeLspText('\u001B]0;title\u0007after') === 'after', 'CONTENT: OSC with BEL stripped whole');
  ok(sanitizeLspText('\u001B]0;unterminated') === '', 'CONTENT: unterminated OSC swallows to end-of-string');
  ok(sanitizeLspText('\u001B]0;a\u001B]0;b\u0007tail') === 'tail', 'CONTENT: OSC chain swallows to the real terminator');
  ok(!hasEsc(sanitizeLspText('a\u0000b\u0008c\u000Bd\u001Fe\u007Ff')), 'CONTENT: control bytes dropped');
  ok(sanitizeLspText('a\tb\nc') === 'a\tb\nc', 'CONTENT: tab and newline survive');
  ok(sanitizeLspText('中文\u202Ertl\u202C-emoji-\u{1F600}') === '中文\u202Ertl\u202C-emoji-\u{1F600}', 'CONTENT: CJK/RTL/emoji survive byte-honest');
  ok(sanitizeLspText(bomb) === '?', 'CONTENT: a toString bomb message renders as "?"');
  const items = [{ severity: 1, range: { start: { line: 0, character: 0 } }, message: '\u001B[31mpainted error\u001B[0m' }, { severity: 1, message: bomb }, { severity: 2, range: { start: { line: 1 } }, message: 'ok'.repeat(300) }];
  const out = formatDiagnostics(items, 'a.ts', { maxItems: 3 });
  ok(!hasEsc(out), 'CONTENT: formatDiagnostics output carries zero control bytes');
  ok(out.includes('painted error'), 'CONTENT: the visible words survive the sanitizer');
  ok(out.includes("'?'") || out.includes('?'), 'CONTENT: the bomb message is rendered, not fatal');
  ok(out.split('\n').length <= 5, 'CONTENT: item cap honored');
}

// ── H. HUB WEAPONS ──────────────────────────────────────────────────────────
{
  const hub = createLspHub(mkRoot(), { servers: { rs: ['node', MOCK_LSP, '--ttl', '30'] } });
  const d1 = await contained(() => hub.definition(null, 0, 0));
  ok(d1.threw && /no language server known/.test(d1.e?.message || ''), 'HUB: definition(null) is a contained, honest rejection');
  const d2 = await contained(() => hub.definition(bomb, 0, 0));
  ok(d2.threw && /no language server known/.test(d2.e?.message || ''), 'HUB: definition(bomb) is contained with a safe ext label');
  const d3 = await hub.diagnosticsFor(bomb);
  ok(Array.isArray(d3) && d3.length === 0, 'HUB: diagnosticsFor(bomb) is honest empty');
  const refs1 = await contained(() => hub.references(getterBomb('x'), 0, 0));
  ok(refs1.threw, 'HUB: references(getter-bomb) is contained');
  hub.stop();
  const d4 = await contained(() => hub.diagnosticsFor('a.rs', { waitMs: 100 }));
  ok(!d4.threw, 'HUB: post-stop diagnostics degrade to honest empty (stopped connection)');
  hub.stop();
  ok(true, 'HUB: stop() is idempotent');
}

console.log(`RED TEAM v0.62: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('RED TEAM: FAIL — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('RED TEAM: PASS — the LSP plane held the line.');
process.exit(0);
