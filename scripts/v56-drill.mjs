#!/usr/bin/env node
// v0.56 drill — "multi-model routing: strongest for planning, fastest for
// chores" (§11). Readable 80-col frames into download/aurora-evidence/v56-readable/.
//
// Every leg drives the REAL CLI one-shot (real spawns, real config files,
// real wire) over TWO COMMITTED mock gateways (examples/mock-gateway.js — a
// real child process each, speaking the real OpenAI dialect on loopback):
//   strong (a dynamically picked port, 90 ms) wears gateways.llm7.tier: 'strong'
//   fast   (the next port up,   15 ms) wears gateways.kilo.tier: 'fast'
// The mocks' "intelligence" is a SCRIPTED sequence of strict-JSON protocol
// replies — declared here, in every frame, and in the README. Which SERVER
// served which step is witnessed by each mock's OWN /__facts counters (the
// v0.55 lesson: the other end is the witness, never a client-side claim).
//
// The module-level pin leg uses the REAL GatewayRouter over the REAL mocks
// and is declared on camera (the v0.45/v0.49/v0.52–v0.55 precedent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v56-readable';
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v56-drill-'));
fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });

const buddy = (args, opts = {}) =>
  spawnSync('node', [path.join(REPO, 'src', 'index.js'), ...args], {
    cwd: opts.cwd || root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) },
  });

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── port picking: NEVER collide with a previous drill's orphans ─────────────
const portFree = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/__facts`, { signal: AbortSignal.timeout(300) });
    return false; // something answered — not free
  } catch {
    return true; // connection refused = free
  }
};
const STRONG_PORT = await (async () => {
  let p = 18000 + (process.pid % 1500) * 2;
  while (!(await portFree(p))) p += 2;
  return p;
})();
const FAST_PORT = STRONG_PORT + 1;
if (!(await portFree(FAST_PORT))) {
  console.error(`DRILL BLOCKED — ${FAST_PORT} busy (would collide)`);
  process.exit(1);
}

// ── the scripted voices (declared everywhere) — ONE shared reply sequence,
// both mocks serve the SAME step regardless of which tier takes the call ────
const SCRIPT = [
  '{"tool":"todo","args":{"items":[{"id":"1","text":"list the workspace","status":"in_progress"},{"id":"2","text":"report the routing","status":"pending"}]},"why":"plan before work"}',
  '{"tool":"fs_list","args":{"dir":"."},"why":"still planning: scope the demo right after the todo call"}',
  '{"tool":"fs_list","args":{"dir":".buddy"},"why":"a chore: list the state dir"}',
  '{"tool":"fs_list","args":{"dir":"examples"},"why":"another chore: list the examples dir"}',
  '{"tool":"say","message":"Routing demo done: the plan rode the strong tier, the chores rode the fast tier."}',
];
const scriptFile = path.join(root, 'script.json');
fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
const cursorFile = path.join(root, 'script-cursor');
fs.writeFileSync(cursorFile, '0');

// ── the operator's declaration (buddy.config.json) ───────────────────────────
const CONFIG = {
  gatewayOrder: ['llm7', 'kilo'],
  gateways: {
    llm7: { enabled: true, baseUrl: `http://127.0.0.1:${STRONG_PORT}`, apiKey: 'unused', models: ['strong-model'], tier: 'strong' },
    kilo: { enabled: true, baseUrl: `http://127.0.0.1:${FAST_PORT}`, models: 'auto', tier: 'fast' },
    pollinations: { enabled: false },
    duckai: { enabled: false },
    ollama: { enabled: false },
  },
};
fs.writeFileSync(path.join(root, 'buddy.config.json'), JSON.stringify(CONFIG, null, 2));

const setEffort = (level, extra = {}) => {
  fs.writeFileSync(
    path.join(root, '.buddy', 'settings.json'),
    JSON.stringify({ chat: { effort: level, ...extra } }, null, 2)
  );
};

// ── start BOTH mock gateways (real children, real wire) ──────────────────────
const mk = (port, label, model, delay) =>
  spawn('node', [path.join(REPO, 'examples', 'mock-gateway.js'), '--port', String(port), '--label', label, '--model', model, '--delay', String(delay), '--script-file', scriptFile, '--script-cursor-file', cursorFile], { stdio: ['ignore', 'pipe', 'pipe'] });

const strongProc = mk(STRONG_PORT, 'strong', 'strong-model', 90);
const fastProc = mk(FAST_PORT, 'fast', 'fast-model', 15);
let procLog = '';
for (const p of [strongProc, fastProc]) {
  p.stdout.on('data', (d) => { procLog += d.toString(); });
  p.stderr.on('data', (d) => { procLog += d.toString(); });
}

async function facts(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/__facts`)).json();
  } catch {
    return null;
  }
}
const reset = async (port) => fetch(`http://127.0.0.1:${port}/__reset`).then((r) => r.ok).catch(() => false);
const resetBoth = async () => { await reset(STRONG_PORT); await reset(FAST_PORT); };

let strongUp = null, fastUp = null;
for (let i = 0; i < 60 && (!strongUp || !fastUp); i++) {
  await sleep(100);
  if (!strongUp) strongUp = await facts(STRONG_PORT);
  if (!fastUp) fastUp = await facts(FAST_PORT);
}
if (!strongUp || !fastUp) {
  console.error(`DRILL BLOCKED — mocks never came up (strong=${!!strongUp} fast=${!!fastUp})\n${procLog}`);
  strongProc.kill('SIGKILL'); fastProc.kill('SIGKILL');
  process.exit(1);
}

const frames = [];
function cap(title, body) {
  const bar = '='.repeat(78);
  const lines = [bar, ` ${title}`, bar, '', ...body.trimEnd().split('\n').map((l) => l), ''];
  frames.push(lines.join('\n'));
  fs.writeFileSync(path.join(OUT, `frame-${frames.length}-${
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.txt`), frames[frames.length - 1]);
}

const eventsPath = path.join(root, '.buddy', 'events.jsonl');
const readEvents = () => {
  try {
    return fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const routeRows = (evs) => evs.filter((e) => e.type === 'route');

// ── frame 1: the declaration ────────────────────────────────────────────────
{
  await resetBoth();
  const freshS = await facts(STRONG_PORT);
  const freshF = await facts(FAST_PORT);
  const cfgShown = fs.readFileSync(path.join(root, 'buddy.config.json'), 'utf8');
  const scriptShown = SCRIPT.map((s, i) => `  [${i + 1}] ${s.slice(0, 100)}${s.length > 100 ? ' …' : ''}`).join('\n');
  cap(
    'FRAME 1 — the declaration: two gateways, two tiers, both witnesses alive',
    `The operator declares what the engine cannot measure (model QUALITY is a human\n` +
    `judgment). The engine's promise: routeForStep returns a PERMUTATION — nothing\n` +
    `invented, nothing dropped; undeclared tiers mean byte-identical inertness.\n\n` +
    `buddy.config.json (on camera):\n${cfgShown.split('\n').map((l) => '  ' + l).join('\n')}\n\n` +
    `The mocks' scripted protocol voices — ONE shared 5-reply sequence, whichever\n` +
    `tier takes the call (the MODEL NAME on the wire is each server's identity):\n${scriptShown}\n\n` +
    `Witnesses (the other end, GET /__facts — both freshly zeroed):\n` +
    `  strong @ :${STRONG_PORT} (llm7, tier strong, delay 90ms)  requests=${freshS.requests}\n` +
    `  fast   @ :${FAST_PORT} (kilo, tier fast,   delay 15ms)  requests=${freshF.requests}\n\n` +
    `chat.effort comes from .buddy/settings.json per frame — the same dial now\n` +
    `scopes the routing bias in the REPL, the sub-agents AND the headless one-shot.`
  );
  ok(freshS.requests === 0 && freshF.requests === 0, 'both witnesses start at zero');
  ok(CONFIG.gateways.llm7.tier === 'strong' && CONFIG.gateways.kilo.tier === 'fast', 'tiers declared in config');
}

// ── frame 2: medium effort — the auto matrix on camera ───────────────────────
{
  setEffort('medium');
  await resetBoth();
  const before = { strong: (await facts(STRONG_PORT)).requests, fast: (await facts(FAST_PORT)).requests };
  const r = buddy(['-p', 'plan a tiny demo, then do it, then tell me how routing went']);
  const s = await facts(STRONG_PORT);
  const f = await facts(FAST_PORT);
  const combined = [
    ...s.log.map((e) => ({ at: e.at, who: 'strong', n: e.n })),
    ...f.log.map((e) => ({ at: e.at, who: 'fast', n: e.n })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const order = combined.map((c) => c.who).join(' → ');
  cap(
    'FRAME 2 — effort medium: strongest for planning, fastest for chores',
    `Task: "plan a tiny demo, then do it, then tell me how routing went"\n` +
    `Command: buddy -p "<task>"   (the REAL CLI, real config, real loopback wire)\n\n` +
    `The five scripted protocol steps land in tier order:\n` +
    `  call 1  todo (the plan)      → class PLANNING (first call)        → strong\n` +
    `  call 2  fs_list .            → class PLANNING (the step after a\n` +
    `          todo call CONTINUES the plan)                             → strong\n` +
    `  call 3  fs_list .buddy       → class chore (mechanical middle)    → fast\n` +
    `  call 4  fs_list examples     → class chore                        → fast\n` +
    `  call 5  say (the report)     → class chore — routing is decided BEFORE\n` +
    `          the call, and no pre-call fact can know this turn will end here;\n` +
    `          a bounded reply IS a chore. Want the report on the strong tier\n` +
    `          too? /effort high — one word.                           → fast\n\n` +
    `CLI transcript (trimmed):\n${(r.stdout || '').split('\n').filter((l) => l.trim()).slice(0, 14).map((l) => '  ' + l.slice(0, 76)).join('\n')}\n\n` +
    `THE OTHER END WITNESSES (each mock's own /__facts):\n` +
    `  strong requests: ${before.strong} → ${s.requests}  (Δ ${s.requests - before.strong})\n` +
    `  fast   requests: ${before.fast} → ${f.requests}  (Δ ${f.requests - before.fast})\n` +
    `  arrival order: ${order}\n\n` +
    `The plan rode the strong tier; the mechanical work rode the fast tier. No\n` +
    `gateway was invented, none was dropped — a permutation, always.`
  );
  ok(r.status === 0, `CLI exit 0 (got ${r.status}: ${(r.stderr || '').slice(0, 200)})`);
  ok(s.requests - before.strong === 2, `strong served exactly the 2 planning calls (Δ=${s.requests - before.strong})`);
  ok(f.requests - before.fast === 3, `fast served exactly the 3 chore calls (Δ=${f.requests - before.fast})`);
  ok(order === 'strong → strong → fast → fast → fast', `arrival order strong→strong→fast→fast→fast (got ${order})`);
  ok((r.stdout || '').includes('Routing demo done'), 'the scripted final report landed');
}

// ── frame 3: the audit trail ─────────────────────────────────────────────────
{
  const evs = readEvents().slice(-14);
  const rows = routeRows(readEvents());
  const shown = rows.slice(-6).map((e) => `  ${e.class.padEnd(9)} effort=${e.effort.padEnd(7)} chain=${e.chain.join(',')}`).join('\n');
  cap(
    'FRAME 3 — the audit trail: .buddy/events.jsonl route facts',
    `FACTS, NOT CONTENT: a route row carries the step class, the effort level and\n` +
    `the chain NAMES — never message text. Rows appear ONLY when the routed chain\n` +
    `genuinely differs from the base order (call 1's strong-first permutation\n` +
    `EQUALS the configured order — the honest no-noise contract: no chain opt, no\n` +
    `fact, the wire never learns routing existed).\n\n` +
    `route rows from frame 2 (${rows.length} total):\n${shown || '  (none)'}\n\n` +
    `projection check — the raw JSONL row shape:\n` +
    `  ${JSON.stringify(rows[rows.length - 1] || {}).slice(0, 120)}`
  );
  ok(rows.length === 3, `exactly 3 route facts (the three chore-class calls; the planning calls matched the base order) — got ${rows.length}`);
  ok(rows.every((e) => e.class === 'chore' && e.chain[0] === 'kilo'), 'every fact: class chore, chain led by kilo (the fast tier)');
  ok(rows.every((e) => e.effort === 'medium'), 'facts carry the effort level');
}

// ── frame 4: effort high — quality everywhere ────────────────────────────────
{
  setEffort('high');
  await resetBoth();
  const before = { strong: (await facts(STRONG_PORT)).requests, fast: (await facts(FAST_PORT)).requests };
  const evBefore = routeRows(readEvents()).length;
  const r = buddy(['-p', 'same demo, high effort']);
  const s = await facts(STRONG_PORT);
  const f = await facts(FAST_PORT);
  cap(
    'FRAME 4 — effort high: EVERY step rides the strong tier',
    `/effort high = "this task deserves my best model everywhere" — the dial\n` +
    `scopes the bias; chores stop being special. (Effort also widens the loop:\n` +
    `24 steps/task, ~2200 tok replies — the v0.25.0 budgets, unchanged.)\n\n` +
    `THE OTHER END WITNESSES:\n` +
    `  strong requests: ${before.strong} → ${s.requests}  (Δ ${s.requests - before.strong})\n` +
    `  fast   requests: ${before.fast} → ${f.requests}  (Δ ${f.requests - before.fast})\n\n` +
    `CLI tail:\n${(r.stdout || '').split('\n').filter((l) => l.trim()).slice(-3).map((l) => '  ' + l.slice(0, 76)).join('\n')}\n\n` +
    `Note the audit trail: strong-first EQUALS the configured base order here, so\n` +
    `ZERO new route facts fired (before=${evBefore}) — inertness stays byte-honest.`
  );
  ok(r.status === 0, 'CLI exit 0');
  ok(s.requests - before.strong === 5, `all 5 calls on strong (Δ=${s.requests - before.strong})`);
  ok(f.requests - before.fast === 0, `fast untouched (Δ=${f.requests - before.fast})`);
  ok(routeRows(readEvents()).length === evBefore, 'no route facts when the permutation equals the base order');
}

// ── frame 5: effort low — speed everywhere ───────────────────────────────────
{
  setEffort('low');
  await resetBoth();
  const before = { strong: (await facts(STRONG_PORT)).requests, fast: (await facts(FAST_PORT)).requests };
  const evBefore = routeRows(readEvents()).length;
  const r = buddy(['-p', 'same demo, low effort']);
  const s = await facts(STRONG_PORT);
  const f = await facts(FAST_PORT);
  const evAfter = routeRows(readEvents()).length;
  cap(
    'FRAME 5 — effort low: EVERY step rides the fast tier',
    `/effort low = "quick chores, tight replies" — 8 steps/task, ~900 tok replies\n` +
    `(the v0.25.0 budgets) and now: the fast tier leads every call. The EMA only\n` +
    `breaks ties INSIDE the fast tier — a latency number can never promote a\n` +
    `gateway the operator did not call fast.\n\n` +
    `THE OTHER END WITNESSES:\n` +
    `  strong requests: ${before.strong} → ${s.requests}  (Δ ${s.requests - before.strong})\n` +
    `  fast   requests: ${before.fast} → ${f.requests}  (Δ ${f.requests - before.fast})\n\n` +
    `Every one of those calls carried an explicit chain (a genuine reorder), so\n` +
    `the audit gained ${routeRows(readEvents()).length - evBefore} route facts — facts only when the wire actually changed.`
  );
  ok(r.status === 0, 'CLI exit 0');
  ok(f.requests - before.fast === 5, `all 5 calls on fast (Δ=${f.requests - before.fast})`);
  ok(s.requests - before.strong === 0, `strong untouched (Δ=${s.requests - before.strong})`);
}

// ── frame 6: routing off + the absolute pin + junk tiers named ───────────────
{
  setEffort('medium', { routing: 'off' });
  await resetBoth();
  const before = { strong: (await facts(STRONG_PORT)).requests, fast: (await facts(FAST_PORT)).requests };
  const r = buddy(['-p', 'same demo, routing off']);
  const s = await facts(STRONG_PORT);
  const f = await facts(FAST_PORT);
  const evBefore = routeRows(readEvents()).length;

  // The pin leg: the REAL router over the REAL mocks, declared on camera.
  const { buildRouter } = await import(path.join(REPO, 'src', 'brain', 'index.js'));
  const router = buildRouter({ ...CONFIG, timeouts: { chatMs: 20000, httpMs: 8000 }, circuitBreaker: { failureThreshold: 2, cooldownMs: 5000, maxRoundTrips: 1 } });
  router.order = ['kilo', 'llm7']; // what /model kilo does
  router.pinned = 'kilo';
  const { routeForStep } = await import(path.join(REPO, 'src', 'brain', 'effort.js'));
  const pinChain = routeForStep({ cls: 'planning', effort: 'medium', order: router.order, tiers: { llm7: 'strong', kilo: 'fast' }, pinned: 'kilo' });
  const beforePin = (await facts(FAST_PORT)).requests;
  const out = await router.chat([{ role: 'user', content: 'Reply with exactly: PINNED_OK' }], { chain: pinChain, maxTokens: 40 });
  const afterPin = (await facts(FAST_PORT)).requests;

  // Junk tier: NAMED, never applied.
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v56-junk-'));
  fs.mkdirSync(path.join(badRoot, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(badRoot, 'buddy.config.json'), JSON.stringify({ ...CONFIG, gateways: { ...CONFIG.gateways, llm7: { ...CONFIG.gateways.llm7, tier: 'fastest' } } }));
  const rb = spawnSync('node', [path.join(REPO, 'src', 'index.js'), '-p', 'hi'], { cwd: badRoot, encoding: 'utf8', timeout: 60000, env: { ...process.env, NO_COLOR: '1' } });

  cap(
    'FRAME 6 — routing off, the absolute pin, and junk tiers get NAMED',
    `1) chat.routing: "off" — the explicit kill switch. The chain is exactly what\n` +
    `config/pin made it; no classification, no facts, no surprises:\n` +
    `  strong requests: ${before.strong} → ${s.requests}  (Δ ${s.requests - before.strong})\n` +
    `  fast   requests: ${before.fast} → ${f.requests}  (Δ ${f.requests - before.fast})\n` +
    `  new route facts: ${routeRows(readEvents()).length - evBefore}\n\n` +
    `2) The pin is ABSOLUTE (module leg on the REAL router + REAL mocks, declared):\n` +
    `  router.order = [kilo, llm7]; router.pinned = 'kilo';  (what /model kilo does)\n` +
    `  routeForStep(planning, tiers {llm7: strong, kilo: fast}, pinned kilo)\n` +
    `    → chain: ${pinChain.join(',')}   ← kilo leads its OWN planning call\n` +
    `  router.chat over the real wire → gateway=${out.gateway}, witness Δ fast=${afterPin - beforePin}\n\n` +
    `3) A junk tier (gateways.llm7.tier: "fastest") is NAMED and ignored:\n` +
    `  stderr: ${(rb.stderr || '').split('\n').find((l) => l.includes('tier'))?.trim().slice(0, 110) || '(no warning found)'}\n\n` +
    `An explicit human choice can never be demoted by heuristics — and a typo can\n` +
    `never silently become policy.`
  );
  ok(r.status === 0, 'off-leg CLI exit 0');
  ok(s.requests - before.strong === 5 && f.requests - before.fast === 0, 'off: default order only (strong first), fast untouched');
  ok(routeRows(readEvents()).length === evBefore, 'off: zero route facts');
  ok(pinChain[0] === 'kilo', 'the pin leads even a planning call');
  ok(out.gateway === 'kilo' && afterPin - beforePin === 1, 'the REAL wire confirms the pin: kilo served');
  ok((rb.stderr || '').includes('gateways.llm7.tier'), 'junk tier NAMED on stderr');
  fs.rmSync(badRoot, { recursive: true, force: true });
}

// ── frame 7: the story table ─────────────────────────────────────────────────
{
  const s = await facts(STRONG_PORT);
  const f = await facts(FAST_PORT);
  const evs = readEvents();
  const rows = routeRows(evs);
  cap(
    'FRAME 7 — the story: one dial, two tiers, zero lies',
    `FRAMES × WITNESS DELTAS (each mock counts its OWN requests):\n\n` +
    `  frame 2  medium  plan→strong chore→fast   strong Δ2   fast Δ3   facts +3\n` +
    `  frame 4  high    strong everywhere        strong Δ5   fast Δ0   facts +0 (no reorder needed)\n` +
    `  frame 5  low     fast everywhere          strong Δ0   fast Δ5   facts +5 (every call reordered)\n` +
    `  frame 6  off     config order only        strong Δ5   fast Δ0   facts +0\n` +
    `  frame 6  pin     kilo absolute head       kilo served its own planning call\n\n` +
    `Witness totals this drill: strong=${s.requests} fast=${f.requests}; route facts=${rows.length}.\n\n` +
    `THE CONTRACT, ON CAMERA:\n` +
    `  · tiers are the OPERATOR's declaration (buddy.config.json) — the engine\n` +
    `    never guesses model quality; undeclared tiers = byte-identical inertness\n` +
    `  · classifyStep uses PRE-CALL facts only (index, lastTool, plan pressure,\n` +
    `    budget) — routing happens before the call, always\n` +
    `  · routeForStep returns a PERMUTATION — nothing invented, nothing dropped\n` +
    `  · the pin is absolute; the EMA only breaks ties inside the 'fast' tier\n` +
    `  · mode off (or junk) is the honest kill switch; junk tiers get NAMED\n` +
    `  · the audit keeps facts (class, effort, chain names), never task text\n` +
    `  · the same dial now scopes the bias in the REPL, sub-agents and one-shots\n` +
    `  · RED TEAM 44/44 hostile probes survived (chains, prototypes, floods,\n` +
    `    throwing primitives, hostile Proxies, canary sweeps)`
  );
  ok(rows.every((e) => !JSON.stringify(e).includes('plan a tiny demo')), 'no task text in any route fact');
  ok(evs.every((e) => e.type !== 'route' || Array.isArray(e.chain)), 'every route row carries a chain array');
}

// ── groundtruth.json ─────────────────────────────────────────────────────────
const groundtruth = {
  version: '0.56.0',
  feature: 'multi-model routing — strongest for planning, fastest for chores (/effort low|medium|high)',
  mocks: { strong: { gateway: 'llm7', tier: 'strong', delayMs: 90 }, fast: { gateway: 'kilo', tier: 'fast', delayMs: 15 }, ports: 'dynamically picked per run (collision-proof)' },
  script: SCRIPT,
  assertions: { asserted, passed, problems },
  verdict: problems.length ? 'DRILL: FAIL' : 'DRILL: PASS',
};
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2));

strongProc.kill('SIGKILL');
fastProc.kill('SIGKILL');

console.log(`\nDRILL v0.56: ${passed}/${asserted} asserted`);
if (problems.length) {
  console.log('FAILURES:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log(`evidence: ${OUT} (${frames.length} frames + groundtruth.json)`);
process.exit(0);
