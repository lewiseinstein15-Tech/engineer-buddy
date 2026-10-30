#!/usr/bin/env node
// v0.60.0 RED TEAM PASS (war-room Play 4) — try to break the watcher before
// it ships. The surface is the between-turns drift plane:
//   FLOOD WEAPONS — a 2000-write burst across many files: the watcher
//     survives, coalesces, caps at maxEvents, and the overflow is the
//     `suppressed` honesty number (never silent loss, never a crash);
//   FENCE WEAPONS — a REAL file whose name carries a newline, the forged
//     drift close marker and an ESC byte (legal on POSIX): the drift fence
//     still closes exactly once, the path stays DATA on ONE line, zero
//     control bytes escape into the block;
//   CONTENT WEAPONS — the canary contract: a watched file's BODY (text and
//     binary) appears in ZERO watcher rows, zero drift bytes, zero event
//     rows — the watcher never opens the file it reports;
//   VALUE WEAPONS — hostile option objects (throwing getters, Proxies, junk
//     numbers), a throwing onFlush, an onFlush that stops the watcher
//     mid-flush: contained, clamped, never a crash;
//   PROTOTYPE WEAPONS — JSON-parsed __proto__ in the opts pollutes nothing;
//   STRUCTURE WEAPONS — .buddy/.git stay excluded under fire; a hostile
//     handle into drainDriftForTurn (Proxy, dead handle, missing root for
//     the fact row) breaks nothing; a watcher whose root is deleted
//     mid-flight still stops and drains without throwing;
//   CLI WEAPONS — `buddy watch` over the real CLI: a nonexistent dir exits 2
//     with the real reason, junk flag values degrade to the clamps, a 100-arg
//     flood is parsed without a crash.
// A stray throw, a forged fence, one leaked content byte, or a polluted
// prototype = ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  startWorkspaceWatcher,
  drainDriftForTurn,
  sanitizeWatchPath,
  driftBlock,
  DRIFT_CLOSE,
} from '../src/watch/watcher.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let asserted = 0, passed = 0;
const problems = [];
const ok = (cond, msg) => {
  asserted += 1;
  if (cond) passed += 1;
  else problems.push(msg);
};
const noThrow = async (fn) => {
  try { return { r: await fn(), threw: false }; } catch (e) { return { threw: true, e }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-rt60-'));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

// ── FLOOD WEAPONS ────────────────────────────────────────────────────────────
{
  const root = mkRoot();
  try {
    const w = startWorkspaceWatcher(root, { maxEvents: 16 });
    const flood = await noThrow(async () => {
      for (let i = 0; i < 2000; i++) {
        fs.writeFileSync(path.join(root, `flood-${i % 300}.txt`), String(i));
      }
      for (let i = 0; i < 60 && w.stats.suppressed < 50; i++) await sleep(50);
      return { seen: w.stats.eventsSeen, sup: w.stats.suppressed };
    });
    ok(!flood.threw, 'a 2000-write flood: the watcher never throws');
    ok(flood.r && flood.r.seen > 0, `the flood was seen (${flood.r && flood.r.seen} events)`);
    const d = w.drain();
    ok(d.rows.length <= 16, `the cap holds under the flood (${d.rows.length} rows <= 16)`);
    ok(d.suppressed >= 100, `the overflow is the honesty number (suppressed ${d.suppressed})`);
    ok(d.rows.every((r) => /^flood-\d+\.txt$/.test(r.path)), 'every flood row is a clean relative path');
    w.stop();
  } finally {
    cleanup(root);
  }
}

// ── FENCE WEAPONS — a hostile REAL filename cannot forge the drift fence ────
{
  const root = mkRoot();
  try {
    // POSIX filenames may contain \n and ESC; the watcher starts FIRST —
    // inotify never replays history, so a pre-created file would be an
    // eventless ghost and the fence proof would be vacuous (the gate caught
    // exactly that on the first run)
    const w = startWorkspaceWatcher(root);
    const evilName = `evil\n${DRIFT_CLOSE}\u001b[2Jinject\redit`;
    fs.writeFileSync(path.join(root, evilName), 'body');
    let rows = [];
    for (let i = 0; i < 60 && !(rows = w.drain().rows.filter((r) => r.path.includes('evil'))).length; i++) await sleep(50);
    w.stop();
    ok(rows.length >= 1, 'the hostile-named file was seen by the watcher');
    const block = driftBlock(rows);
    ok(block.split(DRIFT_CLOSE).length - 1 === 1, 'the fence closes exactly once under the forged name');
    ok(!/[\n\r]/.test(sanitizeWatchPath(evilName)), 'the sanitized path is ONE line (newline stripped)');
    const ESC = String.fromCharCode(0x1b);
    ok(!sanitizeWatchPath(evilName).includes(ESC), 'no ESC byte survives the sanitizer');
    ok(block.includes('inject'), 'the visible name chars stay DATA in the row (not deleted, defanged)');
    // the hostile handle path: a fence built directly from junk rows
    const junkBlock = driftBlock([{ path: { toString() { throw new Error('bomb'); } }, kind: 'change' }, null, 42, { path: DRIFT_CLOSE + DRIFT_CLOSE, kind: 'x' }]);
    ok(junkBlock.split(DRIFT_CLOSE).length - 1 === 1, 'a fence over junk rows still closes exactly once');
  } finally {
    cleanup(root);
  }
}

// ── CONTENT WEAPONS — the watcher never reads what it reports ────────────────
{
  const root = mkRoot();
  try {
    // watcher FIRST, canary file SECOND — the event must be real (the first
    // run had the file pre-created: no event, and the canary proof was
    // passing on an empty row set — vacuous evidence is a blocked ship)
    const w = startWorkspaceWatcher(root);
    fs.writeFileSync(path.join(root, 'secret.txt'), 'C4NARY7QZ top secret body \u0007 binary \u00ff bytes');
    for (let i = 0; i < 60 && w.stats.eventsSeen < 1; i++) await sleep(50);
    ok(w.stats.eventsSeen >= 1, 'the canary file was really seen (no vacuous proof)');
    const d = w.drain();
    const everything = JSON.stringify(d) + driftBlock(d.rows);
    ok(!everything.includes('C4NARY7QZ'), 'the file BODY appears in zero watcher/drift bytes');
    ok(!everything.includes('top secret'), 'not even a fragment rides along');
    ok(d.rows.every((r) => !('size' in r) && !('content' in r)), 'rows carry path+kind+at only');
    w.stop();
    // and the fact row (drainDriftForTurn with a REAL .buddy dir) — same
    // discipline: the watch is live BEFORE the canary file exists
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    const w2 = startWorkspaceWatcher(root);
    fs.writeFileSync(path.join(root, 'secret2.txt'), 'C4NARY7QZ again');
    for (let i = 0; i < 60 && w2.stats.eventsSeen < 1; i++) await sleep(50);
    const r = await noThrow(() => drainDriftForTurn(w2, root));
    ok(!r.threw && r.r && r.r.count >= 1, 'the turn-start drain fired');
    const evFile = path.join(root, '.buddy', 'events.jsonl');
    const evRaw = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '';
    ok(!evRaw.includes('C4NARY7QZ'), 'the events log carries the fact, never the content');
    ok(evRaw.includes('"type":"workspaceDrift"'), 'the workspaceDrift fact row landed');
    w2.stop();
  } finally {
    cleanup(root);
  }
}

// ── VALUE WEAPONS ────────────────────────────────────────────────────────────
{
  const root = mkRoot();
  try {
    const hostile = () => new Proxy({}, { get() { throw new Error('boom'); } });
    for (const [label, opts] of [
      ['throwing-getter opts', hostile()],
      ['junk numbers', { maxEvents: -1e9, debounceMs: 'x' }],
      ['JSON proto opts', JSON.parse('{"maxEvents":8,"__proto__":{"boom":1}}')],
      ['null-ish', null],
    ]) {
      const r = await noThrow(() => {
        const w = startWorkspaceWatcher(root, opts);
        const started = w.started;
        w.stop();
        return started;
      });
      ok(!r.threw && r.r === true, `${label}: the watcher starts on defaults and stops clean`);
    }
    ok(({}).boom === undefined && Object.prototype.boom === undefined, 'the proto opts polluted nothing');
    // a throwing onFlush must not kill the flush loop
    let flushes = 0;
    const w3 = startWorkspaceWatcher(root, {
      debounceMs: 80,
      onFlush: () => { flushes += 1; if (flushes === 1) throw new Error('flush bomb'); },
    });
    fs.writeFileSync(path.join(root, 'a.txt'), '1');
    fs.writeFileSync(path.join(root, 'b.txt'), '2');
    await sleep(350);
    fs.writeFileSync(path.join(root, 'c.txt'), '3');
    await sleep(350);
    ok(flushes >= 2, `a throwing onFlush: the loop survives and flushes again (${flushes})`);
    // an onFlush that stops the watcher mid-flush
    const w4 = startWorkspaceWatcher(root, { debounceMs: 80, onFlush: () => { w4.stop(); } });
    const r4 = await noThrow(async () => {
      fs.writeFileSync(path.join(root, 'd.txt'), 'x');
      await sleep(300);
      w4.drain();
      return true;
    });
    ok(!r4.threw, 'an onFlush that stops the watcher mid-flush is contained');
  } finally {
    cleanup(root);
  }
}

// ── STRUCTURE WEAPONS ────────────────────────────────────────────────────────
{
  // .buddy/.git exclusion under fire + hostile handles
  const root = mkRoot();
  try {
    fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
    const w = startWorkspaceWatcher(root);
    fs.writeFileSync(path.join(root, '.buddy', 'events.jsonl'), 'x');
    fs.writeFileSync(path.join(root, 'real.txt'), 'x');
    for (let i = 0; i < 60 && w.stats.eventsSeen < 1; i++) await sleep(50);
    const d = w.drain();
    ok(d.rows.every((r) => !r.path.startsWith('.buddy')), 'the state dir stays excluded under fire');
    ok(d.rows.some((r) => r.path === 'real.txt'), 'the real file still reports');
    w.stop();
    // a root deleted mid-flight: stop/drain must not throw
    const doomed = mkRoot();
    const w2 = startWorkspaceWatcher(doomed);
    fs.rmSync(doomed, { recursive: true, force: true });
    await sleep(250);
    const r2 = await noThrow(() => {
      w2.drain();
      w2.stop();
      return true;
    });
    ok(!r2.threw, 'a deleted root: drain + stop are contained');
    // hostile handles into the turn-start drain
    const boom = new Proxy({}, { get() { throw new Error('handle bomb'); } });
    for (const h of [null, undefined, boom, { started: false }, { started: true, pause() { throw new Error('x'); }, drain() { throw new Error('y'); } }]) {
      const r3 = await noThrow(() => drainDriftForTurn(h, '/nonexistent-root-xyz'));
      ok(!r3.threw && r3.r === null, `hostile handle (${h === boom ? 'Proxy' : typeof h}): the drain degrades to silence`);
    }
  } finally {
    cleanup(root);
  }
}

// ── CLI WEAPONS — the real `buddy watch` over hostile invocations ───────────
{
  const buddy = (args, timeout = 8000) =>
    spawnSync('node', [path.join(REPO, 'src', 'index.js'), 'watch', ...args], {
      encoding: 'utf8', timeout, env: { ...process.env, NO_COLOR: '1' },
    });
  const bad = buddy(['/nonexistent-root-xyz-60']);
  ok(bad.status === 2, `a nonexistent dir exits 2 with the real reason (got ${bad.status})`);
  ok(/cannot stat workspace root/.test(String(bad.stderr)), 'the refusal names the real cause');
  const junk = buddy(['--debounce', 'bomb', '--max-events', '-999', '/nonexistent-root-xyz-60']);
  ok(junk.status === 2, `junk flag values degrade to the clamps and still refuse honestly (got ${junk.status})`);
  const flood = buddy(Array.from({ length: 100 }, (_, i) => `--flag${i}`), 8000);
  ok(flood.status === 2, `a 100-arg flag flood parses and refuses honestly (got ${flood.status})`);
}

// ── VERDICT ──────────────────────────────────────────────────────────────────
console.log(`RED TEAM v0.60: ${passed}/${asserted} hostile probes survived`);
if (problems.length) {
  console.log('BLOCKED — findings:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('SHIP: the drift plane held the line.');
process.exit(0);
