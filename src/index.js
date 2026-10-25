#!/usr/bin/env node
// index.js — Engineer Buddy CLI.
//
//   engineer-buddy pr-review     --repo O/R --pr N        autonomous PR review
//   engineer-buddy fix-issue     --repo O/R --issue N     issue → diagnosis → patch → tests → PR
//   engineer-buddy dep-audit     --repo O/R               npm audit → triage → tracking issue
//   engineer-buddy triage        --repo O/R --issue N     classify + label + first-response
//   engineer-buddy release-notes --repo O/R [--since TAG] draft notes from merged PRs
//   engineer-buddy doctor                                 probe every gateway
//   engineer-buddy ask "prompt"                           one-off brain query
//
// Exit codes: 0 = handled (success, skip, or graceful failure — the buddy is a
// non-blocking citizen and must never break CI), 2 = usage/config error.
import { loadConfig } from './config.js';
import { buildRouter } from './brain/index.js';
import { GitHubClient } from './tools/github.js';
import { LocalRepo } from './tools/repo.js';
import { runPrReview } from './skills/pr-reviewer.js';
import { runIssueFix } from './skills/issue-fixer.js';
import { runDepAudit } from './skills/dep-auditor.js';
import { runIssueTriage } from './skills/issue-triage.js';
import { runReleaseNotes } from './skills/release-notes.js';
import { log, warn, setVerbose, truncate, BuddyError } from './util.js';
import { parseArgs } from 'node:util';

function tokenFromEnv() {
  return process.env.BUDDY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function usage() {
  console.error(`Engineer Buddy v0.2 — keyless AI engineering agent ($0/month)

Usage:
  engineer-buddy pr-review     --repo OWNER/NAME --pr N [--dry-run] [--repo-dir PATH]
  engineer-buddy fix-issue     --repo OWNER/NAME --issue N [--dry-run] --repo-dir PATH
  engineer-buddy dep-audit     --repo OWNER/NAME [--dry-run] --repo-dir PATH
  engineer-buddy triage        --repo OWNER/NAME --issue N [--dry-run] [--repo-dir PATH]
  engineer-buddy release-notes --repo OWNER/NAME [--since TAG] [--dry-run] [--post-issue N]
  engineer-buddy doctor
  engineer-buddy ask "prompt"

Environment:
  GITHUB_TOKEN / BUDDY_GITHUB_TOKEN   GitHub token (auto-provided by Actions)
  BUDDY_GATEWAY_ORDER                 override gateway order (csv)
  BUDDY_DISABLE_GATEWAYS              disable gateways (csv)`);
}

function commonOpts(extra = {}) {
  return {
    repo: { type: 'string' },
    config: { type: 'string' },
    debug: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'repo-dir': { type: 'string' },
    ...extra,
  };
}

function setup(values) {
  setVerbose(Boolean(values.debug));
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  const github = new GitHubClient({ token: tokenFromEnv(), repo: values.repo, httpMs: cfg.timeouts.httpMs });
  const repo = values['repo-dir'] ? new LocalRepo(values['repo-dir']) : null;
  return { cfg, router, github, repo };
}

/** Wrap a skill run: every failure ends as a graceful comment, exit 0. */
async function graceful(values, { issueNumber = null, prNumber = null, kind = 'task', run }) {
  const { cfg, router, github, repo } = setup(values);
  try {
    const result = await run({ cfg, router, github, repo });
    console.log(JSON.stringify({ status: 'ok', ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.skipped ? { skipped: true, reason: result.reason } : {}) }));
    return 0;
  } catch (e) {
    warn(`${kind} failed: ${e.message}`);
    const target = issueNumber ?? prNumber;
    if (target && !values['dry-run']) {
      try {
        await github.createComment(
          target,
          `## ⚠️ Engineer Buddy could not complete this ${kind}\n\n\`\`\`\n${truncate(e.message, 500)}\n\`\`\`\n\nAll keyless brain gateways were tried. Nothing was changed in the repository. *(Recurring? Run the "Buddy Doctor" workflow to check gateway health.)*`
        );
      } catch (e2) {
        warn(`could not post failure notice: ${e2.message}`);
      }
    }
    console.log(JSON.stringify({ status: 'error', error: truncate(e.message, 300) }));
    return 0;
  }
}

async function cmdPrReview(argv) {
  const { values } = parseArgs({ args: argv, options: commonOpts({ pr: { type: 'string' } }), allowPositionals: true });
  if (!values.repo || !values.pr) {
    usage();
    return 2;
  }
  return graceful(values, {
    kind: 'review',
    prNumber: Number.parseInt(values.pr, 10),
    run: ({ cfg, router, github, repo }) =>
      runPrReview({ repoSlug: values.repo, pr: Number.parseInt(values.pr, 10), github, router, repo, config: cfg, dryRun: Boolean(values['dry-run']) }),
  });
}

async function cmdFixIssue(argv) {
  const { values } = parseArgs({ args: argv, options: commonOpts({ issue: { type: 'string' } }), allowPositionals: true });
  if (!values.repo || !values.issue || !values['repo-dir']) {
    usage();
    return 2;
  }
  return graceful(values, {
    kind: 'fix',
    issueNumber: Number.parseInt(values.issue, 10),
    run: ({ cfg, router, github, repo }) =>
      runIssueFix({ repoSlug: values.repo, issue: Number.parseInt(values.issue, 10), github, router, repoDir: repo, config: cfg, dryRun: Boolean(values['dry-run']) }),
  });
}

async function cmdDepAudit(argv) {
  const { values } = parseArgs({ args: argv, options: commonOpts(), allowPositionals: true });
  if (!values.repo || !values['repo-dir']) {
    usage();
    return 2;
  }
  return graceful(values, {
    kind: 'dependency audit',
    run: ({ cfg, router, github, repo }) => runDepAudit({ repoSlug: values.repo, github, router, repoDir: repo, config: cfg, dryRun: Boolean(values['dry-run']) }),
  });
}

async function cmdTriage(argv) {
  const { values } = parseArgs({ args: argv, options: commonOpts({ issue: { type: 'string' } }), allowPositionals: true });
  if (!values.repo || !values.issue) {
    usage();
    return 2;
  }
  return graceful(values, {
    kind: 'triage',
    issueNumber: Number.parseInt(values.issue, 10),
    run: ({ cfg, router, github, repo }) =>
      runIssueTriage({ repoSlug: values.repo, issue: Number.parseInt(values.issue, 10), github, router, repo, config: cfg, dryRun: Boolean(values['dry-run']) }),
  });
}

async function cmdReleaseNotes(argv) {
  const { values } = parseArgs({ args: argv, options: commonOpts({ since: { type: 'string' }, 'post-issue': { type: 'string' } }), allowPositionals: true });
  if (!values.repo) {
    usage();
    return 2;
  }
  return graceful(values, {
    kind: 'release notes',
    issueNumber: values['post-issue'] ? Number.parseInt(values['post-issue'], 10) : null,
    run: ({ cfg, router, github }) =>
      runReleaseNotes({
        repoSlug: values.repo,
        github,
        router,
        since: values.since || null,
        config: cfg,
        dryRun: Boolean(values['dry-run']),
        postToIssue: values['post-issue'] ? Number.parseInt(values['post-issue'], 10) : null,
      }),
  });
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
    if (cmd === 'fix-issue') process.exit(await cmdFixIssue(argv));
    if (cmd === 'dep-audit') process.exit(await cmdDepAudit(argv));
    if (cmd === 'triage') process.exit(await cmdTriage(argv));
    if (cmd === 'release-notes') process.exit(await cmdReleaseNotes(argv));
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
