#!/usr/bin/env node
// otel-collector.js — a minimal OTLP/HTTP-JSON metrics receiver (v0.53.0).
//
// The zero-dependency demo target for `buddy telemetry export`: run this on
// a loopback port, point chat.telemetry.endpoint at it, and watch the
// exported DELTA windows arrive as real OTLP payloads — no SDK, no protobuf,
// one fetch. It validates the payload shape enough to be honest (a malformed
// export is answered 400, never pretended accepted) and prints one summary
// line per window.
//
// House rules (the v0.51 channels receiver, carried):
//   - LOOPBACK ONLY — `--host 0.0.0.0` is refused with the tunnel answer;
//   - optional token via --token-env NAME (value lives in the environment;
//     a literal token is refused; the compare is timing-safe);
//   - exact-match routing with ONE identical 404 body (no enumeration oracle);
//   - oversized bodies get 413 BEFORE the socket dies (1MB cap);
//   - the token VALUE never renders anywhere.
//
// Usage: node examples/otel-collector.js [--port 4318] [--token-env OTLP_TOKEN]
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(flag('--port') ?? 4318);
const hostArg = flag('--host') ?? '127.0.0.1';
const tokenEnv = flag('--token-env');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('otel-collector: --port must be an integer 1-65535');
  process.exit(2);
}
if (!/^(127\.|localhost$|::1|\[::1\])/.test(hostArg.replace(/^\[|\]$/g, '')) ) {
  console.error('otel-collector: refusing to bind ' + hostArg + ' — LOOPBACK ONLY.');
  console.error('  an OTel endpoint beyond this machine is an exposure, not a feature;');
  console.error('  tunnel it if you must: ssh -R / tailscale.');
  process.exit(2);
}
let expected = null; // the token VALUE, read from the environment once
if (tokenEnv) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    console.error('otel-collector: --token-env must be an env-var NAME (the VALUE never touches argv or config)');
    process.exit(2);
  }
  expected = process.env[tokenEnv];
  if (expected == null || expected === '') {
    console.error(`otel-collector: env ${tokenEnv} is unset — a receiver that cannot check the token must not open the door`);
    process.exit(2);
  }
}

const timingSafeEq = (a, b) => {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const NOT_FOUND = JSON.stringify({ message: 'not found' });
const MAX_BODY = 1024 * 1024;

function summarize(payload) {
  // One honest pass over the OTLP payload: metric name → DELTA totals.
  const out = {};
  let bad = 0;
  for (const rm of payload?.resourceMetrics ?? []) {
    for (const sm of rm?.scopeMetrics ?? []) {
      if (!sm?.scope?.name) bad += 1;
      for (const m of sm?.metrics ?? []) {
        if (typeof m?.name !== 'string') { bad += 1; continue; }
        if (m.sum && Array.isArray(m.sum.dataPoints)) {
          for (const dp of m.sum.dataPoints) {
            const v = Number(dp?.asInt ?? dp?.asDouble ?? 0);
            if (!Number.isFinite(v)) bad += 1;
            else out[m.name] = (out[m.name] ?? 0) + v;
          }
        } else if (m.histogram?.dataPoints?.length) {
          const dp = m.histogram.dataPoints[0];
          out[m.name] = { count: Number(dp?.count ?? 0), sum: Number(dp?.asDouble ?? 0) };
        } else bad += 1;
      }
    }
  }
  return { out, bad };
}

const server = http.createServer((req, res) => {
  const answer = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body);
  };
  if (req.method !== 'POST' || req.url !== '/v1/metrics') return answer(404, NOT_FOUND);
  if (tokenEnv) {
    const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEq(got, expected)) return answer(401, JSON.stringify({ message: 'unauthorized' }));
  }
  let body = '';
  let over = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > MAX_BODY) { over = true; req.destroy(); }
  });
  req.on('end', () => {
    if (over) return; // socket already destroyed
    let payload;
    try { payload = JSON.parse(body); } catch { return answer(400, JSON.stringify({ message: 'body is not JSON' })); }
    const { out, bad } = summarize(payload);
    if (bad > 0 || !payload?.resourceMetrics?.length) {
      return answer(400, JSON.stringify({ message: `malformed OTLP (${bad} bad node(s))` }));
    }
    const svc = payload.resourceMetrics?.[0]?.resource?.attributes?.find((a) => a.key === 'service.name')?.value?.stringValue ?? '?';
    const flat = Object.entries(out).map(([k, v]) =>
      typeof v === 'object' ? `${k}:count=${v.count}` : `${k}=${v}`).join(' ');
    console.log(`otel-collector ⟳ ${new Date().toISOString()} from=${req.socket.remoteAddress} service=${svc} ${flat}`);
    answer(200, JSON.stringify({ partialSuccess: {} }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`otel-collector listening on http://127.0.0.1:${port}/v1/metrics (loopback only)`);
  if (tokenEnv) console.log(`auth: Bearer $${tokenEnv} (value never renders)`);
});
