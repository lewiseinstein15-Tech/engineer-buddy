#!/usr/bin/env node
// v0.55.0 RED TEAM PASS (war-room Play 4) — try to break the voice plane
// before it ships: WAV WEAPONS (a 500-buffer fuzz flood where every outcome
// must be an honest coded refusal or a clean parse — never a stray throw;
// chunk tables that lie with 0xFFFFFFFF sizes; a data header at exact EOF;
// zero-size chunk walks; format/bits/channels/rate boundary probes),
// MULTIPART INJECTION (audio bytes that embed the boundary text and fake
// Content-Disposition parts — defeated by the RED-TEAM-DRIVEN per-request
// random boundary; two requests never share a boundary), TRANSCRIPT WEAPONS
// (OSC with ST terminator, unterminated OSC, ANSI floods, a 1MB transcript
// capped to 64k, CRLF round-trips byte-honest), CONFIG WEAPONS (__proto__
// and constructor keys in the settings view stay named DATA — cfg is never
// polluted; the canary credential value never reaches cfg, receipts, or the
// events log), ENDPOINT WEAPONS (javascript:/data:/protocol-relative/
// 2049-char URLs refused), WIRE WEAPONS (a fetchImpl that throws a raw
// string, a text() that rejects, 200-with-HTML, non-string text fields,
// an endpoint path joined not replaced), RECORDER WEAPONS (junk secs —
// "60\n"/abc/-5/1e2 — canonical-or-default, never coerced into a guess;
// a hostile shape refused), TORN CAPTURES (0xFFFFFFFF data sizes finalized
// honestly to the bytes on disk), and CLI UNDER ATTACK (100-arg floods, a
// .wav DIRECTORY, junk settings.json degrading honestly, dead default
// endpoint exit 2). A stray throw, a boundary collision, a polluted
// prototype, a leaked canary byte, or a fake recording = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseWav, makeWav, sanitizeTranscript, validateEndpoint,
  parseVoiceConfig, parseRecordConfig, readVoiceConfig,
  probeRecorders, recordAudio, startRecording, finalizeTornWav,
  buildTranscribeRequest, transcribeWav, transcribeReceiptText,
  MAX_TRANSCRIPT_CHARS,
} from '../src/voice.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { BuddyError } from '../src/util.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO, 'src', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt55-'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const attempt = (fn) => {
  try { return { out: fn(), err: null }; } catch (e) { return { out: null, err: e }; }
};
const attemptA = async (fn) => {
  try { return { out: await fn(), err: null }; } catch (e) { return { out: null, err: e }; };
};

// ── 1. WAV fuzz flood: 500 hostile buffers, every outcome honest ────────────
{
  const fuzz = () => {
    const kind = crypto.randomInt(6);
    if (kind === 0) return crypto.randomBytes(crypto.randomInt(1, 2048));
    if (kind === 1) { // RIFF-looking garbage
      const b = crypto.randomBytes(crypto.randomInt(12, 512));
      b.write('RIFF', 0, 'latin1');
      if (b.length > 12) b.write('WAVE', 8, 'latin1');
      return b;
    }
    if (kind === 2) { // real header + lying chunk table
      const b = Buffer.concat([makeWav({ seconds: 0.05 }), crypto.randomBytes(crypto.randomInt(0, 256))]);
      b.writeUInt32LE(crypto.randomInt(0, 0xffffffff), 4);
      if (b.length > 40) b.writeUInt32LE(crypto.randomInt(0, 0xffffffff), 40 + crypto.randomInt(0, 4));
      return b;
    }
    if (kind === 3) return Buffer.alloc(0);
    if (kind === 4) { // chunk flood: 500 zero/odd chunks then a real body
      const chunks = [];
      for (let i = 0; i < 500; i++) {
        chunks.push(Buffer.from(`X${String(i).padStart(3, '0')}`, 'latin1'));
        const s = Buffer.alloc(4);
        s.writeUInt32LE(crypto.randomInt(0, 8), 0);
        chunks.push(s, crypto.randomBytes(crypto.randomInt(0, 4)));
      }
      return Buffer.concat([makeWav({ seconds: 0.05 }), ...chunks]);
    }
    return makeWav({ seconds: crypto.randomInt(1, 30) / 100 }); // legal control group
  };
  let refusals = 0, parses = 0, strays = 0;
  for (let i = 0; i < 500; i++) {
    const { out, err } = attempt(() => parseWav(fuzz()));
    if (err) {
      if (err instanceof BuddyError && err.code && err.code.startsWith('WAV_')) refusals += 1;
      else strays += 1;
    } else if (out && out.sampleRate > 0) parses += 1;
    else strays += 1;
  }
  ok(strays === 0, `fuzz flood: ${strays} stray outcomes (every refusal must be a coded WAV_*, every parse clean)`);
  ok(refusals > 100, `fuzz flood: ${refusals} honest refusals (the wall is not imaginary)`);
  ok(parses > 10, `fuzz flood: ${parses} clean parses (legal audio still flows)`);
}

// ── 2. chunk-table attacks, specifically ─────────────────────────────────────
{
  const cases = [
    ['fmt size 15 (one byte short)', (b) => b.writeUInt32LE(15, 16), 'WAV_TORN_FMT'],
    ['data size 0xFFFFFFFF', (b) => b.writeUInt32LE(0xffffffff, 40), 'WAV_TORN_DATA'],
    ['data size 0x7FFFFFFF', (b) => b.writeUInt32LE(0x7fffffff, 40), 'WAV_TORN_DATA'],
    ['data size exactly len-44+1', (b) => b.writeUInt32LE(b.length - 43, 40), 'WAV_TORN_DATA'],
    ['RIFF size 0xFFFFFFFF is TOLERATED (streaming writers)', (b) => b.writeUInt32LE(0xffffffff, 4), null],
  ];
  for (const [name, patch, code] of cases) {
    const b = makeWav({ seconds: 0.1 });
    patch(b);
    const { err } = attempt(() => parseWav(b));
    if (code === null) {
      ok(!err, `${name}: accepted (the 0xFFFFFFFF riff convention) — ${err?.code || 'parsed'}`);
    } else {
      ok(err?.code === code, `${name}: refused ${code} (got ${err?.code || 'no error'})`);
      ok(err instanceof BuddyError, `${name}: the refusal is a coded BuddyError`);
    }
  }
  // a data header at exact EOF: zero audio bytes (RIFF + data sizes honest)
  const b44 = Buffer.from(makeWav({ seconds: 0.05 }).subarray(0, 44));
  b44.writeUInt32LE(36, 4); // 44-8: the header speaks the truth
  b44.writeUInt32LE(0, 40); // data size 0: zero audio bytes follow
  const e44 = attempt(() => parseWav(b44));
  ok(e44.err?.code === 'WAV_EMPTY_DATA', `data header at exact EOF: WAV_EMPTY_DATA (got ${e44.err?.code || 'parsed'})`);
  // rate/channel boundaries
  for (const [rate, good] of [[4000, true], [3999, false], [192000, true], [192001, false]]) {
    const b = makeWav({ seconds: 0.05 });
    b.writeUInt32LE(rate, 24);
    const { err } = attempt(() => parseWav(b));
    ok(good ? !err : err?.code === 'WAV_RATE', `rate ${rate}: ${good ? 'accepted' : 'refused WAV_RATE'}`);
  }
}

// ── 3. MULTIPART INJECTION: the boundary must never be guessable ─────────────
{
  // hostile audio that embeds the OLD fixed boundary + a fake part
  const poison = Buffer.concat([
    makeWav({ seconds: 0.05 }),
    Buffer.from('--buddyvoiceboundary7f3a\r\nContent-Disposition: form-data; name="pwned"\r\n\r\ninjected\r\n', 'latin1'),
  ]);
  const r1 = buildTranscribeRequest({ audio: poison, server: 'auto' });
  const r2 = buildTranscribeRequest({ audio: poison, server: 'auto' });
  const b1 = /boundary=([^;]+)/.exec(r1.headers['Content-Type'])[1];
  const b2 = /boundary=([^;]+)/.exec(r2.headers['Content-Type'])[1];
  ok(b1 !== b2, 'two requests never share a boundary (random per request)');
  ok(b1 !== 'buddyvoiceboundary7f3a', 'the boundary is never the old fixed string');
  // delimiter-level checks: split the body on the REAL boundary — the parts
  // are exactly the honest fields; the poison bytes are inert file content
  const chunks = r1.body.toString('latin1').split(`--${b1}`).slice(1, -1);
  const names = chunks.map((c) => (/name="([^"]*)"/.exec(c) || [])[1]).filter(Boolean);
  ok(JSON.stringify(names) === JSON.stringify(['response_format', 'file']), `the hostile audio cannot create a fake part — parts are exactly ${JSON.stringify(names)}`);
  ok(!chunks.some((c) => c.includes('pwned\r\n\r\n')), 'no injected part survives as a boundary-delimited field');
}

// ── 4. transcript weapons ────────────────────────────────────────────────────
{
  ok(sanitizeTranscript('\u001b]83;9999999999\u001b\\x') === 'x', 'OSC with ST terminator stripped whole');
  ok(sanitizeTranscript('\u001b]0;unterminated') === '', 'unterminated OSC cannot leak its body as text');
  const flood = '\u001b[38;5;208m'.repeat(10000) + 'payload';
  ok(sanitizeTranscript(flood) === 'payload', 'a 10k-sequence ANSI flood cannot paint its body');
  const big = 'a'.repeat(1024 * 1024);
  ok(sanitizeTranscript(big).length === MAX_TRANSCRIPT_CHARS, `a 1MB transcript is capped to ${MAX_TRANSCRIPT_CHARS}`);
  ok(sanitizeTranscript('line\r\nline2\tend') === 'line\nline2\tend', 'CRLF round-trip: \\n and \\t survive, \\r is dropped');
  // the receipt itself stays bounded
  const r = { audio: { sampleRate: 16000, channels: 1, bitsPerSample: 16, durationSec: 1 }, text: 'x'.repeat(5000), bytes: 1, ms: 1, endpointHost: 'h', warnings: [], empty: false, dialect: 'whisper' };
  const txt = transcribeReceiptText(r);
  ok(txt.length < 600, `the receipt is bounded (${txt.length} chars) — the full text rides the CLI, not the card`);
}

// ── 5. config weapons: prototype keys + canary credentials ───────────────────
{
  const CANARY = 'sk-canary-hunter2-do-not-leak';
  const hostileView = JSON.parse(`{"voice":{"stt":{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"apiKey":"${CANARY}","endpoint":"http://127.0.0.1:8178"},"record":{"token":"${CANARY}"}}}`);
  const { cfg, problems } = readVoiceConfig(hostileView);
  ok(problems.some((p) => p.includes('__proto__')), '__proto__ in the stt section is NAMED, never applied');
  ok(problems.filter((p) => p.includes('KEYLESS')).length === 2, 'both credential-smuggling keys are teaching refusals');
  ok(!JSON.stringify(cfg).includes(CANARY), `the canary value never reaches cfg (${JSON.stringify(cfg).slice(0, 80)}…)`);
  ok({}.polluted === undefined, 'Object.prototype unpolluted through the config path');
  ok(cfg.endpoint === 'http://127.0.0.1:8178/', 'the honest endpoint still parsed from the hostile block');
  // endpoint weapons
  for (const [ep, why] of [['javascript:alert(1)', 'scheme'], ['data:text/html,hi', 'scheme'], ['//host/path', 'valid URL'], [' '.repeat(10), 'non-empty'], ['http://x/' + 'a'.repeat(2048), '2048 chars']]) {
    const r = validateEndpoint(ep);
    ok(r.ok === false, `endpoint "${ep.slice(0, 24)}…" refused — ${r.reason}`);
    void why;
  }
}

// ── 6. wire weapons ──────────────────────────────────────────────────────────
{
  const wavPath = path.join(root, 'w.wav');
  fs.writeFileSync(wavPath, makeWav({ seconds: 0.1 }));
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: 'http://127.0.0.1:59999' } } });
  // a fetchImpl that throws a raw STRING (not an Error)
  const s1 = await attemptA(() => transcribeWav({ abs: wavPath, cfg, fetchImpl: async () => { throw 'not an error object'; } }));
  ok(s1.err?.code === 'VOICE_UNREACHABLE' && s1.err.message.includes('not an error object'), 'a fetchImpl throwing a raw string is still an honest refusal');
  // text() that rejects
  const s2 = await attemptA(() => transcribeWav({ abs: wavPath, cfg, fetchImpl: async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => { throw new Error('stream torn'); } }) }));
  ok(s2.err?.code === 'VOICE_BAD_BODY', `a rejecting text() degrades to VOICE_BAD_BODY (got ${s2.err?.code})`);
  // 200 with HTML
  const s3 = await attemptA(() => transcribeWav({ abs: wavPath, cfg, fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/html' }, text: async () => '<html>hi</html>' }) }));
  ok(s3.err?.code === 'VOICE_BAD_BODY' && /text\/html/.test(s3.err.message), '200-with-HTML is refused with the content-type');
  // non-string text fields
  for (const [v, shape] of [[{ text: { deep: true } }, 'object'], [{ text: ['a'] }, 'array'], [{ text: 1.5 }, 'number'], [{ text: null }, 'null']]) {
    const s = await attemptA(() => transcribeWav({ abs: wavPath, cfg, fetchImpl: async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(v) }) }));
    if (v.text === null) ok(s.out?.empty === true, `text:null is an HONEST empty transcript`);
    else ok(s.err?.code === 'VOICE_BAD_TEXT', `text as ${shape} refused VOICE_BAD_TEXT`);
  }
  // an endpoint WITH a path is JOINED, not replaced
  let seenUrl = null;
  await attemptA(() => transcribeWav({
    abs: wavPath, cfg: { ...cfg, endpoint: 'http://127.0.0.1:59999/api' },
    fetchImpl: async (u) => { seenUrl = String(u); return { status: 200, headers: { get: () => 'application/json' }, text: async () => '{"text":"ok"}' }; },
  }));
  ok(seenUrl === 'http://127.0.0.1:59999/api/inference', `path join preserved the base (${seenUrl})`);
  // a 1MB transcript from the wire is capped in the receipt path
  const s4 = await attemptA(() => transcribeWav({
    abs: wavPath, cfg,
    fetchImpl: async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ text: 'z'.repeat(1024 * 1024) }) }),
  }));
  ok(s4.out?.text.length === MAX_TRANSCRIPT_CHARS, 'a 1MB wire transcript lands capped');
}

// ── 7. recorder weapons ──────────────────────────────────────────────────────
{
  for (const [secs, expect] of [['60\n', 60], ['abc', 60], ['-5', 60], ['1e2', 60], ['0', 1], ['999999', 300], ['7', 7]]) {
    let seenSecs = null;
    await attemptA(() => recordAudio({
      outPath: path.join(root, 'r.wav'), seconds: secs, platform: 'linux',
      run: (bin, args, opts = {}) => {
        if (opts.probe) return { ok: true, stdout: 'yes\n' };
        seenSecs = args.find((a) => /^\d+$/.test(a)); // the one pure-integer arg is the duration
        fs.writeFileSync(path.join(root, 'r.wav'), makeWav({ seconds: 0.3 }));
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    }));
    ok(seenSecs === String(expect), `secs ${JSON.stringify(secs)} → canonical ${expect} (recorder saw ${JSON.stringify(seenSecs)})`);
  }
  // a hostile shape is refused before any spawn
  const sh = attempt(() => startRecording({ outPath: '/tmp/x.wav', seconds: '1', shape: { name: 'evil', bin: 'rm' } }));
  ok(sh.err instanceof BuddyError, 'a shape without an args builder is refused');
  // finalize a 0xFFFFFFFF-sized data capture
  const cap = makeWav({ seconds: 0.2 });
  cap.writeUInt32LE(0xffffffff, 40);
  const fx = attempt(() => finalizeTornWav(cap));
  ok(!fx.err && parseWav(fx.out).durationSec > 0.15, 'a 0xFFFFFFFF data size finalizes to the real bytes and parses');
}

// ── 8. the tool under attack: containment ────────────────────────────────────
{
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const t = tools.find((x) => x.name === 'voice_transcribe');
  ok(Boolean(t), 'voice_transcribe registered');
  const outside = path.join(os.tmpdir(), 'rt55-outside.wav');
  fs.writeFileSync(outside, makeWav({ seconds: 0.1 }));
  const rel = path.relative(root, outside);
  const a1 = await t.run({ path: rel.startsWith('..') ? rel : `../${path.basename(root)}/x.wav`, why: 'escape' });
  ok(/ERROR/.test(a1), `a parent-relative escape path is refused (${a1.slice(0, 60)}…)`);
  const a2 = await t.run({ path: 'no-such.wav', why: 'missing' });
  ok(/ERROR/.test(a2), 'a missing file is refused honestly');
  // null byte in path
  const a3 = await t.run({ path: 'a\u0000b.wav', why: 'null byte' });
  ok(/ERROR/.test(a3), 'a null-byte path is refused');
}

// ── 9. the CLI under attack ──────────────────────────────────────────────────
{
  const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'rt55-cli-'));
  fs.writeFileSync(path.join(junk, 'settings.json'), 'not json at all {{{');
  const s = spawnSync('node', [CLI, 'voice', 'status', '--dir', junk], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' } });
  ok(s.status === 0 && /voice — keyless/.test(s.stderr), `junk settings degrade honestly — the status card still renders (exit ${s.status})`);
  ok(!JSON.stringify(s).includes('not json at all {{{'), 'the junk bytes are not echoed as config');
  // dead default endpoint: honest exit 2
  fs.mkdirSync(path.join(junk, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(junk, '.buddy', 'settings.json'), '{}');
  fs.writeFileSync(path.join(junk, 'a.wav'), makeWav({ seconds: 0.1 }));
  const d = spawnSync('node', [CLI, 'voice', 'transcribe', '-f', 'a.wav', '--dir', junk], { encoding: 'utf8', timeout: 45000 });
  ok(d.status === 2 && /UNREACHABLE|unreachable|refused/.test(d.stderr), `a dead default endpoint is an honest exit 2 (${d.stderr.slice(0, 80)})`);
  // a .wav DIRECTORY
  fs.mkdirSync(path.join(junk, 'dir.wav'));
  const dir = spawnSync('node', [CLI, 'voice', 'transcribe', '-f', 'dir.wav', '--dir', junk], { encoding: 'utf8', timeout: 30000 });
  ok(dir.status === 2, `a directory named *.wav is refused (exit ${dir.status})`);
  // 100-arg flood
  const flood = spawnSync('node', [CLI, 'voice', 'status', '--dir', junk, ...Array.from({ length: 100 }, (_, i) => `--ignored${i}`)], { encoding: 'utf8', timeout: 30000 });
  ok(flood.status === 0 || flood.status === 2, `a 100-arg flood never crashes the CLI (exit ${flood.status})`);
}

// ── 10. the canary sweep: no credential bytes anywhere ──────────────────────
{
  const evPath = path.join(root, '.buddy', 'events.jsonl');
  let evBytes = '';
  try { evBytes = fs.readFileSync(evPath, 'utf8'); } catch { /* absent */ }
  const CANARY = 'sk-canary-hunter2-do-not-leak';
  ok(!evBytes.includes(CANARY), 'the canary value appears in ZERO events bytes');
  ok(!evBytes.includes('hunter2'), 'hunter2 appears in ZERO events bytes');
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\nRED TEAM v0.55: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('SHIP: the voice plane held the line.');
process.exit(0);
