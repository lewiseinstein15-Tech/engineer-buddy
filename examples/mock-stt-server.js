#!/usr/bin/env node
// mock-stt-server.js — a zero-dependency KEYLESS speech-to-text server for
// trying `buddy voice` without installing whisper.cpp (v0.55.0 demo).
//
//   node examples/mock-stt-server.js --port 8178 --text "hello from the mock"
//
// What it is: a loopback-only HTTP server that speaks BOTH wire dialects
// Buddy understands — the whisper.cpp `POST /inference` shape and the
// OpenAI-compatible `POST /v1/audio/transcriptions` shape — and answers
// every upload with a CANNED transcript. It does NOT do real ASR: the wire
// protocol is real (multipart is parsed, the RIFF magic is checked, request
// facts are counted), the "hearing" is a canned string, so the whole
// `buddy voice` plumbing can be exercised honestly offline. Point the real
// thing at a real whisper.cpp server for actual transcription.
//
//   GET  /__facts  → {"requests":N,"bytes":N} — what the server ACTUALLY
//                    received; the honest witness for "zero bytes on the wire"
//                    claims when uploads are refused client-side.
//
// Keyless by construction: there is no auth anywhere — that is the point.
// Loopback-only by construction: binds 127.0.0.1, never a LAN interface.
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(flag('port', '8178'), 10);
const TEXT = flag('text', 'the mock server heard this canned sentence');
const MAX_BODY = 64 * 1024 * 1024; // 64MB — mirrors buddy's own upload envelope

let requests = 0;
let bytesSeen = 0;

function extractFilePart(body, boundary) {
  // minimal multipart parse, server-side witness only: find the part whose
  // Content-Disposition names file, return its bytes
  const marker = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(marker);
  while (pos !== -1) {
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd === -1) break;
    const head = body.toString('utf8', pos, headEnd);
    const next = body.indexOf(marker, headEnd);
    if (/name="file"/.test(head)) {
      let end = next === -1 ? body.length : next;
      if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2; // trailing CRLF
      return body.subarray(headEnd + 4, end);
    }
    pos = next;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__facts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests, bytes: bytesSeen }));
    return;
  }
  if (req.method !== 'POST' || (req.url !== '/inference' && req.url !== '/v1/audio/transcriptions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not a transcription route' }));
    return;
  }
  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { refused = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (refused) return;
    requests += 1;
    const body = Buffer.concat(chunks);
    bytesSeen += body.length;
    const ct = String(req.headers['content-type'] || '');
    const m = /boundary=([^;]+)/.exec(ct);
    const file = m ? extractFilePart(body, m[1]) : null;
    if (!file || file.toString('latin1', 0, 4) !== 'RIFF') {
      console.log(`[mock-stt] request #${requests}: ${body.length} bytes, NO RIFF file part → 400`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no RIFF audio part in the multipart body' }));
      return;
    }
    console.log(`[mock-stt] request #${requests}: ${body.length} bytes, RIFF ok → 200 (canned transcript)`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: TEXT }));
  });
  req.on('error', () => { /* a destroyed upload — counted only when it completes */ });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-stt] keyless STT mock on http://127.0.0.1:${PORT} (/inference, /v1/audio/transcriptions, /__facts) — canned transcript: "${TEXT}"`);
});
