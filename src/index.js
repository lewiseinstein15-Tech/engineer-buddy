#!/usr/bin/env node
// index.js — Engineer Buddy CLI.
//
//   engineer-buddy pr-review --repo OWNER/NAME --pr 5 [--dry-run] [--repo-dir PATH]
//   engineer-buddy doctor                     probe every gateway in the chain
//   engineer-buddy ask "question"             one-off brain query (debug)
//
// Exit codes: 0 = handled (review succeeded, skipped, or failed gracefully —
// a review outage must never break CI), 2 = usage/config error.
import { loadConfig } from './config.js';
import { buildRouter } from './brain/index.js';
import { GitHubClient } from './tools/github.js';
import { LocalRepo } from './tools/repo.js';
import { runPrReview } from './skills/pr-reviewer.js';
import { log, warn, setVerbose, truncate, BuddyError } from './util.js';
import { parseArgs } from 'node:util';

function tokenFromEnv() {
  return process.env.BUDDY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function usage() {
  console.error(`Engineer Buddy v0.1 — keyless AI engineering agent ($0/month)

Usage:
  engineer-buddy pr-review --repo OWNER/NAME --pr NUMBER [--dry-run] [--repo-dir PATH] [--config FILE]
  engineer-buddy doctor [--config FILE]
  engineer-buddy ask "prompt" [--config FILE]

Environment:
  GITHUB_TOKEN / BUDDY_GITHUB_TOKEN   GitHub token (auto-provided by Actions)
  BUDDY_GATEWAY_ORDER                 override gateway order (csv)
  BUDDY_DISABLE_GATEWAYS              disable gateways (csv)`);
}

async function cmdPrReview(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'repo-dir': { type: 'string' },
      config: { type: 'string' },
      debug: { type: 'boolean', default: false },
    },
  });
  if (!values.repo || !values.pr) {
    usage();
    return 2;
  }
  setVerbose(Boolean(values.debug));
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  const github = new GitHubClient({
    token: tokenFromEnv(),
    repo: values.repo,
    httpMs: cfg.timeouts.httpMs,
  });
  const repo = values['repo-dir'] ? new LocalRepo(values['repo-dir']) : null;

  try {
    const result = await runPrReview({
      repoSlug: values.repo,
      pr: Number.parseInt(values.pr, 10),
      github,
      router,
      repo,
      config: cfg,
      dryRun: Boolean(values['dry-run']),
    });
    if (result.skipped) console.log(JSON.stringify({ status: 'skipped', reason: result.reason }));
    else console.log(JSON.stringify({ status: 'ok', event: result.event, findings: result.review.findings.length, brain: `${result.meta.gateway}/${result.meta.model}` }));
    return 0;
  } catch (e) {
    // A review failure must never break the contributor's CI.
    warn(`review failed: ${e.message}`);
    try {
      if (!values['dry-run']) {
        await github.createComment(
          Number.parseInt(values.pr, 10),
          `## ⚠️ Engineer Buddy could not complete its review\n\n\`\`\`\n${truncate(e.message, 400)}\n\`\`\`\n\nAll keyless brain gateways were tried. A human review proceeds as normal — this is a non-blocking pre-filter. *(If this repeats, run the "Buddy Doctor" workflow to see gateway health.)*`
        );
        log('posted fallback failure notice');
      }
    } catch (e2) {
      warn(`could not post failure notice: ${e2.message}`);
    }
    console.log(JSON.stringify({ status: 'error', error: truncate(e.message, 300) }));
    return 0;
  }
}

async function cmdDoctor(argv) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' } } });
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  console.error(`Engineer Buddy doctor — probing ${router.order.length} keyless gateways…\n`);
  const rows = [];
  for (const name of router.order) {
    const t0 = Date.now();
    try {
      const gw = router.gateways.get(name);
      const out = await gw.chat([{ role: 'user', content: 'Reply with exactly: BUDDY_OK' }], { maxTokens: 20 });
      const ms = Date.now() - t0;
      const ok = out.text.toUpperCase().includes('BUDDY_OK');
      rows.push({ name, ok, ms, model: out.model, note: ok ? 'round-trip OK' : `unexpected reply: ${truncate(out.text, 60)}` });
    } catch (e) {
      rows.push({ name, ok: false, ms: Date.now() - t0, model: '-', note: truncate(e.message, 90) });
    }
  }
  console.error('\n┌────────────────┬───────┬────────┬──────────────────────────────────────────┐');
  console.error('│ gateway        │ alive │  time  │ model / note                             │');
  console.error('├────────────────┼───────┼────────┼──────────────────────────────────────────┤');
  for (const r of rows) {
    const name = r.name.padEnd(14).slice(0, 14);
    const alive = (r.ok ? '  ✅  ' : '  ❌  ').padEnd(7);
    const ms = `${(r.ms / 1000).toFixed(1)}s`.padStart(6);
    const note = `${r.model} ${r.note}`.replace(/\n/g, ' ').padEnd(40).slice(0, 40);
    console.error(`│ ${name} │${alive}│ ${ms} │ ${note} │`);
  }
  console.error('└────────────────┴───────┴────────┴──────────────────────────────────────────┘');
  const aliveCount = rows.filter((r) => r.ok).length;
  console.error(`\n${aliveCount}/${rows.length} gateways alive. Chain never fails while ≥1 is up.`);
  return aliveCount > 0 ? 0 : 1;
}

async function cmdAsk(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { config: { type: 'string' } }, allowPositionals: true });
  const q = positionals.join(' ');
  if (!q) {
    usage();
    return 2;
  }
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  const out = await router.chat([{ role: 'user', content: q }], { maxTokens: 1024 });
  console.log(out.text);
  console.error(`\n— ${out.gateway}/${out.model} in ${(out.latencyMs / 1000).toFixed(1)}s`);
  return 0;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    if (cmd === 'pr-review') process.exit(await cmdPrReview(argv));
    if (cmd === 'doctor') process.exit(await cmdDoctor(argv));
    if (cmd === 'ask') process.exit(await cmdAsk(argv));
    usage();
    process.exit(2);
  } catch (e) {
    warn(e instanceof BuddyError ? `${e.code}: ${e.message}` : e.stack || e.message);
    process.exit(e instanceof BuddyError && e.code === 'ALL_GATEWAYS_FAILED' ? 0 : 2);
  }
}

main();
