// perf.js — performance profiling as a tool (v0.40.0, checklist §5).
//
// "run profilers (node --prof, py-spy) and summarize hotspots on request" —
// the model calls perf instead of hand-rolling prof invocations through bash,
// and gets a STRUCTURED hotspot summary, not 40k of V8 log soup.
//
// Zero-dep by construction:
//   node    → `node --prof entry.js` + `node --prof-process` (both ship with node)
//   python  → `python -m cProfile -o file.pstats` + a pstats JSON dump (stdlib)
//   py-spy  → optional: `py-spy record -f speedscope` when the binary exists
//             and mode:'pyspy' is asked for — absent binary degrades honestly
//             to cProfile, never a crash.
//
// Boundaries (honest on purpose):
//   - ONE simple command: the entry invocation itself (node x.js / python x.py).
//     Pipes, chains, redirects and npm wrappers are refused — --prof through
//     `npm test` profiles npm, not your code; the tool says so instead of lying.
//   - Artifacts land in .buddy/perf/ (already inside .buddy, never snapshotted,
//     never committed) with the observation naming them for deeper digging.
//   - risky: true — this RUNS code, same gate class as bash.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { truncate, baseSpawnEnv } from '../util.js';

const PERF_TIMEOUT_MS = 120000;
const MAX_OUT = 8000;

/** Parse `node --prof-process` text into {total, hotspots}. Sections look like:
 *  [Summary]: samples N · [JavaScript]: ticks total% nonlib% name … */
export function parseProfProcess(text) {
  const out = { total: 0, hotspots: [] };
  if (typeof text !== 'string' || !text.trim()) return out;
  // total ticks: the result header "(137 ticks, 0 unaccounted, 0 excluded)" on
  // modern node; older builds print "[Summary]: samples N" — accept both, and
  // fall back to the sum of parsed hotspot ticks so the label never lies.
  const header = text.match(/\((\d+) ticks?,/);
  const samples = text.match(/^\s*samples\s+(\d+)\s*$/m);
  out.total = header ? Number(header[1]) : (samples ? Number(samples[1]) : 0);
  const sections = ['[JavaScript]:', '[C++]:'];
  const hot = [];
  for (const sec of sections) {
    const at = text.indexOf(sec);
    if (at < 0) continue;
    const body = text.slice(at + sec.length, text.indexOf('[', at + sec.length) > 0 ? text.indexOf('[', at + sec.length) : undefined);
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)%\s+[\d.]+%\s+(.+?)\s*$/);
      if (m) hot.push({ ticks: Number(m[1]), pct: Number(m[2]), label: m[3].trim() });
    }
  }
  hot.sort((a, b) => b.ticks - a.ticks);
  out.hotspots = hot.slice(0, 12);
  return out;
}

/** Parse the pstats JSON dump (produced by the python one-liner below). */
export function parsePstatsJson(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    const top = Array.isArray(d.top) ? d.top : [];
    return {
      total: Number(d.total_tt) || 0,
      hotspots: top.slice(0, 12).map((r) => ({
        ticks: Number(r.ct) || 0,
        pct: d.total_tt ? Number(((100 * (Number(r.ct) || 0)) / d.total_tt).toFixed(1)) : 0,
        label: `${r.f}  (${r.nc} calls)`,
      })),
    };
  } catch {
    return { total: 0, hotspots: [] };
  }
}

/** Aggregate a speedscope JSON (py-spy) into per-frame hotspots. */
export function parseSpeedscope(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    const frames = d?.shared?.frames || [];
    const counts = new Map();
    for (const p of d?.profiles || []) {
      const samples = p?.samples || [];
      const weights = p?.weights || samples.map(() => 1);
      for (let i = 0; i < samples.length; i++) {
        for (const fi of samples[i] || []) counts.set(fi, (counts.get(fi) || 0) + (weights[i] || 1));
      }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const hot = [...counts.entries()]
      .map(([idx, w]) => ({ ticks: w, pct: total ? Number(((100 * w) / total).toFixed(1)) : 0, label: frames[idx]?.name || `frame ${idx}` }))
      .sort((a, b) => b.ticks - a.ticks)
      .slice(0, 12);
    return { total, hotspots: hot };
  } catch {
    return { total: 0, hotspots: [] };
  }
}

const PYSPY_HINT = '(py-spy not found — cProfile (stdlib) used instead; install py-spy and pass mode:"pyspy" for sampling)';

/** Validate the ONE command perf will run. Returns {ok, lang, argv, error}. */
export function validatePerfCommand(cmd) {
  const c = String(cmd || '').trim().replace(/\s+/g, ' ');
  if (!c) return { ok: false, error: 'command required — e.g. {"command":"node hot.js"}' };
  if (c.length > 300) return { ok: false, error: 'command too long — perf profiles ONE entry invocation' };
  if (/[|;&><`$()]|\b(?:npm|npx|yarn|pnpm|make)\b/.test(c)) {
    return { ok: false, error: 'perf runs ONE entry invocation directly (node x.js / python x.py) — no pipes, chains, redirects or package-manager wrappers (--prof through `npm test` profiles npm, not your code)' };
  }
  const parts = c.split(' ');
  const head = parts[0];
  if (head === 'node' || head === 'nodejs') return { ok: true, lang: 'node', argv: parts };
  if (head === 'python' || head === 'python3') return { ok: true, lang: 'python', argv: parts };
  return { ok: false, error: `perf profiles node or python entries — "${head}" is neither (wrap the hot path in a script and profile that)` };
}

function run(argv, { cwd, timeoutMs = PERF_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: baseSpawnEnv() });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message, durationMs: 0, timedOut: false });
      return;
    }
    const t0 = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d.toString(); });
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, code: -1, stdout: out, stderr: e.message, durationMs: Date.now() - t0, timedOut }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ ok: !timedOut && code === 0, code, stdout: out, stderr: err, durationMs: Date.now() - t0, timedOut }); });
  });
}

const PYTHON_DUMP = (
  "import json,sys,pstats;s=pstats.Stats(sys.argv[1]);" +
  "rows=[{'f':'%s:%s %s'%(k[0],k[1],k[2]),'nc':v[1],'ct':v[3]} for k,v in s.stats.items()];" +
  "rows.sort(key=lambda r:-r['ct']);print(json.dumps({'total_tt':s.total_tt,'top':rows[:12]}))"
);

function fmtHotspots(p, unit) {
  if (!p.hotspots.length) return '(no hotspot samples parsed — the run was too short?)';
  const rows = p.hotspots.map((h, i) => {
    const share = p.total ? ` ${(100 * h.ticks / p.total).toFixed(1)}%` : (h.pct ? ` ${h.pct}%` : '');
    return ` ${i + 1}. ${h.ticks}${unit}${share}  ${truncate(h.label, 110)}`;
  });
  return `top hotspots (${p.total}${unit} total):\n${rows.join('\n')}`;
}

async function profileNode(argv, cwd, perfDir, t0) {
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  const r = await run(['node', '--prof', ...argv.slice(1)], { cwd });
  // the isolate log lands in cwd — claim the newest one created during OUR run
  let log = null;
  try {
    const cands = fs.readdirSync(cwd).filter((f) => f.startsWith('isolate-') && f.endsWith('.log'))
      .map((f) => ({ f, m: fs.statSync(path.join(cwd, f)).mtimeMs }))
      .filter((x) => x.m >= t0 - 50).sort((a, b) => b.m - a.m);
    if (cands.length) {
      log = path.join(cwd, cands[0].f);
      const kept = path.join(perfDir, `${tag}-${cands[0].f}`);
      fs.renameSync(log, kept);
      log = kept;
    }
  } catch { /* best effort */ }
  if (!log) {
    return `perf: the V8 log never appeared (entry must run long enough to sample, or --prof was stripped)\nexit ${r.code} in ${(r.durationMs / 1000).toFixed(1)}s${r.stderr ? `\n[stderr]\n${truncate(r.stderr, 600)}` : ''}`;
  }
  const proc = await run(['node', '--prof-process', log], { cwd, timeoutMs: 30000 });
  const parsed = parseProfProcess(proc.stdout || '');
  const lines = [
    `profiled \`${argv.join(' ')}\` (node --prof) — exit ${r.code} in ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? ' (TIMED OUT)' : ''}`,
    fmtHotspots(parsed, ' ticks'),
    `V8 log kept at ${path.relative(cwd, log) || log} — feed it back to me to dig deeper`,
  ];
  if (!parsed.hotspots.length) lines.push(truncate(proc.stdout || proc.stderr, 800));
  return lines.join('\n');
}

async function profilePython(argv, cwd, perfDir, t0, mode) {
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  const pyspy = mode === 'pyspy' ? spawnSync('py-spy', ['--version'], { encoding: 'utf8', timeout: 5000 }) : null;
  if (pyspy && !pyspy.error) {
    const out = path.join(perfDir, `${tag}-speedscope.json`);
    const r = await run(['py-spy', 'record', '-f', 'speedscope', '-o', out, '--', ...argv], { cwd });
    let parsed = { total: 0, hotspots: [] };
    try { parsed = parseSpeedscope(fs.readFileSync(out, 'utf8')); } catch { /* honest empty */ }
    return [
      `profiled \`${argv.join(' ')}\` (py-spy record) — exit ${r.code} in ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? ' (TIMED OUT)' : ''}`,
      fmtHotspots(parsed, ' samples'),
      `speedscope file kept at ${out} (open in speedscope.app for the flame graph)`,
    ].join('\n');
  }
  const prof = path.join(perfDir, `${tag}.pstats`);
  const r = await run([...argv.slice(0, 1), '-m', 'cProfile', '-o', prof, ...argv.slice(1)], { cwd });
  if (!fs.existsSync(prof)) {
    return `perf: cProfile produced no stats (exit ${r.code})${r.stderr ? `\n[stderr]\n${truncate(r.stderr, 600)}` : ''}${mode === 'pyspy' ? `\n${PYSPY_HINT}` : ''}`;
  }
  const dump = await run([...argv.slice(0, 1), '-c', PYTHON_DUMP, prof], { cwd, timeoutMs: 15000 });
  const parsed = parsePstatsJson(dump.stdout || '');
  return [
    `profiled \`${argv.join(' ')}\` (cProfile) — exit ${r.code} in ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? ' (TIMED OUT)' : ''}`,
    mode === 'pyspy' ? PYSPY_HINT : '',
    fmtHotspots(parsed, 's cum'),
    `pstats file kept at ${prof}`,
  ].filter(Boolean).join('\n');
}


export function createPerfTool({ root } = {}) {
  return {
    name: 'perf',
    description:
      'Profile ONE entry invocation and get a structured hotspot summary — node via --prof + --prof-process (built into node), python via cProfile (stdlib); mode:"pyspy" uses py-spy record when the binary exists. Use when something is slow and the hot path is not obvious. No pipes/chains/package-manager wrappers — profile the script directly.',
    args: '{"command":"node hot.js","mode":"auto"}',
    risky: true,
    render: (a) => `perf ${a?.command}`,
    run: async ({ command, mode = 'auto' } = {}) => {
      const v = validatePerfCommand(command);
      if (!v.ok) return `ERROR: ${v.error}`;
      const perfDir = path.join(root, '.buddy', 'perf');
      try { fs.mkdirSync(perfDir, { recursive: true }); } catch { /* below */ }
      const t0 = Date.now();
      return v.lang === 'node'
        ? profileNode(v.argv, root, perfDir, t0)
        : profilePython(v.argv, root, perfDir, t0, String(mode || 'auto'));
    },
  };
}
