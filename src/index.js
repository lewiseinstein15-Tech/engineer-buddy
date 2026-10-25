#!/usr/bin/env node
// index.js — Engineer Buddy CLI.
//
// LOCAL (Buddy Code — like Claude Code, keyless brain):
//   engineer-buddy                    interactive session in this directory
//   engineer-buddy -p "task"          one-shot autonomous task (headless)
//   engineer-buddy init               scaffold the .buddy/harness surface
//
// GITHUB SKILLS (CI, keyless):
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
import { startRepl, runOneShot, VERSION } from './terminal/repl.js';
import { startMcpServer } from './mcpserver.js';
import { ensureHarness } from './harness/scaffold.js';
import { log, warn, setVerbose, truncate, BuddyError } from './util.js';
import { parseArgs } from 'node:util';
import path from 'node:path';

function tokenFromEnv() {
  return process.env.BUDDY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function usage() {
  console.error(`Engineer Buddy v${VERSION} — keyless AI engineering agent ($0/month)

Local coding agent (Buddy Code — like Claude Code, in your terminal):
  engineer-buddy                        interactive session in the current directory
  engineer-buddy -p "task"              one-shot autonomous task (add --safe to deny writes)
  engineer-buddy init                   scaffold .buddy/harness/ (systemprompt, guardrails,
                                        MEMORY.md, tool guidance, skills)

In the REPL: /help for commands · !cmd runs your own shell · #note saves to
project memory · Ctrl+C interrupts the running task (twice quits).

GitHub skills (CI):
  engineer-buddy pr-review     --repo OWNER/NAME --pr N [--dry-run] [--repo-dir PATH]
  engineer-buddy fix-issue     --repo OWNER/NAME --issue N [--dry-run] --repo-dir PATH
  engineer-buddy dep-audit     --repo OWNER/NAME [--dry-run] --repo-dir PATH
  engineer-buddy triage        --repo OWNER/NAME --issue N [--dry-run] [--repo-dir PATH]
  engineer-buddy release-notes --repo OWNER/NAME [--since TAG] [--dry-run] [--post-issue N]
  engineer-buddy doctor
  engineer-buddy ask "prompt"
  engineer-buddy mcp-serve [--allow-writes]   expose Buddy as an MCP stdio server

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

// ── Buddy Code (local interactive / one-shot) ────────────────────────────────

async function cmdChat(argv, { oneShot = false } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      p: { type: 'string' },
      safe: { type: 'boolean', default: false },
      yolo: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      config: { type: 'string' },
      dir: { type: 'string' },
    },
    allowPositionals: true,
  });
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  const root = values.dir ? path.resolve(values.dir) : process.cwd();

  if (oneShot || values.p) {
    const task = values.p || positionals.join(' ');
    if (!task) {
      usage();
      return 2;
    }
    const out = await runOneShot({ router, root, task, safe: Boolean(values.safe), yolo: Boolean(values.yolo), quiet: Boolean(values.quiet), config: cfg });
    if (!out.said) {
      console.error('buddy: no final reply (see events above)');
      return 1;
    }
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('buddy: interactive mode needs a real terminal (TTY).');
    console.error('       run `buddy` in your terminal, or use one-shot mode: buddy -p "task"');
    return 2;
  }
  return (await startRepl({ router, root, config: cfg, yolo: Boolean(values.yolo) })) ?? 0;
}

async function cmdInit(argv) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: 'string' } }, allowPositionals: true });
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const created = ensureHarness(root);
  if (created.length) {
    console.error(`Harness scaffolded in ${root}:`);
    for (const f of created) console.error(`  + ${f}`);
    console.error('\nEdit these markdown files to shape how Buddy works in this repo.');
  } else {
    console.error('Harness already present — nothing to do.');
  }
  return 0;
}

async function cmdMcpServe(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: 'string' }, 'allow-writes': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  startMcpServer(root, { writes: Boolean(values['allow-writes']), version: VERSION });
  console.error(`[buddy] MCP stdio server up — root ${root}, writes ${values['allow-writes'] ? 'ENABLED' : 'disabled (--allow-writes to enable)'}`);
  // The stdio loop owns the process until stdin closes (the parent agent's
  // transport closes the pipe when it shuts us down).
  return new Promise((resolve) => {
    const done = () => resolve(0);
    if (process.stdin.isTTY) {
      // No parent transport (someone ran it by hand) — idle forever is a
      // mistake; wait 3s then bail with a hint.
      setTimeout(() => {
        console.error('[buddy] no MCP transport on stdin (TTY) — run me from an MCP client, e.g. .buddy/mcp.json: {"command":"buddy","args":["mcp-serve"]}');
        resolve(2);
      }, 3000);
      return;
    }
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    if (cmd === undefined || cmd === 'chat') {
      await cmdChat(argv); // returns immediately by design — the REPL owns the process from here
      return 0;            // quitting happens in the REPL's own close handler ("bye" + exit 0)
    }
    if (cmd === '-p' || cmd === '--prompt' || cmd === 'run') process.exit(await cmdChat(argv, { oneShot: true }));
    if (cmd === 'init') process.exit(await cmdInit(argv));
    if (cmd === 'pr-review') process.exit(await cmdPrReview(argv));
    if (cmd === 'fix-issue') process.exit(await cmdFixIssue(argv));
    if (cmd === 'dep-audit') process.exit(await cmdDepAudit(argv));
    if (cmd === 'triage') process.exit(await cmdTriage(argv));
    if (cmd === 'release-notes') process.exit(await cmdReleaseNotes(argv));
    if (cmd === 'doctor') process.exit(await cmdDoctor(argv));
    if (cmd === 'ask') process.exit(await cmdAsk(argv));
    if (cmd === 'mcp-serve') process.exit(await cmdMcpServe(argv));
    usage();
    process.exit(2);
  } catch (e) {
    warn(e instanceof BuddyError ? `${e.code}: ${e.message}` : e.stack || e.message);
    process.exit(e instanceof BuddyError && e.code === 'ALL_GATEWAYS_FAILED' ? 0 : 2);
  }
}

// Surface async crashes loudly instead of letting the process die silently mid-session.
process.on('unhandledRejection', (e) => {
  console.error('[buddy] async error:', (e && (e.stack || e.message)) || e);
});

main();
