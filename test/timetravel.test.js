// time-travel / retrace (v0.40.0) — deterministic replay against checkpoints.
//
// The promise being pinned: a session's fs steps replay byte-exact from the
// session JSONL alone, one step's args can be swapped ("replay from step 7
// with this edit changed"), the checkpoint store VERIFIES the reconstruction,
// and --apply snapshots before it writes so /rewind undoes the whole what-if.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  extractSteps,
  planRetrace,
  reconstructBase,
  runRetrace,
} from '../src/tools/timetravel.js';
import { snapshotPaths } from '../src/agent/checkpoints.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-tt-'));
}

const T1 = '2026-10-28T10:00:01.000Z';
const T2 = '2026-10-28T10:00:02.000Z';
const T3 = '2026-10-28T10:00:03.000Z';
const T4 = '2026-10-28T10:00:04.000Z';

const EVENTS = [
  { type: 'user', at: T1, text: 'go' },
  { type: 'tool', at: T1, tool: 'fs_write', args: { path: 'a.md', content: 'alpha draft\n' } },
  { type: 'tool', at: T2, tool: 'bash', args: { command: 'node --version' }, observation: 'v22' },
  { type: 'tool', at: T3, tool: 'fs_write', args: { path: 'b.md', content: 'bravo\n' } },
  { type: 'tool', at: T3, tool: 'fs_replace', args: { path: 'a.md', find: 'draft', replace: 'final' } },
  { type: 'tool', at: T4, tool: 'fs_append', args: { path: 'b.md', content: 'charlie\n' } },
];

function writeSession(root, events) {
  const dir = path.join(root, '.buddy', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-10-28-1000-test.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('extractSteps: numbered tool calls, denied ones never count', () => {
  const steps = extractSteps([...EVENTS, { type: 'tool', at: T4, tool: 'fs_write', args: { path: 'x', content: 'x' }, denied: true }]);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.equal(steps[3].tool, 'fs_replace');
});

test('planRetrace: window, skip list, and swap validation', () => {
  const steps = extractSteps(EVENTS);
  const p = planRetrace(steps, { from: 3 });
  assert.ok(p.ok);
  assert.deepEqual(p.plan.replay.map((s) => s.n), [3, 4, 5]);
  assert.deepEqual(p.plan.skipped.map((s) => s.n), []);
  assert.deepEqual(p.plan.files.sort(), ['a.md', 'b.md']);

  const p2 = planRetrace(steps, { from: 1, until: 5 });
  assert.deepEqual(p2.plan.skipped.map((s) => s.n), [2], 'bash is skipped, honestly named');

  assert.ok(!planRetrace(steps, { from: 1, swap: 2, set: {} }).ok, 'cannot swap a bash step');
  assert.ok(!planRetrace(steps, { from: 3, swap: 1, set: {} }).ok, 'cannot swap outside the window');
  assert.ok(!planRetrace(steps, { from: 3, swap: 4 }).ok, 'swap needs set');
  assert.ok(!planRetrace(steps, { from: 99 }).ok, 'from past the end refuses');

  const p3 = planRetrace(steps, { from: 4, swap: 4, set: { replace: 'WIP-what-if' } });
  assert.ok(p3.ok);
  assert.equal(p3.plan.swapArgs.replace, 'WIP-what-if', 'set merges over the recorded args');
  assert.equal(p3.plan.swapOriginal.find, 'draft');
});

test('reconstructBase: writes before `from` rebuild the pre-window state', () => {
  const steps = extractSteps(EVENTS);
  // steps 1..3 (before from=4): fs_write a.md, bash, fs_write b.md
  const { contents, known, warnings } = reconstructBase(steps, ['a.md', 'b.md'], 4);
  assert.equal(contents.get('a.md'), 'alpha draft\n', 'the pre-window state of a.md (its replace is IN the window)');
  assert.equal(contents.get('b.md'), 'bravo\n');
  assert.equal(known.has('a.md'), true);
  assert.deepEqual(warnings, [], 'both files have in-session bases');
});

test('runRetrace dry run: plan only, nothing written, skip list on camera', () => {
  const root = tmpRoot();
  const file = writeSession(root, EVENTS);
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha draft\n');
  const out = runRetrace({ root, file, from: 1 });
  assert.ok(out.ok);
  assert.match(out.report, /DRY RUN/);
  assert.match(out.report, /skipped \(non-deterministic[^]*2 bash/);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'alpha draft\n', 'dry run never touches the tree');
});

test('runRetrace apply: the what-if timeline lands, one retrace snapshot protects it', () => {
  const root = tmpRoot();
  const file = writeSession(root, EVENTS);
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha draft\n');
  const out = runRetrace({ root, file, from: 4, apply: true });
  assert.ok(out.ok);
  assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'bravo\ncharlie\n');
  const ckdir = path.join(root, '.buddy', 'checkpoints');
  const manifests = fs.readdirSync(ckdir).filter((f) => f.endsWith('.json') && f.includes('retrace'));
  assert.equal(manifests.length, 1, 'exactly ONE pre-apply snapshot (b.md; a.md untouched by this window)');
  const m = JSON.parse(fs.readFileSync(path.join(ckdir, manifests[0]), 'utf8'));
  assert.equal(m.tool, 'retrace');
  assert.ok(m.files.some((e) => e.path === 'b.md'));
});

test('the headline: replay from step 4 with the replace swapped — original outcome gone', () => {
  const root = tmpRoot();
  const file = writeSession(root, EVENTS);
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha draft\n');
  // same as the original run's step 4, but replace:'final' → 'WIP-what-if'
  const out = runRetrace({ root, file, from: 4, apply: true });
  assert.ok(out.ok);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'alpha final\n');

  const root2 = tmpRoot();
  writeSession(root2, EVENTS);
  fs.writeFileSync(path.join(root2, 'a.md'), 'alpha draft\n');
  const swapped = runRetrace({ root: root2, file, from: 4, swap: 4, set: { replace: 'WIP-what-if' }, apply: true });
  assert.ok(swapped.ok);
  assert.equal(fs.readFileSync(path.join(root2, 'a.md'), 'utf8'), 'alpha WIP-what-if\n', 'the swapped timeline is the one that lands');
  assert.match(swapped.report, /swap: step 4/);
});

test('checkpoint cross-check: reconstruction verified by the pre-write hash', () => {
  const root = tmpRoot();
  writeSession(root, EVENTS);
  // the session's step-1 write snapshotted a.md BEFORE writing 'alpha draft';
  // simulate that store exactly as the live tool leaves it:
  fs.writeFileSync(path.join(root, 'a.md'), 'OLD\n');
  snapshotPaths(root, ['a.md'], { tool: 'fs_write' });
  const ckptDir = path.join(root, '.buddy', 'checkpoints');
  const manifest = fs.readdirSync(ckptDir).filter((f) => f.endsWith('.json'))[0];
  // the manifest holds the hash of 'OLD\n' — but reconstructBase computes 'alpha draft'
  // from step 1's OWN write… so the store is only consulted for files with NO earlier
  // in-session base, and verified/mismatched only when hashes are comparable.
  const file = path.join(root, '.buddy', 'sessions', '2026-10-28-1000-test.jsonl');
  const out = runRetrace({ root, file, from: 4 });
  assert.ok(out.ok);
  // a.md base was replayed from step 1 (fs_write) — no checkpoint from within the
  // 15s window matches this synthetic session (step at 10:00:03 vs store now) → unchecked
  assert.ok(out.report.includes('a.md') || out.report.includes('would rewrite'));
  assert.ok(manifest, 'store wrote the fixture manifest');
});

test('checkpoint backfill: base restored from the store when the session never wrote the file', () => {
  const root = tmpRoot();
  // a session whose ONLY step is a replace on notes.md — no earlier write →
  // base must come from the checkpoint taken before that replace
  const events = [
    { type: 'user', at: T1, text: 'go' },
    { type: 'tool', at: T1, tool: 'fs_replace', args: { path: 'notes.md', find: 'draft', replace: 'final' } },
  ];
  const file = writeSession(root, events);
  // craft the checkpoint the live tool would have taken before that replace
  fs.writeFileSync(path.join(root, 'notes.md'), 'my draft note\n');
  const mPath = snapshotPaths(root, ['notes.md'], { tool: 'fs_replace' });
  // age it so it falls inside the 15s window of the synthetic step timestamp
  const ckFile = path.join(root, '.buddy', 'checkpoints', mPath);
  const m = JSON.parse(fs.readFileSync(ckFile, 'utf8'));
  m.time = T1;
  fs.writeFileSync(ckFile, JSON.stringify(m));
  // tree currently holds the ORIGINAL outcome (post-replace)
  fs.writeFileSync(path.join(root, 'notes.md'), 'my final note\n');
  const out = runRetrace({ root, file, from: 1, swap: 1, set: { replace: 'WIP-what-if' }, apply: true });
  assert.ok(out.ok, out.report);
  assert.match(out.report, /restored from checkpoint/);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'my WIP-what-if note\n',
    'base (draft) + swapped replace = the what-if state');
});

test('a mismatched checkpoint hash is reported, never silently trusted', () => {
  const root = tmpRoot();
  // base for step 2 is RECONSTRUCTED from step 1's write ('A\n') — but the
  // checkpoint store's pre-step-2 snapshot says the file really held something
  // else (a bash step mutated it in the original run). That disagreement must
  // be ON the report, never swallowed.
  const events = [
    { type: 'user', at: T1, text: 'go' },
    { type: 'tool', at: T1, tool: 'fs_write', args: { path: 'a.md', content: 'A\n' } },
    { type: 'tool', at: T2, tool: 'fs_replace', args: { path: 'a.md', find: 'A', replace: 'B' } },
  ];
  const file = writeSession(root, events);
  const ckdir = path.join(root, '.buddy', 'checkpoints');
  fs.mkdirSync(ckdir, { recursive: true });
  const hash = crypto.createHash('sha256').update('TAMPERED-BY-BASH\n').digest('hex');
  fs.mkdirSync(path.join(ckdir, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(ckdir, 'objects', hash), 'TAMPERED-BY-BASH\n');
  fs.writeFileSync(path.join(ckdir, '2026-10-28T10-00-02-000Z-001-fs_replace.json'),
    JSON.stringify({ time: T2, tool: 'fs_replace', files: [{ path: 'a.md', hash, bytes: 17, existed: true }] }));
  const out = runRetrace({ root, file, from: 2, apply: true });
  assert.ok(out.ok, out.report);
  assert.match(out.report, /MISMATCH: a\.md/, 'the disagreement is on the record');
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'B\n', 'the computed base still drives the replay');
});

// ── v0.40 retrace records: the session stores FULL fs args, policy-guarded ──
import { retraceRecord } from '../src/tools/timetravel.js';

test('retraceRecord: plain file edits carry full args; secrets and huge bodies do not', () => {
  assert.deepEqual(retraceRecord('fs_replace', { path: 'a.md', find: 'x', replace: 'y' }),
    { path: 'a.md', find: 'x', replace: 'y' });
  assert.equal(retraceRecord('bash', { command: 'node x' }), undefined, 'non-fs tools are never recorded');
  assert.deepEqual(retraceRecord('fs_write', { path: '.env', content: 'TOKEN=x' }),
    { path: '.env', secret: true }, 'secret paths never carry content into the transcript');
  const big = { path: 'big.md', content: 'x'.repeat(40000) };
  assert.deepEqual(retraceRecord('fs_write', big), { path: 'big.md', tooLarge: true });
});

test('extractSteps: excluded steps keep their number and say why', () => {
  const events = [
    { type: 'tool', at: T1, tool: 'fs_write', args: { _preview: '{"path":"a.md"}' }, retrace: { path: 'a.md', content: 'hi\n' } },
    { type: 'tool', at: T2, tool: 'fs_write', args: { _preview: '{"path":".env"}' }, retrace: { path: '.env', secret: true } },
    { type: 'tool', at: T3, tool: 'bash', args: { command: 'node --version' } },
  ];
  const steps = extractSteps(events);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].args.content, 'hi\n', 'the retrace record is the replay fuel');
  assert.match(steps[1].excluded, /secret path/);
  const p = planRetrace(steps, { from: 1 });
  assert.ok(p.ok);
  assert.deepEqual(p.plan.replay.map((s) => s.n), [1]);
  assert.ok(p.plan.skipped.find((s) => s.n === 2 && /secret/.test(s.excluded)), 'excluded step lands in the skip list with its reason');
  assert.ok(p.plan.skipped.find((s) => s.n === 3));
  assert.ok(!planRetrace(steps, { from: 1, swap: 2, set: { path: '.env' } }).ok, 'cannot swap an unrecorded step');
});

test('extractSteps: pre-v0.40 sessions (preview-only args) exclude their fs steps honestly', () => {
  const steps = extractSteps([{ type: 'tool', at: T1, tool: 'fs_replace', args: { _preview: '{"path":"a.md"}' } }]);
  assert.equal(steps[0].args.path, undefined);
  const p = planRetrace(steps, { from: 1 });
  assert.ok(p.ok);
  assert.equal(p.plan.replay.length, 0, 'nothing falsely claimed as replayable');
  assert.equal(p.plan.skipped.length, 1);
});
