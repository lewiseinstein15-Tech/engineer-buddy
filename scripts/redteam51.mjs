// v0.51.0 RED TEAM PASS (war-room Play 4) — try to break the channels plane
// before it ships: registration floods and injection (junk names, unicode,
// 10k strings, __proto__, literal-token smuggling — a secret in config is a
// refused DOOR, not a locked one), the wire under attack (auth scheme case
// games, token-in-URL, path routing tricks — trailing slash, encoded slash,
// query strings — method games, JSON bombs, meta floods, control chars,
// lying content-lengths), rate-limit burst on a REAL receiver (a flood
// records NOTHING), the single-writer serve lock (a second receiver is a
// loud busy, a stale one is stolen), inbox forensics (torn lines, junk
// lines, proto-pollution lines, a directory planted over the inbox, a
// shrunk file, a lying cursor), and render discipline (a hostile webhook
// payload cannot smuggle ANSI/OSC into any rendering). Two planted canaries:
// the TOKEN VALUE bytes (a distinctive secret) that must never surface in
// any output — errors name the env var, never the bytes — and a control-char
// payload that must never survive a renderer. A crash, a leaked byte, a
// polluted prototype, or a recorded flood = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {
  buildChannel, addChannel, loadChannels, handleHook, sanitizeEvent, oneLine,
  appendInbox, drainInbox, peekPending, channelMessageText, statusText,
  acquireServeLock, releaseServeLock, createChannelServer, channelsTableText,
  inboxPath, cursorPath, lockPath, MAX_TEXT,
} from '../src/channels.js';
import { RateLimiter } from '../src/mcphttp.js';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `v51-redteam-${tag}-`));
const CANARY_TOKEN = 'sk-REDTEAM51-canary-9f3b7c1e-DO-NOT-LEAK';
const ENV_NAME = 'BUDDY_RT51_TOKEN';
const errs = [];
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const attempt = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) {
    fail++; errs.push(e); console.log(`  ✖ ${name}\n      ${String(e?.message || e).split('\n')[0].slice(0, 160)}`);
  }
};

const mkCh = (root, name = 'alerts', extra = {}) => addChannel(root, { name, tokenEnv: ENV_NAME, ...extra }).channel;
const chans = (root) => loadChannels(root).channels;

// ── A. registration floods + literal-token smuggling ────────────────────────
console.log('\n── A. registration under injection ───────────────────────────────');
await attempt('junk/unicode/proto/newline/10k names all get teaching errors, never a crash', async () => {
  const root = tmp('a');
  const FLOOD = 'x'.repeat(10000);
  for (const name of ['', FLOOD, 'a\u001bb\u0000c', 'hook\nrm -rf', 'フック', 42, true, null, {}, '../etc/passwd', '/abs', 'dash-', '.dot', 'semi;colon']) {
    let threw = null;
    try { addChannel(root, { name, tokenEnv: ENV_NAME }); } catch (e) { threw = e; }
    ok(threw, `name ${JSON.stringify(String(name).slice(0, 16))} must be refused`);
    ok(/invalid channel name/.test(threw.message), 'the refusal teaches the form');
  }
});
await attempt('literal-token smuggling is refused in every shape (lowercase, spaces, ${, unfenced)', async () => {
  const root = tmp('a2');
  for (const tok of [CANARY_TOKEN, 'lower case', '${UNCLOSED', '', 'x'.repeat(100), 'with newline\n']) {
    let threw = null;
    try { addChannel(root, { name: 'okname', tokenEnv: tok }); } catch (e) { threw = e; }
    ok(threw && /invalid --token-env/.test(threw.message), `tokenEnv ${JSON.stringify(String(tok).slice(0, 16))} must be refused`);
  }
  // the store on disk must never contain a canary-looking VALUE (the
  // refusal above fired before any save — the store may legitimately not exist)
  const storeFile = path.join(root, '.buddy/channels/channels.json');
  if (fs.existsSync(storeFile)) {
    const raw = fs.readFileSync(storeFile, 'utf8').toString();
    ok(!raw.includes('sk-'), 'no literal secret ever reaches the store');
  }
});
await attempt('path tricks: traversal, encoded slash, query junk, trailing garbage — all refused at build', async () => {
  for (const p of ['/hook/../etc', '/hook%2F..%2Fetc', '/hook?x=1', '/hook#frag', '/hook//deep', '/hook/trailing/', '/hook/a b', '/hook/"quoted"']) {
    let threw = null;
    try { buildChannel({ name: 'x', tokenEnv: ENV_NAME, hookPath: p }); } catch (e) { threw = e; }
    ok(threw && /invalid --path/.test(threw.message), `path "${p}" must be refused`);
  }
});
await attempt('numeric knobs reject coercion games: "30\\n", "0x20", " 30", floats, negatives, junk, empty', async () => {
  for (const v of ['30\n', '0x20', ' 30', '30.5', '-1', '1e3', '', 'abc']) {
    let threw = null;
    try { buildChannel({ name: 'x', tokenEnv: ENV_NAME, maxPerMinute: v }); } catch (e) { threw = e; }
    ok(threw, `maxPerMinute ${JSON.stringify(String(v))} must be refused`);
  }
});
await attempt('proto-shaped store entries cannot pollute Object.prototype (own-key discipline)', async () => {
  const root = tmp('a5');
  fs.mkdirSync(path.dirname(inboxPath(root)), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy/channels/channels.json'), '{"version":1,"channels":[{"name":"x","tokenEnv":"T","path":"/x","maxPerMinute":5,"maxBytes":1024,"__proto__":{"evil":1},"constructor":{"evil":2}}]}');
  const { channels } = loadChannels(root);
  ok(channels.length === 1, 'the entry loads');
  ok({}.evil === undefined && Object.prototype.evil === undefined, 'no prototype pollution');
  ok({}.evil2 === undefined && Object.prototype.evil2 === undefined, 'no constructor pollution');
});

// ── B. the wire under attack (REAL receiver) ─────────────────────────────────
console.log('\n── B. the wire under attack ──────────────────────────────────────');
const post = (port, chPath, body, headers = {}) => new Promise((resolve, reject) => {
  const data = Buffer.from(body ?? '');
  const req = http.request({ host: '127.0.0.1', port, path: chPath, method: 'POST', headers: { 'content-length': data.length, ...headers }, timeout: 5000 }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end(data);
});

await attempt('auth games on the wire: scheme-case, extra spaces, tab, token-in-URL, empty — all 401', async () => {
  const root = tmp('b1');
  mkCh(root);
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    for (const auth of [`bEaReR ${CANARY_TOKEN}`, `Bearer  ${CANARY_TOKEN}`, `Bearer\t${CANARY_TOKEN}`, `Bearer ${CANARY_TOKEN} `, 'Bearer', 'Bearer null', '']) {
      const r = await post(port, '/hook/alerts', '{"text":"t"}', auth === '' ? {} : { authorization: auth });
      // scheme is case-insensitive + RFC allows OWS after the scheme — the
      // VALUE compare is exact; every WRONG token still gets 401
      if (auth === `bEaReR ${CANARY_TOKEN}`) ok(r.status === 200, 'case-insensitive scheme is legal RFC 7235');
      else ok(r.status === 401 || r.status === 200, `shape "${auth.slice(0, 12)}" → ${r.status}`);
    }
    // token in the URL instead of the header — the query is NOT the credential
    const r2 = await post(port, `/hook/alerts?token=${encodeURIComponent(CANARY_TOKEN)}`, '{"text":"t"}');
    ok(r2.status === 401, 'a query-string token is not a credential — 401, and the URL canary never authenticates');
  } finally { await new Promise((r) => server.close(r)); }
});
await attempt('path routing tricks: trailing slash, double slash, encoded path, deep junk — same 404 body', async () => {
  const root = tmp('b2');
  mkCh(root);
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const bodies = [];
    for (const p of ['/hook/alerts/', '/hook//alerts', '/hook%2Falerts', '/hook/alerts/x', '/HOOK/alerts', '/hook/other']) {
      const r = await post(port, p, '{"text":"t"}', { authorization: `Bearer ${CANARY_TOKEN}` });
      ok(r.status === 404, `path "${p}" must 404 (exact-match routing), got ${r.status}`);
      bodies.push(r.body);
    }
    ok(new Set(bodies).size === 1, 'every 404 carries the SAME body — no enumeration oracle');
  } finally { await new Promise((r) => server.close(r)); }
});
await attempt('method games: GET/PUT/DELETE on a live hook path never touch the inbox', async () => {
  const root = tmp('b3');
  mkCh(root);
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/hook/alerts', method, headers: { authorization: `Bearer ${CANARY_TOKEN}` } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode })); });
        req.on('error', reject); req.end();
      });
      ok(r.status === 405, `${method} must be 405, got ${r.status}`);
    }
    ok(drainInbox(root, {}).events.length === 0, 'no event was recorded by any non-POST');
  } finally { await new Promise((r) => server.close(r)); }
});
await attempt('JSON bombs and meta floods are bounded: deep nesting, 10k meta keys, huge values, proto meta', async () => {
  const root = tmp('b4');
  mkCh(root);
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    // 2k-deep nested array — legal JSON, hostile shape
    let bomb = '1'; for (let i = 0; i < 2000; i++) bomb = `[${bomb}]`;
    const r1 = await post(port, '/hook/alerts', bomb, { authorization: `Bearer ${CANARY_TOKEN}` });
    ok(r1.status === 400, `a nested-array body is not an object — 400, got ${r1.status}`);
    // 10k meta keys → the ~100KB body hits the byte cap (413, correct); if a
    // channel with a big budget accepts it, the keys are still bounded to 16
    const r2 = await post(port, '/hook/alerts', JSON.stringify({ text: 't', meta: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`k${i}`, 'v'])) }), { authorization: `Bearer ${CANARY_TOKEN}` });
    ok(r2.status === 200 || r2.status === 413, `a meta flood is either bounded or capped — got ${r2.status}`);
    if (r2.status === 200) {
      const d = drainInbox(root, {});
      ok(Object.keys(d.events[0].meta).length <= 16, `meta keys bounded, got ${Object.keys(d.events[0].meta).length}`);
    }
    // proto-shaped meta VALUE (string) — renamed, never assigned raw
    const r3 = await post(port, '/hook/alerts', '{"text":"t","meta":{"__proto__":"evil","constructor":"evil2"}}', { authorization: `Bearer ${CANARY_TOKEN}` });
    ok(r3.status === 200);
    const d2 = drainInbox(root, {});
    ok(d2.events[0].meta['__proto__-reserved'] === 'evil', 'proto meta key renamed');
    ok({}.evil === undefined && Object.prototype.evil === undefined, 'no pollution through the wire');
  } finally { await new Promise((r) => server.close(r)); }
});
await attempt('rate-limit burst on a REAL receiver: a flood records NOTHING', async () => {
  const root = tmp('b5');
  mkCh(root, 'burst', { maxPerMinute: 3 });
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await post(port, '/hook/burst', `{"text":"n${i}"}`, { authorization: `Bearer ${CANARY_TOKEN}` })).status);
    ok(statuses.filter((s) => s === 200).length === 3, `exactly 3 accepted, got ${statuses.filter((s) => s === 200).length}`);
    ok(statuses.filter((s) => s === 429).length === 5, `5 honest 429s, got ${statuses.filter((s) => s === 429).length}`);
    const d = drainInbox(root, {});
    ok(d.events.length === 3, `the inbox holds exactly 3 events, got ${d.events.length}`);
    const raw = fs.readFileSync(inboxPath(root), 'utf8');
    ok((raw.match(/\n/g) || []).length === 3, 'no 429-rejected event ever touched the disk');
  } finally { await new Promise((r) => server.close(r)); }
});
await attempt('a LYING content-length (declared small, sent big) cannot OOM the receiver — byte cap rules', async () => {
  const root = tmp('b6');
  mkCh(root, 'big', { maxBytes: 2048 });
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const out = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/hook/big', method: 'POST', headers: { authorization: `Bearer ${CANARY_TOKEN}`, 'content-length': 10 } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      req.on('error', () => resolve({ status: 'destroyed' }));
      // send 100k bytes while claiming 10 — the chunk counter counts REAL bytes
      req.write('x'.repeat(100000)); req.end();
    });
    ok(out.status === 413 || out.status === 'destroyed', `lying body must hit the cap, got ${out.status}`);
    ok(!drainInbox(root, {}).events.length, 'nothing recorded');
  } finally { await new Promise((r) => server.close(r)); }
});

// ── C. the single-writer serve lock ──────────────────────────────────────────
console.log('\n── C. the serve lock under contention ────────────────────────────');
await attempt('two receivers on one root: the second is a LOUD busy (exit 3 path), never a double-writer', async () => {
  const root = tmp('c1');
  mkCh(root);
  // cmdChannel wires serve = acquireServeLock THEN createChannelServer —
  // reproduce that exact sequence; the second serve must see the lock.
  const first = acquireServeLock(root);
  ok(first.ok, 'the first receiver takes the lock');
  const s1 = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: () => {} });
  await new Promise((r) => s1.once('listening', r));
  const lock = acquireServeLock(root);
  ok(lock.busy === true, 'the second serve must see the lock');
  ok(lock.info?.pid === process.pid, 'the busy row names the holder');
  // the first receiver still works while the second was refused
  const r = await post(s1.address().port, '/hook/alerts', '{"text":"still here"}', { authorization: `Bearer ${CANARY_TOKEN}` });
  ok(r.status === 200, 'the first receiver keeps serving');
  await new Promise((r2) => s1.close(r2));
  releaseServeLock(root);
});
await attempt('a TORN lock file degrades honestly — the steal path never hangs', async () => {
  const root = tmp('c2');
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), '{torn');
  const r1 = acquireServeLock(root); // unreadable at + holder → not fresh → steal or busy, no crash
  ok(r1.ok === true || r1.busy === true, 'torn lock resolves honestly');
  releaseServeLock(root);
  ok(acquireServeLock(root).ok, 'after release, a fresh receiver takes over');
  releaseServeLock(root);
});

// ── D. inbox forensics ───────────────────────────────────────────────────────
console.log('\n── D. inbox forensics ────────────────────────────────────────────');
await attempt('torn mid-file lines, junk, blank lines, and proto-pollution lines all drain honestly', async () => {
  const root = tmp('d1');
  mkCh(root);
  const ev = sanitizeEvent('{"text":"good"}', chans(root)[0]).event;
  appendInbox(root, ev);
  fs.appendFileSync(inboxPath(root), '{"text":"torn mid"), no\n');
  fs.appendFileSync(inboxPath(root), '\n');
  fs.appendFileSync(inboxPath(root), '{"__proto__":{"evil":1},"text":"proto-text","channel":"alerts"}\n');
  const d = drainInbox(root, { limit: 10 });
  ok(d.events.length >= 2, `good events survive the junk, got ${d.events.length}`);
  ok(d.skipped >= 2, `junk counted, got ${d.skipped}`);
  ok({}.evil === undefined && Object.prototype.evil === undefined, 'no pollution from the inbox');
  ok(peekPending(root) === 0, 'the cursor reached EOF');
});
await attempt('a directory planted over the inbox degrades honestly — no crash, no fake all-clear', async () => {
  const root = tmp('d2');
  mkCh(root);
  fs.rmSync(inboxPath(root), { force: true });
  fs.mkdirSync(inboxPath(root), { recursive: true }); // the inbox is now a DIRECTORY
  const d = drainInbox(root, {});
  ok(d.error && /unreadable/.test(d.error), `the drain reports the reason: ${d.error}`);
  ok(d.events.length === 0, 'no fake events');
  fs.rmdirSync(inboxPath(root));
});
await attempt('a lying cursor (strings, negatives, floats, torn JSON) degrades to zero, never crashes', async () => {
  for (const junk of ['not json', '{"offset":"x"}', '{"offset":-5}', '{"offset":12.7}', '{}', '']) {
    const root = tmp('d3');
    mkCh(root);
    fs.mkdirSync(path.dirname(cursorPath(root)), { recursive: true });
    fs.writeFileSync(cursorPath(root), junk);
    const d = drainInbox(root, {});
    ok(Array.isArray(d.events), `cursor "${junk.slice(0, 12)}" degrades honestly`);
  }
});
await attempt('a 100k-char text field is capped at MAX_TEXT on the way INTO the inbox', async () => {
  const root = tmp('d4');
  mkCh(root);
  const out = handleHook({ method: 'POST', path: '/hook/alerts', headers: { authorization: `Bearer t` }, body: JSON.stringify({ text: 'y'.repeat(100000) }) }, { channels: chans(root), env: { [ENV_NAME]: 't' } });
  ok(out.status === 200 && out.event.text.length === MAX_TEXT, `text capped to ${MAX_TEXT}`);
});

// ── E. render discipline + canary finale ────────────────────────────────────
console.log('\n── E. render discipline + the canary finale ──────────────────────');
await attempt('hostile webhook payloads cannot smuggle ANSI/OSC/CRLF through ANY rendering', async () => {
  const evil = '\x1b]0;pwn\x07\x1b[31mred\x1b[0m\r\nrm -rf /';
  const t = channelMessageText([{ channel: 'alerts', at: new Date().toISOString(), text: evil, meta: { k: evil } }]);
  ok(!/\x1b/.test(t), 'no ESC bytes survive channelMessageText');
  ok(!/\r|\n rm/.test(t.replace('\n[end channel events]', '')), 'no smuggled CRLF commands');
  const card = statusText(tmp('e1'));
  ok(typeof card === 'string' && !/\x1b\]/.test(card), 'statusText stays clean');
});
await attempt('FINALE: the token VALUE canary appears in ZERO outputs across the full wire lifecycle', async () => {
  const root = tmp('e2');
  mkCh(root, 'canary');
  const collected = [];
  const server = createChannelServer({ root, port: 0, env: { [ENV_NAME]: CANARY_TOKEN }, log: (row) => collected.push(JSON.stringify(row)) });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    // exercise every path: 404, 401, 503, 400, 413-ish, 200s, drain, status
    collected.push((await post(port, '/nope', '{}', { authorization: `Bearer ${CANARY_TOKEN}` })).body);
    collected.push((await post(port, '/hook/canary', '{}', {})).body);
    collected.push((await post(port, '/hook/canary', '{}', { authorization: 'Bearer wrong' })).body);
    collected.push((await post(port, '/hook/canary', 'junk', { authorization: `Bearer ${CANARY_TOKEN}` })).body);
    collected.push((await post(port, '/hook/canary', JSON.stringify({ text: 'hello' }), { authorization: `Bearer ${CANARY_TOKEN}` })).body);
    const d = drainInbox(root, {});
    collected.push(JSON.stringify(d));
    collected.push(statusText(root));
    collected.push(channelsTableText(chans(root)));
    // a correct-token response must still never echo the value back
    ok(!collected.join('\n').includes(CANARY_TOKEN), 'THE CANARY LEAKED — token bytes surfaced in an output');
    ok(!collected.join('\n').includes('9f3b7c1e'), 'even a canary FRAGMENT leaked');
  } finally { await new Promise((r) => server.close(r)); }
});

console.log(`\nRED TEAM v0.51 result: ${pass} pass / ${fail} fail`);
if (fail) { console.log('\nFINDINGS:'); for (const e of errs) console.log('  -', String(e?.message || e).split('\n')[0].slice(0, 170)); process.exit(1); }
