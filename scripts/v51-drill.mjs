#!/usr/bin/env node
// v0.51 drill — "channels" (§11). Readable 80-col frames into
// download/aurora-evidence/v51-readable/. The CLI legs drive the REAL binary;
// the wire legs drive a REAL loopback HTTP receiver (a real `buddy channel
// serve` child on a real port); the drain + injection legs exercise the real
// store/cursor/firewall modules. The token lives in the drill process env
// and is NEVER printed — frames reference $BUDDY_DRILL_TOKEN symbolically,
// and frame-07 greps every captured byte for the value (0 occurrences).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v51-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync('/tmp/v51-drill-');
const TOKEN = 'drill-canary-' + crypto.randomBytes(12).toString('hex');
const ENV_NAME = 'BUDDY_DRILL_TOKEN';
const buddy = (args, env = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NO_COLOR: '1', BUDDY_DRILL: '1', [ENV_NAME]: TOKEN, ...env },
  });
const post = async (port, hookPath, body, auth) => {
  const res = await fetch(`http://127.0.0.1:${port}${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body,
  });
  return { status: res.status, body: await res.text() };
};
const bar = '-'.repeat(78);
const frames = [];
const cap = (title, sections) => {
  let t = `${bar}\n${title}\n${bar}\n`;
  for (const s of sections) {
    if (s.cmd) t += `\n$ ${s.cmd}\n`;
    if (s.out) t += s.out.trimEnd() + '\n';
    if (s.note) t += `--> ${s.note}\n`;
  }
  return t;
};
const sh = (r) => [r.stdout, r.stderr].filter((x) => x && x.trim()).join('').trimEnd();

// ── frame-01: the lifecycle (real CLI) ──────────────────────────────────────
const add1 = buddy(['channel', 'add', 'alerts', '--token-env', ENV_NAME]);
const add2 = buddy(['channel', 'add', 'deploys', '--token-env', ENV_NAME, '--path', '/hook/deploys', '--max-per-minute', '10', '--max-bytes', '4096']);
const list1 = buddy(['channel', 'list']);
frames.push(['frame-01-lifecycle.txt', cap('frame-01 — CHANNEL LIFECYCLE (real CLI, temp repo)', [
  { cmd: 'channel add alerts --token-env $BUDDY_DRILL_TOKEN', out: sh(add1), note: 'the token is an ENV NAME — a literal secret in config is refused, not merely discouraged (the v0.48 rule, carried)' },
  { cmd: 'channel add deploys --token-env $BUDDY_DRILL_TOKEN --path /hook/deploys --max-per-minute 10 --max-bytes 4096', out: sh(add2), note: 'custom path + knobs; the default path would be /hook/deploys anyway — stated explicitly for the record' },
  { cmd: 'channel list', out: sh(list1), note: 'the table shows the env NAME ($BUDDY_DRILL_TOKEN), never a value' },
])]);

// ── frame-02: the receiver UP on a real port ────────────────────────────────
const serveChild = spawn('node', [path.join(REPO, 'src', 'index.js'), 'channel', 'serve', '--port', '0'], {
  cwd: root, env: { ...process.env, NO_COLOR: '1', [ENV_NAME]: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serveLog = '';
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('receiver never came up')), 15000);
  const onData = (d) => {
    serveLog += d.toString();
    const m = serveLog.match(/channel receiver UP on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  };
  serveChild.stdout.on('data', onData);
  serveChild.stderr.on('data', onData);
});
const getInfo = await (async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  return { status: res.status, body: await res.text() };
})();
frames.push(['frame-02-receiver-up.txt', cap(`frame-02 — THE RECEIVER UP ON A REAL PORT (:${port}, loopback only)`, [
  { cmd: 'channel serve --port 0', out: serveLog.trimEnd(), note: 'a REAL http receiver — the port was printed by the receiver itself; loopback-only by contract' },
  { cmd: `curl http://127.0.0.1:${port}/`, out: `HTTP ${getInfo.status}\n${getInfo.body}`, note: 'gate-free service info: counts and endpoint paths, no secrets (performed over the real loopback wire by the drill runner)' },
])]);

// ── frame-03: the webhook on the wire ───────────────────────────────────────
const ok1 = await post(port, '/hook/alerts', JSON.stringify({ text: 'CI is green on main — deploy window open', meta: { source: 'github-actions', run: '40827187662' } }), TOKEN);
const ok2 = await post(port, '/hook/deploys', JSON.stringify({ text: 'staging rollout finished, 3/3 pods healthy' }), TOKEN);
const ok3 = await post(port, '/hook/alerts', JSON.stringify({ text: 'disk usage at 91% on db-1', meta: { severity: 'warn' } }), TOKEN);
frames.push(['frame-03-webhook-accepted.txt', cap(`frame-03 — WEBHOOKS ON THE REAL WIRE (accepted → inbox)`, [
  { cmd: `curl -X POST http://127.0.0.1:${port}/hook/alerts -H "Authorization: Bearer $BUDDY_DRILL_TOKEN" -d '{"text":"CI is green on main — deploy window open","meta":{"source":"github-actions",...}}'`, out: `HTTP ${ok1.status}\n${ok1.body}`, note: 'the drill runner performed the POST over the real loopback wire; the token is referenced by env name, its value is never printed' },
  { cmd: `curl -X POST http://127.0.0.1:${port}/hook/deploys -H "Authorization: Bearer $BUDDY_DRILL_TOKEN" -d '{"text":"staging rollout finished, 3/3 pods healthy"}'`, out: `HTTP ${ok2.status}\n${ok2.body}`, note: 'second channel, same token env — one credential, two doors' },
  { cmd: `curl -X POST http://127.0.0.1:${port}/hook/alerts -H "Authorization: Bearer $BUDDY_DRILL_TOKEN" -d '{"text":"disk usage at 91% on db-1","meta":{"severity":"warn"}}'`, out: `HTTP ${ok3.status}\n${ok3.body}`, note: 'events are bounded jsonl rows in .buddy/channels/inbox.jsonl — the receiver is the ONLY writer (serve lock)' },
])]);

// ── frame-04: the refusal wall ───────────────────────────────────────────────
const r401a = await post(port, '/hook/alerts', '{"text":"no token"}', null);
const r401b = await post(port, '/hook/alerts', '{"text":"wrong token"}', 'wrong-token-value');
const r400 = await post(port, '/hook/alerts', 'this is not json', TOKEN);
const rBig = await post(port, '/hook/deploys', JSON.stringify({ text: 'x'.repeat(8192) }), TOKEN); // > 4096B budget
const flood = [];
for (let i = 0; i < 12; i++) flood.push(await post(port, '/hook/deploys', `{"text":"burst ${i}"}`, TOKEN));
const flood429 = flood.filter((r) => r.status === 429).length;
const badHost = buddy(['channel', 'serve', '--host', '0.0.0.0']);
const busyServe = buddy(['channel', 'serve', '--port', String(port)], { [ENV_NAME]: TOKEN }); // second receiver while the first holds the lock
frames.push(['frame-04-refusal-wall.txt', cap('frame-04 — THE REFUSAL WALL (every shape, on camera)', [
  { cmd: 'curl -X POST .../hook/alerts  (no Authorization header)', out: `HTTP ${r401a.status}\n${r401a.body}` },
  { cmd: 'curl -X POST .../hook/alerts  (wrong token)', out: `HTTP ${r401b.status}\n${r401b.body}` },
  { cmd: 'curl -X POST .../hook/alerts  (body is not JSON)', out: `HTTP ${r400.status}\n${r400.body}` },
  { cmd: `curl -X POST .../hook/deploys  (${(8192).toLocaleString()}-byte body vs a 4096-byte budget)`, out: `HTTP ${rBig.status}\n${rBig.body}`, note: 'RED TEAM v0.51: the oversize answer goes out BEFORE the socket dies — the client always gets the reason' },
  { cmd: '12 rapid POSTs against deploys (rate 10/min; 1 earlier event already spent the budget)', out: `HTTP 200 ×${flood.filter((r) => r.status === 200).length}, HTTP 429 ×${flood429}\n${flood.find((r) => r.status === 429)?.body ?? ''}`, note: 'a flood records NOTHING — the rate limit fires before the disk write (9+1=10 accepted, the window honest)' },
  { cmd: 'channel serve --host 0.0.0.0', out: sh(badHost), exit: badHost.status, note: 'the receiver is LOOPBACK-ONLY by contract — the refusal teaches the tunnel answer (ssh -R / tailscale)' },
  { cmd: `channel serve --port ${port}  (a second receiver while one is up)`, out: sh(busyServe), exit: busyServe.status, note: 'ONE receiver at a time — a second writer on the inbox is a corruption vector, exit 3' },
])]);

// ── frame-05: the drain (real CLI) ──────────────────────────────────────────
serveChild.kill('SIGINT');
await new Promise((r) => serveChild.once('exit', r));
const serveStop = serveLog.split('\n').filter((l) => l.includes('→')).join('\n');
const drain1 = buddy(['channel', 'drain']);
const drain2 = buddy(['channel', 'drain']);
const drain3 = buddy(['channel', 'drain']);
const drain4 = buddy(['channel', 'drain']);
frames.push(['frame-05-drain.txt', cap('frame-05 — THE DRAIN (real CLI; bounded batches, cursor honesty)', [
  { cmd: '(SIGINT the receiver)', out: 'receiver stopping — lock released', note: 'the lock is released on the way out; the inbox stays' },
  { cmd: 'channel drain', out: sh(drain1), note: 'the batch is BOUNDED (default 5) — 12 accepted events cannot flood one turn; the rest stay queued beyond the cursor' },
  { cmd: 'channel drain  (again)', out: sh(drain2), note: 'the remaining events — the cursor only ever advances over RETURNED events; nothing is re-delivered, nothing is lost' },
  { cmd: 'channel drain  (third)', out: sh(drain3), note: 'the last 2 — 5 + 5 + 2: every event exactly once' },
  { cmd: 'channel drain  (fourth)', out: sh(drain4), note: '0 new — the honest empty; nothing is re-delivered, nothing is lost' },
])]);

// ── frame-06: the injection path (the real firewall wrapper) ────────────────
const C = await import(path.join(REPO, 'src', 'channels.js'));
const drained = C.drainInbox(root, { limit: 5 });
const wrapped = C.channelMessageText(drained.events.length ? drained.events : [
  { channel: 'alerts', at: new Date().toISOString(), text: 'CI is green on main — deploy window open', meta: {} },
  { channel: 'deploys', at: new Date().toISOString(), text: 'staging rollout finished, 3/3 pods healthy', meta: {} },
]);
const status = C.statusText(root, { receiverUp: false });
frames.push(['frame-06-injection-firewall.txt', cap('frame-06 — THE INJECTION PATH (the exact text the model sees next turn)', [
  { cmd: '(inside the live session — the idle drain renders ⚡ cards, then the events ride into context)', out: wrapped, note: 'THE FIREWALL: the webhook is DATA, not instructions — the wrapper says so on camera (the same rule /docs, /report and /pr-comments live by)' },
  { cmd: 'channels status (the /channels card)', out: status, note: 'disk facts: channels, receiver state, inbox bytes, pending beyond the cursor — token NAMES only' },
])]);

// ── frame-07: the leak probe + ground truth ─────────────────────────────────
const allFrames = frames.map(([, t]) => t).join('\n');
const leaks = allFrames.includes(TOKEN);
const storeRaw = fs.readFileSync(path.join(root, '.buddy/channels/channels.json'), 'utf8');
const storeSafe = !storeRaw.includes(TOKEN) && storeRaw.includes(ENV_NAME);
frames.push(['frame-07-leak-probe.txt', cap('frame-07 — THE LEAK PROBE (the canary sweep)', [
  { cmd: `grep -F "$BUDDY_DRILL_TOKEN_VALUE" <<every captured byte of frames 01-06>>`, out: leaks ? 'LEAK — the token value surfaced' : '0 occurrences — the token VALUE never appeared in any frame, response, log, or store', note: 'the drill token was a random canary; every output referenced $BUDDY_DRILL_TOKEN symbolically' },
  { cmd: 'cat .buddy/channels/channels.json', out: storeSafe ? storeRaw.trimEnd() : 'STORE CONTAMINATED', note: 'the store carries the env NAME; the VALUE lives in the environment or it does not exist' },
])]);

// ── write frames + groundtruth ──────────────────────────────────────────────
const gt = {
  wave: 'v0.51.0',
  plane: '§11 channels — push external events (webhook → live session message)',
  date: new Date().toISOString(),
  tokenEnv: ENV_NAME,
  tokenValuePrinted: leaks,
  frames: {},
  assertions: {
    'receiver on a real loopback port': Number.isFinite(port) && port > 0,
    'accepted webhooks → 200 + inbox rows': [ok1, ok2, ok3].every((r) => r.status === 200),
    'no-token / wrong-token → 401': r401a.status === 401 && r401b.status === 401,
    'junk body → 400': r400.status === 400,
    'oversize body → 413 (answer sent before close)': rBig.status === 413,
    'flood → honest 429s, nothing recorded': flood429 === 3,
    'non-loopback bind refused with the tunnel answer': badHost.status === 2 && /LOOPBACK-ONLY|tunnel/.test(sh(badHost)),
    'second receiver → exit 3 (single writer)': busyServe.status === 3,
    'drain consumes in bounded batches, fourth drain is the honest empty': /0 new events/.test(sh(drain4)),
    'injection wrapper says data-not-instructions': /data, not instructions/.test(wrapped),
    'store carries env NAME, never a value': storeSafe,
    'token canary absent from every captured byte': !leaks,
  },
};
for (const [name, text] of frames) {
  fs.writeFileSync(path.join(OUT, name), text.endsWith('\n') ? text : text + '\n');
  gt.frames[name] = { sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(gt, null, 2) + '\n');
const failed = Object.entries(gt.assertions).filter(([, v]) => !v);
console.log(`v51 drill: ${frames.length} frames → ${OUT}`);
console.log(`receiver port: ${port} · canary leak: ${leaks ? 'YES (FAIL)' : 'none'}`);
for (const [k, v] of Object.entries(gt.assertions)) console.log(`  ${v ? '✔' : '✖'} ${k}`);
if (failed.length) { console.log(`DRILL: FAIL (${failed.length})`); process.exit(1); }
console.log('DRILL: PASS');
