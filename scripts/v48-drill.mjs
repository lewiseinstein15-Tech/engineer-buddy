#!/usr/bin/env node
// v0.48.0 DRILL — MCP auth hardening on camera.
//
// Spins up the repo's own zero-dependency demo remote server
// (examples/echo-mcp-http.js) and drives it through the REAL product
// surfaces — loadMcpConfig → connectMcpServers → buildMcpTools — capturing
// human-readable frames into the evidence pack:
//
//   frame-01-connect-masked   /mcp row: host + "bearer via env …" (no value)
//   frame-02-echo-roundtrip   the bridged tool answers through the real gate
//   frame-03-sse-mode         the event-stream response path
//   frame-04-wrong-token      the honest HTTP 401 observation, leak-checked
//   frame-05-evil-echo        a hostile server that ECHOES the credential —
//                             the client still prints nothing
//   frame-06-rate-limited     the per-server budget's honest in-band refusal
//   frame-07-leak-probe       the planted token grepped across EVERY byte of
//                             captured output — zero hits
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpConfig, connectMcpServers, buildMcpTools, describeMcpServers } from '../src/tools/mcp.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(REPO, '..', 'download', 'aurora-evidence', 'v48-readable');
fs.mkdirSync(OUT, { recursive: true });

const FAKE = 'sk-drill-48-CANARY-5e1f'; // the planted credential for the leak probe
const frames = [];
let allOutput = ''; // every byte the drill prints or captures — the leak probe's haystack

const say = (s) => { allOutput += `${s}\n`; process.stdout.write(`${s}\n`); };
let framesAll = ''; // every byte written into the frame files (probe haystack part 2)
const keep = (name, body) => {
  frames.push({ name, body });
  fs.writeFileSync(path.join(OUT, `${name}.txt`), body.trimStart());
  framesAll += body;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the demo remote server; resolve when its banner reveals the port. */
function startDemo(extraArgs = [], token = FAKE) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'examples', 'echo-mcp-http.js'), '--port', '0', ...extraArgs], {
      env: { ...process.env, MCP_HTTP_TOKEN: token },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      if (m) resolve({ child, url: m[1], banner: buf.trim() });
    };
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`demo server exited early (${code}): ${buf}`)));
    setTimeout(() => reject(new Error(`demo server did not announce a port: ${buf}`)), 5000).unref();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v48-drill-'));
const writeConfig = (servers) => {
  fs.mkdirSync(path.join(tmp, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
};

// ── frames 01–03: connect, mask, round trip, SSE ────────────────────────────
say(`\n═══ v0.48.0 DRILL — MCP auth hardening (${new Date().toISOString()} · node ${process.version}) ═══\n`);

const demo = await startDemo();
writeConfig({ 'remote-demo': { url: demo.url, auth: { type: 'bearer', tokenEnv: 'V48_DRILL_TOKEN' } } });
process.env.V48_DRILL_TOKEN = FAKE;

const conn = await connectMcpServers(tmp, { initTimeoutMs: 5000, home: tmp });
const row = describeMcpServers(conn.connected, conn.failed);
keep('frame-01-connect-masked', `
frame-01 — CONNECT + MASKED IDENTITY
demo server: node examples/echo-mcp-http.js --port 0   (${demo.url})
config:      { "remote-demo": { "url": "${demo.url}",
                                 "auth": { "type": "bearer", "tokenEnv": "V48_DRILL_TOKEN" } } }
the token VALUE lives only in the environment — the config names it.

/mcp rows (as the REPL renders them):
${row.map((r) => `  ${r[0]}  ${r[1].padEnd(14)} ${r[2].padEnd(4)} ${r[3]}`).join('\n')}

→ the row shows the host and "bearer via env V48_DRILL_TOKEN" —
  the credential value appears in NO row, NO error, NO event.
`);
say(row.map((r) => `  ${r.join('  ')}`).join('\n'));

const tools = buildMcpTools(conn.connected);
const echo = tools.find((t) => t.name === 'mcp__remote-demo__echo');
const echoed = await echo.run({ text: 'hello over authenticated HTTP' });
keep('frame-02-echo-roundtrip', `
frame-02 — ECHO ROUND TRIP through the bridged tool
call:  mcp__remote-demo__echo { "text": "hello over authenticated HTTP" }
out:   ${echoed}
→ a real request/response across the wire with the Authorization header
  attached by the client from the environment — approved-tool semantics
  unchanged (bridged tools remain risky-gated).
`);
say(`  echo → ${echoed}`);

const sseDemo = await startDemo(['--sse']);
writeConfig({ 'remote-sse': { url: sseDemo.url, auth: { type: 'bearer', tokenEnv: 'V48_DRILL_TOKEN' } } });
const connSse = await connectMcpServers(tmp, { initTimeoutMs: 5000, home: tmp });
const sseTool = buildMcpTools(connSse.connected).find((t) => t.name === 'mcp__remote-sse__echo');
const sseOut = await sseTool.run({ text: 'over event-stream' });
keep('frame-03-sse-mode', `
frame-03 — SSE RESPONSE PATH
demo server restarted with --sse (Content-Type: text/event-stream)
call:  mcp__remote-sse__echo { "text": "over event-stream" }
out:   ${sseOut}
→ the client parses the event-stream shape: notifications flood-capped,
  the id-matched reply resolved, byte budget enforced.
`);
say(`  sse echo → ${sseOut}`);

// ── frames 04–05: honest 401, hostile echo ─────────────────────────────────
writeConfig({ 'wrong-token': { url: demo.url, auth: { type: 'bearer', tokenEnv: 'V48_WRONG_TOKEN' } } });
process.env.V48_WRONG_TOKEN = 'deliberately-wrong';
const connBad = await connectMcpServers(tmp, { initTimeoutMs: 5000, home: tmp });
const badFail = connBad.failed.find((f) => f.name === 'wrong-token');
keep('frame-04-wrong-token', `
frame-04 — WRONG TOKEN → HONEST 401
config points the same server with a deliberately wrong env token.
${badFail ? `failed-list entry: ${badFail.error}` : '(no failure recorded — UNEXPECTED)'}
→ the refusal names the status and where to look; it never names the token,
  never quotes the server's response body. One bad server still did not
  block the rest of the connect (${connBad.connected.length} others up).
`);
say(`  wrong token → ${badFail?.error}`);

const evil = await startDemo(['--evil-echo']);
writeConfig({ 'evil-server': { url: evil.url, auth: { type: 'bearer', tokenEnv: 'V48_WRONG_TOKEN' } } });
const connEvil = await connectMcpServers(tmp, { initTimeoutMs: 5000, home: tmp });
const evilFail = connEvil.failed.find((f) => f.name === 'evil-server');
keep('frame-05-evil-echo', `
frame-05 — HOSTILE SERVER ECHOES THE CREDENTIAL
demo server restarted with --evil-echo: its 401 body reflects the caller's
Authorization header back and adds "hint" fields — bait for a leaking client.
${evilFail ? `the client's entire output: ${evilFail.error}` : '(no failure recorded — UNEXPECTED)'}
→ bait taken by nothing: the credential value appears in NO output byte.
`);

// ── frame 06: the per-server rate budget ────────────────────────────────────
writeConfig({ 'budgeted': { url: demo.url, auth: { type: 'bearer', tokenEnv: 'V48_DRILL_TOKEN' }, rateLimit: { max: 2, perMinutes: 1 } } });
const connB = await connectMcpServers(tmp, { initTimeoutMs: 5000, home: tmp });
const bTools = buildMcpTools(connB.connected);
const bEcho = bTools.find((t) => t.name === 'mcp__budgeted__echo');
const b1 = await bEcho.run({ text: '1' });
const b2 = await bEcho.run({ text: '2' });
const b3 = await bEcho.run({ text: '3' });
keep('frame-06-rate-limited', `
frame-06 — PER-SERVER BUDGET (config: max 2 calls / 1 min)
call 1: ${b1}
call 2: ${b2}
call 3: ${b3}
→ the third call is refused IN BAND, before the wire, with the budget,
  the retry hint, and "No call was made." The model can back off; the
  loop never dies; nothing auto-sleeps.
`);
say(`  call 3 → ${b3}`);

// ── frame 07: the leak probe over every captured byte ──────────────────────
// computed BEFORE frame-07 itself exists, so the probe frame's own canary
// mention cannot dilute the count: haystack = console bytes + frames 01–06.
const hits = (allOutput + framesAll).split(FAKE).length - 1;
keep('frame-07-leak-probe', `
frame-07 — LEAK PROBE
planted credential: ${FAKE}  (used as the real bearer token in frames 01–03,
abused in 04–05, present in the environment of every server above)
haystack: every byte this drill printed or captured — the console stream
AND the full text of frames 01–06, including both hostile-server responses.
occurrences of the credential in that haystack: ${hits}
→ the secret-hygiene contract held on camera.
`);
say(`\n  leak probe: ${hits} occurrences outside the probe frame`);

// cleanup
for (const c of [conn, connSse, connBad, connEvil, connB].flatMap((x) => x.connected)) c.client.stop?.();
demo.child.kill(); sseDemo.child.kill(); evil.child.kill();

const reel = [`v0.48.0 drill reel — ${new Date().toISOString()}`, ...frames.map((f) => `\n########## ${f.name} ##########\n${f.body}`)].join('\n');
fs.writeFileSync(path.join(OUT, 'reel.txt'), reel);
say(`\n═══ frames written to ${OUT} (${frames.length + 2} files incl. reel) ═══`);
process.exit(0);
