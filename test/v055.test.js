// v0.55.0 — VOICE INPUT (§11): keyless speech-to-text. Tests run against the
// pure engine (src/voice.js), the REAL CLI (index.js voice …), the REAL agent
// tool layer (LocalScope + the registered voice_transcribe tool), a REAL
// loopback STT server (node:http — the wire is never mocked, the neural
// model is out of scope by contract), and the REAL input-box reducer.
// Pins that carry the house rules:
//   - BROKEN INPUT IS A REFUSAL, ZERO BYTES ON THE WIRE: torn/truncated WAVs
//     are refused with the parser's position BEFORE any fetch (the v0.54
//     notebook lesson, carried to the network plane);
//   - KEYLESS BY CONTRACT: an auth-ish key in voice.* is a teaching refusal,
//     never a credential in play;
//   - endpoint hygiene is the v0.53 discipline: http(s) only, no embedded
//     credentials, no fragment, no control bytes;
//   - THE TRANSCRIPT IS DATA: whole ANSI/OSC sequences stripped (the v0.52
//     renderer discipline), control bytes dropped, __proto__ stays data;
//   - recorders ride the machine's own tools (names-only probe, whitelisted
//     argv, bounded), absent = honest refusal naming what was probed;
//   - events.jsonl keeps voice FACTS (bytes, seconds, chars) — never the
//     transcript text;
//   - terminals deliver key PRESS events only: the dictate binding is an
//     honest TOGGLE (the v0.33.0 wire-truth lesson, generalized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import {
  parseWav, makeWav, sanitizeTranscript, validateEndpoint,
  parseVoiceConfig, parseRecordConfig, readVoiceConfig,
  probeRecorders, recordAudio, startRecording, finalizeTornWav,
  buildTranscribeRequest, transcribeWav, transcribeReceiptText,
  voiceStatusText, voiceDirPath,
  MAX_WAV_BYTES, MAX_WAV_SECONDS, MAX_RECORD_SECONDS_CAP,
} from '../src/voice.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { applyKey } from '../src/terminal/inputbox.js';
import { SLASH_COMMANDS, SLASH_DESCRIPTIONS } from '../src/terminal/repl.js';
import { projectEvent } from '../src/eventslog.js';
import { BuddyError } from '../src/util.js';

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(REPO, 'src', 'index.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-voice55-'));
}

function codeOf(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
async function codeOfAsync(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// ── a REAL loopback STT server (declared: answers a canned transcript; the
//    point under test is OUR wire pipeline, not a neural model) ──────────────
function startLoopbackStt({ status = 200, body = null, contentType = 'application/json', sleepMs = 0, expect = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      hits.push({ path: req.url, ctype: req.headers['content-type'], bytes: raw.length, body: raw });
      const answer = () => {
        if (status !== 200) {
          res.writeHead(status, { 'content-type': contentType });
          res.end(typeof body === 'string' ? body : JSON.stringify(body ?? { error: 'no' }));
          return;
        }
        if (body !== null) {
          res.writeHead(200, { 'content-type': contentType });
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'hello from the loopback server' }));
      };
      if (sleepMs > 0) setTimeout(answer, sleepMs);
      else answer();
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, hits }));
  });
}

/** Minimal multipart reader for the loopback server side (assert OUR shape). */
function readMultipart(buf, ctype) {
  const m = /boundary=([^;]+)/.exec(ctype || '');
  assert.ok(m, 'our request carries a multipart boundary');
  const boundary = '--' + m[1];
  const parts = [];
  const text = buf.toString('latin1');
  for (const raw of text.split(boundary)) {
    if (!raw || raw === '--' || raw === '--\r\n') continue;
    const chunk = raw.replace(/^\r\n/, '').replace(/\r\n--\r?\n?$/, '').replace(/\r\n$/, '');
    const split = chunk.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = chunk.slice(0, split);
    const body = chunk.slice(split + 4);
    const nm = /name="([^"]*)"/.exec(head);
    const fm = /filename="([^"]*)"/.exec(head);
    const tm = /Content-Type: ([^\r\n]*)/.exec(head);
    if (!nm) continue;
    parts.push({ name: nm[1], filename: fm ? fm[1] : null, ftype: tm ? tm[1].trim() : null, bytes: Buffer.from(body, 'latin1') });
  }
  return parts;
}

// ═════════════════════════════ engine: the WAV parser ═══════════════════════

test('v055: parseWav accepts a real wav made by our own writer', () => {
  const buf = makeWav({ seconds: 0.5, sampleRate: 16000 });
  const a = parseWav(buf);
  assert.equal(a.sampleRate, 16000);
  assert.equal(a.channels, 1);
  assert.equal(a.bitsPerSample, 16);
  assert.equal(a.format, 1);
  assert.equal(a.durationSec, 0.5);
  assert.ok(a.dataBytes > 0);
});

test('v055: parseWav accepts float32 wavs and extra chunks before fmt (LIST/JUNK walk)', () => {
  const base = makeWav({ seconds: 0.1 });
  // splice an odd-sized LIST chunk between the WAVE marker and fmt (needs the pad byte)
  const head = base.subarray(0, 12);
  const listPayload = Buffer.from('INFOodd', 'latin1'); // 7 bytes — odd → one pad byte
  const list = Buffer.concat([Buffer.from('LIST', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(listPayload.length, 0); return b; })(), listPayload, Buffer.alloc(1)]);
  const rest = base.subarray(12);
  const out = Buffer.concat([head, list, rest]);
  out.writeUInt32LE(out.length - 8, 4); // honest RIFF size over the spliced layout
  const a = parseWav(out);
  assert.equal(a.sampleRate, 16000, 'the walk finds fmt after the odd padded LIST chunk');
  // and a float32 wav parses with format 3
  const f32 = makeWav({ seconds: 0.05, bitsPerSample: 32 });
  const patched = Buffer.from(f32);
  patched.writeUInt16LE(3, 20); // IEEE float format code
  const a32 = parseWav(patched);
  assert.equal(a32.format, 3);
  assert.equal(a32.bitsPerSample, 32);
});

test('v055: BROKEN INPUT IS A REFUSAL — empty, tiny, non-RIFF, RIFF-not-WAVE, giant', () => {
  assert.equal(codeOf(() => parseWav(Buffer.alloc(0)))?.code, 'WAV_EMPTY');
  assert.equal(codeOf(() => parseWav(Buffer.from('RIFF')))?.code, 'WAV_TORN');
  assert.equal(codeOf(() => parseWav(Buffer.from('JUNKJUNKJUNKJUNK')))?.code, 'WAV_NOT_RIFF');
  const notWave = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 20), Buffer.from('AVI ', 'latin1')]);
  assert.equal(codeOf(() => parseWav(notWave))?.code, 'WAV_NOT_WAVE');
  const giant = Buffer.alloc(MAX_WAV_BYTES + 1);
  giant.write('RIFF', 0, 'latin1'); giant.write('WAVE', 8, 'latin1');
  assert.equal(codeOf(() => parseWav(giant))?.code, 'WAV_GIANT');
});

test('v055: torn data chunk is refused WITH THE PARSER POSITION — never guessed', () => {
  const base = makeWav({ seconds: 0.2 });
  const torn = Buffer.from(base.subarray(0, base.length - 10)); // chop the tail
  torn.writeUInt32LE(torn.length - 8, 4); // make the RIFF size HONEST so the data chunk is what lies
  const e = codeOf(() => parseWav(torn));
  assert.equal(e?.code, 'WAV_TORN_DATA');
  assert.match(e.message, /torn or truncated/);
  assert.match(e.message, /at byte/);
});

test('v055: a lying RIFF size is caught; no fmt / no data are honest refusals', () => {
  const base = makeWav({ seconds: 0.1 });
  const lie = Buffer.from(base);
  lie.writeUInt32LE(999999, 4);
  assert.equal(codeOf(() => parseWav(lie))?.code, 'WAV_TORN');
  const noFmt = Buffer.concat([Buffer.from('RIFF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4, 0); return b; })(), Buffer.from('WAVE', 'latin1')]);
  assert.equal(codeOf(() => parseWav(noFmt))?.code, 'WAV_NO_FMT');
  const noData = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4 + 8 + 16, 0); return b; })(), Buffer.from('WAVE', 'latin1'),
    Buffer.from('fmt ', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(16, 0); return b; })(),
    (() => { const b = Buffer.alloc(16); b.writeUInt16LE(1, 0); b.writeUInt16LE(1, 2); b.writeUInt32LE(16000, 4); b.writeUInt32LE(32000, 8); b.writeUInt16LE(2, 12); b.writeUInt16LE(16, 14); return b; })(),
  ]);
  assert.equal(codeOf(() => parseWav(noData))?.code, 'WAV_NO_DATA');
});

test('v055: hostile chunk sizes cannot loop the walk — missing fmt/data is the refusal', () => {
  const hostile = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0xffffffff, 0); return b; })(), Buffer.from('WAVE', 'latin1'),
    Buffer.from('JUNK', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0xffffffff, 0); return b; })(),
  ]);
  const e = codeOf(() => parseWav(hostile));
  assert.ok(e, 'the walk terminates');
  assert.ok(['WAV_NO_FMT', 'WAV_NO_DATA', 'WAV_TORN'].includes(e.code), `got ${e.code}`);
});

test('v055: format/bits/channels/rate outside the honest envelope are teaching refusals', () => {
  const mk = (patch) => {
    const base = makeWav({ seconds: 0.1 });
    const b = Buffer.from(base);
    // fmt body at 20: format@0 channels@2 rate@4 byteRate@8 blockAlign@12 bits@14
    patch(b);
    return b;
  };
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt16LE(2, 20))))?.code, 'WAV_FORMAT'); // mp3-ish compressed
  assert.match(codeOf(() => parseWav(mk((b) => b.writeUInt16LE(2, 20)))).message, /ffmpeg -i/);
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt16LE(8, 34))))?.code, 'WAV_BITS');
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt16LE(9, 22))))?.code, 'WAV_CHANNELS');
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt16LE(0, 22))))?.code, 'WAV_CHANNELS');
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt32LE(1000, 24))))?.code, 'WAV_RATE');
  assert.equal(codeOf(() => parseWav(mk((b) => b.writeUInt32LE(200000, 24))))?.code, 'WAV_RATE');
});

test('v055: duration over the cap is refused with the number', () => {
  const buf = makeWav({ seconds: 1, sampleRate: 8000, channels: 1 });
  const e = codeOf(() => parseWav(buf, { maxSeconds: 0.5 }));
  assert.equal(e?.code, 'WAV_LONG');
  assert.match(e.message, /over the 0\.5s cap/);
});

// ═══════════════════════ engine: the transcript sanitizer ═══════════════════

test('v055: sanitizeTranscript strips WHOLE ANSI/OSC sequences (the v0.52 discipline)', () => {
  assert.equal(sanitizeTranscript('\u001b[31mred\u001b[0m text'), 'red text');
  assert.equal(sanitizeTranscript('\u001b]0;title\u0007body'), 'body');
  assert.equal(sanitizeTranscript('\u001b]0;title\u001b\\body'), 'body');
  // a BARE ESC is dropped, but the sequence BODY must never be painted as text
  assert.equal(sanitizeTranscript('a\u001b[2Jb'), 'ab');
  assert.equal(sanitizeTranscript('bell\u0007x\u0000y\u001f'), 'bellxy');
  assert.equal(sanitizeTranscript('keep\ttabs\nand newlines'), 'keep\ttabs\nand newlines');
  assert.equal(sanitizeTranscript('x'.repeat(100), { max: 10 }).length, 10);
  assert.equal(sanitizeTranscript(null), '');
  // RED TEAM v0.55: UNTERMINATED sequences used to leak their bodies as text
  assert.equal(sanitizeTranscript('\u001b]0;unterminated'), '', 'unterminated OSC swallowed whole');
  assert.equal(sanitizeTranscript('ok\u001b[2'), 'ok', 'unterminated CSI swallowed whole');
  assert.equal(sanitizeTranscript('\u001b]0;abc\u001b[31mx'), 'x', 'an OSC interrupted by a new ESC hands off cleanly');
  assert.equal(sanitizeTranscript('\u001b]0;a\u001b\\b\u001b[1mc'), 'bc', 'ST-terminated OSC still works beside CSI');
});

// ═══════════════════════ engine: config — KEYLESS BY CONTRACT ═══════════════

test('v055: config defaults are the loopback whisper.cpp shape', () => {
  const { cfg, problems } = parseVoiceConfig(undefined);
  assert.deepEqual(problems, []);
  assert.equal(cfg.endpoint, 'http://127.0.0.1:8178/');
  assert.equal(cfg.server, 'auto');
  assert.equal(cfg.model, 'whisper-1');
  assert.ok(cfg.timeoutMs >= 1000);
});

test('v055: endpoint hygiene — scheme, credentials, fragment, control bytes', () => {
  const cases = [
    ['ftp://x/y', /scheme/],
    ['http://user:pass@127.0.0.1:8178/inference', /credentials/],
    ['http://127.0.0.1:8178/x#frag', /fragment/],
    ['http://127.0.0.1:8178/\u0007', /control bytes/],
    ['not a url', /not a valid URL/],
    ['', /non-empty/],
    [['array'], /non-empty/],
  ];
  for (const [ep, re] of cases) {
    const r = validateEndpoint(ep);
    assert.equal(r.ok, false, ep);
    assert.match(r.reason, re);
  }
  assert.equal(validateEndpoint('http://127.0.0.1:8178').ok, true);
  assert.equal(validateEndpoint('https://stt.lan.local/v1').ok, true);
});

test('v055: an auth-ish key in the voice config is a TEACHING REFUSAL (keyless by contract)', () => {
  for (const key of ['apiKey', 'api_key', 'token', 'headersEnv', 'auth', 'password', 'secret']) {
    const { problems } = parseVoiceConfig({ [key]: 'hunter2' });
    assert.ok(problems.length, key);
    assert.match(problems[0], /KEYLESS by contract/);
  }
  // the value never lands in cfg — no credential is ever in play
  const { cfg } = parseVoiceConfig({ apiKey: 'sk-hunter2' });
  assert.equal(JSON.stringify(cfg).includes('hunter2'), false);
});

test('v055: canonical-only knobs — junk is named, never coerced into a guess', () => {
  assert.match(parseVoiceConfig({ server: 'honest' }).problems[0], /auto \| whisper \| openai/);
  assert.match(parseVoiceConfig({ timeoutMs: 'soon' }).problems[0], /bare integer/);
  assert.match(parseVoiceConfig({ timeoutMs: '30\n' }).problems[0], /bare integer/);
  assert.match(parseVoiceConfig({ model: '' }).problems[0], /short non-empty/);
  assert.match(parseVoiceConfig({ unknownKnob: 1 }).problems[0], /unknown key "unknownKnob"/);
  assert.match(parseRecordConfig({ maxSeconds: 'five' }).problems[0], /bare integer/);
  assert.match(parseRecordConfig({ keepAudio: 'yes' }).problems[0], /true or false/);
  assert.match(parseRecordConfig({ bogus: true }).problems[0], /unknown key "bogus"/);
  const { cfg } = parseVoiceConfig({ endpoint: 'http://127.0.0.1:9999', server: 'openai', timeoutMs: '5000' });
  assert.equal(cfg.endpoint, 'http://127.0.0.1:9999/');
  assert.equal(cfg.server, 'openai');
  assert.equal(cfg.timeoutMs, 5000);
});

test('v055: maxSeconds is capped at the hard ceiling', () => {
  assert.equal(parseRecordConfig({ maxSeconds: '999999' }).cfg.maxSeconds, MAX_RECORD_SECONDS_CAP);
  assert.equal(parseRecordConfig({ maxSeconds: '10' }).cfg.maxSeconds, 10);
});

test('v055: readVoiceConfig reads the canonical sections and names junk sections', () => {
  const { cfg, problems } = readVoiceConfig({ voice: { stt: { endpoint: 'http://127.0.0.1:9000' }, record: { maxSeconds: '30', keepAudio: true }, junkSection: {} } });
  assert.equal(cfg.endpoint, 'http://127.0.0.1:9000/');
  assert.equal(cfg.maxSeconds, 30);
  assert.equal(cfg.keepAudio, true);
  assert.ok(problems.some((p) => p.includes('unknown section "junkSection"')));
  // non-object sections degrade with a named problem
  const bad = readVoiceConfig({ voice: { stt: 'junk', record: ['nope'] } });
  assert.equal(bad.problems.length, 2);
  // auth keys in either section refuse
  const auth = readVoiceConfig({ voice: { stt: { token: 'x' }, record: { apiKey: 'y' } } });
  assert.equal(auth.problems.length, 2);
  assert.match(auth.problems[0], /KEYLESS/);
});

// ═══════════════════════ engine: the multipart request ══════════════════════

test('v055: buildTranscribeRequest — whisper dialect by default, openai on demand', () => {
  const audio = makeWav({ seconds: 0.05 });
  const w = buildTranscribeRequest({ audio, server: 'auto' });
  assert.equal(w.dialect, 'whisper');
  assert.equal(w.urlPath, '/inference');
  assert.match(w.headers['Content-Type'], /multipart\/form-data; boundary=/);
  assert.ok(w.body.includes('name="response_format"'));
  assert.ok(!w.body.includes('name="model"'), 'the whisper.cpp shape sends no model field');
  assert.ok(w.body.includes('filename="speech.wav"'));
  assert.ok(w.body.includes('Content-Type: audio/wav'));
  const o = buildTranscribeRequest({ audio, server: 'openai', model: 'my-model' });
  assert.equal(o.dialect, 'openai');
  assert.equal(o.urlPath, '/v1/audio/transcriptions');
  assert.ok(o.body.includes('name="model"'));
  assert.ok(o.body.includes('my-model'));
  // the audio bytes ride verbatim inside the multipart body
  assert.ok(w.body.includes(audio.subarray(0, 4)), 'RIFF magic inside the body');
});

// ═══════════════════════ engine: transcribe over the REAL wire ══════════════

test('v055: transcribeWav — REAL loopback server, whisper dialect, receipt + events fact', async () => {
  const root = tmp();
  const { srv, url, hits } = await startLoopbackStt();
  fs.writeFileSync(path.join(root, 'settings.json'), '');
  const wav = path.join(root, 'speech.wav');
  fs.writeFileSync(wav, makeWav({ seconds: 0.3 }));
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: url } } });
  const r = await transcribeWav({ abs: wav, cfg, eventsRoot: root });
  assert.equal(r.empty, false);
  assert.equal(r.text, 'hello from the loopback server');
  assert.equal(r.dialect, 'whisper');
  assert.ok(r.ms >= 0 && r.bytes > 0);
  // our request shape on the wire (the server validated it by receiving it)
  assert.equal(hits.length, 1);
  const parts = readMultipart(hits[0].body, hits[0].ctype);
  assert.ok(parts.some((p) => p.name === 'file' && p.ftype === 'audio/wav'));
  assert.ok(parts.some((p) => p.name === 'response_format'));
  // events.jsonl keeps the FACT, not the text
  const ev = JSON.parse(fs.readFileSync(path.join(root, '.buddy', 'events.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(ev.type, 'voice');
  assert.equal(ev.ok, true);
  assert.equal(ev.transcriptChars, r.text.length);
  assert.equal(JSON.stringify(ev).includes('loopback server'), false, 'no transcript text in the events log');
  srv.close();
});

test('v055: transcribeWav — openai dialect rides the canonical path with the model field', async () => {
  const root = tmp();
  const { srv, url, hits } = await startLoopbackStt();
  const wav = path.join(root, 'speech.wav');
  fs.writeFileSync(wav, makeWav({ seconds: 0.1 }));
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: url, server: 'openai', model: 'faster-whisper-local' } } });
  const r = await transcribeWav({ abs: wav, cfg });
  assert.equal(r.dialect, 'openai');
  const parts = readMultipart(hits[0].body, hits[0].ctype);
  assert.ok(parts.some((p) => p.name === 'model'));
  assert.ok(hits[0].path.startsWith('/v1/audio/transcriptions'));
  srv.close();
});

test('v055: a torn wav is refused BEFORE the wire — the fetch never fires', async () => {
  const root = tmp();
  let fetched = false;
  const wav = path.join(root, 'torn.wav');
  const torn = Buffer.from(makeWav({ seconds: 0.2 }).subarray(0, 60));
  torn.writeUInt32LE(torn.length - 8, 4); // RIFF honest, data chunk still lies
  fs.writeFileSync(wav, torn);
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: 'http://127.0.0.1:1/' } } });
  const e = await codeOfAsync(() => transcribeWav({ abs: wav, cfg, fetchImpl: async () => { fetched = true; return { status: 200, text: async () => '{}' }; } }));
  assert.equal(e?.code, 'WAV_TORN_DATA');
  assert.equal(fetched, false, 'ZERO bytes on the wire for broken input');
});

test('v055: honest refusals — unreachable endpoint, non-200, non-JSON body, hostile shapes', async () => {
  const root = tmp();
  const wav = path.join(root, 'ok.wav');
  fs.writeFileSync(wav, makeWav({ seconds: 0.1 }));
  const { cfg: cfgDead } = readVoiceConfig({ voice: { stt: { endpoint: 'http://127.0.0.1:9' } } });
  const dead = await codeOfAsync(() => transcribeWav({ abs: wav, cfg: cfgDead }));
  assert.equal(dead?.code, 'VOICE_UNREACHABLE');

  const { srv, url } = await startLoopbackStt({ status: 500, body: 'internal flames' });
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: url } } });
  const e500 = await codeOfAsync(() => transcribeWav({ abs: wav, cfg }));
  assert.equal(e500?.code, 'VOICE_HTTP_STATUS');
  assert.match(e500.message, /500/);
  assert.match(e500.message, /internal flames/);
  srv.close();

  const { srv: s2, url: u2 } = await startLoopbackStt({ body: '<html>not json</html>', contentType: 'text/html' });
  const { cfg: cfg2 } = readVoiceConfig({ voice: { stt: { endpoint: u2 } } });
  const eHtml = await codeOfAsync(() => transcribeWav({ abs: wav, cfg: cfg2 }));
  assert.equal(eHtml?.code, 'VOICE_BAD_BODY');
  assert.match(eHtml.message, /text\/html/);
  s2.close();

  const { srv: s3, url: u3 } = await startLoopbackStt({ body: '[[1,2],3]' });
  const { cfg: cfg3 } = readVoiceConfig({ voice: { stt: { endpoint: u3 } } });
  const eArr = await codeOfAsync(() => transcribeWav({ abs: wav, cfg: cfg3 }));
  assert.equal(eArr?.code, 'VOICE_BAD_BODY');
  s3.close();

  const { srv: s4, url: u4 } = await startLoopbackStt({ body: { text: 42 } });
  const { cfg: cfg4 } = readVoiceConfig({ voice: { stt: { endpoint: u4 } } });
  const eNum = await codeOfAsync(() => transcribeWav({ abs: wav, cfg: cfg4 }));
  assert.equal(eNum?.code, 'VOICE_BAD_TEXT');
  s4.close();

  // RED TEAM v0.55: text:null is the JSON way of saying "no text" — the same
  // honest empty as a MISSING field, never a refusal
  const { srv: s5, url: u5 } = await startLoopbackStt({ body: { text: null } });
  const { cfg: cfg5 } = readVoiceConfig({ voice: { stt: { endpoint: u5 } } });
  const rNull = await transcribeWav({ abs: wav, cfg: cfg5 });
  assert.equal(rNull.empty, true, 'text:null lands as an honest empty transcript');
  s5.close();
});

test('v055: hostile transcript shapes stay DATA — ANSI stripped, __proto__ not consulted, empty is honest', async () => {
  const root = tmp();
  const wav = path.join(root, 'ok.wav');
  fs.writeFileSync(wav, makeWav({ seconds: 0.1 }));
  const { srv, url } = await startLoopbackStt({ body: { text: '\u001b[31mRED\u001b[0m words\u0007', __proto__: { polluted: true }, toString: 'x' } });
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: url } } });
  const r = await transcribeWav({ abs: wav, cfg });
  assert.equal(r.text, 'RED words');
  assert.equal({}.polluted, undefined, 'no prototype pollution through the response');
  srv.close();

  const { srv: s2, url: u2 } = await startLoopbackStt({ body: { other: 'field, no text' } });
  const { cfg: cfg2 } = readVoiceConfig({ voice: { stt: { endpoint: u2 } } });
  const r2 = await transcribeWav({ abs: wav, cfg: cfg2 });
  assert.equal(r2.empty, true, 'a missing text field is an HONEST empty transcript');
  assert.match(transcribeReceiptText(r2), /\(empty transcript/);
  s2.close();
});

test('v055: a sleeping endpoint hits the hard timeout (one fetch, no retries)', async () => {
  const root = tmp();
  const wav = path.join(root, 'ok.wav');
  fs.writeFileSync(wav, makeWav({ seconds: 0.1 }));
  const { srv, url, hits } = await startLoopbackStt({ sleepMs: 5000 });
  const { cfg } = readVoiceConfig({ voice: { stt: { endpoint: url, timeoutMs: '800' } } });
  const t0 = Date.now();
  const e = await codeOfAsync(() => transcribeWav({ abs: wav, cfg }));
  assert.ok(['VOICE_UNREACHABLE'].includes(e?.code), `got ${e?.code}`);
  assert.match(e.message, /timed out|unreachable/i);
  assert.ok(Date.now() - t0 < 4000, 'the timeout actually bounded the call');
  assert.equal(hits.length, 1, 'ONE attempt — no retry storm');
  srv.close();
});

// ═══════════════════════ engine: recorders + finalize ═══════════════════════

test('v055: probeRecorders — names-only, platform-filtered, injectable', () => {
  const shapes = probeRecorders({
    platform: 'linux',
    run: (bin, args, opts = {}) => (opts.probe ? (bin === 'ffmpeg' ? { ok: true, stdout: 'yes\n' } : { ok: true, stdout: 'no\n' }) : { ok: true, stdout: '' }),
  });
  const alsa = shapes.find((s) => s.name === 'ffmpeg-alsa');
  const pulse = shapes.find((s) => s.name === 'ffmpeg-pulse');
  assert.equal(alsa.found, true, 'ffmpeg probed once — both linux shapes ride it');
  assert.equal(pulse.found, true);
  assert.equal(shapes.find((s) => s.name === 'arecord').found, false);
  assert.equal(shapes.find((s) => s.name === 'ffmpeg-avfoundation').skipped, 'not on this OS');
  // darwin: alsa/pulse skipped, avfoundation rides ffmpeg
  const mac = probeRecorders({ platform: 'darwin', run: (bin, args, opts = {}) => (opts.probe ? { ok: true, stdout: 'yes\n' } : { ok: true, stdout: '' }) });
  assert.equal(mac.find((s) => s.name === 'ffmpeg-alsa').skipped, 'not on this OS');
  assert.equal(mac.find((s) => s.name === 'ffmpeg-avfoundation').found, true);
});

test('v055: recordAudio — the argv is WHITELISTED (no shell, bounded secs, contained out)', async () => {
  const root = tmp();
  const out = path.join(root, 'cap.wav');
  let seen = null;
  // replay the probe through recordAudio with a capturing runner
  const r = await recordAudio({
    outPath: out,
    seconds: '5',
    platform: 'linux',
    run: (bin, args, opts = {}) => {
      if (opts.probe) return bin === 'arecord' ? { ok: true, stdout: 'yes\n' } : { ok: true, stdout: 'no\n' };
      seen = { bin, args };
      fs.writeFileSync(out, makeWav({ seconds: 1 }));
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(r.recorder, 'arecord');
  assert.ok(seen, 'the record call went through the runner');
  assert.deepEqual(seen.args, ['-q', '-d', '5', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', out]);
  assert.ok(!seen.args.join(' ').includes(';'), 'no shell metacharacters — argv form');
});

test('v055: recordAudio — no recorder is an honest refusal naming the probed list', async () => {
  const e = await codeOfAsync(() => recordAudio({
    outPath: '/tmp/nope.wav', seconds: '1', platform: 'linux',
    run: (bin, args, opts = {}) => (opts.probe ? { ok: true, stdout: 'no\n' } : { ok: true, stdout: '' }),
  }));
  assert.equal(e?.code, 'VOICE_NO_RECORDER');
  assert.match(e.message, /probed: arecord, sox, parecord, ffmpeg-alsa, ffmpeg-pulse/);
  assert.match(e.message, /transcribe -f/);
});

test('v055: recordAudio — a failed recorder reports its real stderr, never a fake capture', async () => {
  const root = tmp();
  const e = await codeOfAsync(() => recordAudio({
    outPath: path.join(root, 'x.wav'), seconds: '2', platform: 'linux',
    run: (bin, args, opts = {}) => (opts.probe
      ? { ok: true, stdout: 'yes\n' }
      : { ok: false, status: 1, stderr: 'alsa: no capture device (the machine has no mic)' }),
  }));
  assert.equal(e?.code, 'VOICE_RECORDER_FAILED');
  assert.match(e.message, /no capture device/);
});

test('v055: recordAudio — a "successful" recorder that wrote garbage is a refusal', async () => {
  const root = tmp();
  const out = path.join(root, 'junk.wav');
  const e = await codeOfAsync(() => recordAudio({
    outPath: out, seconds: '1', platform: 'linux',
    run: (bin, args, opts = {}) => {
      if (opts.probe) return { ok: true, stdout: 'yes\n' };
      fs.writeFileSync(out, Buffer.from('this is not a wav, it is a lie'));
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  }));
  assert.equal(e?.code, 'WAV_NOT_RIFF');
});

test('v055: finalizeTornWav — OUR capture artifact gets an honest header, then parses', () => {
  const base = makeWav({ seconds: 0.2 });
  const torn = Buffer.from(base.subarray(0, base.length - 10)); // killed mid-capture
  torn.writeUInt32LE(0, 4); // ffmpeg-style: RIFF size never finalized
  // find the data chunk and zero its size too (the full non-finalizer shape)
  const dataOff = torn.indexOf('data', 0, 'latin1');
  torn.writeUInt32LE(0, dataOff + 4);
  const fixed = finalizeTornWav(torn);
  const a = parseWav(fixed); // parses AFTER finalization
  assert.ok(a.durationSec > 0.18, `recovered ~${a.durationSec}s of real audio`);
  // refusals: not-RIFF (44+ bytes of junk), too small, zero audio
  assert.equal(codeOf(() => finalizeTornWav(Buffer.from('not a wav at all, really not a wav, padding on'.padEnd(48, '.'))))?.code, 'WAV_NOT_WAVE');
  assert.equal(codeOf(() => finalizeTornWav(Buffer.alloc(10)))?.code, 'WAV_TORN');
  const empty = makeWav({ seconds: 0.01 }).subarray(0, 44); // header only, zero audio
  empty.writeUInt32LE(36, 4);
  const eEmpty = codeOf(() => finalizeTornWav(Buffer.from(empty)));
  assert.equal(eEmpty?.code, 'WAV_EMPTY_DATA');
});

test('v055: startRecording — the async capture handle: spawn, kill, done resolves', async () => {
  const root = tmp();
  const out = path.join(root, 'cap.wav');
  // a node child (no grandchildren holding stdio pipes): killed = closes fast
  const fakeShape = { name: 'fake-rec', bin: process.execPath, os: ['linux'], args: () => ['-e', 'setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(9));'] };
  const h = startRecording({ outPath: out, seconds: '3', shape: fakeShape });
  assert.equal(h.seconds, 3);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(h.proc.exitCode, null, 'the child is still running (async, not blocking)');
  h.proc.kill('SIGTERM');
  const r = await h.done;
  assert.equal(r.ok, false, 'killed mid-capture is not an ok result');
});

// ═══════════════════════ the agent tool layer ═══════════════════════════════

test('v055: voice_transcribe through the REAL toolset — happy path + teaching refusals', async () => {
  const { srv, url } = await startLoopbackStt({ body: { text: 'deploy the auth service at noon' } });
  const root = tmp();
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ voice: { stt: { endpoint: url } } }));
  fs.writeFileSync(path.join(root, 'meeting.wav'), makeWav({ seconds: 0.2 }));
  fs.writeFileSync(path.join(root, 'notes.mp3'), Buffer.from('ID3 fake mp3'));
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const t = tools.find((x) => x.name === 'voice_transcribe');
  assert.ok(t, 'voice_transcribe is registered in the chat toolset');
  assert.equal(t.risky, true, 'egress of file bytes is gated — the why contract applies');
  const out = await t.run({ path: 'meeting.wav', why: 'the user asked for a transcript' });
  assert.match(out, /OK transcribe/);
  assert.match(out, /deploy the auth service at noon/);
  assert.match(out, /127\.0\.0\.1/);
  // teaching refusals
  const mp3 = await t.run({ path: 'notes.mp3', why: 'compressed audio' });
  assert.match(mp3, /ERROR:.*not a \.wav/);
  assert.match(mp3, /ffmpeg -i/);
  const dir = await t.run({ path: '.', why: 'a directory' });
  assert.match(dir, /ERROR/);
  const missing = await t.run({ why: 'no path' });
  assert.match(missing, /ERROR:.*path required/);
  // keyless enforcement rides the config: an auth key in settings poisons the call
  fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ voice: { stt: { apiKey: 'sk-nope' } } }));
  const auth = await t.run({ path: 'meeting.wav', why: 'credentials smuggled' });
  assert.match(auth, /ERROR:.*KEYLESS by contract/);
  srv.close();
});

test('v055: the events projection keeps voice FACTS only — never the transcript', () => {
  // exercised end-to-end above; here the projection contract is pinned
  const p = projectEvent({ type: 'voice', ok: true, recorder: 'arecord', endpointHost: '127.0.0.1:8178', dialect: 'whisper', audioBytes: 6400, seconds: 0.2, transcriptChars: 30, text: 'SECRET TRANSCRIPT THAT MUST NOT LOG' });
  assert.equal(p.type, 'voice');
  assert.equal(p.ok, true);
  assert.equal(p.transcriptChars, 30);
  assert.equal(JSON.stringify(p).includes('SECRET'), false, 'the transcript text never reaches the log');
  const f = projectEvent({ type: 'voice', ok: false, status: 500, reason: 'http' });
  assert.equal(f.status, 500);
  assert.equal(f.reason, 'http');
});

// ═══════════════════════ the CLI over the REAL command surface ══════════════

test('v055: buddy voice status — the card is disk-only facts (exit 0)', () => {
  const root = tmp();
  const r = spawnSync('node', [CLI, 'voice', 'status', '--dir', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /voice — keyless speech-to-text/);
  assert.match(r.stderr, /endpoint : http:\/\/127\.0\.0\.1:8178/);
  assert.match(r.stderr, /NO credentials field exists/);
});

test('v055: buddy voice — usage refusals exit 2', () => {
  const root = tmp();
  const bad = spawnSync('node', [CLI, 'voice', 'sing', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown voice subcommand/);
  const noFile = spawnSync('node', [CLI, 'voice', 'transcribe', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(noFile.status, 2);
  assert.match(noFile.stderr, /needs -f\/--file/);
});

test('v055: buddy voice transcribe — REAL loopback server over the REAL CLI', () => {
  return (async () => {
    // spawnSync BLOCKS this process's event loop — the server must be a real
    // child process (the v0.44 live-loopback lesson, re-learned honestly)
    const root = tmp();
    const srvSrc = [
      'const http = require("node:http");',
      'const fs = require("node:fs");',
      `const want = ${JSON.stringify('the cli speaks keyless')};`,
      'const srv = http.createServer((req, res) => { let c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {',
      '  res.writeHead(200, { "content-type": "application/json" });',
      '  res.end(JSON.stringify({ text: want }));',
      '}); });',
      'srv.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(srv.address().port)));',
    ].join('\n');
    const srvPath = path.join(root, 'stt-srv.cjs');
    const portFile = path.join(root, 'stt-port.txt');
    fs.writeFileSync(srvPath, srvSrc);
    const child = spawn(process.execPath, [srvPath, portFile], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    const port = fs.readFileSync(portFile, 'utf8').trim();
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ voice: { stt: { endpoint: `http://127.0.0.1:${port}` } } }));
    fs.writeFileSync(path.join(root, 'speech.wav'), makeWav({ seconds: 0.2 }));
    const r = spawnSync('node', [CLI, 'voice', 'transcribe', '-f', 'speech.wav', '--dir', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /OK transcribe/);
    assert.match(r.stderr, /the cli speaks keyless/);
    // broken input refused with the parser position, exit 2, endpoint untouched
    const torn = Buffer.from(makeWav({ seconds: 0.2 }).subarray(0, 80));
    torn.writeUInt32LE(torn.length - 8, 4);
    fs.writeFileSync(path.join(root, 'torn.wav'), torn);
    const bad = spawnSync('node', [CLI, 'voice', 'transcribe', '-f', 'torn.wav', '--dir', root], { encoding: 'utf8', timeout: 30000 });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /torn or truncated/);
    // config problems refuse BEFORE any wire call
    fs.writeFileSync(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ voice: { stt: { endpoint: 'ftp://nope' } } }));
    const cfgBad = spawnSync('node', [CLI, 'voice', 'transcribe', '-f', 'speech.wav', '--dir', root], { encoding: 'utf8', timeout: 30000 });
    assert.equal(cfgBad.status, 2);
    assert.match(cfgBad.stderr, /scheme must be http/);
    child.kill('SIGKILL');
  })();
});

test('v055: buddy voice record — honest refusal when the machine has no capture device', () => {
  const root = tmp();
  const r = spawnSync('node', [CLI, 'voice', 'record', '--secs', '1', '--dir', root], { encoding: 'utf8', timeout: 60000, env: { ...process.env, NO_COLOR: '1' } });
  // this machine HAS ffmpeg but no mic — the recorder must fail honestly
  // (either no recorder found, or the recorder ran and failed on the device)
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refused/);
  assert.ok(/no audio recorder found|failed \(exit/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.buddy', 'voice')) || fs.readdirSync(path.join(root, '.buddy', 'voice')).length === 0, 'no fake capture file left behind');
});

test('v055: buddy voice list — the empty state teaches the keepAudio knob', () => {
  const root = tmp();
  const r = spawnSync('node', [CLI, 'voice', 'list', '--dir', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no kept audio/);
  assert.match(r.stderr, /keepAudio/);
});

// ═══════════════════════ the REPL pieces (wire truth) ═══════════════════════

test('v055: the dictate binding is ctrl+g — and the toggle is honest wire truth', () => {
  // terminals deliver key PRESS events only; the reducer exposes ONE action
  // and the repl owns the toggle. The binding itself is pinned here.
  assert.deepEqual(applyKey({ name: 'g', ctrl: true }, {}), { action: 'dictate' });
  assert.deepEqual(applyKey({ name: 'g', ctrl: false, sequence: 'g' }, {}), { action: 'insert', data: 'g' }, 'bare g still types');
  assert.deepEqual(applyKey({ name: 'k', ctrl: true }, {}), { action: 'kill-to-line-end' }, 'neighbours untouched');
  assert.ok(SLASH_COMMANDS.includes('dictate'), '/dictate is discoverable');
  assert.ok(SLASH_COMMANDS.includes('voice'), '/voice is discoverable');
  assert.match(SLASH_DESCRIPTIONS.dictate, /press to start, press again to finish/);
  assert.match(SLASH_DESCRIPTIONS.voice, /keyless/);
});

test('v055: the voice status card is shared by CLI and REPL', () => {
  const text = voiceStatusText('/tmp/does-not-matter', {
    settingsView: { voice: { stt: { endpoint: 'http://127.0.0.1:9000' } } },
    platform: 'linux',
    run: (bin) => (bin === 'ffmpeg' ? { ok: true, stdout: 'yes\n' } : { ok: true, stdout: 'no\n' }),
  });
  assert.match(text, /http:\/\/127\.0\.0\.1:9000/);
  assert.match(text, /ffmpeg-alsa, ffmpeg-pulse/);
  assert.match(text, /ctrl\+g/);
  assert.match(text, /keyless/);
});
