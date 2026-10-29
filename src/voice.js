// voice.js — keyless speech-to-text dictation (§11 "Voice input", v0.55.0).
//
// The contract, in house voice:
//   - RECORD rides the machine's own recorders (arecord / sox-rec / parecord /
//     ffmpeg — probed at call time, never bundled; absent = honest refusal
//     naming what was probed: the v0.43 cloud / v0.50 frontier pattern).
//     Recorder argv is BUILT by this module — one whitelisted shape per
//     recorder, the only user-controlled piece is the contained output path.
//   - TRANSCRIBE speaks ONE keyless endpoint: no API key field exists, and a
//     config that tries to smuggle one (apiKey / token / headers / auth) is a
//     teaching refusal — voice is keyless BY CONTRACT. Wire dialects: the
//     whisper.cpp `/inference` shape and the OpenAI-compatible
//     `/v1/audio/transcriptions` shape.
//   - Endpoint hygiene is the v0.53 telemetry discipline carried over: http(s)
//     only, no embedded credentials, no fragment, no control bytes, bounded.
//   - BROKEN INPUT IS A REFUSAL, ZERO BYTES ON THE WIRE: a torn/truncated WAV
//     is refused with the parser's own position (the v0.54 notebook lesson),
//     never uploaded for a stranger to interpret.
//   - THE TRANSCRIPT IS DATA: whole ANSI/OSC sequences stripped (the v0.52
//     renderer discipline — a bare char class would eat the ESC byte), control
//     chars dropped, bounded. The endpoint's JSON is parsed defensively —
//     __proto__ stays data (JSON.parse cannot pollute; own-key reads pinned).
//   - Facts land in .buddy/events.jsonl as `voice` rows (recorder, endpoint
//     HOST, audio bytes, seconds, transcript CHARS) — never the transcript
//     text: the events log is facts, not content.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { BuddyError } from './util.js';
import { appendEvent } from './eventslog.js';

// ── caps (why: a dictation wav is small; anything bigger is a different job) ──
export const MAX_WAV_BYTES = 32 * 1024 * 1024; // 32MB
export const MAX_WAV_SECONDS = 600; // 10 minutes
export const MAX_TRANSCRIPT_CHARS = 64 * 1024;
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8178'; // whisper.cpp-server default port
export const MAX_RECORD_SECONDS_DEFAULT = 60;
export const MAX_RECORD_SECONDS_CAP = 300;
export const DEFAULT_TIMEOUT_MS = 30000;

// ── sanitizeTranscript: whole ANSI/OSC sequences stripped, controls dropped ──
// The v0.52 lesson: a sanitizer built from a bare char class eats the ESC
// byte and PAINTS THE SEQUENCE BODY as text. Sequences go as wholes.
export function sanitizeTranscript(s, { max = MAX_TRANSCRIPT_CHARS } = {}) {
  // eslint-disable-next-line no-control-regex
  const clean = String(s ?? '')
    // Complete CSI/OSC sequences go as wholes. RED TEAM v0.55: an UNTERMINATED
    // sequence used to leak its body as text (the v0.52 lesson, second life) —
    // now a sequence swallows up to its terminator, the next ESC, or the end
    // of the string, whichever comes first. OSC runs BEFORE CSI: an OSC must
    // stop at the NEXT ESC (which may be a CSI's own), so the CSI cannot be
    // stripped out from under it first.
    .replace(/\u001B\][^\u0007]*?(?:\u0007|\u001B\\|(?=\u001B)|$)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*$/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ''); // keep \t (\u0009) and \n (\u000A)
  return clean.length > max ? clean.slice(0, max) : clean;
}

// ── WAV parsing: strict, bounds-safe, honest about every defect ──────────────
//
// parseWav returns { format, channels, sampleRate, bitsPerSample, dataBytes,
// durationSec, byteRate }. Every defect throws BuddyError with the parser's
// own position — the drill puts those refusals on camera.

function fail(msg, code, pos) {
  const at = pos != null ? ` (at byte ${pos})` : '';
  throw new BuddyError(`wav: ${msg}${at}`, { code });
}

export function parseWav(buf, { maxBytes = MAX_WAV_BYTES, maxSeconds = MAX_WAV_SECONDS } = {}) {
  if (!Buffer.isBuffer(buf)) fail('input is not a buffer', 'WAV_BAD_INPUT');
  if (buf.length === 0) fail('empty file', 'WAV_EMPTY');
  if (buf.length > maxBytes) fail(`file is ${buf.length} bytes — over the ${maxBytes} cap`, 'WAV_GIANT');
  if (buf.length < 12) fail(`truncated RIFF header (${buf.length} bytes, need ≥ 12)`, 'WAV_TORN', buf.length);
  if (buf.toString('latin1', 0, 4) !== 'RIFF') fail(`not a RIFF container (starts ${JSON.stringify(buf.toString('latin1', 0, 4))})`, 'WAV_NOT_RIFF', 0);
  if (buf.toString('latin1', 8, 12) !== 'WAVE') fail(`RIFF but not WAVE (form type ${JSON.stringify(buf.toString('latin1', 8, 12))})`, 'WAV_NOT_WAVE', 8);
  const riffSize = buf.readUInt32LE(4);
  if (riffSize !== 0xffffffff && 8 + riffSize > buf.length) {
    fail(`RIFF size says ${riffSize} but the file has ${buf.length - 8} bytes after the header — torn or truncated`, 'WAV_TORN', 4);
  }

  let fmt = null;
  let data = null;
  let pos = 12;
  // Chunk walk: id (4 bytes) + size (4 LE) + payload, padded to even. pos
  // advances by ≥ 8 every iteration, so a hostile chunk table can never loop
  // forever — a size past EOF just ends the walk (and the missing fmt/data
  // becomes the honest refusal).
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16) fail(`fmt chunk is ${size} bytes — need ≥ 16`, 'WAV_TORN_FMT', pos);
      if (body + size > buf.length) fail(`fmt chunk claims ${size} bytes but only ${buf.length - body} remain — torn`, 'WAV_TORN', pos);
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // The one chunk held to the strictest standard: the bytes must ACTUALLY
      // be there. A data size past EOF is the torn-file shape.
      if (body + size > buf.length) {
        fail(`data chunk claims ${size} bytes but only ${buf.length - body} remain — torn or truncated`, 'WAV_TORN_DATA', pos);
      }
      data = { offset: body, size };
    }
    // padding: chunks are word-aligned — odd sizes carry one pad byte
    pos = body + size + (size % 2);
  }

  if (!fmt) fail('no fmt chunk — not a parseable WAV', 'WAV_NO_FMT');
  if (!data) fail('no data chunk — a WAV without audio', 'WAV_NO_DATA');
  if (data.size === 0) fail('data chunk is empty — zero audio bytes', 'WAV_EMPTY_DATA');

  if (fmt.format !== 1 && fmt.format !== 3) {
    fail(`unsupported sample format ${fmt.format} — this tool speaks PCM (1) and IEEE float (3) only; compressed audio must be converted (hint: ffmpeg -i in.mp3 out.wav)`, 'WAV_FORMAT');
  }
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 32) {
    fail(`${fmt.bitsPerSample}-bit samples unsupported — speak 16-bit PCM (32-bit float accepted)`, 'WAV_BITS');
  }
  if (fmt.channels < 1 || fmt.channels > 8) fail(`channel count ${fmt.channels} refused (1–8)`, 'WAV_CHANNELS');
  if (fmt.sampleRate < 4000 || fmt.sampleRate > 192000) fail(`sample rate ${fmt.sampleRate} refused (4000–192000 Hz)`, 'WAV_RATE');

  const bytesPerFrame = fmt.channels * (fmt.bitsPerSample / 8);
  const rate = fmt.byteRate > 0 ? fmt.byteRate : fmt.sampleRate * bytesPerFrame;
  const durationSec = rate > 0 ? data.size / rate : 0;
  if (durationSec > maxSeconds) fail(`audio is ${durationSec.toFixed(1)}s — over the ${maxSeconds}s cap`, 'WAV_LONG');

  return {
    format: fmt.format,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    byteRate: fmt.byteRate,
    dataBytes: data.size,
    durationSec: Math.round(durationSec * 10) / 10,
  };
}

/** Build a REAL wav (tests + drill seeding — the same writer, no fixtures). */
export function makeWav({ sampleRate = 16000, channels = 1, bitsPerSample = 16, seconds = 0.2, fill = null } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = channels * bytesPerSample;
  const frames = Math.max(1, Math.round(sampleRate * seconds));
  const dataBytes = frames * frameBytes;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * frameBytes, 28);
  buf.writeUInt16LE(frameBytes, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);
  if (bitsPerSample === 16) {
    for (let i = 0; i < frames * channels; i++) {
      const v = fill ? fill(i, i % channels) : Math.round(Math.sin((i / sampleRate) * 880 * 2 * Math.PI) * 8000);
      buf.writeInt16LE(v, 44 + i * 2);
    }
  } else {
    for (let i = 0; i < frames * channels; i++) buf.writeUInt32LE(fill ? fill(i, i % channels) : 0, 44 + i * 4);
  }
  return buf;
}

// ── config: canonical-only knobs + the KEYLESS contract ─────────────────────
//
// Canonical shape (both sections optional, defaults below):
//   voice.stt:    { endpoint, server: auto|whisper|openai, model, timeoutMs }
//   voice.record: { maxSeconds, keepAudio }
//
// ANY auth-ish key (apiKey, token, headers, auth, ...) in either section is a
// TEACHING REFUSAL: voice is keyless by contract — a credentials field would
// quietly turn the feature into a paid-API client and the checklist says
// otherwise. Unknown keys are NAMED, never applied (the v0.53 knob discipline).

const VOICE_AUTH_KEYS = new Set(['apikey', 'api_key', 'token', 'headers', 'headersenv', 'auth', 'authorization', 'bearer', 'password', 'secret', 'key']);
const isBool = (v) => v === true || v === false;

export function validateEndpoint(ep) {
  if (typeof ep !== 'string' || ep.trim() === '') return { ok: false, reason: 'endpoint must be a non-empty URL string' };
  if (ep.length > 2048) return { ok: false, reason: 'endpoint over 2048 chars' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(ep)) return { ok: false, reason: 'endpoint contains control bytes — a header cannot be split through the URL' };
  let u;
  try { u = new URL(ep); } catch { return { ok: false, reason: 'endpoint is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `endpoint scheme must be http(s) — got ${u.protocol}` };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'endpoint must not embed credentials — voice is keyless by contract' };
  if (!u.hostname) return { ok: false, reason: 'endpoint has no host' };
  if (u.hash) return { ok: false, reason: 'endpoint must not carry a fragment' };
  return { ok: true, url: u };
}

function guardAuthKeys(obj, section, problems) {
  for (const k of Object.keys(obj || {})) {
    if (VOICE_AUTH_KEYS.has(String(k).toLowerCase())) {
      problems.push(`voice.${section} refused — key "${k}" looks like credentials; voice is KEYLESS by contract (point voice.stt.endpoint at a server that needs no key)`);
    }
  }
}

/** parseSttConfig — one section, canonical-only. Never throws. */
export function parseVoiceConfig(raw) {
  const cfg = { endpoint: validateEndpoint(DEFAULT_ENDPOINT).url.href, server: 'auto', model: 'whisper-1', timeoutMs: DEFAULT_TIMEOUT_MS };
  const problems = [];
  if (raw === undefined || raw === null) return { cfg, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`voice.stt refused — expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
    return { cfg, problems };
  }
  guardAuthKeys(raw, 'stt', problems);
  for (const [k, v] of Object.entries(raw)) {
    if (VOICE_AUTH_KEYS.has(k.toLowerCase())) continue;
    switch (k) {
      case 'endpoint':
        if (v === undefined || v === null || v === '') break; // default stands
        {
          const r = validateEndpoint(v);
          if (r.ok) cfg.endpoint = r.url.href;
          else problems.push(`voice.stt.endpoint refused — ${r.reason}`);
        }
        break;
      case 'server':
        if (['auto', 'whisper', 'openai'].includes(v)) cfg.server = v;
        else problems.push(`voice.stt.server must be auto | whisper | openai — got ${JSON.stringify(v)}`);
        break;
      case 'model':
        if (typeof v === 'string' && v.trim() && v.length <= 80) cfg.model = v.trim();
        else problems.push('voice.stt.model must be a short non-empty string');
        break;
      case 'timeoutMs':
        if (/^\d+$/.test(String(v))) cfg.timeoutMs = Math.max(1000, Math.min(120000, parseInt(v, 10)));
        else problems.push('voice.stt.timeoutMs must be a bare integer (ms, 1000–120000)');
        break;
      default:
        problems.push(`voice.stt: unknown key "${k}" — named, never applied (known: endpoint · server · model · timeoutMs)`);
    }
  }
  return { cfg, problems };
}

/** parseRecordConfig — the recording section. Never throws. */
export function parseRecordConfig(raw) {
  const cfg = { maxSeconds: MAX_RECORD_SECONDS_DEFAULT, keepAudio: false };
  const problems = [];
  if (raw === undefined || raw === null) return { cfg, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`voice.record refused — expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
    return { cfg, problems };
  }
  guardAuthKeys(raw, 'record', problems);
  for (const [k, v] of Object.entries(raw)) {
    if (VOICE_AUTH_KEYS.has(k.toLowerCase())) continue;
    if (k === 'maxSeconds') {
      if (/^\d+$/.test(String(v))) cfg.maxSeconds = Math.max(1, Math.min(MAX_RECORD_SECONDS_CAP, parseInt(v, 10)));
      else problems.push(`voice.record.maxSeconds must be a bare integer (1–${MAX_RECORD_SECONDS_CAP})`);
    } else if (k === 'keepAudio') {
      if (isBool(v)) cfg.keepAudio = v;
      else problems.push('voice.record.keepAudio must be true or false');
    } else {
      problems.push(`voice.record: unknown key "${k}" — named, never applied (known: maxSeconds · keepAudio)`);
    }
  }
  return { cfg, problems };
}

export function voiceDirPath(root) {
  return path.join(root, '.buddy', 'voice');
}

function sectionOf(voiceBlock, name, problems) {
  const s = voiceBlock?.[name];
  if (s === undefined || s === null) return {};
  if (typeof s !== 'object' || Array.isArray(s)) {
    problems.push(`voice.${name} refused — expected an object, got ${Array.isArray(s) ? 'an array' : typeof s}`);
    return {};
  }
  return s;
}

/**
 * readVoiceConfig — the merged settings view → { cfg, problems }.
 * cfg: { endpoint, server, model, timeoutMs, maxSeconds, keepAudio }.
 * Both canonical sections parsed independently; a section that is NOT an
 * object is a named problem (junk degrades honestly, never throws).
 */
export function readVoiceConfig(settingsView) {
  const voiceBlock = settingsView?.voice && typeof settingsView.voice === 'object' && !Array.isArray(settingsView.voice)
    ? settingsView.voice
    : {};
  const problems = [];
  const stt = sectionOf(voiceBlock, 'stt', problems);
  const record = sectionOf(voiceBlock, 'record', problems);
  for (const k of Object.keys(voiceBlock)) {
    if (k !== 'stt' && k !== 'record') problems.push(`voice: unknown section "${k}" — named, never applied (known: stt · record)`);
  }
  const sttParsed = parseVoiceConfig(stt);
  const recParsed = parseRecordConfig(record);
  problems.push(...sttParsed.problems, ...recParsed.problems);
  return { cfg: { ...sttParsed.cfg, ...recParsed.cfg }, problems };
}

// ── recorder probe: the machine's own tools, names-only, honest ──────────────

// One whitelisted argv shape per recorder, built HERE. `secs` and `out` are
// the only substituted values: secs is a canonical integer, out is a
// contained path resolved by the caller. No shell — spawnSync argv form.
export const RECORDER_SHAPES = [
  { name: 'arecord', bin: 'arecord', os: ['linux'], args: (secs, out) => ['-q', '-d', String(secs), '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', out] },
  { name: 'sox', bin: 'rec', os: ['linux', 'darwin'], args: (secs, out) => ['-q', '-c', '1', '-r', '16000', '-b', '16', out, 'trim', '0', String(secs)] },
  { name: 'parecord', bin: 'parecord', os: ['linux', 'darwin'], args: (secs, out) => ['--rate=16000', '--channels=1', '--format=s16le', `--idle-cutoff=${secs}`, out] },
  { name: 'ffmpeg-alsa', bin: 'ffmpeg', os: ['linux'], args: (secs, out) => ['-nostdin', '-loglevel', 'error', '-f', 'alsa', '-i', 'default', '-t', String(secs), '-ac', '1', '-ar', '16000', '-y', out] },
  { name: 'ffmpeg-pulse', bin: 'ffmpeg', os: ['linux'], args: (secs, out) => ['-nostdin', '-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-t', String(secs), '-ac', '1', '-ar', '16000', '-y', out] },
  { name: 'ffmpeg-avfoundation', bin: 'ffmpeg', os: ['darwin'], args: (secs, out) => ['-nostdin', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-t', String(secs), '-ac', '1', '-ar', '16000', '-y', out] },
];

function defaultRun(bin, args, { timeoutMs = 5000, probe = false } = {}) {
  // probe = names-only PATH lookup (no --version spawns, no device touches);
  // otherwise a bounded record through spawnSync argv form — no shell, no
  // interpolation, a kill timer on every call
  if (probe) {
    const p = spawnSync('sh', ['-c', `command -v '${String(bin).replace(/'/g, "")}' >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'buffer', timeout: timeoutMs });
    return { ok: p.status === 0, status: p.status, stderr: p.stderr?.toString?.() || '', stdout: p.stdout?.toString?.() || '' };
  }
  const r = spawnSync(bin, args, { encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { ok: r.status === 0, status: r.status, stderr: r.stderr?.toString?.() || '', stdout: r.stdout?.toString?.() || '' };
}

/**
 * startRecording — the ASYNC capture handle (the REPL dictation flow needs a
 * recorder that runs WHILE the input line stays live; spawnSync would block
 * the second ctrl+g on the wire). Spawn here, finalize later:
 *   const h = startRecording({ outPath, seconds, shape });
 *   … later … h.proc.kill('SIGTERM'); const r = await h.done;
 * The recorder is still bounded by its own duration flag, so a lost toggle
 * self-stops at `seconds`.
 */
export function startRecording({ outPath, seconds, shape }) {
  if (!shape || typeof shape.args !== 'function') {
    throw new BuddyError('startRecording: a probed recorder shape is required', { code: 'VOICE_RECORDER_SHAPE' });
  }
  const secs = /^\d+$/.test(String(seconds)) ? Math.max(1, Math.min(MAX_RECORD_SECONDS_CAP, parseInt(seconds, 10))) : MAX_RECORD_SECONDS_DEFAULT;
  const argv = shape.args(secs, outPath);
  const proc = spawn(shape.bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  const startedAt = Date.now();
  const done = new Promise((resolve) => {
    let stderr = '';
    proc.stderr?.on('data', (d) => { if (stderr.length < 4096) stderr += d.toString('utf8'); });
    proc.on('error', (e) => resolve({ ok: false, status: null, stderr: `${stderr}${stderr ? ' · ' : ''}${e.message}`.slice(0, 1024) }));
    proc.on('close', (code) => resolve({ ok: code === 0, status: code, stderr: stderr.slice(0, 1024) }));
  });
  return { proc, done, shape, argv, seconds: secs, startedAt };
}

/**
 * finalizeTornWav — best-effort finalization of OUR OWN capture artifact.
 * A recorder killed mid-capture (ffmpeg does not finalize on SIGTERM) leaves
 * header size fields that lie. This is not user-data guesswork: the audio
 * bytes on disk are the recording, and the header is rewritten to say
 * exactly what is there. Returns the repaired buffer; throws when the file
 * cannot be honestly finalized (no fmt, no data header at all).
 */
export function finalizeTornWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) fail('too small to finalize', 'WAV_TORN');
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    fail('not a RIFF/WAVE capture — nothing to finalize', 'WAV_NOT_WAVE');
  }
  // locate the data chunk with the same bounds-safe walk
  let pos = 12;
  let fmtOff = null;
  let dataOff = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) fmtOff = body;
    if (id === 'data') { dataOff = pos; break; }
    pos = body + size + (size % 2);
  }
  if (!fmtOff) fail('no fmt chunk — cannot finalize', 'WAV_TORN');
  if (dataOff == null) fail('no data chunk header — cannot finalize', 'WAV_TORN');
  const dataSize = buf.length - (dataOff + 8);
  if (dataSize <= 0) fail('zero audio bytes after the data header', 'WAV_EMPTY_DATA');
  const out = Buffer.from(buf);
  out.writeUInt32LE(out.length - 8, 4); // RIFF size = everything after the first 8 bytes
  out.writeUInt32LE(dataSize, dataOff + 4); // data size = the bytes that actually landed
  return out;
}

/**
 * probeRecorders — which recorder shapes can this machine run? The probe is
 * NAMES-ONLY (`sh -c 'command -v bin'`): a recorder that exists but has no
 * capture device still fails LATER, at record time, with its real stderr —
 * nothing fake is reported here either way. Injectable runner for tests.
 */
export function probeRecorders({ run = defaultRun, platform = process.platform } = {}) {
  const binFound = new Map();
  const out = [];
  for (const shape of RECORDER_SHAPES) {
    if (!shape.os.includes(platform)) {
      out.push({ ...shape, found: false, skipped: 'not on this OS' });
      continue;
    }
    if (!binFound.has(shape.bin)) {
      let found = false;
      try {
        const r = run(shape.bin, [], { probe: true, timeoutMs: 5000 });
        found = r?.ok && String(r.stdout || '').trim() === 'yes';
      } catch { found = false; }
      binFound.set(shape.bin, found);
    }
    out.push({ ...shape, found: binFound.get(shape.bin) });
  }
  return out;
}

/**
 * recordAudio — probe → first available shape → ONE bounded spawn → the
 * output is parseWav'd: a recorder that "succeeded" but wrote garbage is a
 * refusal, not a receipt. Refusals name what was probed; no fake recording
 * is ever reported (the cloud/frontier honesty rule).
 */
export async function recordAudio({ outPath, seconds, run = defaultRun, platform = process.platform, eventsRoot = null }) {
  const secs = /^\d+$/.test(String(seconds))
    ? Math.max(1, Math.min(MAX_RECORD_SECONDS_CAP, parseInt(seconds, 10)))
    : MAX_RECORD_SECONDS_DEFAULT;
  const shapes = probeRecorders({ run, platform });
  const chosen = shapes.find((s) => s.found);
  if (!chosen) {
    const probed = shapes.filter((s) => !s.skipped).map((s) => s.name).join(', ') || 'none for this OS';
    if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', recorder: null, ok: false, reason: 'no recorder' });
    throw new BuddyError(`no audio recorder found on this machine — probed: ${probed}. Install one (alsa-utils' arecord, sox, pulseaudio's parecord, or ffmpeg), or use buddy voice transcribe -f <file.wav> on an existing recording`, { code: 'VOICE_NO_RECORDER' });
  }
  const argv = chosen.args(secs, outPath);
  const t0 = Date.now();
  const r = run(chosen.bin, argv, { timeoutMs: (secs + 10) * 1000 });
  const ms = Date.now() - t0;
  if (!r?.ok) {
    if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', recorder: chosen.name, ok: false, reason: 'recorder failed' });
    throw new BuddyError(`recorder "${chosen.name}" failed (exit ${r?.status ?? 'null'}) — ${String(r?.stderr || 'no stderr').slice(0, 300)}. No fake recording is reported — check that a microphone/capture device exists`, { code: 'VOICE_RECORDER_FAILED' });
  }
  let buf;
  try {
    buf = fs.readFileSync(outPath);
  } catch (e) {
    throw new BuddyError(`recorder "${chosen.name}" exited 0 but the output is unreadable — ${e.message}`, { code: 'VOICE_RECORDER_OUTPUT' });
  }
  const audio = parseWav(buf);
  if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', recorder: chosen.name, ok: true, audioBytes: buf.length, seconds: audio.durationSec, ms });
  return { recorder: chosen.name, argv, audio, bytes: buf.length, ms };
}

// ── multipart: deterministic, hand-built (zero deps) ─────────────────────────

function multipartBody({ boundary, fileBuffer, filename, fields }) {
  const head = [];
  for (const [k, v] of Object.entries(fields)) {
    head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  head.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(head.join(''), 'utf8'), fileBuffer, Buffer.from(tail, 'utf8')]);
}

export function buildTranscribeRequest({ audio, server = 'auto', model = 'whisper-1', boundary = null }) {
  const dialect = server === 'openai' ? 'openai' : 'whisper'; // auto → whisper.cpp shape (the loopback default)
  const urlPath = dialect === 'openai' ? '/v1/audio/transcriptions' : '/inference';
  const fields = dialect === 'openai' ? { model: model || 'whisper-1', response_format: 'json' } : { response_format: 'json' };
  // RED TEAM v0.55: the boundary is RANDOM PER REQUEST — a fixed one could be
  // collided by hostile audio bytes that embed the boundary text and split the
  // multipart body into fake parts (a server-side injection through our own
  // upload). 24 hex chars from crypto.randomBytes; the audio would have to
  // guess it live to stand a chance.
  const b = boundary || `buddyvoice${crypto.randomBytes(12).toString('hex')}`;
  const body = multipartBody({ boundary: b, fileBuffer: audio, filename: 'speech.wav', fields });
  return {
    dialect,
    urlPath,
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
    body,
  };
}

// ── transcribe: ONE fetch, hard timeout, defensive parse ────────────────────

function failRefusal(msg, code) {
  throw new BuddyError(msg, { code });
}

export async function transcribeWav({ abs, cfg, fetchImpl, eventsRoot = null, readFileSync = null }) {
  const readFile = readFileSync || ((p) => fs.readFileSync(p));
  const ep = validateEndpoint(cfg?.endpoint);
  if (!ep.ok) failRefusal(`voice.stt.endpoint refused — ${ep.reason}`, 'VOICE_ENDPOINT');
  let audioBuf;
  try {
    audioBuf = readFile(abs);
  } catch (e) {
    failRefusal(`cannot read "${abs}" — ${e.message}`, 'VOICE_READ');
  }
  const audio = parseWav(audioBuf); // broken input is a refusal — ZERO bytes on the wire
  const req = buildTranscribeRequest({ audio: audioBuf, server: cfg.server, model: cfg.model });
  const url = new URL(cfg.endpoint);
  url.pathname = (url.pathname.replace(/\/+$/, '') || '') + req.urlPath;
  const f = fetchImpl || fetch;
  const t0 = Date.now();
  let res;
  try {
    res = await f(url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(cfg.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timed out after ${cfg.timeoutMs}ms` : String(e?.message || e).slice(0, 300);
    if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', ok: false, endpointHost: url.host, reason });
    failRefusal(`STT endpoint unreachable — ${reason} (endpoint host: ${url.host}; is your keyless STT server running?)`, 'VOICE_UNREACHABLE');
  }
  const raw = await res.text().catch(() => '');
  if (res.status !== 200) {
    if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', ok: false, endpointHost: url.host, status: res.status });
    failRefusal(`STT endpoint answered ${res.status} — ${sanitizeTranscript(raw).slice(0, 200) || '(no body)'}`, 'VOICE_HTTP_STATUS');
  }
  // The 200 must be JSON with a text field. A server that answers HTML is a
  // fact worth teaching: content-type + sanitized bounded preview.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const ct = String(res.headers?.get?.('content-type') || 'unknown');
    if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', ok: false, endpointHost: url.host, reason: 'non-JSON body' });
    failRefusal(`STT endpoint returned a non-JSON body (content-type ${ct}) — this tool speaks the whisper.cpp / OpenAI-compatible JSON dialects; preview: ${sanitizeTranscript(raw).slice(0, 120)}`, 'VOICE_BAD_BODY');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failRefusal('STT endpoint JSON is not an object — no transcript to trust', 'VOICE_BAD_BODY');
  }
  // own-key read: a hostile {"__proto__":...} response stays DATA
  const hasOwn = Object.prototype.hasOwnProperty.call(parsed, 'text');
  const rawText = hasOwn ? parsed.text : undefined;
  // RED TEAM v0.55: text:null is the JSON way of saying "no text" — the same
  // honest empty as a MISSING field; any other non-string type is a refusal.
  if (rawText != null && typeof rawText !== 'string') {
    failRefusal(`STT endpoint "text" field is ${typeof rawText}, not a string — refusing to guess`, 'VOICE_BAD_TEXT');
  }
  const text = sanitizeTranscript(typeof rawText === 'string' ? rawText : '');
  const ms = Date.now() - t0;
  const r = {
    text,
    empty: !text.trim(),
    dialect: req.dialect,
    audio,
    bytes: audioBuf.length,
    ms,
    endpointHost: url.host,
    warnings: [],
  };
  if (eventsRoot) appendEvent(eventsRoot, { type: 'voice', ok: true, endpointHost: url.host, dialect: req.dialect, audioBytes: audioBuf.length, seconds: audio.durationSec, transcriptChars: text.length, ms });
  return r;
}

// ── receipts (human-facing, bounded) ─────────────────────────────────────────

export function transcribeReceiptText(r) {
  const a = r.audio;
  const head = `OK transcribe · ${a.sampleRate}Hz · ${a.channels}ch · ${a.bitsPerSample}-bit · ${a.durationSec}s · ${r.bytes} bytes · ${r.dialect} dialect · ${r.ms}ms · host ${r.endpointHost}`;
  const preview = r.empty ? '(empty transcript — the server heard nothing)' : r.text.length > 400 ? `${r.text.slice(0, 400)}…` : r.text;
  const lines = [head, '', `transcript (${r.text.length} chars):`, preview];
  for (const w of r.warnings || []) lines.push(`WARNING: ${w}`);
  return lines.join('\n');
}

// ── the shared status card (CLI `buddy voice status` + REPL /voice) ──────────

export function voiceStatusText(root, { settingsView = null, platform = process.platform, run = defaultRun } = {}) {
  const { cfg, problems } = readVoiceConfig(settingsView);
  const shapes = probeRecorders({ run, platform });
  const found = shapes.filter((s) => s.found).map((s) => s.name);
  const lines = [
    `voice — keyless speech-to-text (v0.55.0)`,
    `  endpoint : ${cfg.endpoint}`,
    `  dialect  : ${cfg.server}${cfg.server === 'auto' ? ' (whisper.cpp shape; openai via voice.stt.server)' : ''} · model ${cfg.model} · timeout ${cfg.timeoutMs}ms`,
    `  record   : max ${cfg.maxSeconds}s per capture · keep audio: ${cfg.keepAudio ? 'yes (.buddy/voice/)' : 'no (deleted after transcription)'}`,
    `  recorders: ${found.length ? found.join(', ') : 'NONE FOUND — probed ' + shapes.filter((s) => !s.skipped).map((s) => s.name).join(', ')}`,
    `  contract : NO credentials field exists — point voice.stt.endpoint at a server that answers without a key`,
    `  dictate  : ctrl+g (or /dictate) — press to start, press again to finish; the transcript lands in the draft`,
  ];
  if (problems.length) lines.push(`  problems : ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`);
  return lines.join('\n');
}
