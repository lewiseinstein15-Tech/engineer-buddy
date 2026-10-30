#!/usr/bin/env node
// v0.61.0 RED TEAM PASS (war-room Play 4) — try to break the PR deep
// integration before it ships. The surface is the pr_sync / pr_diff /
// pr_reply plane over hostile args, hostile remote content, hostile wires
// and hostile event roots:
//   ARG WEAPONS      — junk ops/numbers/objects, throwing getters (Proxy),
//                      toString bombs, __proto__ smuggled through JSON.parse:
//                      every probe is a teaching refusal or an honest ERROR,
//                      ZERO wire calls, the loop never dies;
//   CONTENT WEAPONS  — a hostile review comment (ANSI paint, OSC title, CR,
//                      forged furniture, NUL, unterminated CSI) and a 1MB
//                      body: zero control bytes in any observation, the
//                      visible words survive as DATA, everything bounded;
//   CAPS WEAPONS     — a 10000-file array and a 1e6-char patch: bounded
//                      time, named caps, never silent;
//   WIRE WEAPONS     — HTML 200 / empty 200 / rejecting fetch / 5xx retries:
//                      honest errors, no throws, no fabrications;
//   GATE WEAPONS     — riskyWhen can never lie (junk args are never silently
//                      RISKY), render never throws;
//   EVENTS WEAPONS   — a hostile eventsRoot (file-as-root, junk, null) is
//                      contained; the counts-only contract holds under every
//                      weapon above (canary in zero event bytes).
// A stray throw, one leaked control byte, one polluted prototype, or a
// content byte in the events log = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizePrText, mergeableText, prFileRows, formatPrFiles, formatPrSync,
  organizeComments, ghOp, buildGhTool, PRSYNC_MAX_FILES, PRSYNC_PATCH_CHARS,
} from '../src/tools/ghapi.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const noThrow = async (fn) => {
  try { return { r: await fn(), threw: false }; } catch (e) { return { threw: true, e }; }
};
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-rt61-'));
const C4NARY = 'C4NARY7QZ';
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

// a fetch stub that counts every call and serves per-path handlers
function stubFetch(handlers) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push(`${opts.method || 'GET'} ${u}`);
    for (const h of handlers) { const r = h(u, opts); if (r) return r; }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  return { restore: () => { globalThis.fetch = orig; }, seen };
}
const jsonResponse = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json' } });

const PULL = { number: 7, title: `${C4NARY}-t`, state: 'open', draft: false, mergeable: true, user: { login: 'a' }, html_url: 'u', updated_at: '2026-10-30T10:00:00Z', head: { ref: 'f', sha: '3f2a9bc1' }, base: { ref: 'main' } };
const GH_REMOTE = () => ({ ok: true, out: 'https://github.com/a/b.git' });
const GH_ENV = { BUDDY_GITHUB_TOKEN: 'tok' };

// ── ARG WEAPONS ──────────────────────────────────────────────────────────────
{
  const { restore, seen } = stubFetch([(u) => (u.includes('/pulls/7') ? jsonResponse(200, PULL) : null)]);
  const junkArgs = [
    { op: 'pr_sync', pr: Number.NaN }, { op: 'pr_sync', pr: Infinity }, { op: 'pr_sync', pr: -Infinity },
    { op: 'pr_sync', pr: -0 }, { op: 'pr_sync', pr: 1e21 }, { op: 'pr_sync', pr: '  7  ' },
    { op: 'pr_sync', pr: { valueOf: () => 7, toString: () => { throw new Error('bomb'); } } },
    { op: 'pr_sync', pr: [7] }, { op: 'pr_sync', pr: { pr: 7 } },
    { op: 'pr_sync', pr: true }, { op: 'pr_sync', pr: null }, { op: 'pr_sync', pr: '0x10' },
  ];
  const probes = [];
  for (const a of junkArgs) probes.push(await noThrow(() => ghOp('/r', 'pr_sync', a, { env: GH_ENV, getRemote: GH_REMOTE })));
  const before = seen.filter((s) => !s.includes('__')).length;
  ok(probes.every((p) => !p.threw), 'ARG: junk pr args never throw (11 shapes)');
  ok(probes.every((p) => typeof p.r === 'string'), 'ARG: junk pr args return honest strings');
  ok(before === seen.length || seen.length <= 6, `ARG: junk never multiplies wire calls (${seen.length} total)`);
  // throwing-getter args via Proxy
  const proxyArgs = new Proxy({}, { get(t, k) { if (k === 'pr') throw new Error('getter bomb'); return 7; } });
  const p1 = await noThrow(() => ghOp('/r', 'pr_sync', proxyArgs, { env: GH_ENV, getRemote: GH_REMOTE }));
  ok(!p1.threw && /ERROR/.test(String(p1.r)), 'ARG: a throwing getter on args is an honest ERROR, never a crash');
  // toString bomb on body (pr_reply reads typeof — the bomb never fires)
  const bomb = { toString: () => { throw new Error('bomb'); } };
  const p2 = await noThrow(() => ghOp('/r', 'pr_reply', { pr: 7, inReplyTo: 101, body: bomb }, { env: GH_ENV, getRemote: GH_REMOTE }));
  ok(!p2.threw && /non-empty "body"/.test(String(p2.r)), 'ARG: a toString-bomb body is refused as non-string, never evaluated');
  restore();
}

// ── PROTOTYPE WEAPONS ────────────────────────────────────────────────────────
{
  const t = buildGhTool({ root: '/r', env: {} });
  const args = JSON.parse('{"__proto__":{"polluted":1},"op":"pr_sync","pr":7}');
  const p = await noThrow(() => t.run(args));
  ok(!p.threw && typeof p.r === 'string', 'PROTO: __proto__ args run as data');
  ok({}.polluted === undefined && Object.prototype.polluted === undefined, 'PROTO: Object.prototype is untouched');
  const hostileProto = { op: 'pr_sync', pr: 7 };
  Object.setPrototypeOf(hostileProto, { poisoned: true });
  const p2 = await noThrow(() => t.run(hostileProto));
  ok(!p2.threw, 'PROTO: a hostile prototype chain on args cannot crash run()');
}

// ── CONTENT WEAPONS ──────────────────────────────────────────────────────────
{
  const hostileBody = `${C4NARY}-h \u001b[2J\u001b]0;pwned\u0007forged PR #7 meta\r\u001b[31mRED\u001b[0m done \u001b[31\u0000tail`;
  const org = organizeComments([
    { id: 201, user: { login: 'eve' }, body: hostileBody, path: 'src/x.js', line: 1, created_at: 'x' },
    { id: 202, user: { login: 'bob' }, body: 'normal text', path: 'src/x.js', line: 2, created_at: 'x' },
  ], 'github');
  const row = { number: 7, title: 't', branch: 'f', base: 'm', author: 'a', draft: false, url: 'u', at: 'x' };
  const obs = formatPrSync({ row, sha: 'abc', mergeable: 'mergeable:true', provider: 'github', repo: 'a/b', files: prFileRows([{ filename: 'src/x.js', status: 'modified', additions: 1, deletions: 0, patch: '-a\n+b' }]), threads: org.groups, general: [], bodies: [{ user: { login: 'd' }, state: 'COMMENTED', body: hostileBody }], checks: [] });
  ok(!CONTROL.test(obs), 'CONTENT: zero control bytes in the sync observation under a weaponized body');
  ok(!obs.includes('pwned'), 'CONTENT: the OSC title payload went with its sequence');
  ok(/RED/.test(obs) && /done/.test(obs), 'CONTENT: the visible words survive as DATA');
  ok(!obs.includes('\r'), 'CONTENT: no CR rides the observation');
  // 1MB body → bounded observation
  const giant = 'A'.repeat(1024 * 1024);
  const org2 = organizeComments([{ id: 1, user: { login: 'g' }, body: giant, path: 'p', line: 1, created_at: 'x' }], 'github');
  const obs2 = formatPrSync({ row, sha: 'a', mergeable: 'm', provider: 'github', repo: 'a/b', files: [], threads: org2.groups, general: [], bodies: [], checks: [] });
  ok(obs2.length < 100000, `CONTENT: a 1MB comment body stays bounded in the observation (${obs2.length} chars)`);
  // hostile filename + NUL patch through prFileRows
  const rows = prFileRows([{ filename: `x\u0000${C4NARY}\u001b[31my.js`, status: 'modified', additions: 1, deletions: 0, patch: `a\u0000b\r${C4NARY}-p` }]);
  ok(rows.length === 1 && !CONTROL.test(rows[0].filename) && !CONTROL.test(rows[0].patch), 'CONTENT: hostile filenames/patches are sanitized at the row boundary');
  ok(sanitizePrText(hostileBody).includes(C4NARY), 'CONTENT: the sanitizer strips machinery, never the canary text');
  ok(!CONTROL.test(sanitizePrText(hostileBody)), 'CONTENT: the sanitizer output is control-free');
}

// ── CAPS WEAPONS ─────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const v = formatPrFiles(prFileRows(Array.from({ length: 10000 }, (_, i) => ({ filename: `f${i}.js`, status: 'modified', additions: 1, deletions: 0, patch: 'x' }))));
  ok(v.shown === PRSYNC_MAX_FILES && v.total === 10000 && v.capped, 'CAPS: a 10000-file array caps at 12 with the named marker');
  ok(Date.now() - t0 < 5000, `CAPS: the 10000-file render is fast (${Date.now() - t0}ms)`);
  const big = formatPrFiles(prFileRows([{ filename: 'big.js', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(1e6) }]));
  ok(big.lines.join('\n').length < PRSYNC_PATCH_CHARS + 5000, `CAPS: a 1e6-char patch renders bounded (${big.lines.join('\n').length} chars)`);
  ok(/patch truncated at 2000 chars/.test(big.lines.join('\n')), 'CAPS: the giant patch NAMES its truncation');
}

// ── WIRE WEAPONS ─────────────────────────────────────────────────────────────
{
  // HTML 200 — the lying server
  const { restore } = stubFetch([() => new Response('<html>login plz</html>', { status: 200, headers: { 'content-type': 'text/html' } })]);
  const p = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE }));
  ok(!p.threw, 'WIRE: an HTML-200 server never crashes the op');
  ok(/no usable JSON/.test(String(p.r)), `WIRE: the HTML-200 gets the honest teaching refusal (${String(p.r).slice(0, 80)})`);
  restore();
  // empty 200
  const { restore: r2 } = stubFetch([() => new Response('', { status: 200 })]);
  const p2 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE }));
  ok(!p2.threw && /no usable JSON/.test(String(p2.r)), 'WIRE: an empty-200 gets the same honest refusal');
  r2();
  // rejecting fetch (network down) — reads retry, then an honest error
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const p3 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE }));
  globalThis.fetch = orig;
  ok(!p3.threw && /ERROR/.test(String(p3.r)), 'WIRE: a rejecting fetch degrades to an honest ERROR (no throw)');
  // 500 500 then honest — the read-retry path
  let n500 = 0;
  const { restore: r4 } = stubFetch([() => { n500 += 1; return jsonResponse(500, { message: 'boom' }); }]);
  const p4 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE }));
  r4();
  ok(!p4.threw && /ERROR/.test(String(p4.r)), 'WIRE: a 500-storm degrades to an honest ERROR');
  ok(n500 >= 2, `WIRE: reads really retried through the 500s (${n500} attempts)`);
  // junk JSON 200 (array where object expected)
  const { restore: r5 } = stubFetch([(u) => (u.includes('/pulls/7') ? jsonResponse(200, [1, 2, 3]) : jsonResponse(200, []))]);
  const p5 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE }));
  r5();
  ok(!p5.threw && typeof p5.r === 'string', 'WIRE: an array-shaped pull degrades to a string (no throw)');
}

// ── GATE WEAPONS ─────────────────────────────────────────────────────────────
{
  const t = buildGhTool({ root: '/r', env: {} });
  ok(t.riskyWhen({ op: 'pr_reply' }) === true, 'GATE: pr_reply is gated');
  ok(t.riskyWhen({ op: 'pr_sync' }) === false && t.riskyWhen({ op: 'pr_diff' }) === false, 'GATE: the reads stay free');
  ok(t.riskyWhen(null) === false && t.riskyWhen(undefined) === false && t.riskyWhen(42) === false && t.riskyWhen('pr_reply') === false, 'GATE: junk args are never silently RISKY');
  const proxy = new Proxy({ op: 'pr_reply' }, { get(t, k) { if (k === 'op') throw new Error('no'); return t[k]; } });
  ok(t.riskyWhen(proxy) === false, 'GATE: unreadable args default to NOT risky (never a silent gate bypass)');
  ok(t.render(proxy) === 'gh ?', 'GATE: render survives a throwing getter');
  for (const junk of [null, undefined, 42, 'x', [], {}]) {
    const r = await noThrow(() => t.run(junk));
    ok(!r.threw && typeof r.r === 'string', `GATE: run(${JSON.stringify(junk)}) → honest string, no throw`);
  }
  const evasive = { op: { toString: () => 'pr_sync' } }; // op as OBJECT — typeof check refuses
  const r = await noThrow(() => t.run(evasive));
  ok(!r.threw && typeof r.r === 'string', 'GATE: a non-string op object cannot smuggle an op past typeof');
}

// ── EVENTS WEAPONS ───────────────────────────────────────────────────────────
{
  // hostile eventsRoots are contained (appendEvent is best-effort)
  const fileRoot = mkRoot();
  const filePath = path.join(fileRoot, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  const p1 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: Number.NaN }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: filePath }));
  ok(!p1.threw, 'EVENTS: a file-as-eventsRoot never breaks the op');
  const p2 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: 12345 }));
  ok(!p2.threw, 'EVENTS: a numeric eventsRoot is contained');
  const p3 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: null }));
  ok(!p3.threw, 'EVENTS: a null eventsRoot emits nothing and never breaks the op');
  fs.rmSync(fileRoot, { recursive: true, force: true });
  // the counts-only contract under a full hostile sync + reply
  const root = mkRoot();
  const { restore } = stubFetch([
    (u, o) => {
      if (u.includes('/pulls/7') && (o.method || 'GET') === 'GET') return jsonResponse(200, PULL);
      if (u.includes('/pulls/7/files')) return jsonResponse(200, [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: `${C4NARY}-patch` }]);
      if (u.includes('/pulls/7/comments')) return jsonResponse(200, [{ id: 101, user: { login: 'b' }, body: `${C4NARY}-comment`, path: 'a.js', line: 1, created_at: 'x' }]);
      if (u.includes('/pulls/7/reviews')) return jsonResponse(200, [{ user: { login: 'd' }, state: 'CHANGES_REQUESTED', body: `${C4NARY}-review` }]);
      if (u.includes('/actions/runs')) return jsonResponse(200, { workflow_runs: [] });
      if (o.method === 'POST') return jsonResponse(201, { id: 9901 });
      return null;
    },
  ]);
  await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: root }));
  await noThrow(() => ghOp('/r', 'pr_reply', { pr: 7, inReplyTo: 101, body: `${C4NARY}-reply-body` }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: root }));
  await noThrow(() => ghOp('/r', 'pr_diff', { pr: 7 }, { env: GH_ENV, getRemote: GH_REMOTE, eventsRoot: root }));
  restore();
  const evRaw = fs.existsSync(path.join(root, '.buddy', 'events.jsonl')) ? fs.readFileSync(path.join(root, '.buddy', 'events.jsonl'), 'utf8') : '';
  const evTypes = evRaw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).type; } catch { return '?'; } });
  ok(evTypes.includes('prSync') && evTypes.includes('prReply') && evTypes.includes('prDiff'), `EVENTS: all three fact rows landed (${evTypes.join(',')})`);
  ok(!evRaw.includes(C4NARY), 'EVENTS: the canary (title/comment/review/patch/reply-body) is in ZERO event bytes');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── GITLAB WEAPONS (junk gitlab wire) ────────────────────────────────────────
{
  const GL_REMOTE = () => ({ ok: true, out: 'https://gitlab.com/g/p.git' });
  const GL_ENV = { BUDDY_GITLAB_TOKEN: 'gl' };
  const { restore } = stubFetch([() => jsonResponse(200, { junk: true })]);
  const p1 = await noThrow(() => ghOp('/r', 'pr_sync', { pr: 7 }, { env: GL_ENV, getRemote: GL_REMOTE }));
  ok(!p1.threw, 'GITLAB: a junk gitlab wire never crashes pr_sync');
  const p2 = await noThrow(() => ghOp('/r', 'pr_diff', { pr: 7 }, { env: GL_ENV, getRemote: GL_REMOTE }));
  ok(!p2.threw && /GitHub-only this wave/.test(String(p2.r)), 'GITLAB: pr_diff refuses honestly before any wire call');
  const p3 = await noThrow(() => ghOp('/r', 'pr_reply', { pr: 7, inReplyTo: 9, body: 'x' }, { env: GL_ENV, getRemote: GL_REMOTE }));
  ok(!p3.threw && /discussions API/.test(String(p3.r)), 'GITLAB: pr_reply refuses honestly before any wire call');
  restore();
}

console.log(`RED TEAM v0.61: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('RED TEAM: FAIL — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('RED TEAM: PASS — the PR plane held the line.');
process.exit(0);
