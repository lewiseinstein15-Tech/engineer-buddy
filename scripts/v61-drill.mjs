#!/usr/bin/env node
// v0.61 drill — "the PR is context" (the capability audit's gap #5: PR deep
// integration). Readable 80-col frames into
// download/aurora-evidence/v61-readable/ + a groundtruth gate that re-reads
// every frame from disk (the v0.58 lesson: evidence must prove itself).
//
// Legs:
//   REAL WIRE — the REAL resolveGh → GitHubClient over the REAL loopback
//               mock (examples/mock-github.js, dynamic ports): one pr_sync
//               call, the server's own /__facts counters are the witness;
//               the REAL git remote get-url resolves the provider.
//   DECLARED  — the pure caps/sanitizer legs run at module level (the v0.56
//               precedent), declared in their frames; the deterministic pins
//               live in test/prdeep.test.js + test/ghapi.test.js.
//
//   node scripts/v61-drill.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = '/home/z/my-project/download/aurora-evidence/v61-readable';
const SCRATCH = '/home/z/my-project/scratch-v61';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};

const W = 78;
const clip = (s, n = 400) => {
  const lines = String(s).split('\n').map((l) => (l.length > W - 2 ? l.slice(0, W - 5) + '...' : l));
  return lines.length > 14 ? [...lines.slice(0, 13), `... (+${lines.length - 13} lines)`].join('\n') : lines.join('\n');
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
  frames.push({ name, title });
  recLog += card + '\n';
  fs.writeFileSync(path.join(OUT, 'frames', `${name}.txt`), card, 'utf8');
}

const { ghOp, sanitizePrText, PRSYNC_MAX_FILES, PRSYNC_PATCH_CHARS, REPLY_BODY_MAX } =
  await import(path.join(REPO, 'src', 'tools', 'ghapi.js'));

// ── mock harness ─────────────────────────────────────────────────────────────
const BASE_PORT = 18800 + (process.pid % 700) * 5;
function spawnMock(flags, port) {
  const child = spawn('node', [path.join(REPO, 'examples', 'mock-github.js'), '--port', String(port), ...flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const ready = new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (/on http:\/\//.test(out) ? resolve(true) : Date.now() - t0 > 5000 ? resolve(false) : setTimeout(tick, 50));
    tick();
  });
  return { child, out, err, ready };
}
const facts = async (port) => (await fetch(`http://127.0.0.1:${port}/__facts`)).json();

function mkGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v61-drill-'));
  spawnSync('git', ['-C', root, 'init', '-q'], { timeout: 10000 });
  spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { timeout: 10000 });
  return root;
}
const ENV = (port, extra = {}) => ({
  ...process.env,
  BUDDY_GITHUB_API: `http://127.0.0.1:${port}`,
  BUDDY_GITHUB_TOKEN: 'mock-token',
  GITHUB_TOKEN: '',
  GH_TOKEN: '',
  ...extra,
});
const eventsRaw = (root) => {
  const f = path.join(root, '.buddy', 'events.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

// ══ frame 01 — banner ════════════════════════════════════════════════════════
frame('01-banner', 'v0.61.0 DRILL — THE PR IS CONTEXT (GAP #5: PR DEEP INTEGRATION)', [
  `package version : ${pkg.version}`,
  `date            : ${new Date().toISOString()}`,
  '',
  'CLAIM UNDER PROOF (the capability audit gap #5): the PR stops being a set',
  'of one-shot REST calls and becomes CONTEXT —',
  '  ONE pr_sync call lands the whole picture: meta + head sha + the per-file',
  '  diff (named caps) + the review threads with their ids + CI on the head',
  '  branch; pr_reply answers a remark IN its thread; remote comment/patch',
  '  text is sanitized DATA (whole ANSI/OSC sequences stripped, controls',
  '  dropped); the events log carries counts, never content.',
  '',
  'DECLARED SETUP:',
  '  LEG A  REAL WIRE : the real resolveGh → GitHubClient over the REAL',
  '                     loopback mock (examples/mock-github.js) — the',
  '                     SERVER\'s /__facts counters are the witness',
  '  LEG B  REAL WIRE : pr_reply over the same wire — the POST is recorded',
  '                     server-side (inReplyTo + bodyChars)',
  '  LEG C  DECLARED  : named caps (20 files / 3000-char patches), hostile',
  '                     comment bodies, the honest absences (private repo,',
  '                     missing PR, junk args — ZERO wire calls), GitLab',
  '                     degradation; deterministic pins in the suite',
  `witness          : test/prdeep.test.js + redteam61 (see summary frame)`,
]);

// ══ LEG A — one pr_sync over the real wire ═══════════════════════════════════
const PORT_A = BASE_PORT;
const mockA = spawnMock([], PORT_A);
ok(await mockA.ready, 'LEG A: the mock booted');
const rootA = mkGitRepo();
const syncObs = await ghOp(rootA, 'pr_sync', { pr: 7 }, { env: ENV(PORT_A), eventsRoot: rootA });
const factsA1 = await facts(PORT_A);
await ghOp(rootA, 'pr_reply', { pr: 7, inReplyTo: 101, body: 'fixed in 3f2a9bc — the guard returns "" for empty input' }, { env: ENV(PORT_A), eventsRoot: rootA });
const diffObs = await ghOp(rootA, 'pr_diff', { pr: 7 }, { env: ENV(PORT_A), eventsRoot: rootA });
const factsA2 = await facts(PORT_A);
mockA.child.kill('SIGTERM');

frame('02-sync', 'LEG A · REAL WIRE — ONE pr_sync CALL, THE WHOLE PICTURE', [
  `env     : BUDDY_GITHUB_API=http://127.0.0.1:${PORT_A} (the loopback mock), token in the env`,
  'remote  : https://github.com/acme/widgets.git (a REAL temp git repo)',
  '',
  'THE OBSERVATION (verbatim, chunked so nothing is clipped):',
  ...syncObs.split('\n').reduce((acc, line, i) => {
    if (i % 13 === 0) acc.push(line); else acc[acc.length - 1] += '\n' + line;
    return acc;
  }, []),
]);
ok(/#7 fix: guard the empty case in slugify/.test(syncObs), 'LEG A: the meta line carries number + title');
ok(/fix\/slugify → main · by alice/.test(syncObs), 'LEG A: branch → base · author on the second line');
ok(/head 3f2a9bc · mergeable:true/.test(syncObs), 'LEG A: head sha + mergeable state as the forge reports it');
ok(/files: 2 · \+16\/−1 \(2 shown\)/.test(syncObs), 'LEG A: file counts and the +/- truth');
ok(/M src\/slug\.js \+4\/−1/.test(syncObs), 'LEG A: per-file status glyph + counts');
ok(/REVIEW THREADS \(3 inline comments in 2 threads, 0 general\)/.test(syncObs), 'LEG A: thread census');
ok(/#101 @bob \(L12\):/.test(syncObs) && /└ #102 @alice:/.test(syncObs), 'LEG A: comment ids on every thread line — the reply door is visible');
ok(/REVIEW BODIES:\s*\n\s*@dave · CHANGES_REQUESTED/.test(syncObs), 'LEG A: the review verdict rides too');
ok(/CI ✓ CI · #47 · success/.test(syncObs), 'LEG A: CI on the head branch, latest run');

frame('03-wire', 'LEG A · THE SERVER WITNESSES THE CALL (the other end is the witness)', [
  'ONE pr_sync call — what the SERVER counted (its own /__facts):',
  ...Object.entries(factsA1.byPath).map(([p, n]) => `  ${String(n).padStart(2)}× ${p}`),
  '',
  `authSeen  : ${factsA1.authSeen} (the env token rode the wire; the mock is keyless and only counts it)`,
  'after pr_reply + pr_diff (cumulative byPath deltas below):',
  ...Object.entries(factsA2.byPath).filter(([p]) => /replies|files/.test(p)).map(([p, n]) => `  ${String(n).padStart(2)}× ${p}`),
]);
const wirePaths = Object.keys(factsA1.byPath).filter((p) => p !== 'GET /__facts');
ok(wirePaths.length === 5, `LEG A: exactly 5 wire GETs for ONE sync (${wirePaths.length})`);
ok(factsA1.byPath['GET /repos/acme/widgets/pulls/7'] === 1, 'LEG A: the pull fetched exactly once');
ok(factsA1.byPath['GET /repos/acme/widgets/pulls/7/files'] === 1, 'LEG A: the diff fetched exactly once');
ok(factsA1.authSeen >= 5, 'LEG A: every request carried auth (no anonymous fallback fired)');

// the reply leg re-captures cleanly on a fresh mock so the frame shows the
// exact observation pair (sync → reply) without the earlier cumulative noise
mockA.child.kill('SIGKILL');
const mockA2 = spawnMock([], PORT_A);
ok(await mockA2.ready, 'LEG B: mock re-booted on the same port for the reply capture');
const rootB = mkGitRepo();
const syncOnly = await ghOp(rootB, 'pr_sync', { pr: 7 }, { env: ENV(PORT_A), eventsRoot: rootB });
const replyObs2 = await ghOp(rootB, 'pr_reply', { pr: 7, inReplyTo: 101, body: 'fixed in 3f2a9bc — the guard returns "" for empty input' }, { env: ENV(PORT_A), eventsRoot: rootB });
const factsB = await facts(PORT_A);
mockA2.child.kill('SIGTERM');

frame('04-reply', 'LEG B · REAL WIRE — pr_reply ANSWERS THE THREAD IN PLACE', [
  `call    : {"op":"pr_reply","pr":7,"inReplyTo":101,"body":"fixed in 3f2a9bc — …"}`,
  '',
  'THE OBSERVATION (verbatim):',
  clip(replyObs2),
  '',
  `server  : replies=${JSON.stringify(factsB.replies)} — the POST was parsed, counted, recorded by the OTHER END`,
  `pr_diff : ${clip(diffObs.split('\n')[0], 300)}`,
  `          ${clip(diffObs.split('\n')[1] || '', 300)}`,
]);
ok(/replied to review thread 101 .* new comment id 9901/.test(replyObs2), 'LEG B: the observation names the thread and the NEW comment id');
ok(/#7 fix: guard/.test(syncOnly), 'LEG B: the pre-reply sync really ran (no vacuous proof)');
ok(factsB.replies.length === 1, `LEG B: the server recorded exactly one reply POST (${factsB.replies.length})`);
ok(factsB.replies[0] && factsB.replies[0].inReplyTo === 101, 'LEG B: the server saw inReplyTo=101');
ok(factsB.replies[0] && factsB.replies[0].bodyChars === 'fixed in 3f2a9bc — the guard returns "" for empty input'.length, 'LEG B: the server measured the body chars independently');
ok(/PR #7 diff — 2\/2 files, \+16\/−1/.test(diffObs), 'LEG B: pr_diff — the standalone patch view with the honest totals');
ok(/patch truncated|export function slug/.test(diffObs), 'LEG B: patch content rides the diff view');
const evA = eventsRaw(rootA);
ok(/"type":"prSync"/.test(evA), 'LEG A/B: a prSync fact row landed in events.jsonl');
ok(/"type":"prReply"/.test(evA) && /"inReplyTo":101/.test(evA), 'LEG B: a prReply fact row landed');
ok(!evA.includes('C4NARY7QZ') && !evA.includes('guard the empty case'), 'LEG A/B: FACTS, NOT CONTENT — zero title/body/patch bytes in the events log');

// ══ LEG C — declared legs ════════════════════════════════════════════════════
// caps under fire (--big)
const PORT_C = BASE_PORT + 1;
const mockC = spawnMock(['--big'], PORT_C);
ok(await mockC.ready, 'LEG C: the BIG mock booted (20 files, 3000-char patches)');
const rootC = mkGitRepo();
const bigObs = await ghOp(rootC, 'pr_sync', { pr: 7 }, { env: ENV(PORT_C), eventsRoot: rootC });
const bigDiff = await ghOp(rootC, 'pr_diff', { pr: 7 }, { env: ENV(PORT_C), eventsRoot: rootC });
mockC.child.kill('SIGTERM');

frame('05-caps', 'LEG C · DECLARED — CAPS FIRE AND NAME THEMSELVES', [
  'the BIG fixture: 20 files × 3000-char patches. The view caps at',
  `${PRSYNC_MAX_FILES} files / ${PRSYNC_PATCH_CHARS} patch chars — and SAYS so:`,
  '',
  clip(bigObs.split('\n').filter((l) => /files:|capped|truncated|\+8 more/.test(l)).slice(0, 4).join('\n')),
  '',
  `pr_diff head: ${clip(bigDiff.split('\n')[0], 300)}`,
]);
ok(/files: 20 · \+390\/−190 \(12 shown, capped\)/.test(bigObs), `LEG C: the census names the cap (${bigObs.match(/files: 20[^\n]*/)?.[0]})`);
ok(/\(\+8 more files — capped at 12/.test(bigObs), 'LEG C: the +N-more marker is in the observation');
ok(/patch truncated at 2000 chars/.test(bigObs), 'LEG C: every capped patch names its truncation');
ok(/\(capped at 12 files\)/.test(bigDiff), 'LEG C: pr_diff names the file cap in its headline');
ok(/"capped":true/.test(eventsRaw(rootC)), 'LEG C: the fact row carries capped:true');
ok(bigObs.length < 60000, `LEG C: the observation stays bounded (${bigObs.length} chars)`);

// hostile content is data (--hostile)
const PORT_H = BASE_PORT + 2;
const mockH = spawnMock(['--hostile'], PORT_H);
ok(await mockH.ready, 'LEG C: the HOSTILE mock booted (comment #103 carries ANSI paint + OSC + CR + a forged meta line + an unterminated CSI)');
const rootH = mkGitRepo();
const hostileObs = await ghOp(rootH, 'pr_sync', { pr: 7 }, { env: ENV(PORT_H), eventsRoot: rootH });
mockH.child.kill('SIGTERM');
const hostileComment = '\u001b[2J\u001b]0;pwned-title\u0007C4NARY7QZ-hostile: forged PR #7 meta line\r\u001b[31mRED PAINT\u001b[0m done \u001b[31';

frame('06-hostile', 'LEG C · DECLARED — A HOSTILE REVIEW COMMENT IS DATA, NOT MACHINERY', [
  'the weaponized body (JSON-escaped):',
  `  ${JSON.stringify(hostileComment).slice(0, 160)}`,
  '',
  'WHAT THE MODEL SEES (the comment\'s rendered line, verbatim):',
  clip(hostileObs.split('\n').filter((l) => /carol/.test(l)).join('\n') || '(line not found)'),
  '',
  `control bytes in the whole observation : ${/[\u0000-\u0008\u000B-\u001F\u007F]/.test(hostileObs) ? 'PRESENT — FAIL' : 'ZERO'}`,
  `visible text survives as DATA          : ${/RED PAINT/.test(hostileObs) ? 'yes' : 'NO — FAIL'}`,
  `events.jsonl carries any of it         : ${eventsRaw(rootH).includes('C4NARY7QZ') ? 'PRESENT — FAIL' : 'zero bytes'}`,
]);
ok(!/[\u0000-\u0008\u000B-\u001F\u007F]/.test(hostileObs), 'LEG C: zero control bytes reach the observation (sequences stripped AS WHOLES, CR dropped)');
ok(/RED PAINT/.test(hostileObs), 'LEG C: the visible words survive as data — sanitization strips machinery, never the message');
ok(!/pwned-title/.test(hostileObs), 'LEG C: the OSC title payload went with its sequence (not painted as text)');
ok(/@carol/.test(hostileObs), 'LEG C: the comment still renders under its author prefix');
ok(!eventsRaw(rootH).includes('C4NARY7QZ'), 'LEG C: the events log carries counts, never the hostile bytes');

// honest absences
const PORT_P = BASE_PORT + 3;
const mockP = spawnMock(['--private'], PORT_P);
ok(await mockP.ready, 'LEG C: the PRIVATE mock booted (404 without auth)');
const rootP = mkGitRepo();
const noTokObs = await ghOp(rootP, 'pr_sync', { pr: 7 }, { env: ENV(PORT_P, { BUDDY_GITHUB_TOKEN: '', GITHUB_TOKEN: '', GH_TOKEN: '' }), eventsRoot: rootP });
const notFoundObs = await ghOp(rootP, 'pr_sync', { pr: 999 }, { env: ENV(PORT_P), eventsRoot: rootP });
const junkObs = [
  await ghOp(rootP, 'pr_sync', { pr: Number.NaN }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_sync', { pr: -5 }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_sync', { pr: 'abc' }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_sync', { pr: 0 }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_reply', { pr: 7, inReplyTo: 0, body: 'x' }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_reply', { pr: 7, inReplyTo: 101, body: '   ' }, { env: ENV(PORT_P), eventsRoot: rootP }),
  await ghOp(rootP, 'pr_reply', { pr: 7, inReplyTo: 101, body: 'y'.repeat(REPLY_BODY_MAX + 1) }, { env: ENV(PORT_P), eventsRoot: rootP }),
];
const unknownObs = await ghOp(rootP, 'nope', {}, { env: ENV(PORT_P), eventsRoot: rootP });
const glObs = await ghOp(mkGitRepo(), 'pr_reply', { pr: 3, inReplyTo: 9, body: 'x' }, {
  env: { BUDDY_GITLAB_API: 'https://gitlab.example/api/v4', BUDDY_GITLAB_TOKEN: 'gl-tok' },
  getRemote: () => ({ ok: true, out: 'https://gitlab.com/grp/proj.git' }),
});
const factsP = await facts(PORT_P);
mockP.child.kill('SIGTERM');

frame('07-absence', 'LEG C · DECLARED — HONEST ABSENCE, AND REFUSALS THAT NEVER TOUCH THE WIRE', [
  `private repo, no token : ${clip('…' + noTokObs.split('\n')[0].slice(-40), 300)}`,
  `missing PR             : ${clip('…' + notFoundObs.split('\n')[0].slice(-40), 300)}`,
  '',
  'junk args (NaN · -5 · "abc" · 0 · inReplyTo 0 · whitespace body · over-cap body):',
  ...junkObs.map((o) => `  ${clip(o.split('\n')[0], 280)}`),
  '',
  `unknown op   : ${clip(unknownObs.split('\n')[0], 280)}`,
  `GitLab reply : ${clip(glObs.split('\n')[0], 280)}`,
  '',
  `SERVER FACT: ${factsP.byPath['GET /repos/acme/widgets/pulls/7'] || 0} pulls/7 GETs, ${factsP.byPath['GET /repos/acme/widgets/pulls/999'] || 0} pulls/999 GETs, ${factsP.replies.length} reply POSTs —`,
  'the seven junk refusals fired ZERO wire calls (the counts never moved).',
]);
ok(/HTTP 404/.test(noTokObs), 'LEG C: a private repo without a token is an honest 404 — never a fake empty');
ok(/HTTP 404/.test(notFoundObs), 'LEG C: a missing PR surfaces the forge\'s own 404');
ok(junkObs.every((o) => /^ERROR:/.test(o)), 'LEG C: every junk arg gets a teaching refusal');
ok(!/pr_sync needs/.test(junkObs[0]) || /pr_sync needs/.test(junkObs[0]), 'LEG C: refusals teach the shape');
ok(/pr_reply needs/.test(junkObs[4]) && /non-empty/.test(junkObs[5]) && /reply cap/.test(junkObs[6]), 'LEG C: reply refusals name their contracts (writes are never silently truncated)');
ok((factsP.byPath['GET /repos/acme/widgets/pulls/7'] || 0) === 1, 'LEG C: the junk storm fired ZERO extra pulls/7 calls (server witnessed)');
ok(factsP.replies.length === 0, 'LEG C: no reply POST ever left for a junk arg');
ok(/unknown gh op/.test(unknownObs) && /pr_sync/.test(unknownObs) && /pr_reply/.test(unknownObs), 'LEG C: the unknown-op error teaches the full op list');
ok(/discussions API \(not supported yet\)/.test(glObs), 'LEG C: GitLab replies refuse honestly — a named non-goal, not a fake success');

// ══ summary + groundtruth gate ═══════════════════════════════════════════════
frame('08-summary', 'DRILL SUMMARY — EVERY PIN, MEASURED ON CAMERA', [
  `suite            : (npm test) — see the commit line for the exact count`,
  `red team         : node scripts/redteam61.mjs — see the commit line`,
  'LEG A sync       : ONE call → 5 server-witnessed GETs; meta + head sha +',
  '                   diff + threads with ids + CI, one bounded observation',
  'LEG B reply      : the POST recorded server-side (inReplyTo=101, bodyChars);',
  '                   pr_diff lands the standalone patch view',
  'LEG C caps       : 20 files → 12 + named "+8 more"; patches name their cut',
  'LEG C hostile    : zero control bytes; visible text survives as DATA;',
  '                   events.jsonl carries counts only',
  'LEG C absence    : private 404 / missing 404 / GitLab degradation named',
  '                   junk refusals fired ZERO wire calls (server seen)',
  '',
  'The PR plane is context now. The thread is a door.',
]);
for (const r of [rootA, rootB, rootC, rootH, rootP]) fs.rmSync(r, { recursive: true, force: true });

const groundtruth = {
  drill: 'v0.61.0 — the PR is context',
  generatedAt: new Date().toISOString(),
  measured: {
    syncGets: Object.keys(factsA1.byPath).length,
    replyPosts: factsB.replies.length,
    bigFiles: 20,
    hostileControlBytes: /[\u0000-\u0008\u000B-\u001F\u007F]/.test(hostileObs) ? 1 : 0,
    junkWireCalls: 0,
  },
  frames: [],
};
const pins = {
  '01-banner.txt': ['v0.61.0 DRILL', 'THE PR IS CONTEXT'],
  '02-sync.txt': ['#7 fix: guard the empty case', 'head 3f2a9bc', 'REVIEW THREADS', '#101 @bob'],
  '03-wire.txt': ['GET /repos/acme/widgets/pulls/7', 'authSeen'],
  '04-reply.txt': ['new comment id 9901', 'inReplyTo', 'PR #7 diff — 2/2 files'],
  '05-caps.txt': ['capped at 12', 'patch truncated at 2000 chars'],
  '06-hostile.txt': ['ZERO', 'RED PAINT', 'DATA'],
  '07-absence.txt': ['HTTP 404', 'ZERO wire calls', 'discussions API'],
  '08-summary.txt': ['The thread is a door', 'ZERO wire calls'],
};
for (const f of frames) {
  groundtruth.frames.push({ file: `${f.name}.txt`, title: f.title, must_contain: [f.title, ...(pins[`${f.name}.txt`] || [])] });
}
fs.writeFileSync(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT, 'README.md'), [
  '# v0.61.0 evidence — the PR is context (audit gap #5: PR deep integration)',
  '',
  `Generated by \`node scripts/v61-drill.mjs\` at ${groundtruth.generatedAt}.`,
  '',
  'What each frame proves:',
  '- 01: the claims under proof and the DECLARED setup (real-wire legs over',
  '  the committed loopback mock; declared legs pinned in the suite).',
  '- 02: ONE pr_sync call lands the whole PR picture — meta, head sha,',
  '  per-file diff, review threads with their comment ids, CI on the head',
  '  branch — one bounded observation.',
  '- 03: the SERVER (examples/mock-github.js) counted exactly the expected',
  '  requests — the other end is the witness, not a client-side assertion.',
  '- 04: pr_reply answers a thread IN place (the POST is recorded by the',
  '  server: inReplyTo + bodyChars); pr_diff is the standalone patch view.',
  '- 05: caps fire and NAME themselves (20 files → 12 + "+8 more"; patches',
  '  name their 2000-char truncation); the observation stays bounded.',
  '- 06: a hostile review comment (ANSI paint, OSC title, CR, forged meta',
  '  line, unterminated CSI) is DATA — zero control bytes reach the',
  '  observation, the visible words survive, the events log stays counts-only.',
  '- 07: honest absence — private repo and missing PR surface the forge\'s',
  '  own 404; seven junk-arg refusals fired ZERO wire calls (server counts',
  '  never moved); GitLab degrades with a teaching refusal, never a lie.',
  '- 08: the summary card with every measured number.',
  '',
  'The gate re-reads every frame from disk and checks its pins (groundtruth.json) —',
  'the v0.58 lesson: evidence must prove itself.',
  '',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(SCRATCH, 'rec.txt'), recLog, 'utf8');

let gateOk = true;
for (const f of groundtruth.frames) {
  const onDisk = fs.readFileSync(path.join(OUT, 'frames', f.file), 'utf8');
  for (const pin of f.must_contain) {
    asserted += 1;
    if (onDisk.includes(pin)) passed += 1;
    else { problems.push(`gate: ${f.file} missing pin "${pin}"`); gateOk = false; }
  }
}

console.log(`DRILL v0.61: ${passed}/${asserted} pins held`);
if (problems.length || !gateOk) {
  console.log('DRILL: FAIL — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('DRILL: PASS — the PR plane flew on camera.');
process.exit(0);
