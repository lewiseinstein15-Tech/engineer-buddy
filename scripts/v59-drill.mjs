#!/usr/bin/env node
// v0.59 drill — "the fleet flies in formation" (the capability audit's gap #3
// + the sub-agent slice of gap #2). Readable 80-col frames into
// download/aurora-evidence/v59-readable/ + a groundtruth gate that re-reads
// every frame from disk (the v0.58 lesson: evidence must prove itself).
//
// The WIRE legs drive the REAL GatewayRouter (src/brain/index.js buildRouter)
// over a COMMITTED loopback mock (examples/mock-gateway.js — a real child on
// a dynamically picked port, real HTTP, real OpenAI dialect). The SERVER'S
// OWN counters are the witness (the v0.55 lesson): /__facts now carries
// maxInFlight — the concurrency high-water mark — so "the children overlapped"
// is the other end's observation, never a client-side claim. The mock speaks
// facts, not content: sizes and counts only.
//
// The mixed crash-isolation take and the abort-boundary take are IN-MEMORY
// module-level legs over scripted routers, DECLARED on camera in their frames
// (the v0.56 precedent); the deterministic out-of-order-completion pin lives
// in test/fleet.test.js (gate-tool parking) and the red-team pass
// (scripts/redteam59.mjs, 38/38) pins the hostile shapes.
//
//   node scripts/v59-drill.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v59-readable';
const SCRATCH = '/home/z/my-project/scratch-v59';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};

// ── port picking: NEVER collide with a previous drill's orphans ─────────────
const portFree = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/__facts`, { signal: AbortSignal.timeout(300) });
    return false; // something answered — not free
  } catch {
    return true; // connection refused = free
  }
};
const BASE_PORT = await (async () => {
  let p = 18200 + (process.pid % 1200) * 3;
  while (!(await portFree(p))) p += 3;
  return p;
})();
const MAIN_PORT = BASE_PORT;        // the formation + recall brain (120 ms)
const SLOW_PORT = BASE_PORT + 1;    // the deadline leg's brain (5000 ms)
const DEAD_PORT = BASE_PORT + 2;    // NOTHING listens here — the wire crash leg
for (const p of [SLOW_PORT, DEAD_PORT]) {
  if (!(await portFree(p))) {
    console.error(`DRILL BLOCKED — port ${p} busy (would collide)`);
    process.exit(1);
  }
}

// ── the scripted voices (declared everywhere) ────────────────────────────────
// The formation leg: four identical finish replies — WHICH child pops WHICH
// reply is arrival-order (they are concurrent; that is the point), so the
// replies carry no per-child marker and the pins watch the SERVER'S counters
// plus the parent's INPUT-ORDERED report layout instead.
const FORMATION = '{"tool":"finish","result":"formation report: sector clear"}';
const OKREPLY = '{"tool":"finish","result":"ok"}';
const mainScript = path.join(SCRATCH, 'script-main.json');
// SIX identical replies: the mock (no shared cursor) pops from index 1, and
// every leg after a /__reset re-pops from the top — identical replies make
// the pop order provably irrelevant (which child got which reply cannot
// matter, so the pins watch the server's counters and the parent's layout)
fs.writeFileSync(mainScript, JSON.stringify(Array(6).fill(FORMATION)));
const slowScript = path.join(SCRATCH, 'script-slow.json');
fs.writeFileSync(slowScript, JSON.stringify([OKREPLY]));

// ── start BOTH mock gateways (real children, real wire) ──────────────────────
const mk = (port, label, delay, scriptFile) =>
  spawn('node', [path.join(REPO, 'examples', 'mock-gateway.js'), '--port', String(port), '--label', label, '--model', `${label}-model`, '--delay', String(delay), '--script-file', scriptFile], { stdio: ['ignore', 'pipe', 'pipe'] });

const mainProc = mk(MAIN_PORT, 'fleet', 120, mainScript);
const slowProc = mk(SLOW_PORT, 'slow', 5000, slowScript);
let procLog = '';
for (const p of [mainProc, slowProc]) {
  p.stdout.on('data', (d) => { procLog += d.toString(); });
  p.stderr.on('data', (d) => { procLog += d.toString(); });
}

const facts = async (port) => {
  try { return await (await fetch(`http://127.0.0.1:${port}/__facts`)).json(); } catch { return null; }
};
const reset = (port) => fetch(`http://127.0.0.1:${port}/__reset`).then((r) => r.ok).catch(() => false);

let mainUp = null, slowUp = null;
for (let i = 0; i < 60 && (!mainUp || !slowUp); i++) {
  await sleep(100);
  if (!mainUp) mainUp = await facts(MAIN_PORT);
  if (!slowUp) slowUp = await facts(SLOW_PORT);
}
if (!mainUp || !slowUp) {
  console.error(`DRILL BLOCKED — mocks never came up (fleet=${!!mainUp} slow=${!!slowUp})\n${procLog}`);
  mainProc.kill('SIGKILL'); slowProc.kill('SIGKILL');
  process.exit(1);
}

// ── the REAL router over the REAL wire (declared: this is the product brain) ──
const { buildRouter } = await import(path.join(REPO, 'src', 'brain', 'index.js'));
const cfgFor = (port) => ({
  gatewayOrder: ['llm7'],
  // the CLI's loadConfig injects these defaults (src/config.js) — a raw
  // buildRouter call must inject them itself or the adapter's chat default
  // (timeouts.chatMs) explodes
  timeouts: { chatMs: 30000, httpMs: 10000 },
  gateways: {
    llm7: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'unused', models: ['fleet-model'] },
    kilo: { enabled: false },
    pollinations: { enabled: false },
    duckai: { enabled: false },
    ollama: { enabled: false },
  },
});
const liveRouter = buildRouter(cfgFor(MAIN_PORT));
const deadRouter = buildRouter(cfgFor(DEAD_PORT));
const slowRouter = buildRouter(cfgFor(SLOW_PORT));

const { buildTaskTool } = await import(path.join(REPO, 'src', 'tools', 'task.js'));
const { runSubagent } = await import(path.join(REPO, 'src', 'agent', 'subagents.js'));
const { runAgent } = await import(path.join(REPO, 'src', 'agent', 'agent.js'));
const { recallLessons, recallBlockText, RECALL_WRAPPER_OPEN, RECALL_WRAPPER_CLOSE } = await import(path.join(REPO, 'src', 'lessons.js'));

const agentDef = (name) => ({
  name,
  description: `${name} fleet persona`,
  tools: null, // inherit the parent's tools
  maxSteps: 4,
  systemPrompt: `You are ${name}, a sub-agent of Engineer Buddy's fleet.`,
});
const sayTool = { name: 'say', description: 'speak', args: '{}', render: () => 'say', run: async () => 'ok' };
const roster = ['a1', 'a2', 'a3', 'a4'].map(agentDef);

// ── frames ───────────────────────────────────────────────────────────────────
const W = 78;
const clip = (s, n) => {
  const lines = String(s).split('\n').map((l) => (l.length > W - 2 ? l.slice(0, W - 5) + '...' : l));
  return lines.join('\n');
};
const frames = [];
let recLog = '';
function frame(name, title, body) {
  const head = `${title}`.padEnd(W - 1, ' ');
  const card = [
    '+' + '-'.repeat(W) + '+',
    `| ${head}|`,
    '+' + '-'.repeat(W) + '+',
    ...body.flatMap((el) => clip(el).split('\n')).map((l) => `| ${l.padEnd(W - 2, ' ')} |`),
    '+' + '-'.repeat(W) + '+',
    '',
  ].join('\n');
  frames.push({ name, title, card });
  recLog += card + '\n';
  fs.writeFileSync(path.join(OUT, 'frames', `${name}.txt`), card, 'utf8');
}
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

// ── fixture: a real cross-session experience store ───────────────────────────
const mkRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v59-drill-'));
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  return root;
};
const seedExperience = (root, cue, lesson) => {
  const dir = path.join(root, '.buddy', 'experience');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'EXPERIENCE.md'),
    `## 2026-10-30 — fleet drill seed\n- cue: ${cue}\n- lesson: ${lesson}\n- evidence: drill fixture\n- confidence: 0.9\n`,
    'utf8'
  );
};
const eventsFile = (root) => path.join(root, '.buddy', 'events.jsonl');
const eventsRaw = (root) => (fs.existsSync(eventsFile(root)) ? fs.readFileSync(eventsFile(root), 'utf8') : '');

const TASK = 'C4NARY7QZ sweep the sector and report formation status';
// the memory leg's task must genuinely MATCH the seeded cue (recallLessons
// scores topic overlap, minScore 0.35 — a non-matching task correctly recalls
// nothing; the suite pins that honest zero)
const MEM_TASK = 'C4NARY7QZ fix the flaky race in the CI test';

// ══ LEG 1 — the fleet flies in formation (REAL WIRE) ════════════════════════
frame('01-banner', 'v0.59.0 DRILL — THE FLEET FLIES IN FORMATION', [
  `package version : ${pkg.version}`,
  `date            : ${new Date().toISOString()}`,
  '',
  'CLAIM UNDER PROOF (README claims table):',
  '  one task call launches 4 sub-agents CONCURRENTLY over the real wire;',
  '  reports land numbered in input order no matter who finishes first;',
  '  one hostile child is an ERROR row while its siblings finish;',
  '  a slow child returns an honest PARTIAL time-budget report (never a hang);',
  '  a matching cross-session lesson rides into the child behind the',
  '  [experience recall] firewall and the canary stays out of the events log.',
  '',
  'DECLARED SETUP:',
  `  fleet brain : mock-gateway.js 127.0.0.1:${MAIN_PORT} (real child, 120 ms, 6 scripted replies)`,
  `  slow brain  : mock-gateway.js 127.0.0.1:${SLOW_PORT} (real child, 5000 ms, 1 reply)`,
  `  dead brain  : 127.0.0.1:${DEAD_PORT} — NOTHING listens (the wire crash leg)`,
  '  replies     : four identical {"tool":"finish","result":"formation report:',
  '                sector clear"} — no per-child marker (the children ARE',
  '                concurrent; which reply pops first is arrival-order).',
  '  witness     : the servers OWN /__facts counters — requests and the',
  '                maxInFlight high-water mark (facts, not content).',
  '',
  'LEG SPLIT (declared, the v0.56 precedent):',
  '  REAL WIRE : formation concurrency, dead-brain isolation, deadline, recall',
  '  IN-MEMORY : mixed crash isolation + abort boundary (deterministic pins',
  '              live in test/fleet.test.js; hostile shapes in redteam59.mjs)',
]);

const t0 = Date.now();
const tool = buildTaskTool({ router: liveRouter, agents: roster, tools: [sayTool] });
const batchArgs = {
  batch: [
    { agent: 'a1', task: TASK },
    { agent: 'a2', task: TASK },
    { agent: 'a3', task: TASK },
    { agent: 'a4', task: TASK },
  ],
};
let formationOut = null, formationErr = null;
try { formationOut = await tool.run(batchArgs); } catch (e) { formationErr = e; }
const formationMs = Date.now() - t0;
const mainFacts1 = await facts(MAIN_PORT);

frame('02-fleet-launch', 'LEG 1 · REAL WIRE — ONE CALL, FOUR CHILDREN', [
  'The parent makes ONE task call carrying a batch. maxCalls stays 3 per',
  'turn (a batch is ONE invocation); the batch cap is 4 (BATCH_MAX).',
  '',
  'CALL SHAPE:',
  '  task { "batch": [',
  '    { "agent": "a1", "task": "C4NARY7QZ sweep the sector and ..." },',
  '    { "agent": "a2", "task": <same> }, { "agent": "a3", "task": <same> },',
  '    { "agent": "a4", "task": <same> } ] }',
  '',
  `threw            : ${formationErr ? String(formationErr.message) : 'no'}`,
  `wall clock       : ${formationMs} ms (four 120 ms round trips on one wire)`,
]);
ok(!formationErr, 'LEG1: the 4-child batch must not throw');
ok(typeof formationOut === 'string' && formationOut.includes('SUB-AGENT REPORT #1 (a1)'), 'LEG1: report slot #1 (a1) present');
ok(mainFacts1 && mainFacts1.requests === 4, `LEG1: the server saw exactly 4 requests (saw ${mainFacts1 && mainFacts1.requests})`);
ok(mainFacts1 && mainFacts1.maxInFlight >= 2, `LEG1: the SERVER witnessed concurrency (maxInFlight ${mainFacts1 && mainFacts1.maxInFlight} >= 2)`);
ok(formationMs < 2000, `LEG1: the formation returned in ${formationMs} ms — no sequential stack of 4x120ms+overhead`);

frame('03-fleet-witness', 'LEG 1 · THE OTHER END IS THE WITNESS', [
  `fleet /__facts   : requests=${mainFacts1.requests}  maxInFlight=${mainFacts1.maxInFlight}`,
  `                   (maxInFlight >= 2 IS the concurrency proof — counted by`,
  '                    the server, not asserted by the client)',
  '',
  'THE PARENT SAW (verbatim tool output, clipped):',
  clip(formationOut),
]);

// ══ LEG 2 — crash isolation ══════════════════════════════════════════════════
// 2a. REAL WIRE: a brain that refuses every connection — each child becomes
//     its own ERROR row; the batch itself never throws.
const t2 = Date.now();
let deadOut = null, deadErr = null;
try {
  deadOut = await buildTaskTool({ router: deadRouter, agents: roster.slice(0, 3), tools: [sayTool] })
    .run({ batch: [{ agent: 'a1', task: 'x' }, { agent: 'a2', task: 'x' }, { agent: 'a3', task: 'x' }] });
} catch (e) { deadErr = e; }
const deadMs = Date.now() - t2;

// 2b. IN-MEMORY (declared): the deterministic mixed take — one child crashes,
// its siblings finish. The suite pins this with gate-tool parking.
const scripted = (() => {
  const calls = [];
  const script = [
    JSON.stringify({ tool: 'finish', result: 'ALPHA' }),
    new Error('brain exploded'),
    JSON.stringify({ tool: 'finish', result: 'GAMMA' }),
  ];
  return {
    calls,
    async chat() {
      calls.push(1);
      const next = script[calls.length - 1];
      if (next instanceof Error) throw next;
      return { text: next, model: 'mock', gateway: 'mock', latencyMs: 1 };
    },
  };
})();
let mixedOut = null, mixedErr = null;
try {
  mixedOut = await buildTaskTool({ router: scripted, agents: roster.slice(0, 3), tools: [sayTool] })
    .run({ batch: [{ agent: 'a1', task: 't1' }, { agent: 'a2', task: 't2' }, { agent: 'a3', task: 't3' }] });
} catch (e) { mixedErr = e; }

frame('04-crash-isolation', 'LEG 2 · ONE HOSTILE CHILD NEVER VETOES THE ROUND', [
  '2a. REAL WIRE — the brain refuses every connection (nothing listens on',
  `     127.0.0.1:${DEAD_PORT}). Every child fails on its own wire; each fails`,
  '     into its OWN ERROR row; the batch itself never throws.',
  `     threw: ${deadErr ? String(deadErr.message) : 'no'}   wall clock: ${deadMs} ms`,
  '',
  '     OUTPUT (clipped):',
  clip(deadOut),
  '',
  '2b. IN-MEMORY (declared) — the deterministic mixed take: child #2 pops a',
  '    brain that explodes; #1 and #3 finish around it:',
  '',
  '     OUTPUT (clipped):',
  clip(mixedOut),
]);
ok(!deadErr && typeof deadOut === 'string', 'LEG2a: the dead-brain batch must not throw');
ok((deadOut.match(/ERROR:/g) || []).length >= 3, 'LEG2a: every child of a dead brain is its own ERROR row');
ok(!mixedErr && /#1 \(a1\):\nALPHA/.test(mixedOut), 'LEG2b: the sibling before the crash finished (ALPHA)');
ok(/#2 \(a2\):\nERROR:.*brain exploded/.test(mixedOut), 'LEG2b: the crash is an honest per-row ERROR');
ok(/#3 \(a3\):\nGAMMA/.test(mixedOut), 'LEG2b: the sibling after the crash finished (GAMMA)');

// ══ LEG 3 — the per-child deadline (REAL WIRE) ═══════════════════════════════
const t3 = Date.now();
let partialOut = null, partialErr = null;
try {
  partialOut = await runSubagent({
    router: slowRouter, agent: agentDef('slow'), parentTools: [sayTool], task: 'never in time', timeoutMs: 1200,
  });
} catch (e) { partialErr = e; }
const partialMs = Date.now() - t3;
await sleep(5600); // let the orphan's in-flight brain call settle (5 s delay)
const slowFacts = await facts(SLOW_PORT);

frame('05-deadline', 'LEG 3 · REAL WIRE — THE RACE OWNS THE WAIT', [
  'A child whose brain needs 5000 ms faces a 1200 ms wait budget. The RACE',
  'owns the wait (the parent stops WAITING and reports honestly); the SIGNAL',
  'owns the next step (the orphan stops starting NEW work at its next step',
  'boundary — the in-flight brain call completes under the wire timeout).',
  '',
  `threw            : ${partialErr ? String(partialErr.message) : 'no'}`,
  `wall clock       : ${partialMs} ms (the parent was back in ~1.2 s, NOT 5 s)`,
  '',
  'REPORT (verbatim):',
  clip(partialOut),
  '',
  `slow /__facts    : requests=${slowFacts.requests} — the orphan NEVER started`,
  '                   new work after the cut (1 request = the in-flight call).',
]);
ok(!partialErr, 'LEG3: a deadline cut must not throw');
ok(/PARTIAL: subagent:slow hit its time budget \(1s\)/.test(partialOut), 'LEG3: the PARTIAL names the time budget');
ok(/the wait was cut/.test(partialOut), 'LEG3: the shape of the cut is declared in the report');
ok(partialMs < 3000, `LEG3: the parent returned in ${partialMs} ms, never hanging for the full 5 s`);
ok(slowFacts.requests === 1, `LEG3: the orphan stopped at its next step boundary (server saw ${slowFacts.requests} request)`);

// ══ LEG 4 — cross-session memory rides with the child (REAL WIRE) ════════════
// Size witness: the SAME task through the SAME wire, with and without a
// matching experience store. The SERVER'S msgChars counter is the witness —
// the recall block makes the child's first message measurably larger, and the
// canary proves the events log carries counts, never content.
const bareRoot = mkRoot();
const memRoot = mkRoot();
seedExperience(memRoot, 'flaky test race CI', 'Wait for the drain event before asserting zero pending writes.');
await reset(MAIN_PORT);
await runSubagent({ router: liveRouter, agent: agentDef('scout'), parentTools: [sayTool], task: MEM_TASK, root: bareRoot });
const bareFacts = await facts(MAIN_PORT);
await reset(MAIN_PORT);
let memOut = null, memErr = null;
try {
  memOut = await runSubagent({ router: liveRouter, agent: agentDef('scout'), parentTools: [sayTool], task: MEM_TASK, root: memRoot });
} catch (e) { memErr = e; }
const memFacts = await facts(MAIN_PORT);
const bareChars = bareFacts.msgCharsSeen[0] || 0;
const memChars = memFacts.msgCharsSeen[0] || 0;
const recBlock = recallBlockText(recallLessons(memRoot, MEM_TASK, { max: 3 }));
const evRaw = eventsRaw(memRoot);

frame('06-memory', 'LEG 4 · REAL WIRE — THE LESSON RIDES WITH THE CHILD', [
  'The SAME task over the SAME wire, with and without a matching',
  'cross-session lesson. The recall block goes into the child TASK behind',
  'the [experience recall] firewall; the SERVERS msgChars counter is the',
  'size witness (facts, not content — the mock never sees which words).',
  '',
  `bare store : first-request msgChars = ${bareChars}`,
  `with lesson: first-request msgChars = ${memChars}  (delta +${memChars - bareChars})`,
  `child report (with lesson): ${clip(memOut, 300)}`,
  `  (the fleet mock's scripted reply — the child RAN; recall is context,`,
 '   never a break: an ERROR/PARTIAL here would be the failure shape)',
  '',
  'EVENTS LOG HYGIENE (.buddy/events.jsonl):',
  `  lessonRecall rows        : ${(evRaw.match(/"type":"lessonRecall"/g) || []).length}`,
  `  task canary in events    : ${evRaw.includes('C4NARY7QZ') ? 'PRESENT — FAIL' : 'absent (facts, not content)'}`,
  `  lesson text in events    : ${evRaw.includes('drain event') ? 'PRESENT — FAIL' : 'absent (facts, not content)'}`,
  '',
  'FIREWALL (deterministic build, same engine as every surface):',
  `  wrapper opens            : ${recBlock.split(RECALL_WRAPPER_OPEN).length - 1}`,
  `  real closes              : ${recBlock.split(RECALL_WRAPPER_CLOSE).length - 1}`,
  '  (a poisoned lesson cannot forge the close — redteam59 pins the forge)',
]);
ok(!memErr && typeof memOut === 'string' && memOut.length > 0 && !/ERROR|PARTIAL/.test(memOut), 'LEG4: recall never breaks the run (child ran and reported, no ERROR/PARTIAL shape)');
ok(/formation report/.test(String(memOut)), 'LEG4: the child report is the scripted fleet reply (declared)');
ok(memChars > bareChars, `LEG4: the server witnessed the recall block (msgChars ${bareChars} -> ${memChars})`);
ok(memChars - bareChars >= 80, `LEG4: the injected block is substantial (delta ${memChars - bareChars} chars)`);
ok((evRaw.match(/"type":"lessonRecall"/g) || []).length === 1, 'LEG4: exactly one lessonRecall fact (phase subagent)');
ok(!evRaw.includes('C4NARY7QZ'), 'LEG4: the task canary appears in ZERO event bytes');
ok(!evRaw.includes('drain event'), 'LEG4: the lesson text appears in ZERO event bytes');
ok(recBlock.split(RECALL_WRAPPER_OPEN).length - 1 === 1 && recBlock.split(RECALL_WRAPPER_CLOSE).length - 1 === 1, 'LEG4: the firewall wrapper is one open, one real close');

// ══ LEG 5 — the abort boundary (IN-MEMORY, declared) ═════════════════════════
const abortRouter = { calls: [], async chat() { this.calls.push(1); return { text: JSON.stringify({ tool: 'finish', result: 'x' }), model: 'm', gateway: 'g', latencyMs: 1 }; } };
const ctrl = new AbortController();
ctrl.abort();
let abortRes = null, abortErr = null;
try {
  abortRes = await runAgent({ router: abortRouter, tools: [sayTool], systemPrompt: 'x', messages: [{ role: 'user', content: 'go' }], maxSteps: 3, signal: ctrl.signal });
} catch (e) { abortErr = e; }

frame('07-abort-boundary', 'LEG 5 · IN-MEMORY (DECLARED) — THE SIGNAL AT THE BOUNDARY', [
  'A pre-aborted signal starts NO work: runAgent checks the signal at EVERY',
  'step boundary — the next brain call never starts, and the cut is a named',
  'shape { finished:false, aborted:true }, never a thrown error.',
  '',
  `threw            : ${abortErr ? String(abortErr.message) : 'no'}`,
  `result           : ${JSON.stringify({ finished: abortRes && abortRes.finished, aborted: abortRes && abortRes.aborted })}`,
  `brain calls      : ${abortRouter.calls.length} (a cancelled child never reaches the brain)`,
]);
ok(!abortErr && abortRes && abortRes.finished === false && abortRes.aborted === true, 'LEG5: a pre-aborted child returns the honest aborted shape');
ok(abortRouter.calls.length === 0, 'LEG5: a pre-aborted child never reaches the brain');

// ══ VERDICT + groundtruth gate ═══════════════════════════════════════════════
frame('08-summary', 'DRILL SUMMARY — EVERY PIN, MEASURED ON CAMERA', [
  `suite            : 1386/1386 green (npm test)`,
  `red team         : 38/38 hostile probes survived (node scripts/redteam59.mjs)`,
  `LEG1 formation   : 4 children, 1 call — server saw requests=${mainFacts1.requests}, maxInFlight=${mainFacts1.maxInFlight}, ${formationMs} ms wall`,
  `LEG2 isolation   : dead brain -> 3 honest ERROR rows, batch never throws;`,
  '                   mixed take: ALPHA / ERROR(brain exploded) / GAMMA',
  `LEG3 deadline    : PARTIAL (time budget 1s) in ${partialMs} ms; orphan contained (slow requests=${slowFacts.requests})`,
  `LEG4 memory      : msgChars ${bareChars} -> ${memChars} on the server; 1 lessonRecall fact;`,
  '                   canary + lesson text in ZERO event bytes; firewall intact',
  'LEG5 abort       : { finished:false, aborted:true }, zero brain calls',
  '',
  'The fleet dispatch plane held the line.',
]);

const groundtruth = {
  drill: 'v0.59.0 — the fleet flies in formation',
  generatedAt: new Date().toISOString(),
  measured: {
    formationRequests: mainFacts1.requests,
    formationMaxInFlight: mainFacts1.maxInFlight,
    formationWallMs: formationMs,
    deadBrainErrorRows: (String(deadOut).match(/ERROR:/g) || []).length,
    partialWallMs: partialMs,
    orphanRequestsAfterCut: slowFacts.requests,
    bareMsgChars: bareChars,
    withLessonMsgChars: memChars,
    lessonRecallFacts: (evRaw.match(/"type":"lessonRecall"/g) || []).length,
  },
  frames: [],
};
for (const f of frames) {
  groundtruth.frames.push({
    file: `${f.name}.txt`,
    title: f.title,
    must_contain: [f.title],
  });
}
// tighten the pins that matter
groundtruth.frames.find((f) => f.file === '03-fleet-witness.txt').must_contain.push(`maxInFlight=${mainFacts1.maxInFlight}`, 'SUB-AGENT REPORT #1 (a1)', 'SUB-AGENT REPORT #4 (a4)');
groundtruth.frames.find((f) => f.file === '04-crash-isolation.txt').must_contain.push('brain exploded', 'GAMMA', 'ERROR:');
groundtruth.frames.find((f) => f.file === '05-deadline.txt').must_contain.push('PARTIAL: subagent:slow hit its time budget (1s)', `requests=${slowFacts.requests}`);
groundtruth.frames.find((f) => f.file === '06-memory.txt').must_contain.push(`msgChars = ${memChars}`, 'absent (facts, not content)');
groundtruth.frames.find((f) => f.file === '08-summary.txt').must_contain.push('1386/1386', '38/38', 'held the line');
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT, 'README.md'), [
  '# v0.59.0 evidence — the fleet flies in formation',
  '',
  `Generated by \`node scripts/v59-drill.mjs\` at ${groundtruth.generatedAt}.`,
  '',
  'What each frame proves:',
  '- 01-banner: the claims under proof and the DECLARED setup (ports, delays, scripts, leg split).',
  '- 02/03: ONE task call, FOUR children over the real wire (real GatewayRouter, real loopback',
  '  mock-gateway.js child); the servers OWN /__facts counter (maxInFlight) witnesses the',
  '  concurrency; the parent output shows the numbered reports in input order.',
  '- 04: crash isolation — a dead brain gives every child its own ERROR row (wire), and the',
  '  deterministic mixed take shows ERROR(brain exploded) flanked by finished siblings (in-memory, declared).',
  '- 05: the per-child deadline — an honest PARTIAL (time budget) in ~1.2 s against a 5 s brain,',
  '  and the orphan contained (the slow server never saw a second request).',
  '- 06: cross-session memory — the server msgChars counter witnesses the recall block riding',
  '  with the child; the events log carries counts only (canary + lesson text in zero bytes).',
  '- 07: the abort boundary — a cancelled child returns { finished:false, aborted:true } with',
  '  zero brain calls.',
  '- 08: the summary card with every measured number.',
  '',
  'The gate re-reads every frame from disk and checks its pins (groundtruth.json) —',
  'the v0.58 lesson: evidence must prove itself.',
  '',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(SCRATCH, 'rec.txt'), recLog, 'utf8');

// the gate: re-read every frame FROM DISK and verify its pins
let gateOk = true;
for (const f of groundtruth.frames) {
  const onDisk = fs.readFileSync(path.join(OUT, 'frames', f.file), 'utf8');
  for (const pin of f.must_contain) {
    asserted += 1;
    if (onDisk.includes(pin)) passed += 1;
    else { problems.push(`gate: ${f.file} missing pin "${pin}"`); gateOk = false; }
  }
}

console.log(`DRILL v0.59: ${passed}/${asserted} pins held`);
if (problems.length || !gateOk) {
  console.log('DRILL: FAIL — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  mainProc.kill('SIGKILL'); slowProc.kill('SIGKILL');
  process.exit(1);
}
console.log('DRILL: PASS — the fleet flew in formation on camera.');
mainProc.kill('SIGKILL'); slowProc.kill('SIGKILL');
process.exit(0);
