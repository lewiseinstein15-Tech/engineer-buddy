#!/usr/bin/env node
// v0.55 drill — "voice input: keyless STT dictation" (§11). Readable 80-col
// frames into download/aurora-evidence/v55-readable/. Every leg drives the
// REAL CLI (real spawns, real wire) or the REAL agent tool layer (LocalScope
// + the registered voice_transcribe tool) — module-function calls are
// declared on camera (the v0.45/v0.49/v0.52/v0.53/v0.54 precedent).
//
// The STT endpoint on camera is the COMMITTED examples/mock-stt-server.js —
// a real child process speaking the real wire dialects (multipart parsed,
// RIFF checked); its "hearing" is a CANNED transcript, declared here and in
// the README. The mock's GET /__facts is the honest witness from the OTHER
// end: when the drill claims ZERO BYTES ON THE WIRE, it is the server's own
// counters that prove it, not a client-side claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v55-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v55-drill-'));
const buddy = (args, opts = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: opts.cwd || root, encoding: 'utf8', timeout: 90000, input: opts.input,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) },
  });

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};

// ── the canned transcript (the mock's voice — declared everywhere) ──────────
const CANNED = 'the quarterly review is on Thursday at ten';

// ── seed a REAL wav through the REAL module (the same writer, no fixtures) ──
const { makeWav } = await import(path.join(REPO, 'src', 'voice.js'));
fs.writeFileSync(path.join(root, 'meeting.wav'), makeWav({ seconds: 1 }));

// ── start the COMMITTED mock STT server (a real child, real wire) ───────────
const mock = spawn('node', [path.join(REPO, 'examples', 'mock-stt-server.js'), '--port', '8178', '--text', CANNED], { stdio: ['ignore', 'pipe', 'pipe'] });
let mockLog = '';
mock.stdout.on('data', (d) => { mockLog += d.toString(); });
mock.stderr.on('data', (d) => { mockLog += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function facts(port = 8178) {
  const r = await fetch(`http://127.0.0.1:${port}/__facts`).then((x) => x.json()).catch(() => null);
  return r;
}
let up = null;
for (let i = 0; i < 40 && !up; i++) { await sleep(100); up = await facts(); }
if (!up) { console.error('DRILL BLOCKED — the mock STT server never came up on 8178'); mock.kill('SIGKILL'); process.exit(1); }

const frames = [];
function cap(title, sections) {
  const bar = '-'.repeat(78);
  let t = `${bar}\n${title}\n${bar}\n`;
  for (const s of sections) {
    if (s.cmd) t += `\n$ buddy ${s.cmd}\n`;
    const r = s.run;
    if (r?.stdout?.trim()) t += r.stdout.trimEnd() + '\n';
    if (r?.stderr?.trim()) t += r.stderr.trimEnd() + '\n';
    if (s.exit != null) t += `exit=${s.exit}\n`;
    if (s.text) t += s.text.trimEnd() + '\n';
  }
  return t;
}

// ── frame-01: the status card — disk-only facts, the honest contract ────────
{
  const s = buddy(['voice', 'status']);
  ok(s.status === 0, 'frame-01: buddy voice status exits 0');
  ok(s.stderr.includes('voice — keyless speech-to-text (v0.55.0)'), 'frame-01: the card names the wave');
  ok(s.stderr.includes('http://127.0.0.1:8178/'), 'frame-01: the default endpoint is the loopback whisper.cpp port');
  ok(s.stderr.includes('NO credentials field exists'), 'frame-01: the KEYLESS contract is on the card');
  ok(s.stderr.includes('ctrl+g'), 'frame-01: the card teaches the dictate binding');
  ok(/recorders: .*ffmpeg/.test(s.stderr), 'frame-01: recorders probed on THIS machine (ffmpeg present)');
  const list = buddy(['voice', 'list']);
  ok(list.status === 0 && list.stderr.includes('no kept audio'), 'frame-01: the empty list teaches the keepAudio knob');
  frames.push(['frame-01-the-status-card.txt', cap('frame-01 — THE STATUS CARD (disk-only facts; the keyless contract in plain English)', [
    { cmd: 'voice status', run: s, exit: s.status },
    { cmd: 'voice list', run: list, exit: list.status },
  ])]);
}

// ── frame-02: the wire — a REAL multipart POST to a REAL server ─────────────
{
  const t = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(t.status === 0, `frame-02: transcribe exits 0 (${t.stderr.slice(0, 120)})`);
  ok(t.stderr.includes('OK transcribe'), 'frame-02: the receipt is OK transcribe');
  ok(t.stderr.includes('whisper dialect') && t.stderr.includes('host 127.0.0.1:8178'), 'frame-02: the receipt names the dialect + host');
  ok(t.stderr.includes(CANNED), 'frame-02: the transcript rides the receipt');
  const f1 = await facts();
  ok(f1.requests === 1, `frame-02: the server received exactly 1 request (saw ${f1.requests})`);
  ok(f1.bytes > 32000, `frame-02: the server received ${f1.bytes} bytes (the wav + multipart envelope)`);
  ok(mockLog.includes('RIFF ok'), 'frame-02: the mock parsed the upload as real RIFF audio');
  frames.push(['frame-02-the-wire.txt', cap('frame-02 — THE WIRE (a real multipart POST, parsed by the real server; the transcript is CANNED — the mock speaks the dialect, not ASR — declared)', [
    { text: `--> the endpoint on camera is the COMMITTED examples/mock-stt-server.js\n    (loopback-only child process; canned transcript = "${CANNED}")` },
    { cmd: 'voice transcribe -f meeting.wav', run: t, exit: t.status },
    { text: `--> the server\'s own log (the other end of the wire):\n${mockLog.trim().split('\n').map((l) => '    ' + l).join('\n')}` },
    { text: `--> GET /__facts (the server\'s counters): ${JSON.stringify(f1)}` },
  ])]);
}

// ── frame-03: broken input is a refusal — ZERO bytes on the wire ────────────
{
  const torn = makeWav({ seconds: 0.5 });
  fs.writeFileSync(path.join(root, 'torn.wav'), Buffer.from(torn.subarray(0, torn.length - 100)));
  fs.writeFileSync(path.join(root, 'junk.wav'), Buffer.from('definitely not a RIFF audio file, just plain text'));
  fs.writeFileSync(path.join(root, 'giant.wav'), Buffer.alloc(33 * 1024 * 1024, 0x41)); // over the 32MB cap
  const before = await facts();
  const r1 = buddy(['voice', 'transcribe', '-f', 'torn.wav']);
  const r2 = buddy(['voice', 'transcribe', '-f', 'junk.wav']);
  const r3 = buddy(['voice', 'transcribe', '-f', 'giant.wav']);
  ok(r1.status === 2 && /torn or truncated/.test(r1.stderr), 'frame-03: the torn wav is refused with the parser position');
  ok(r2.status === 2 && /not a RIFF container/.test(r2.stderr), 'frame-03: junk is refused (not a RIFF container)');
  ok(r3.status === 2 && /over the .* cap/.test(r3.stderr), 'frame-03: the 33MB giant is refused');
  const after = await facts();
  ok(after.requests === before.requests && after.bytes === before.bytes,
    `frame-03: ZERO BYTES ON THE WIRE — server counters unchanged (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
  frames.push(['frame-03-zero-bytes-on-the-wire.txt', cap('frame-03 — BROKEN INPUT IS A REFUSAL, ZERO BYTES ON THE WIRE (the server\'s own counters prove it)', [
    { cmd: 'voice transcribe -f torn.wav', run: r1, exit: r1.status },
    { cmd: 'voice transcribe -f junk.wav', run: r2, exit: r2.status },
    { cmd: 'voice transcribe -f giant.wav', run: r3, exit: r3.status },
    { text: `--> GET /__facts BEFORE the refusals: ${JSON.stringify(before)}\n--> GET /__facts AFTER  the refusals: ${JSON.stringify(after)}\n    the server never saw a byte of the broken files — the parser\n    refused them BEFORE the wire, and the OTHER END is the witness` },
  ])]);
}

// ── frame-04: the keyless contract — credentials are teaching refusals ──────
{
  const settings = path.join(root, '.buddy', 'settings.json');
  const set = (o) => { fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, JSON.stringify(o, null, 2)); };
  set({ voice: { stt: { endpoint: 'http://127.0.0.1:8178', apiKey: 'sk-hunter2-do-not-leak' } } });
  const a = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(a.status === 2 && a.stderr.includes('"apiKey" looks like credentials') && a.stderr.includes('KEYLESS'), 'frame-04: an apiKey in the config is a TEACHING refusal, never a credential in play');
  set({ voice: { stt: { temperature: 0.5 } } });
  const b = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(b.status === 2 && b.stderr.includes('unknown key "temperature"'), 'frame-04: an unknown key is NAMED, never applied');
  set({ voice: { stt: { endpoint: 'http://user:pass@127.0.0.1:8178' } } });
  const c = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(c.status === 2 && c.stderr.includes('must not embed credentials'), 'frame-04: credentials embedded in the endpoint are refused');
  set({ voice: { stt: { endpoint: 'javascript:alert(1)' } } });
  const d = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(d.status === 2 && d.stderr.includes('scheme must be http(s)'), 'frame-04: a javascript: endpoint is refused');
  const after = await facts();
  ok(after.requests === 1, `frame-04: the hostile configs never touched the wire (requests still ${after.requests})`);
  frames.push(['frame-04-the-keyless-contract.txt', cap('frame-04 — THE KEYLESS CONTRACT (credentials are teaching refusals; voice has no key field to set)', [
    { text: '--> .buddy/settings.json: {"voice":{"stt":{"endpoint":"…8178","apiKey":"sk-hunter2-do-not-leak"}}}' },
    { cmd: 'voice transcribe -f meeting.wav', run: a, exit: a.status },
    { text: '--> {"voice":{"stt":{"temperature":0.5}}} — an unknown key is NAMED, never applied' },
    { cmd: 'voice transcribe -f meeting.wav', run: b, exit: b.status },
    { text: '--> {"voice":{"stt":{"endpoint":"http://user:pass@…"}}} — embedded credentials' },
    { cmd: 'voice transcribe -f meeting.wav', run: c, exit: c.status },
    { text: '--> {"voice":{"stt":{"endpoint":"javascript:alert(1)"}}} — not an http(s) scheme' },
    { cmd: 'voice transcribe -f meeting.wav', run: d, exit: d.status },
    { text: `--> GET /__facts: ${JSON.stringify(after)} — four hostile configs, zero wire` },
  ])]);
}

// ── frame-05: the transcript is data — a hostile server cannot paint ────────
{
  // the drill plays attacker: a tmp-written server (declared) answering
  // hostile bodies on path-prefixed modes
  const attackerFile = path.join(root, 'attacker-stt.mjs');
  fs.writeFileSync(attackerFile, `import http from 'node:http';
const replies = {
  '/a': ${JSON.stringify(JSON.stringify({ text: '\u001b]0;pwned-title\u0007hello from a hostile server\u001b[38;5;208mBODY\u001b[0m' }))},
  '/b': 'HTML:<html><body>please log in</body></html>',
  '/c': ${JSON.stringify(JSON.stringify({ text: 123 }))},
  '/d': ${JSON.stringify(JSON.stringify({ text: null }))},
  '/e': ${JSON.stringify(JSON.stringify({ text: '\u001b]83;hidden-exfil' }))},
};
http.createServer((req, res) => {
  let chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const key = Object.keys(replies).find((k) => req.url.startsWith(k)) || '/a';
    const html = key === '/b';
    res.writeHead(200, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json' });
    res.end(html ? replies[key].slice(5) : replies[key]);
  });
}).listen(8199, '127.0.0.1', () => console.log('attacker up on 8199'));
`);
  const attacker = spawn('node', [attackerFile], { stdio: 'ignore' });
  let aUp = false;
  for (let i = 0; i < 30 && !aUp; i++) { await sleep(100); aUp = await facts(8199); }
  ok(aUp, 'frame-05: the attacker server is up (loopback 8199)');
  const settings = path.join(root, '.buddy', 'settings.json');
  const setEp = (ep) => fs.writeFileSync(settings, JSON.stringify({ voice: { stt: { endpoint: ep } } }));
  // /a — ANSI + OSC + hostile title in the transcript: stripped WHOLE, body never painted
  setEp('http://127.0.0.1:8199/a');
  const a = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(a.status === 0 && a.stderr.includes('hello from a hostile serverBODY'), 'frame-05: the hostile transcript survives as DATA (sequences stripped whole)');
  ok(!a.stderr.includes('\u001b') && !a.stderr.includes('pwned'), 'frame-05: no ESC byte, no hostile title survives');
  // /e — UNTERMINATED OSC: the body cannot leak as text
  setEp('http://127.0.0.1:8199/e');
  const e = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(e.status === 0 && e.stderr.includes('(empty transcript') && !e.stderr.includes('hidden-exfil'), 'frame-05: an unterminated OSC swallows whole — the exfil string never shows');
  // /b — 200 with HTML: refused with the content-type
  setEp('http://127.0.0.1:8199/b');
  const b = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(b.status === 2 && b.stderr.includes('text/html'), 'frame-05: a 200-with-HTML is refused with the content-type');
  // /c — text as number: refusal; /d — text null: HONEST empty
  setEp('http://127.0.0.1:8199/c');
  const c = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(c.status === 2 && c.stderr.includes('not a string'), 'frame-05: text as number is refused (never coerced into a guess)');
  setEp('http://127.0.0.1:8199/d');
  const d = buddy(['voice', 'transcribe', '-f', 'meeting.wav']);
  ok(d.status === 0 && d.stderr.includes('(empty transcript'), 'frame-05: text:null is the honest empty');
  fs.writeFileSync(settings, JSON.stringify({ voice: { stt: { endpoint: 'http://127.0.0.1:8178' } } })); // restore
  frames.push(['frame-05-the-transcript-is-data.txt', cap('frame-05 — THE TRANSCRIPT IS DATA (a hostile server cannot paint, leak, or lie its way in)', [
    { text: '--> the drill plays attacker: tmp-written server (declared) on loopback 8199,\n    five answer modes behind path prefixes; the CLI is REAL throughout' },
    { text: '--> /a answers {"text":"<ESC>]0;pwned-title<BEL>hello from a hostile server<ESC>[38;5;208mBODY<ESC>[0m"}' },
    { cmd: 'voice transcribe -f meeting.wav  (endpoint …/a)', run: a, exit: a.status },
    { text: '--> /e answers an UNTERMINATED OSC carrying an exfil-looking string' },
    { cmd: 'voice transcribe -f meeting.wav  (endpoint …/e)', run: e, exit: e.status },
    { text: '--> /b answers 200 text/html — a login page wearing a transcript\'s status code' },
    { cmd: 'voice transcribe -f meeting.wav  (endpoint …/b)', run: b, exit: b.status },
    { text: '--> /c answers {"text":123} — /d answers {"text":null}' },
    { cmd: 'voice transcribe -f meeting.wav  (endpoint …/c)', run: c, exit: c.status },
    { cmd: 'voice transcribe -f meeting.wav  (endpoint …/d)', run: d, exit: d.status },
  ])]);
  attacker.kill('SIGKILL');
}

// ── frame-06: the agent tool — voice_transcribe through the REAL toolset ────
{
  fs.rmSync(path.join(root, '.buddy', 'settings.json'), { force: true }); // default loopback endpoint again
  const { LocalScope, buildLocalTools } = await import(path.join(REPO, 'src', 'tools', 'local.js'));
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const t = tools.find((x) => x.name === 'voice_transcribe');
  ok(Boolean(t), 'frame-06: voice_transcribe is registered in the chat toolset');
  ok(t.risky === true, 'frame-06: the tool is risky:true — the why contract applies (bytes leave the machine)');
  const t1 = await t.run({ path: 'meeting.wav', why: 'drill: demo the tool surface' });
  ok(/OK transcribe/.test(t1) && t1.includes(CANNED), 'frame-06: the tool transcribes through the same engine + endpoint');
  const t2 = await t.run({ path: 'notes.txt', why: 'wrong extension' });
  ok(/not a \.wav/.test(t2) && /converted first/.test(t2), 'frame-06: a .txt is a teaching refusal (RIFF-only, conversion hinted)');
  const t3 = await t.run({ path: '../outside.wav', why: 'escape the workspace' });
  ok(/ERROR/.test(t3), 'frame-06: an escape path is refused by the scope guard');
  const t4 = await t.run({ path: 'no-such.wav', why: 'missing file' });
  ok(/ERROR/.test(t4), 'frame-06: a missing file is refused honestly');
  frames.push(['frame-06-the-agent-tool.txt', cap('frame-06 — THE AGENT TOOL (voice_transcribe through the REAL chat toolset, declared)', [
    { text: '--> declared: voice_transcribe.run from buildLocalTools({ scope: LocalScope(root) })\n    — the exact object the live chat loop hands the model; risky:true' },
    { text: `> voice_transcribe  {"path":"meeting.wav","why":"drill: demo the tool surface"}\n${t1.split('\n').slice(0, 3).join('\n')}` },
    { text: `> voice_transcribe  {"path":"notes.txt"}\n${t2}` },
    { text: `> voice_transcribe  {"path":"../outside.wav"}\n${t3}` },
    { text: `> voice_transcribe  {"path":"no-such.wav"}\n${t4}` },
  ])]);
}

// ── frame-07: the audit trail + the machine's own recorder, honestly ────────
{
  const evRaw = fs.readFileSync(path.join(root, '.buddy', 'events.jsonl'), 'utf8');
  const rows = evRaw.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'voice');
  ok(rows.length >= 1, `frame-07: ${rows.length} voice facts in events.jsonl`);
  ok(rows.every((r) => !('text' in r) && !('transcript' in r)), 'frame-07: no row carries transcript content');
  ok(rows.some((r) => r.ok === true && r.endpointHost === '127.0.0.1:8178' && r.transcriptChars === CANNED.length && r.audioBytes > 32000), 'frame-07: the success rows carry FACTS (host, audio bytes, transcript CHARS — not text)');
  ok(!evRaw.includes(CANNED) && !evRaw.includes('pwned') && !evRaw.includes('hidden-exfil'), 'frame-07: the transcript text appears in ZERO events bytes (facts, not content)');
  const rec = buddy(['voice', 'record', '--secs', '2']);
  ok(rec.status === 2 && /failed/.test(rec.stderr) && /No fake recording/.test(rec.stderr), 'frame-07: record honestly fails on a machine with no capture device (real stderr, no fake capture)');
  fs.mkdirSync(path.join(root, '.buddy', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'voice', 'kept-dictation.wav'), makeWav({ seconds: 0.4 })); // declared: simulates a keepAudio:true capture
  const list = buddy(['voice', 'list']);
  ok(list.status === 0 && list.stderr.includes('kept-dictation.wav') && /kept audio \(/.test(list.stderr), 'frame-07: voice list shows kept audio with bytes + mtime');
  frames.push(['frame-07-the-audit-trail.txt', cap('frame-07 — THE AUDIT TRAIL + THE RECORDER, HONESTLY (facts, not content; no fake capture)', [
    { text: `--> .buddy/events.jsonl voice rows (${rows.length} facts across the drill):\n${rows.map((r) => '    ' + JSON.stringify(r)).join('\n')}` },
    { text: `--> grep the log for the transcript text: ${evRaw.includes(CANNED) ? 'FOUND (would be a failure)' : 'absent — the events log is facts, not content'}` },
    { cmd: 'voice record --secs 2   (ffmpeg present, no capture device)', run: rec, exit: rec.status },
    { text: '--> the drill seeds .buddy/voice/kept-dictation.wav (declared: what the REPL\n    leaves behind when voice.record.keepAudio is true), then:' },
    { cmd: 'voice list', run: list, exit: list.status },
  ])]);
}

// ── verdict + evidence pack ─────────────────────────────────────────────────
for (const [name, body] of frames) {
  fs.writeFileSync(path.join(OUT, name), body);
}
const finalFacts = await facts();
const groundtruth = {
  wave: 'v0.55.0 — voice input: keyless STT dictation (§11)',
  date: new Date().toISOString(),
  assertions: asserted, passed, failed: problems.length,
  frames: frames.map(([n]) => n),
  verdict: problems.length === 0 ? 'DRILL: PASS' : 'DRILL: FAIL',
  stt_endpoint: 'examples/mock-stt-server.js — the COMMITTED loopback mock (real wire dialects, canned transcript — declared)',
  server_final_facts: finalFacts,
  zero_wire_proof: 'frame-03: the server\'s own /__facts counters unchanged across 3 broken-file refusals',
};
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2) + '\n');
console.log(`\nDRILL v0.55: ${passed}/${asserted} — ${groundtruth.verdict}`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  mock.kill('SIGKILL');
  process.exit(1);
}
console.log(`frames → ${OUT}`);
mock.kill('SIGKILL');
process.exit(0);
