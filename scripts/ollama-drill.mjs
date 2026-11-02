#!/usr/bin/env node
// ollama-drill.mjs — prove the ollama gateway talks the REAL ollama wire
// without needing a real Ollama daemon (CI has none; your laptop might).
// A loopback stub serves /api/chat in BOTH shapes (plain JSON and NDJSON
// stream) and the gateway must read the model's answer from each.
//   node scripts/ollama-drill.mjs          → PASS/FAIL, exit 0/1
//   OLLAMA_PORT=11434 node scripts/…       → reuse a port (default: ephemeral)
import http from 'node:http';
import { createOllamaGateway } from '../src/brain/gateways/ollama.js';

const port = Number(process.env.OLLAMA_PORT) || 0;
let mode = 'json'; // the stub flips to NDJSON for the second call

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/api/chat')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const asked = JSON.parse(body || '{}');
    if (asked.model !== 'fake-local') {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown model' }));
      return;
    }
    if (asked.stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'LOCAL BRAIN ' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { content: 'ONLINE (streamed)' }, done: true, prompt_eval_count: 11, eval_count: 7 }) + '\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: asked.model, message: { content: 'LOCAL BRAIN ONLINE (buffered)' }, prompt_eval_count: 11, eval_count: 7 }));
    }
  });
});

const timeouts = { chatMs: 5000, httpMs: 5000 };
const gw = createOllamaGateway({ baseUrl: `http://127.0.0.1:${port}`, models: ['fake-local'], enabled: true }, timeouts);
let failed = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${label}${cond ? '' : extra}`);
  if (!cond) failed++;
};

await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const live = createOllamaGateway({ baseUrl: base, models: ['fake-local'] }, timeouts);
try {
  const buffered = await live.chat([{ role: 'user', content: 'ping' }]);
  check('buffered /api/chat answered', buffered.text === 'LOCAL BRAIN ONLINE (buffered)', ` — got ${JSON.stringify(buffered.text)}`);
  check('gateway attribution', buffered.gateway === 'ollama' && buffered.model === 'fake-local');
  check('usage counters read', buffered.usage?.completionTokens === 7, ` — got ${JSON.stringify(buffered.usage)}`);

  const streamed = await live.chat([{ role: 'user', content: 'ping' }], { onDelta: () => {} });
  check('NDJSON stream assembled', streamed.text === 'LOCAL BRAIN ONLINE (streamed)', ` — got ${JSON.stringify(streamed.text)}`);
  check('stream marked', streamed.streamed === true);

  const bad = await live.chat([{ role: 'user', content: 'ping' }], { model: 'nope' }).catch((e) => e);
  check('wrong model → HTTP_400 surfaced', bad?.code === 'HTTP_400', ` — got ${bad?.code || bad}`);
} catch (e) {
  check('no unexpected crash', false, ` — ${e.message}`);
} finally {
  server.close();
}
console.log(failed ? `OLLAMA DRILL: FAIL (${failed})` : 'OLLAMA DRILL: PASS');
process.exit(failed ? 1 : 0);
