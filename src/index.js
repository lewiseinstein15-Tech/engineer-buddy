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
import { cmdUpdate } from './update.js';
import { latestSession, findSession } from './session.js';
import { importSession } from './session.js';
import { startMcpServer } from './mcpserver.js';
import { ensureHarness } from './harness/scaffold.js';
import { createWorktree, worktreeSlug } from './tools/worktree.js';
import { log, warn, setVerbose, truncate, BuddyError } from './util.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

function tokenFromEnv() {
  return process.env.BUDDY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function usage() {
  console.error(`Engineer Buddy v${VERSION} — keyless AI engineering agent ($0/month)

Local coding agent (Buddy Code — like Claude Code, in your terminal):
  engineer-buddy                        interactive session in the current directory
  engineer-buddy -p "task"              one-shot autonomous task (add --safe to deny writes)
  engineer-buddy --worktree             isolate the run in its own git worktree
                                        (.buddy/worktrees/<slug>, branch buddy/<slug> —
                                        your dirty tree stays untouched; the tree is kept
                                        after exit, the note prints the removal command)
  echo "task" | engineer-buddy -p       pipe the task in on stdin
  engineer-buddy -p "task" -o json      machine-readable output (text | json | stream-json)
  engineer-buddy -c                     continue the newest session in this directory
  engineer-buddy -r <name>              resume a named session (see /rename)
  engineer-buddy --replay [name]        replay a saved session step-by-step, paced from its
                                        own timestamps (space pause · n next · [ ] speed · q quit;
                                        newest session when no name is given)
  engineer-buddy --retrace [name]       time-travel: rebuild a session's file timeline
                                        deterministically (dry run) — --from N --until M
                                        --swap K --set '<json>' swap ONE step's args,
                                        --apply writes the what-if state (checkpoints first)
  engineer-buddy init                   scaffold .buddy/harness/ (systemprompt, guardrails,
                                        MEMORY.md, tool guidance, skills)
  engineer-buddy update [--check]       self-update from the latest git tag
                                        (--check reports only; --force overrides dirty-tree refusal)

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
  engineer-buddy benchmark [--dim a,b] [--fast] [--list]   run THE CONTRACT's seven
                                        dimensions as real scored exercises with
                                        evidence artifacts (.buddy/benchmark/); live
                                        dimensions degrade to honest SKIP offline
  engineer-buddy goals [list|add|enable|disable|remove|run|history|next]
                                        (alias: goal) objectives that wake on a
                                        schedule (.buddy/goals/); schedules:
                                        --every <minutes> | --cron "min hour dom
                                        mon dow" (UTC) | --at "YYYY-MM-DD HH:MM"
                                        (one-shot); 'goals run' is a TICK — the
                                        wake is external (OS cron, Actions cron);
                                        store + history + artifacts record every
                                        run; --dry provably calls no runner; HELD
                                        junk is reported, never scheduled
  engineer-buddy channel [list|add|remove|serve|drain|status]
                                        (alias: channels) push external events
                                        into a live session: webhook → inbox →
                                        next-turn message (.buddy/channels/);
                                        token lives in the ENV, referenced by
                                        name; receiver is LOOPBACK-ONLY with a
                                        per-channel rate limit; one receiver at
                                        a time (serve lock); 'channel drain'
                                        consumes the inbox headless
  engineer-buddy lessons [query...]
                                        (alias: lesson) cross-session lessons:
                                        no query = index stats (entries, torn,
                                        vocabulary); with a query = ranked TOPIC
                                        recall from .buddy/experience — idf-damped,
                                        cue-weighted, threshold 0.35; the same
                                        engine the live session auto-recalls with
                                        (--task "..." | positional words, --max N)
  engineer-buddy telemetry [view|export|reset]
                                        (alias: metrics) opt-in metrics export:
                                        the all-time view over .buddy/events.jsonl
                                        (turns, tokens, tool counts, durations);
                                        'export' lands one DELTA window in
                                        .buddy/telemetry/metrics.jsonl and — when
                                        chat.telemetry.endpoint is set — POSTs a
                                        zero-dep OTLP/HTTP-JSON payload to your
                                        collector (token by env NAME via
                                        headersEnv; --dry-run writes nothing);
                                        auto-flush at turn boundaries rides
                                        chat.telemetry.enabled (default FALSE)
  engineer-buddy notebook [read|insert|replace|delete|move|clear]
                                        (alias: nb) edit a Jupyter notebook
                                        (.ipynb) by cell: 'read' lists the cell
                                        map (indices, types, outputs); the
                                        mutations take -f/--file, 0-based
                                        --index/--after/--to, --type
                                        code|markdown, --source/--source-file/
                                        --stdin, --expect (stale-cell guard),
                                        --clear-outputs, --all. Broken or
                                        oversized notebooks are REFUSED, not
                                        repaired by guesswork; writes are
                                        atomic (tmp+rename)
  engineer-buddy voice [status|record|transcribe|list]
                                        keyless speech-to-text (§11): 'status'
                                        shows the probed recorders + endpoint;
                                        'record' captures a wav via the
                                        machine's own recorder (arecord/rec/
                                        parecord/ffmpeg, bounded); 'transcribe'
                                        POSTs a RIFF WAV to the KEYLESS STT
                                        endpoint (voice.stt.endpoint in
                                        .buddy/settings.json — a local
                                        whisper.cpp or OpenAI-compatible
                                        server; NO credentials field exists,
                                        voice is keyless by contract); 'list'
                                        shows kept dictation audio. Broken or
                                        oversized wavs are REFUSED before any
                                        byte goes on the wire
  engineer-buddy mcp-serve [--allow-writes]   expose Buddy as an MCP stdio server
  engineer-buddy import <session.jsonl>       restore a shared session (then -r <name>)

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
      record: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      config: { type: 'string' },
      dir: { type: 'string' },
      worktree: { type: 'boolean', default: false },
      replay: { type: 'boolean', default: false },
      retrace: { type: 'boolean', default: false },
      from: { type: 'string' },
      until: { type: 'string' },
      swap: { type: 'string' },
      set: { type: 'string' },
      apply: { type: 'boolean', default: false },
      c: { type: 'boolean', default: false },
      continue: { type: 'boolean', default: false },
      r: { type: 'string' },
      resume: { type: 'string' },
      o: { type: 'string' },
      'output-format': { type: 'string' },
    },
    allowPositionals: true,
  });
  const cfg = loadConfig({ file: values.config });
  const router = buildRouter(cfg);
  let root = values.dir ? path.resolve(values.dir) : process.cwd();

  // --replay (v0.37.0): watch a saved session step-by-step. Read-only — the
  // JSONL is never touched — so it runs BEFORE worktree isolation (a replay
  // wants the sessions of the directory you are IN, not a fresh checkout).
  if (values.replay) {
    const needle = positionals[0] || null;
    const file = needle ? findSession(root, needle) : latestSession(root);
    if (!file) {
      console.error(`buddy: nothing to replay — ${needle ? `no session matches "${needle}"` : 'no saved sessions'} in ${root}`);
      return 2;
    }
    const { playReplay } = await import('./terminal/replay.js');
    const out = await playReplay({ file });
    if (!out.ok) console.error(`buddy: replay failed — ${out.error}`);
    return out.ok ? 0 : 2;
  }

  // --retrace (v0.40.0): time-travel debugging — rebuild a saved session's
  // file timeline deterministically, optionally swapping ONE step's args.
  // Dry run by default; --apply writes the what-if state (checkpoints first).
  if (values.retrace) {
    const needle = positionals[0] || null;
    const file = needle ? findSession(root, needle) : latestSession(root);
    if (!file) {
      console.error(`buddy: nothing to retrace — ${needle ? `no session matches "${needle}"` : 'no saved sessions'} in ${root}`);
      return 2;
    }
    const { runRetrace } = await import('./tools/timetravel.js');
    let set = null;
    if (values.set) {
      try { set = JSON.parse(values.set); } catch {
        console.error('buddy: --set must be a JSON object, e.g. --set \'{"find":"draft","replace":"what-if"}\'');
        return 2;
      }
    }
    const out = runRetrace({
      root,
      file,
      from: Number(values.from) || 1,
      until: values.until ? Number(values.until) : null,
      swap: values.swap != null ? Number(values.swap) : null,
      set,
      apply: Boolean(values.apply),
    });
    console.log(out.report);
    return out.ok ? 0 : 2;
  }

  // --retrace (v0.40.0): time-travel debugging — rebuild a saved session's
  // file timeline deterministically, optionally swapping ONE step's args.
  // Dry run by default; --apply writes the what-if state (checkpoints first).
  if (values.retrace) {
    const needle = positionals[0] || null;
    const file = needle ? findSession(root, needle) : latestSession(root);
    if (!file) {
      console.error(`buddy: nothing to retrace — ${needle ? `no session matches "${needle}"` : 'no saved sessions'} in ${root}`);
      return 2;
    }
    const { runRetrace } = await import('./tools/timetravel.js');
    let set = null;
    if (values.set) {
      try { set = JSON.parse(values.set); } catch {
        console.error('buddy: --set must be a JSON object, e.g. --set \'{"find":"draft","replace":"what-if"}\'');
        return 2;
      }
    }
    const out = runRetrace({
      root,
      file,
      from: Number(values.from) || 1,
      until: values.until ? Number(values.until) : null,
      swap: values.swap != null ? Number(values.swap) : null,
      set,
      apply: Boolean(values.apply),
    });
    console.log(out.report);
    return out.ok ? 0 : 2;
  }

  // --worktree (v0.36.0): isolate this run in its own git worktree — a fresh
  // checkout of HEAD on a buddy/<slug> branch under .buddy/worktrees/. The
  // user's dirty tree stays theirs; the run's edits, stages, and commits land
  // in the worktree, and the diff between the two is plain git. The tree
  // OUTLIVES the run on purpose (it may hold unmerged work) — the exit note
  // prints the exact removal command.
  let worktreeNote = null;
  if (values.worktree) {
    const wt = createWorktree(root, { slug: worktreeSlug(new Date()) });
    if (wt.ok) {
      console.error(`[buddy] --worktree: isolated in ${wt.path}`);
      console.error(`[buddy]           branch ${wt.branch} (fresh checkout of HEAD — your dirty tree is untouched)`);
      worktreeNote = wt;
      root = wt.path;
    } else {
      console.error(`[buddy] --worktree failed, continuing in ${root}: ${wt.error}`);
    }
  }

  // Session continuity: -c continues the newest session here; -r <name>
  // resumes a named one (exact name → suffix → substring).
  const resumeNeedle = values.r ?? values.resume;
  let resumeFile = null;
  if (resumeNeedle) {
    resumeFile = findSession(root, resumeNeedle);
    if (!resumeFile) {
      console.error(`buddy: no session matches "${resumeNeedle}" in ${root} — /sessions lists what exists`);
      return 2;
    }
  } else if (values.c || values.continue) {
    resumeFile = latestSession(root);
    if (!resumeFile) {
      console.error(`buddy: nothing to continue — no sessions in ${root}`);
      return 2;
    }
    console.error(`[buddy] continuing: ${path.basename(resumeFile)}`);
  }

  const fmt = (values.o || values['output-format'] || 'text').toLowerCase();
  if (!['text', 'json', 'stream-json'].includes(fmt)) {
    console.error(`buddy: --output-format must be text | json | stream-json (got "${fmt}")`);
    return 2;
  }

  if (oneShot || values.p || !process.stdin.isTTY) {
    let task = values.p || positionals.join(' ');
    // stdin pipe support: echo "task" | buddy -p  ·  cat task.md | buddy -p
    if (!task && !process.stdin.isTTY) {
      try {
        task = fs.readFileSync(0, 'utf8').trim();
      } catch {
        task = '';
      }
    }
    if (!task) {
      usage();
      return 2;
    }
    const out = await runOneShot({
      router,
      root,
      task,
      safe: Boolean(values.safe),
      yolo: Boolean(values.yolo),
      quiet: Boolean(values.quiet),
      config: cfg,
      outputFormat: fmt,
      resumeFrom: resumeFile,
    });
    // v0.36.0 review catch: the kept-note used to print only on the
    // interactive path (via the onExit hook) — a --worktree one-shot run
    // returned without ever naming the kept tree or its removal command.
    if (worktreeNote) printWorktreeNote(worktreeNote);
    if (!out.said) {
      if (fmt !== 'json' && fmt !== 'stream-json') console.error('buddy: no final reply (see events above)');
      return 1;
    }
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('buddy: interactive mode needs a real terminal (TTY).');
    console.error('       run `buddy` in your terminal, or use one-shot mode: buddy -p "task"');
    return 2;
  }
  // v0.36.0 drill catch: the REPL owns the process — every interactive exit
  // funnels through its close handler's process.exit(0), so code AFTER
  // startRepl is dead. The worktree kept-note rides the onExit hook instead
  // (called by the close handler before the exit, still inside the terminal).
  const exitNote = worktreeNote ? () => printWorktreeNote(worktreeNote) : null;
  const exitCode = (await startRepl({ router, root, config: cfg, yolo: Boolean(values.yolo), resumeFrom: resumeFile, record: values.record || null, onExit: exitNote })) ?? 0;
  return exitCode;
}

/** The --worktree kept-note: where the tree lives and exactly how to remove it. */
function printWorktreeNote(wt) {
  console.error(`\n[buddy] worktree kept: ${wt.path} (branch ${wt.branch})`);
  console.error(`[buddy]   review: git -C "${wt.path}" diff HEAD   ·   remove: git worktree remove "${wt.path}"`);
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

async function cmdImport(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { dir: { type: 'string' } }, allowPositionals: true });
  const src = positionals[0];
  if (!src) {
    console.error('usage: buddy import <session.jsonl> — restores a shared session into .buddy/sessions/ (then buddy -r <name>)');
    return 2;
  }
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  try {
    const r = importSession(root, src);
    console.error(`imported ${r.events} events → ${r.target}${r.renamed ? ' (name conflict — stamped copy)' : ''}`);
    console.error(`resume it:  buddy -r ${path.basename(r.target, '.jsonl')}`);
    return 0;
  } catch (e) {
    console.error(`buddy: import failed — ${e.message}`);
    return 2;
  }
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
}/** `buddy benchmark` — THE CONTRACT, demonstrated on demand (v0.45.0). */
async function cmdBenchmark(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      dim: { type: 'string' },
      fast: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const { DIMENSIONS, parseDimList, runBenchmark, scorecardText } = await import('./benchmark.js');
  if (values.list) {
    console.error('buddy benchmark — THE CONTRACT (seven dimensions):\n');
    for (const d of DIMENSIONS) {
      console.error(`  ${d.title.padEnd(14)} ${d.kind.padEnd(10)} ${d.rubric}`);
    }
    console.error('\nusage: buddy benchmark [--dim research,reason,...] [--fast] — live dimensions need a reachable keyless brain; they SKIP honestly otherwise.');
    return 0;
  }
  const sel = parseDimList(values.dim);
  if (sel.error) {
    console.error(`buddy: ${sel.error}`);
    return 2;
  }
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  let out;
  try {
    out = await runBenchmark({ root, dims: sel.dims, fast: Boolean(values.fast), config: values.config || null });
  } catch (e) {
    console.error(`buddy: benchmark failed honestly — ${e?.message || e}`);
    return 2;
  }
  console.error('\n' + scorecardText(out.results, { passed: out.passed, failed: out.failed, skipped: out.skipped, score: out.score, benchDir: out.benchDir, fast: Boolean(values.fast), brain: out.brain }));
  if (out.failed > 0) return 2;
  if (out.passed === 0) return 1; // nothing scored (all skipped) — honest, but not a pass
  return 0;
}

/** `buddy telemetry` (v0.53.0) — opt-in metrics export (§11): the all-time
 *  view, one cursor-based DELTA export (JSONL sink + optional OTLP/HTTP JSON
 *  collector wire), and the explicit cursor reset. The engine is telemetry.js. */
async function cmdTelemetry(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const T = await import('./telemetry.js');
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const sub = String(positionals[0] ?? 'view').toLowerCase();
  try {
    if (sub === 'view' || sub === 'status') {
      console.error('\n' + T.telemetryViewText(root) + '\n');
      return 0;
    }
    if (sub === 'export') {
      // the engine never touches process.env (testable + the secret stays
      // out of the engine) — the CLI resolves headersEnv here, the ONE place
      const { config: tcfg, problems: tcfgProblems } = T.readTelemetryConfig(root);
      // BROKEN CONFIG IS A REFUSAL, not a degradation (the goals/channels
      // precedent: junk is HELD honestly — an export with a refused knob
      // must not silently run as JSONL-only while the operator believes the
      // wire is configured)
      if (tcfgProblems.length) {
        console.error('buddy: telemetry export refused — the chat.telemetry config has problems:');
        for (const p of tcfgProblems) console.error(`  - ${p}`);
        console.error('fix .buddy/settings.json (or ~/.buddy/settings.json) and re-run; nothing was exported.');
        return 2;
      }
      const token = tcfg?.headersEnv ? process.env[tcfg.headersEnv] : undefined;
      const r = await T.exportTelemetry(root, { dryRun: Boolean(values['dry-run']), token });
      if (r.dryRun) {
        console.error(`dry run — nothing was written (no sink line, no cursor move, no POST):`);
        console.error(`  would export : ${r.events.read} event(s) (${r.events.torn} torn counted, ${r.events.giants} giant discarded) since byte ${r.cursor.before}`);
        console.error(`  would count  : turns ${r.metrics.turns} · calls ${r.metrics.calls} · ~${r.metrics.tokIn} tok in · ~${r.metrics.tokOut} out · tools ${Object.keys(r.metrics.byTool).length} distinct · denied ${r.metrics.denied}`);
        console.error(`  would sink   : ${r.sink === null ? '.buddy/telemetry/metrics.jsonl (one DELTA record)' : r.sink}`);
        console.error(`  would post   : ${r.otlp.wouldPost ? r.problems.length ? 'endpoint configured — see problems' : 'endpoint configured' : 'nothing (no endpoint configured — JSONL sink only)'}`);
        for (const p of r.problems) console.error(`  problem: ${p}`);
        return 0;
      }
      if (!r.ok) {
        console.error(`buddy: telemetry export failed honestly — ${(r.problems[r.problems.length - 1] || 'unknown reason')}`);
        return 2;
      }
      if (r.note) { console.error(r.note); return 0; }
      console.error(`exported one DELTA window (${r.window.bytes} bytes): turns ${r.metrics.turns} · calls ${r.metrics.calls} · ~${r.metrics.tokIn} in / ~${r.metrics.tokOut} out · tools ${Object.keys(r.metrics.byTool).length} distinct (denied ${r.metrics.denied})`);
      console.error(`  sink  : ${r.sink}`);
      console.error(`  cursor: ${r.cursor.before} → ${r.cursor.after}${r.reset ? ' (reset — the events log shrank below the old cursor)' : ''}`);
      if (r.events.torn) console.error(`  torn  : ${r.events.torn} corpse line(s) counted, never guessed`);
      if (r.otlp.attempted) console.error(`  otlp  : ${r.otlp.sent ? `sent — collector answered ${r.otlp.status}` : `NOT sent — ${r.otlp.reason}`}`);
      else if (r.otlp.reason) console.error(`  otlp  : not attempted — ${r.otlp.reason}`);
      for (const p of r.problems) console.error(`  problem: ${p}`);
      return 0;
    }
    if (sub === 'reset') {
      if (!values.yes) {
        console.error('refusing to reset the export cursor without --yes — a reset SKIPS the log history (the events log itself is never touched).');
        console.error('usage: buddy telemetry reset --yes   (cursor → end of log; future exports start from now)');
        return 2;
      }
      const target = T.resetCursorToEnd(root);
      console.error(`cursor reset to ${target} — the next export starts from now (history is skipped, not deleted)`);
      return 0;
    }
    console.error(`buddy: unknown telemetry subcommand "${sub}" — known: view | export | reset`);
    return 2;
  } catch (e) {
    console.error(`buddy: telemetry failed honestly — ${e?.message || e}`);
    return 2;
  }
}

/** `buddy notebook` (v0.54.0) — Jupyter notebook (.ipynb) cell editing (§11):
 *  read the cell map, then insert/replace/delete/move/clear_outputs. The
 *  engine is notebook.js; indices are 0-based and canonical-or-refused;
 *  broken notebooks are refused, never repaired by guesswork; writes are
 *  atomic (tmp+rename). Refusals exit 2 with the reason on stderr. */
async function cmdNotebook(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string', short: 'f' },
      index: { type: 'string' },
      after: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string' },
      source: { type: 'string' },
      'source-file': { type: 'string' },
      stdin: { type: 'boolean' },
      expect: { type: 'string' },
      'clear-outputs': { type: 'boolean' },
      all: { type: 'boolean' },
      dir: { type: 'string' },
    },
    allowPositionals: true,
  });
  const NB = await import('./notebook.js');
  const sub = String(positionals[0] ?? '').toLowerCase();
  try {
    if (!['read', 'insert', 'replace', 'delete', 'move', 'clear'].includes(sub)) {
      console.error(`buddy: unknown notebook subcommand "${sub || '(none)'}" — known: read | insert | replace | delete | move | clear`);
      console.error('  every subcommand takes -f/--file <path.ipynb>; indices are 0-based.');
      return 2;
    }
    const rel = values.file;
    if (!rel || String(rel).includes('..')) {
      console.error('buddy: notebook needs -f/--file <path.ipynb> (no ".." segments)');
      return 2;
    }
    if (!NB.isNotebookPath(rel)) {
      console.error(`buddy: "${rel}" is not a .ipynb — this command edits notebook cells only`);
      return 2;
    }
    const abs = path.resolve(values.dir ? path.resolve(values.dir) : process.cwd(), rel);
    if (sub === 'read') {
      console.error('\n' + NB.notebookReadText(abs) + '\n');
      return 0;
    }
    const op = sub === 'clear' ? 'clear_outputs' : sub;
    const args = {};
    if (values.index != null) args.index = values.index;
    if (values.after != null) args.after = values.after;
    if (values.to != null) args.to = values.to;
    if (values.type != null) args.cellType = values.type;
    if (values.expect != null) args.expect = values.expect;
    if (values['clear-outputs']) args.clearOutputs = true;
    if (values.all) args.all = true;
    if (sub === 'insert' || sub === 'replace') {
      if (values.source != null) args.source = values.source;
      else if (values['source-file']) args.source = fs.readFileSync(path.resolve(values['source-file']), 'utf8');
      else if (values.stdin) args.source = fs.readFileSync(0, 'utf8');
      if (typeof args.source !== 'string' || args.source === '') {
        console.error('buddy: insert/replace needs --source "text", --source-file <path>, or --stdin');
        return 2;
      }
    }
    const r = NB.nbEdit(abs, op, args);
    const bits = [`OK ${r.op}`, r.index != null ? `cell [${r.index}]` : '', r.to != null ? `→ [${r.to}]` : '', r.cellType || '', `${r.cellsBefore}→${r.cellsAfter} cells`, `${r.bytesBefore}→${r.bytesAfter} bytes`].filter(Boolean);
    console.error(bits.join(' '));
    if (r.outputs) console.error(`  outputs: ${r.outputs}`);
    if (r.moved === false) console.error('  (to === index — nothing moved, nothing written)');
    for (const w of r.warnings || []) console.error(`  warning: ${w}`);
    return 0;
  } catch (e) {
    console.error(`buddy: notebook ${sub} refused — ${e?.message || e}`);
    return 2;
  }
}

/** `buddy voice` (v0.55.0) — keyless speech-to-text (§11): status / record /
 *  transcribe / list. The engine is voice.js. Broken or oversized wavs are
 *  refused with the parser's own position BEFORE any byte goes on the wire;
 *  the endpoint contract is keyless (no credentials field exists to set);
 *  refusals exit 2 with the reason on stderr. */
async function cmdVoice(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string', short: 'f' },
      out: { type: 'string' },
      secs: { type: 'string' },
      dir: { type: 'string' },
    },
    allowPositionals: true,
  });
  const V = await import('./voice.js');
  const { loadSettingsView } = await import('./settings.js');
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const sub = String(positionals[0] ?? 'status').toLowerCase();
  try {
    if (!['status', 'record', 'transcribe', 'list'].includes(sub)) {
      console.error(`buddy: unknown voice subcommand "${sub || '(none)'}" — known: status | record | transcribe | list`);
      return 2;
    }
    const { cfg, problems } = V.readVoiceConfig(loadSettingsView(root));
    if (sub === 'status') {
      console.error('\n' + V.voiceStatusText(root, { settingsView: loadSettingsView(root) }) + '\n');
      return 0;
    }
    if (problems.length) {
      console.error(`buddy: voice config has problems — fix .buddy/settings.json before using voice:`);
      for (const p of problems) console.error(`  - ${p}`);
      return 2;
    }
    if (sub === 'list') {
      const dir = V.voiceDirPath(root);
      let entries = [];
      try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')); } catch { /* absent — normal */ }
      if (!entries.length) {
        console.error(`\nno kept audio in ${dir} — dictation wavs are deleted after transcription unless voice.record.keepAudio is true\n`);
        return 0;
      }
      console.error(`\nkept audio (${dir}):`);
      for (const f of entries) {
        const st = fs.statSync(path.join(dir, f));
        console.error(`  ${f}  ${st.size} bytes  ${st.mtime.toISOString()}`);
      }
      console.error('');
      return 0;
    }
    if (sub === 'record') {
      const dir = V.voiceDirPath(root);
      fs.mkdirSync(dir, { recursive: true });
      const name = values.out && !String(values.out).includes('..')
        ? (String(values.out).endsWith('.wav') ? String(values.out) : `${String(values.out)}.wav`)
        : `dictation-${Date.now()}.wav`;
      const abs = path.isAbsolute(name) ? name : path.join(dir, name);
      const secs = values.secs ?? cfg.maxSeconds;
      const r = await V.recordAudio({ outPath: abs, seconds: secs, eventsRoot: root });
      console.error(`OK record · ${r.recorder} · ${r.audio.sampleRate}Hz ${r.audio.channels}ch · ${r.audio.durationSec}s · ${r.bytes} bytes · ${r.ms}ms`);
      console.error(`  saved: ${abs}`);
      console.error(`  next : buddy voice transcribe -f ${abs}`);
      return 0;
    }
    // transcribe
    const rel = values.file;
    if (!rel || String(rel).trim() === '') {
      console.error('buddy: transcribe needs -f/--file <path.wav>');
      return 2;
    }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(values.dir ? path.resolve(values.dir) : process.cwd(), rel);
    const r = await V.transcribeWav({ abs, cfg, eventsRoot: root });
    console.error(V.transcribeReceiptText(r));
    return 0;
  } catch (e) {
    console.error(`buddy: voice ${sub} refused — ${e?.message || e}`);
    return 2;
  }
}

/** `buddy lessons` (v0.52.0) — cross-session lessons: index stats, or ranked
 *  topic recall for a query. The same recall engine the live session rides. */
async function cmdLessons(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        task: { type: 'string' },
        max: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch {
    // RED TEAM v0.52 fix: a dash-leading literal query (`buddy lessons -999`)
    // is a QUERY, not an option cluster — parseArgs refused it with a generic
    // exit 2. Scan the three known flags by hand; everything else is query.
    values = {};
    positionals = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if ((a === '--dir' || a === '--task' || a === '--max') && i + 1 < argv.length) {
        values[a.slice(2)] = argv[++i];
        continue;
      }
      positionals.push(a);
    }
  }
  const L = await import('./lessons.js');
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const query = values.task ?? (positionals.length ? positionals.join(' ') : null);
  // canonical-only knob (the v0.50/v0.51 lesson): pure digits or default —
  // '5\n' or 'abc' never becomes 5-by-coincidence.
  const max = /^\d+$/.test(String(values.max ?? '')) ? Math.max(1, Math.min(20, parseInt(values.max, 10))) : 5;
  if (query) console.log('\n' + L.lessonsRecallText(root, query, { max }) + '\n');
  else console.log('\n' + L.lessonsIndexText(root) + '\n');
  return 0;
}

async function cmdChannel(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      'token-env': { type: 'string' },
      path: { type: 'string' },
      'max-per-minute': { type: 'string' },
      'max-bytes': { type: 'string' },
      port: { type: 'string' },
      limit: { type: 'string' },
      host: { type: 'string' },
    },
    allowPositionals: true,
  });
  const C = await import('./channels.js');
  const line = (s, n = 60) => C.oneLine(s, n);
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const sub = String(positionals[0] ?? 'list').toLowerCase();
  try {
    if (sub === 'list' || sub === 'ls') {
      const l = C.loadChannels(root);
      console.error('\n' + C.channelsTableText(l.channels, l.problems) + '\n');
      return 0;
    }
    if (sub === 'add') {
      const name = positionals[1];
      if (!name) { console.error('usage: buddy channel add <name> --token-env NAME [--path /hook/x] [--max-per-minute N] [--max-bytes N]'); return 2; }
      const { channel } = C.addChannel(root, {
        name,
        tokenEnv: values['token-env'],
        hookPath: values.path,
        maxPerMinute: values['max-per-minute'],
        maxBytes: values['max-bytes'],
      });
      console.error(`channel added: ${channel.name} — POST ${channel.path}`);
      console.error(`  token: $${channel.tokenEnv} (the VALUE lives in the environment, never in config) · rate ${channel.maxPerMinute}/min · ≤${channel.maxBytes}B`);
      console.error('  receive: buddy channel serve --port 7788   drain: buddy channel drain');
      return 0;
    }
    if (sub === 'remove' || sub === 'rm') {
      const { channel } = C.removeChannel(root, positionals[1]);
      console.error(`channel removed: ${channel.name} — POST ${channel.path} is no longer served`);
      return 0;
    }
    if (sub === 'status') {
      console.error('\n' + C.statusText(root) + '\n');
      return 0;
    }
    if (sub === 'drain') {
      const out = C.drainInbox(root, { limit: values.limit });
      if (out.reset) console.error('! the inbox shrank below the cursor (rotated or truncated) — the drain reset to zero and says so');
      if (out.torn) console.error(`! ${out.torn} torn trailing line skipped (a receiver died mid-write) — it cannot block the cursor`);
      if (!out.events.length) {
        console.error(out.skipped ? `0 new events (${out.skipped} junk line(s) skipped honestly)` : '0 new events — the inbox is drained');
        return 0;
      }
      for (const e of out.events) {
        console.error(`${String(e.at ?? '').replace('T', ' ').slice(0, 19)}  ${line(e.channel, 16).padEnd(17)} ${e.id ?? '(no id)'}`);
        console.error(`  ${line(e.text, 200)}`);
        const mk = Object.keys(e.meta ?? {});
        if (mk.length) console.error(`  meta: ${mk.map((k) => `${k}=${line(e.meta[k], 40)}`).join(' ')}`);
      }
      if (out.skipped) console.error(`(${out.skipped} junk line(s) skipped honestly)`);
      console.error(`cursor advanced — ${out.events.length} event(s) consumed`);
      return 0;
    }
    if (sub === 'serve') {
      const host = C.assertLoopbackHost(values.host ?? '127.0.0.1');
      const port = Number(values.port ?? 7788);
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`invalid --port "${line(values.port, 20)}" — expected 0..65535`); return 2; }
      const lock = C.acquireServeLock(root);
      if (lock.busy) {
        console.error(`! a receiver already holds ${C.lockPath(root)} (pid ${lock.info?.pid ?? '?'}, since ${lock.info?.at ?? '?'}) — one receiver at a time; a second writer on the inbox is a corruption vector, not a feature`);
        return 3;
      }
      if (lock.stole) console.error(`! stale receiver lock stolen (holder since ${lock.staleHolder?.at ?? '?'}, pid ${lock.staleHolder?.pid ?? '?'}) — a dead receiver cannot own the inbox forever`);
      const { channels } = C.loadChannels(root);
      const unset = channels.filter((c) => !process.env[c.tokenEnv]);
      for (const c of unset) console.error(`! $${c.tokenEnv} is not set — channel "${c.name}" will refuse every request with an honest 503 until the env var exists`);
      const server = C.createChannelServer({ root, host, port, env: process.env, log: (row) => console.error(`  ${row.at.slice(11, 19)} ${row.method} ${row.path} → ${row.status}`) });
      await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });
      const addr = server.address();
      console.error(`channel receiver UP on http://${addr.address}:${addr.port} (loopback only) — ${channels.length} channel(s)`);
      console.error('  webhook POSTs land in .buddy/channels/inbox.jsonl; the live session picks them up at the next idle — buddy channel drain consumes them headless');
      console.error('  Ctrl+C stops the receiver (the lock is released, the inbox stays)');
      let stopping = false;
      process.on('SIGINT', () => {
        if (stopping) return;
        stopping = true;
        console.error('\nreceiver stopping — lock released');
        try { C.releaseServeLock(root); } catch { /* best effort on the way out */ }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      });
      process.on('exit', () => { try { C.releaseServeLock(root); } catch { /* best effort */ } });
      return new Promise(() => {}); // the receiver owns the process until SIGINT
    }
    console.error(`buddy: unknown channel subcommand "${line(sub, 24)}" — known: list | add | remove | serve | drain | status`);
    return 2;
  } catch (e) {
    console.error(`buddy: channel failed honestly — ${e?.message || e}`);
    return 2;
  }
}

async function cmdGoals(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      name: { type: 'string' },
      prompt: { type: 'string' },
      every: { type: 'string' },
      cron: { type: 'string' },
      at: { type: 'string' },
      'max-minutes': { type: 'string' },
      yolo: { type: 'boolean', default: false },
      fast: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      id: { type: 'string' },
      dry: { type: 'boolean', default: false },
      'timeout-minutes': { type: 'string' },
    },
    allowPositionals: true,
  });
  const G = await import('./goals.js');
  const line = (s, n = 60) => G.oneLine(s, n);
  const root = values.dir ? path.resolve(values.dir) : process.cwd();
  const sub = String(positionals[0] ?? 'list').toLowerCase();
  try {
    if (sub === 'list' || sub === 'ls') {
      const l = G.loadGoals(root);
      console.error('\n' + G.goalsTableText(l.goals, l.problems) + '\n');
      return 0;
    }
    if (sub === 'add' || sub === 'set') {
      const { goal, problems } = G.addGoal(root, {
        name: values.name ?? positionals[1],
        prompt: values.prompt,
        everyMinutes: values.every,
        cron: values.cron,
        at: values.at,
        maxMinutes: values['max-minutes'],
        yolo: values.yolo === true,
      });
      const due = G.nextDue(goal);
      console.error(`goal added: ${goal.id} — ${line(goal.name, 40)}`);
      console.error(`  ${G.scheduleText(goal)} · max ${goal.maxMinutes}m/run${goal.yolo ? ' · YOLO (gates off — operator choice)' : ''}`);
      console.error(`  next: ${due ? due.toISOString() : '(never)'}`);
      console.error('  the wake is external — OS cron / GitHub Actions cron calls: buddy goals run --dir .');
      for (const p of problems) console.error(`! ${p}`);
      return 0;
    }
    if (sub === 'enable' || sub === 'disable') {
      const { goal } = G.setGoalEnabled(root, values.id ?? positionals[1], sub === 'enable');
      console.error(`goal ${sub}d: ${goal.id} — ${line(goal.name, 40)}`);
      return 0;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'del') {
      const { goal } = G.removeGoal(root, values.id ?? positionals[1]);
      console.error(`goal removed: ${goal.id} — ${line(goal.name, 40)}`);
      return 0;
    }
    if (sub === 'history') {
      const rows = G.readHistory(root, { id: values.id ?? null, limit: 50 });
      if (!rows.length) { console.error('no goal runs recorded yet — history lands in .buddy/goals/history.jsonl after the first tick'); return 0; }
      for (const r of rows) {
        console.error(`${String(r.at).replace('T', ' ').slice(0, 19)}  ${line(`${r.name} (${r.id})`, 30).padEnd(31)} ${String(r.status).padEnd(9)} ${(Number(r.durationMs) / 1000).toFixed(1)}s${r.said ? ` — ${line(r.said, 70)}` : ''}${r.error ? ` — ${line(r.error, 70)}` : ''}`);
      }
      return 0;
    }
    if (sub === 'next') {
      const { goals, problems } = G.loadGoals(root);
      const nowMs = Date.now();
      const wakes = goals
        .map((g) => ({ g, d: G.nextDue(g, nowMs) }))
        .filter((r) => r.d)
        .sort((a, b) => a.d.getTime() - b.d.getTime());
      console.error(wakes.length ? `next wake: ${wakes[0].d.toISOString()}` : 'nothing will ever wake (no enabled goals, or all maxed out / held)');
      for (const { g, d } of wakes) console.error(`  ${d.toISOString().replace('T', ' ').slice(0, 16)}  ${g.id}  ${line(g.name, 28)} — ${G.scheduleText(g)}`);
      for (const p of problems) console.error(`! ${p}`);
      return 0;
    }
    if (sub === 'run') {
      if (values.dry === true) {
        // CLI-level dry run: a pure view over the exported nextDue — the tick
        // (and its runner) is never invoked, so "no runner was called" is true
        // BY CONSTRUCTION, not by promise.
        const { goals, problems } = G.loadGoals(root);
        const nowMs = Date.now();
        const due = goals
          .map((g) => ({ g, d: G.nextDue(g, nowMs) }))
          .filter((r) => r.d && r.d.getTime() <= nowMs)
          .sort((a, b) => a.d.getTime() - b.d.getTime());
        console.error(`dry run — ${due.length} goal(s) would fire now, no runner was called:`);
        for (const { g, d } of due) console.error(`  ${g.id} ${line(g.name, 32)} — ${G.scheduleText(g)} · overdue since ${d.toISOString()}`);
        for (const g of goals.filter((x) => x.hold)) console.error(`  HELD ${g.id} ${line(g.name, 32)} — ${g.hold}`);
        if (!due.length) console.error('  (nothing is due — the tick would be honestly idle)');
        for (const p of problems) console.error(`! ${p}`);
        return 0;
      }
      const tmo = Number(values['timeout-minutes']);
      const out = await G.runDueGoals(root, {
        fast: Boolean(values.fast),
        force: values.all ? (values.id ?? positionals[1] ?? true) : null,
        ...(Number.isFinite(tmo) && tmo >= 1 && tmo <= 720 ? { timeoutMs: tmo * 60000 } : {}),
      });
      console.error('\n' + G.runSummaryText(out));
      if (out.problems?.length) for (const p of out.problems) console.error(`! ${p}`);
      if (out.busy) return 3;
      if (out.failed > 0) return 2;
      if (out.passed === 0) return 1; // nothing scored (all skipped / idle) — honest, but not a pass
      return 0;
    }
    console.error(`buddy: unknown goal subcommand "${line(sub, 24)}" — known: list | set | enable | disable | remove | run | history | next`);
    return 2;
  } catch (e) {
    console.error(`buddy: goals failed honestly — ${e?.message || e}`);
    return 2;
  }
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    if (cmd === undefined || cmd === 'chat') {
      await cmdChat(argv); // returns immediately by design — the REPL owns the process from here
      return 0;            // quitting happens in the REPL's own close handler ("bye" + exit 0)
    }
    if (cmd === '-p' || cmd === '--prompt' || cmd === 'run') process.exit(await cmdChat(argv, { oneShot: true }));
    // Flags-first invocations (e.g. `buddy -c -p "task"`, `buddy -r name`, `buddy --safe -p "…"`)
    // used to fall through to usage() because argv[0] isn't a command word. Route the FULL
    // arg vector to cmdChat — its own parser + TTY detection decide one-shot vs interactive.
    if (typeof cmd === 'string' && cmd.startsWith('-') && cmd !== '-h' && cmd !== '--help') {
      process.exit(await cmdChat(process.argv.slice(2)));
    }
    if (cmd === 'init') process.exit(await cmdInit(argv));
    if (cmd === 'pr-review') process.exit(await cmdPrReview(argv));
    if (cmd === 'fix-issue') process.exit(await cmdFixIssue(argv));
    if (cmd === 'dep-audit') process.exit(await cmdDepAudit(argv));
    if (cmd === 'triage') process.exit(await cmdTriage(argv));
    if (cmd === 'release-notes') process.exit(await cmdReleaseNotes(argv));
    if (cmd === 'doctor') process.exit(await cmdDoctor(argv));
    if (cmd === 'benchmark') process.exit(await cmdBenchmark(argv));
    if (cmd === 'goals' || cmd === 'goal') process.exit(await cmdGoals(argv));
    if (cmd === 'channel' || cmd === 'channels') process.exit(await cmdChannel(argv));
    if (cmd === 'lesson' || cmd === 'lessons') process.exit(await cmdLessons(argv));
    if (cmd === 'telemetry' || cmd === 'metrics') process.exit(await cmdTelemetry(argv));
    if (cmd === 'notebook' || cmd === 'nb') process.exit(await cmdNotebook(argv));
    if (cmd === 'voice') process.exit(await cmdVoice(argv));
    if (cmd === 'ask') process.exit(await cmdAsk(argv));
    if (cmd === 'mcp-serve') process.exit(await cmdMcpServe(argv));
    if (cmd === 'import') process.exit(await cmdImport(argv));
    if (cmd === 'update') process.exit(await cmdUpdate(argv));
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
