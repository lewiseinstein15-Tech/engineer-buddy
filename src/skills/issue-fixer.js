// issue-fixer.js — Skill #2: turn an issue into a reviewed fix PR.
//
// Pipeline: fetch issue → PLAN (1 LLM call) → EXPLORE (agent, read-only) →
// EDIT (agent, guarded write tools) → VERIFY (allowlisted tests, ≤2 repair
// loops) → SHIP (branch buddy/fix-issue-N → commit → push → PR + issue
// comment). Any failure = polite issue comment + exit 0. The buddy NEVER
// pushes to main, NEVER merges, NEVER approves.
import { extractJson, truncate, debugLog, log, warn } from '../util.js';
import { runAgent } from '../agent/agent.js';
import { RepoEditor, WRITE_DENYLIST, MutationLedger } from '../tools/edit.js';
import { runCommand, digestTestFailure } from '../tools/shell.js';
import { GitWorktree, sanitizeBranchName } from '../tools/git.js';

const PLAN_CONTRACT = `Respond with EXACTLY ONE JSON object (no fences, no prose):
{
  "understanding": "1-3 sentences: what the issue actually asks and the likely root cause",
  "type": "bug" | "feature" | "refactor" | "docs" | "test",
  "confidence": "high" | "medium" | "low",
  "files_to_read": ["src/most/likely.js", "src/involved.js"],
  "plan": ["step 1", "step 2", "step 3"],
  "test_command": "the repo's test command, e.g. npm test — or null if unknown"
}`;

const DIAGNOSE_CONTRACT = `Respond with EXACTLY ONE JSON object (no fences, no prose):
{
  "root_cause": "1-4 sentences: the confirmed root cause / precise change needed",
  "files_to_edit": [{"path":"src/file.js","change":"what exactly to change and why"}],
  "tests_to_run": ["npm test"],
  "confidence": "high" | "medium" | "low"
}`;

const EDIT_SYSTEM = `You are Engineer Buddy in FIX mode. You have file tools and you MUST implement the diagnosed change now.
Rules:
- Read a file before editing it. Prefer replace_in_file (surgical) over write_file (rewrite).
- Make the MINIMAL correct change that fixes the issue. No drive-by refactors, no style churn.
- If the issue asks for a feature, add it cleanly and update any obvious test.
- Protected paths (workflows, .env, keys, lock files) are enforced by tooling — do not try.
- When the change is complete, call finish with {"summary":"what you changed"}.
JSON protocol only.`;

const REPAIR_NOTE = (digest, cmd) => `The verification step FAILED. Fix your change and try again.

Command: ${cmd}
Failure digest:
${digest}

Read the file you edited, find the bug in your own change, and fix it. Then finish again.`;

function branchFor(issue) {
  const slug = sanitizeBranchName((issue.title || 'issue').slice(0, 40));
  return `buddy/fix-issue-${issue.number}-${slug}`;
}

async function planPhase({ router, issue }) {
  const { text, model, gateway, attempts } = await router.chat(
    [
      {
        role: 'user',
        content: [
          `You are triaging an issue in a repository to prepare a fix.`,
          ``,
          `Issue #${issue.number}: ${issue.title}`,
          issue.body ? `Body:\n${truncate(issue.body, 6000)}` : 'Body: (empty)',
          ``,
          PLAN_CONTRACT,
        ].join('\n'),
      },
    ],
    { maxTokens: 1400 }
  );
  const parsed = extractJson(text);
  if (!parsed.ok) throw new Error(`plan phase: unparsable plan (${gateway}/${model})`);
  return { plan: parsed.value, meta: { model, gateway, attempts } };
}

async function explorePhase({ router, repo, plan }) {
  const tools = [
    {
      name: 'read_file',
      description: 'Read a repository file (capped).',
      args: '{"path":"src/file.js"}',
      maxCalls: 6,
      run: async ({ path }) => {
        const r = repo.readFile(String(path), 24000);
        return r ? `FILE ${path}:\n${r.content}` : `ERROR: cannot read ${path}`;
      },
    },
    {
      name: 'search_code',
      description: 'Search the repository (substring or regex).',
      args: '{"needle":"text","regex":false}',
      maxCalls: 4,
      run: async ({ needle, regex = false } = {}) => {
        const hits = repo.search(String(needle), { regex: Boolean(regex), max: 15 });
        return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') || '(no matches)';
      },
    },
    {
      name: 'list_files',
      description: 'List repository files.',
      args: '{"dir":"src"}',
      maxCalls: 3,
      run: async ({ dir = '' } = {}) => repo.listFiles(dir, { max: 200 }).join('\n') || '(empty)',
    },
  ];

  const { finished, result, steps } = await runAgent({
    router,
    tools,
    systemPrompt:
      'You are diagnosing a bug/feature before implementing the fix. Read the files most likely involved, confirm the root cause with evidence (line numbers, code snippets), then finish. Do NOT propose edits yet — diagnosis only.',
    messages: [
      {
        role: 'user',
        content: [
          `Issue: ${truncate(plan.understanding || '', 1200)}`,
          `Suggested files to read: ${(plan.files_to_read || []).join(', ') || '(none suggested)'}`,
          '',
          DIAGNOSE_CONTRACT,
        ].join('\n'),
      },
    ],
    maxSteps: 8,
    maxTokens: 1400,
  });

  const diag = finished && result && typeof result === 'object' ? result : null;
  if (!diag) {
    const lastText = steps.filter((s) => s.observation).map((s) => s.observation).pop();
    throw new Error(`explore phase did not finish (${steps.length} steps)${lastText ? ` — last: ${truncate(lastText, 200)}` : ''}`);
  }
  return diag;
}

async function editPhase({ router, repo, editor, diag, plan }) {
  const tools = editor.toTools(repo);
  const { finished, steps } = await runAgent({
    router,
    tools,
    systemPrompt: EDIT_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Diagnosis (confirmed by reading the repo):`,
          `Root cause: ${truncate(String(diag.root_cause || plan.understanding || ''), 1500)}`,
          `Confidence: ${diag.confidence || plan.confidence || 'medium'}`,
          '',
          `Edits to make:`,
          ...(diag.files_to_edit || []).map((f) => `- ${f.path}: ${f.change}`),
          '',
          `Implement these edits now. Start by reading the first file.`,
        ].join('\n'),
      },
    ],
    maxSteps: 14,
    maxTokens: 2000,
  });

  if (!editor.ledger.filesChanged.length) {
    const errStep = steps.find((s) => String(s.observation || '').startsWith('ERROR'));
    throw new Error(`no files changed after edit phase (${steps.length} steps)${errStep ? ` — ${truncate(errStep.observation, 200)}` : ''}`);
  }
  if (!finished) debugLog(`edit phase hit step budget; continuing with ${editor.ledger.filesChanged.length} file(s) changed`);
  return steps;
}

/** Detect the repo's test command: package.json scripts, then fallbacks. */
export function detectTestCommand(repo) {
  const pkg = repo.readFile('package.json', 20000);
  if (pkg) {
    try {
      const scripts = JSON.parse(pkg.content).scripts || {};
      if (scripts.test && scripts.test !== 'echo \\"Error: no test specified\\" && exit 1') return 'npm test';
    } catch { /* fall through */ }
  }
  if (repo.fileExists('pytest.ini') || repo.fileExists('setup.cfg')) return 'pytest';
  return null;
}

async function verifyPhase({ repoDir, testCmd, router, repo, editor, maxRepairs = 2, logFn = log }) {
  const attempts = [];
  if (!testCmd) {
    return { verified: true, skipped: true, attempts, note: 'no test command detected — manual verification required' };
  }
  for (let i = 0; i <= maxRepairs; i++) {
    logFn(`verify: running "${testCmd}" (attempt ${i + 1})`);
    const run = await runCommand(testCmd, { cwd: repoDir.root, timeoutMs: 420000 });
    attempts.push({ command: testCmd, ok: run.ok, durationMs: run.durationMs, digest: digestTestFailure(`${run.stderr}\n${run.stdout}`) });
    if (run.ok) return { verified: true, skipped: false, attempts, note: `\`${testCmd}\` passed` };

    if (i === maxRepairs) break;
    // Repair loop: hand the failure back to the editing agent.
    const digest = digestTestFailure(`${run.stderr}\n${run.stdout}`);
    try {
      await runAgent({
        router,
        tools: editor.toTools(repo),
        systemPrompt: EDIT_SYSTEM,
        messages: [{ role: 'user', content: REPAIR_NOTE(digest, testCmd) }],
        maxSteps: 10,
        maxTokens: 2000,
      });
    } catch (e) {
      warn(`repair loop ${i + 1} failed: ${e.message}`);
    }
  }
  return { verified: false, skipped: false, attempts, note: `\`${testCmd}\` still failing after ${maxRepairs} repair attempt(s)` };
}

export function formatFixPrBody({ issue, plan, diag, ledger, verify, stats, meta, note }) {
  const lines = [];
  lines.push(`## 🔧 Engineer Buddy — fix for #${issue.number}`);
  lines.push('');
  lines.push(`Fixes #${issue.number}`);
  lines.push('');
  lines.push(`**Understanding:** ${truncate(String(plan.understanding || ''), 800)}`);
  lines.push('');
  lines.push(`**Root cause:** ${truncate(String(diag?.root_cause || '(see understanding)'), 800)}`);
  lines.push('');
  lines.push(`### Plan`);
  (plan.plan || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push(`### Changes (${ledger.filesChanged.length} file(s), ~${ledger.totalLines()} lines)`);
  lines.push('');
  lines.push(ledger.toMarkdown());
  lines.push('');
  lines.push(`### Verification`);
  lines.push('');
  if (verify.skipped) {
    lines.push(`- ⚠️ ${note}`);
  } else {
    for (const a of verify.attempts) {
      lines.push(`- ${a.ok ? '✅' : '❌'} \`${a.command}\` (${(a.durationMs / 1000).toFixed(1)}s)`);
    }
    lines.push('');
    lines.push(verify.verified ? `**All checks passed.**` : `**⚠️ Verification FAILED — this PR is a proposal, not a proven fix. See digests below.**`);
    const lastFail = [...verify.attempts].reverse().find((a) => !a.ok);
    if (lastFail?.digest) {
      lines.push('');
      lines.push('<details><summary>Last failure digest</summary>');
      lines.push('');
      lines.push('```');
      lines.push(truncate(lastFail.digest, 2500));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(
    `*🧠 \`${meta.model}\` via \`${meta.gateway}\` · ${(meta.latencyMs / 1000).toFixed(1)}s · $0.00 keyless · ${stats.files} file(s) changed · Engineer Buddy v0.2 — human review required before merge*`
  );
  return lines.join('\n');
}

export async function runIssueFix({ repoSlug, issue: issueNumber, github, router, repoDir, config: cfg, dryRun = false, logFn = log }) {
  const t0 = Date.now();
  logFn(`issue fix: ${repoSlug}#${issueNumber}${dryRun ? ' (dry-run)' : ''}`);

  if (!repoDir) throw new Error('issue fix requires a local checkout (--repo-dir)');
  const git = new GitWorktree(repoDir.root, cfg.write.commitIdentity || {});

  // 1. Fetch the issue -----------------------------------------------------
  const issue = await github.getIssue(issueNumber);
  if (!issue || !issue.title) throw new Error(`issue #${issueNumber} not found`);
  if (issue.pull_request) throw new Error(`#${issueNumber} is a PR, not an issue`);
  if (issue.state === 'closed') throw new Error(`issue #${issueNumber} is closed`);
  if (cfg.review.skipBots && (issue.user?.type === 'Bot' || String(issue.user?.login || '').endsWith('[bot]'))) {
    return { skipped: true, reason: 'bot-issue' };
  }

  // 2. Plan ----------------------------------------------------------------
  logFn('phase: plan');
  const { plan, meta } = await planPhase({ router, issue });

  // 3. Explore / diagnose ----------------------------------------------------
  logFn('phase: explore');
  const diag = await explorePhase({ router, repo: repoDir, plan });
  logFn(`diagnosis: confidence=${diag.confidence || '?'} — ${truncate(String(diag.root_cause || ''), 120)}`);

  if (String(diag.confidence || '').toLowerCase() === 'low' && !diag.files_to_edit?.length) {
    const body = [
      `## 🤔 Engineer Buddy investigated #${issue.number}`,
      '',
      'I could not confidently locate the root cause from the repository alone:',
      '',
      `> ${truncate(String(diag.root_cause || plan.understanding || 'unclear'), 700)}`,
      '',
      'Rather than guess and ship a wrong patch, I am handing this back with my analysis. A maintainer with more context can re-trigger me with `@engineer-buddy fix #' + issue.number + '` after adding details.',
      '',
      '---',
      `*🧠 \`${meta.model}\` via \`${meta.gateway}\` · $0.00 keyless · Engineer Buddy v0.2*`,
    ].join('\n');
    if (!dryRun) await github.createComment(issueNumber, body);
    return { skipped: false, outcome: 'needs-human', diagnosis: diag, meta };
  }

  // 4. Edit ----------------------------------------------------------------
  logFn('phase: edit');
  const ledger = new MutationLedger();
  const editor = new RepoEditor(repoDir, {
    denyPaths: WRITE_DENYLIST,
    maxFiles: cfg.write.maxFilesChanged,
    maxLines: cfg.write.maxLinesChanged,
    ledger,
  });
  await editPhase({ router, repo: repoDir, editor, diag, plan });
  logFn(`edited: ${ledger.filesChanged.join(', ')}`);

  // 5. Verify ----------------------------------------------------------------
  const testCmd = diag.tests_to_run?.find((t) => typeof t === 'string' && t.trim()) || detectTestCommand(repoDir);
  logFn(`phase: verify (${testCmd || 'no test command'})`);
  const verify = await verifyPhase({ repoDir, testCmd, router, repo: repoDir, editor, maxRepairs: cfg.write.maxRepairLoops, logFn });
  logFn(`verify: ${verify.verified ? 'PASSED' : 'FAILED'}${verify.skipped ? ' (skipped)' : ''} — ${verify.note}`);

  if (!verify.verified && cfg.write.requireTestsPass) {
    await git.resetHard();
    const body = [
      `## ⚠️ Engineer Buddy attempted #${issue.number} — aborted before PR`,
      '',
      `I implemented a candidate fix (${ledger.filesChanged.length} file(s)) but could **not** get the test suite green:`,
      '',
      ...verify.attempts.map((a) => `- ${a.ok ? '✅' : '❌'} \`${a.command}\``),
      '',
      'Per safety policy (tests must pass), the changes were **discarded** and nothing was pushed. My diagnosis for whoever picks this up:',
      '',
      `> ${truncate(String(diag.root_cause || ''), 700)}`,
      '',
      '---',
      `*🧠 \`${meta.model}\` via \`${meta.gateway}\` · $0.00 keyless · Engineer Buddy v0.2*`,
    ].join('\n');
    if (!dryRun) await github.createComment(issueNumber, body);
    return { skipped: false, outcome: 'verification-failed-discarded', diagnosis: diag, verify, meta };
  }

  // 6. Ship ----------------------------------------------------------------
  const branch = branchFor(issue);
  const base = await git.defaultBranch();
  const stats = { files: ledger.filesChanged.length };
  const meta2 = { ...meta, latencyMs: Date.now() - t0 };
  const prBody = formatFixPrBody({ issue, plan, diag, ledger, verify, stats, meta: meta2, note: verify.note });

  if (dryRun) {
    logFn('dry-run: PR body follows\n' + prBody);
    return { skipped: false, outcome: 'dry-run', branch, base, prBody, ledger: ledger.entries, verify, meta: meta2 };
  }

  await git.createBranch(branch);
  const commitMsg = [
    `fix(#${issue.number}): ${truncate(issue.title, 60)}`,
    '',
    truncate(String(diag.root_cause || ''), 300),
    '',
    `Files: ${ledger.filesChanged.join(', ')}`,
    `Authored-by: Engineer Buddy (keyless AI) — human review required`,
  ].join('\n');
  const commit = await git.commitAll(commitMsg);
  logFn(`committed: ${commit}`);
  await git.push(branch, { token: github.token || process.env.GITHUB_TOKEN || process.env.BUDDY_GITHUB_TOKEN, repo: repoSlug });

  const pr = await github.createPull({
    head: branch,
    base,
    title: `fix(#${issue.number}): ${truncate(issue.title, 60)}`,
    body: prBody,
  });
  await github.addLabels(issueNumber, ['buddy:fix-ready']).catch(() => null);
  await github.createComment(
    issueNumber,
    [
      `## 🔧 Engineer Buddy opened a fix PR`,
      '',
      `**#${pr.number} — ${pr.title}**`,
      '',
      `Branch \`${branch}\` · ${stats.files} file(s) · verification: ${verify.verified ? '✅ tests passed' : '⚠️ see PR body'}`,
      '',
      'This is a proposal for human review — I never merge or approve. Feedback on the PR trains me: comment there and re-run with `@engineer-buddy review`.',
      '',
      '---',
      `*🧠 \`${meta2.model}\` via \`${meta2.gateway}\` · $0.00 keyless · Engineer Buddy v0.2*`,
    ].join('\n')
  );
  logFn(`shipped: PR #${pr.number} (${branch} → ${base})`);
  return { skipped: false, outcome: 'pr-opened', pr, branch, base, ledger: ledger.entries, verify, meta: meta2 };
}
