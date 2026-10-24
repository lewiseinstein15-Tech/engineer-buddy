// pr-reviewer.js — Skill #1: autonomous engineering-grade PR review.
// Pipeline: fetch PR → parse diff → deterministic scans (secrets, risks) →
// optional agentic deep-read of hot files → single structured LLM review →
// normalize → post GitHub review (+labels, +inline comments).
import { parseUnifiedDiff, renderDiffDigest } from '../diff.js';
import { extractJson, globMatches, truncate, debugLog, log, warn } from '../util.js';
import { scanSecrets, scanRisks } from '../tools/security.js';
import { runAgent, systemPromptFor } from '../agent/agent.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, praise: 4 };
const SEVERITY_ICON = { critical: '🚨', high: '⚠️', medium: '🔍', low: '💡', praise: '👍' };
const VERDICT_ICON = { approve: '✅', comment: '⚠️', request_changes: '🚨' };

const SYSTEM_PROMPT = `You are Engineer Buddy, a meticulous staff-level software engineer performing pre-review triage on a pull request. Your review runs BEFORE the human team lead reads the PR, so your job is to surface what would waste their time or endanger production.

You hunt for, in priority order:
1. CORRECTNESS BUGS — logic errors, off-by-one, inverted conditions, unhandled null/undefined, wrong variable, broken edge cases, race conditions, await-less async calls.
2. SECURITY — injection, XSS, IDOR, missing authorization, secrets committed to the repo, unsafe deserialization, SSRF, insecure defaults.
3. MONEY & DATA SAFETY — any code handling balances, payouts, transactions, migrations: wrong math, non-atomic updates, missing rollback, RLS/policy bypass.
4. BREAKING CHANGES — renamed/removed exports, changed function signatures, API contract drift, schema changes without migration.
5. TEST GAPS — new behavior with zero tests, tests that assert nothing, mocks hiding real logic.
6. ERROR HANDLING — swallowed exceptions, missing error paths on network/DB calls, silent failures.

You IGNORE: formatting/style nits (linters handle those), personal preference, architectural philosophy, generated files, lock files.

Severity guide:
- critical: will break production, lose money, leak data, or open an attack path
- high: likely bug or significant risk the author must address before merge
- medium: worth fixing, not merge-blocking
- low: minor improvement
- praise: genuinely good pattern worth reinforcing (use sparingly)

Be concrete: cite the exact line, explain the failure scenario, and when you know the fix say it in one sentence. If the PR is solid, say so honestly — false alarms erode trust.`;

const JSON_CONTRACT = `Respond with EXACTLY ONE JSON object and nothing else (no markdown fences, no prose before or after):
{
  "verdict": "approve" | "comment" | "request_changes",
  "summary": "2-6 sentences: what this PR does, overall quality, the single most important thing to know",
  "risk": "low" | "medium" | "high",
  "tests_added": true | false,
  "findings": [
    {
      "file": "path/relative/to/repo.ext",
      "line": 123,
      "severity": "critical" | "high" | "medium" | "low" | "praise",
      "title": "one-line headline",
      "body": "what is wrong, the failure scenario, and the fix if obvious"
    }
  ]
}
Rules: "line" must be a line number from the ADDED (+) lines shown for that file, or 0 for a PR-wide finding. Max 8 findings, ordered by severity. Never invent file paths or line numbers. If everything is fine, return an empty findings array and verdict "approve".`;

// ---------- normalization ----------

export function normalizeReview(raw, parsedFiles, cfg) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const filesByPath = new Map(parsedFiles.map((f) => [f.path, f]));

  const verdictRaw = String(v.verdict || 'comment').toLowerCase();
  const verdict = ['approve', 'comment', 'request_changes'].includes(verdictRaw) ? verdictRaw : 'comment';
  const riskRaw = String(v.risk || 'medium').toLowerCase();
  const risk = ['low', 'medium', 'high'].includes(riskRaw) ? riskRaw : 'medium';

  const findings = Array.isArray(v.findings) ? v.findings : [];
  const normalized = [];
  const displaced = [];

  for (const f of findings.slice(0, 24)) {
    if (!f || typeof f !== 'object') continue;
    const file = typeof f.file === 'string' ? f.file.trim() : '';
    let line = Number.isFinite(f.line) ? Math.trunc(f.line) : Number.parseInt(f.line, 10) || 0;
    const sevRaw = String(f.severity || 'medium').toLowerCase();
    const severity = sevRaw in SEVERITY_RANK ? sevRaw : 'medium';
    const title = String(f.title || 'Finding').slice(0, 120);
    const body = String(f.body || '').slice(0, 1200);

    const pf = filesByPath.get(file);
    if (!pf) {
      // unknown path → PR-wide, keep but flag
      displaced.push({ file: file || '(unknown file)', line: 0, severity, title, body });
      continue;
    }
    if (line > 0 && !pf.addedLines.has(line)) {
      // GitHub inline comments must anchor to added lines; move bad anchors
      // into the summary body instead of dropping the finding.
      displaced.push({ file, line, severity, title, body });
      continue;
    }
    normalized.push({ file, line, severity, title, body });
  }

  normalized.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  displaced.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const capped = normalized.slice(0, cfg.review.maxFindings);
  return {
    verdict,
    risk,
    summary: String(v.summary || '').slice(0, 2000),
    tests_added: Boolean(v.tests_added),
    findings: capped,
    displaced,
  };
}

// ---------- formatting ----------

export function formatReviewBody({ pr, review, secFindings, risks, stats, meta, cfg }) {
  const { verdict } = review;
  const icon = VERDICT_ICON[verdict] || '⚠️';
  const lines = [];

  lines.push(`## ${icon} Engineer Buddy — pre-review triage`);
  lines.push('');
  lines.push(`**Verdict:** \`${verdict}\` · **Risk:** \`${review.risk}\` · **Tests added:** ${review.tests_added ? 'yes' : 'no'}`);
  lines.push('');
  if (review.summary) {
    lines.push(review.summary);
    lines.push('');
  }

  const allFindings = [...review.findings];
  if (secFindings.length) {
    lines.push(`### 🛡️ Deterministic secret scan (${secFindings.length})`);
    for (const s of secFindings.slice(0, 10)) {
      lines.push(`- 🚨 **${s.label}** at \`${s.file}:${s.line}\` — \`${s.snippet}\``);
      allFindings.push({ file: s.file, line: s.line, severity: 'critical', title: `Committed secret: ${s.label}`, body: `This line matches a known secret pattern and must not be committed. Revoke the credential and remove it from history.` });
    }
    lines.push('');
  }

  if (allFindings.length || review.displaced.length) {
    lines.push(`### Findings (${allFindings.length})`);
    lines.push('');
    for (const f of allFindings) {
      const anchor = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`- ${SEVERITY_ICON[f.severity] || '•'} **${f.title}** — ${anchor}`);
      if (f.body) lines.push(`  ${f.body}`);
    }
    for (const d of review.displaced) {
      lines.push(`- ${SEVERITY_ICON[d.severity] || '•'} **${d.title}** — \`${d.file}:${d.line}\` *(line not in added range)*`);
      if (d.body) lines.push(`  ${d.body}`);
    }
    lines.push('');
  } else {
    lines.push('No blocking findings. Nice work.');
    lines.push('');
  }

  if (risks.length) {
    lines.push(`<details><summary>⚙️ Risk heuristics (${risks.length})</summary>`);
    lines.push('');
    for (const r of risks) lines.push(`- \`${r.file}\` — ${r.note}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('---');
  const attempts = meta.attempts ? ` · ${meta.attempts.length} attempt(s)` : '';
  lines.push(
    `*🧠 \`${meta.model}\` via \`${meta.gateway}\`${attempts} · ${(meta.latencyMs / 1000).toFixed(1)}s · $0.00 keyless · diff ${stats.totalAdded}+/−${stats.totalRemoved} across ${stats.files} files · Engineer Buddy v0.1 — human review still required*`
  );
  return lines.join('\n');
}

export function mapToGitHubReview({ review, secFindings, cfg }) {
  const criticalPresent = review.findings.some((f) => f.severity === 'critical') || secFindings.length > 0;
  let event = 'COMMENT';
  if (criticalPresent && cfg.review.requestChangesOnCritical) event = 'REQUEST_CHANGES';

  const comments = review.findings
    .filter((f) => f.file && f.line > 0)
    .slice(0, cfg.review.maxFindings)
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: `${SEVERITY_ICON[f.severity]} **${f.title}**\n\n${f.body}\n\n---\n*Engineer Buddy · keyless pre-review — confirm before acting*`,
    }));
  return { event, comments };
}

// ---------- orchestration ----------

function filterExcluded(parsed, cfg) {
  return parsed.map((f) =>
    (cfg.review.excludeFiles || []).some((g) => globMatches(g, f.path))
      ? { ...f, addedLines: new Map(), removedLines: [], additions: 0, deletions: 0, binary: true, excluded: true }
      : f
  );
}

async function deepGather({ router, repo, parsed, cfg, log }) {
  const significant = parsed
    .filter((f) => !f.binary && f.additions + f.deletions >= cfg.review.deepModeChangedLineThreshold / 3)
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 6)
    .map((f) => f.path);
  if (!significant.length || !repo) return null;

  const tools = [
    {
      name: 'read_file',
      description: 'Read a repository file (capped).',
      args: '{"path": "src/file.js"}',
      run: async ({ path }) => {
        const r = repo.readFile(path, cfg.review.maxFileChars);
        return r ? `FILE ${path}:\n${r.content}` : `ERROR: cannot read ${path}`;
      },
    },
    {
      name: 'list_files',
      description: 'List repository files.',
      args: '{"dir": "src"}',
      run: async ({ dir = '' } = {}) => repo.listFiles(dir, { max: 200 }).join('\n') || '(empty)',
    },
    {
      name: 'search_code',
      description: 'Search the repository for a substring or regex.',
      args: '{"needle": "survivor", "regex": false}',
      run: async ({ needle, regex = false } = {}) => {
        const hits = repo.search(String(needle), { regex: Boolean(regex), max: 15 });
        return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') || '(no matches)';
      },
    },
  ];

  const task = [
    `Changed files needing deeper context (most changed first):`,
    ...significant.map((p) => `- ${p}`),
    '',
    'Read the 1-3 files whose surrounding context (callers, imports, related config) is essential to judge these changes, then finish with the list you read.',
  ].join('\n');

  const gathered = [];
  try {
    const { steps } = await runAgent({
      router,
      tools,
      systemPrompt: 'The diff under review is being evaluated. Your only job is to collect just enough surrounding repository context for a thorough review. Read at most 3 files, then finish.',
      messages: [{ role: 'user', content: task }],
      maxSteps: 4,
      onStep: ({ tool, args, observation }) => {
        if (tool === 'read_file' && observation && !String(observation).startsWith('ERROR')) {
          gathered.push(`### context: ${args?.path}\n${String(observation).slice(0, cfg.review.maxFileChars)}`);
        }
      },
    });
    debugLog(`deep gather finished=${steps.length} steps, gathered=${gathered.length} files`);
    return gathered.length ? gathered.join('\n\n') : null;
  } catch (e) {
    warn(`deep gather failed (continuing without it): ${e.message}`);
    return null;
  }
}

export async function runPrReview({ repoSlug, pr: prNumber, github, router, repo = null, config: cfg, dryRun = false, log: logFn = log }) {
  const t0 = Date.now();
  logFn(`PR review: ${repoSlug}#${prNumber}${dryRun ? ' (dry-run)' : ''}`);

  // 1. Fetch + skip rules -------------------------------------------------
  const pull = await github.getPull(prNumber);
  if (!pull || !pull.head) throw new Error(`PR #${prNumber} not found`);
  const author = pull.user?.login || 'unknown';
  if (cfg.review.skipBots && (pull.user?.type === 'Bot' || author.endsWith('[bot]'))) {
    logFn(`skip: author ${author} is a bot`);
    return { skipped: true, reason: 'bot-author' };
  }
  if (cfg.review.skipDrafts && pull.draft) {
    logFn('skip: draft PR');
    return { skipped: true, reason: 'draft' };
  }
  if (/^\s*(wip|work in progress|do not merge|dnm)\b/i.test(pull.title || '')) {
    logFn('skip: WIP title');
    return { skipped: true, reason: 'wip' };
  }

  // 2. Material: diff, files, deterministic scans -------------------------
  const [files, diffText] = await Promise.all([github.getFiles(prNumber), github.getDiff(prNumber)]);
  const parsedAll = parseUnifiedDiff(diffText);
  const parsed = filterExcluded(parsedAll, cfg);
  const secFindings = scanSecrets(parsed);
  const { risks, totalAdded, totalRemoved, files: nFiles } = scanRisks(parsed, { rawDiff: diffText });

  logFn(`diff: ${nFiles} files, +${totalAdded}/-${totalRemoved}, secrets=${secFindings.length}, risks=${risks.length}`);

  // 3. Context pack --------------------------------------------------------
  const diffDigest = renderDiffDigest(parsed, { maxTotal: cfg.review.maxDiffChars });
  const fileTable = parsed
    .map((f) => `- ${f.path}${f.excluded ? ' *(content excluded by policy)*' : f.binary ? ' *(binary)*' : ` (+${f.additions}/−${f.deletions})`}`)
    .join('\n');

  const shouldDeep = totalAdded + totalRemoved >= cfg.review.deepModeChangedLineThreshold && repo;
  let deepContext = null;
  if (shouldDeep) {
    logFn('deep mode: agentic context gather…');
    deepContext = await deepGather({ router, repo, parsed, cfg, log: logFn });
  }

  // 4. The review call ------------------------------------------------------
  const userParts = [
    `Review this pull request from ${repoSlug}.`,
    '',
    `PR #${pull.number}: ${pull.title}`,
    `Author: ${author} · Branch: ${pull.head?.ref} → ${pull.base?.ref}`,
    pull.body ? `Description:\n${truncate(pull.body, 1200)}` : 'Description: (none)',
    '',
    `### Files (${nFiles})`,
    fileTable,
    '',
    '### Diff (added lines prefixed with new-file line number, removed with -:)',
    diffDigest || '(no textual diff)',
  ];
  if (secFindings.length) {
    userParts.push('', '### Deterministic secret scan results (ALREADY CONFIRMED — include them as critical findings):');
    for (const s of secFindings) userParts.push(`- ${s.file}:${s.line} → ${s.label}`);
  }
  if (risks.length) {
    userParts.push('', '### Structural risk heuristics (verify before trusting):');
    for (const r of risks) userParts.push(`- ${r.file}: ${r.note}`);
  }
  if (deepContext) {
    userParts.push('', '### Repository context gathered for this review (use it to verify the diff):');
    userParts.push(deepContext);
  }
  userParts.push('', JSON_CONTRACT);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') },
  ];

  const { text, model, gateway, latencyMs, attempts } = await router.chat(messages, { maxTokens: 3000 });
  const parsedOut = extractJson(text);
  if (!parsedOut.ok) {
    throw new Error(`brain returned unparsable review (${gateway}/${model}): ${truncate(text, 200)}`);
  }
  const review = normalizeReview(parsedOut.value, parsed, cfg);

  // 5. Publish ---------------------------------------------------------------
  const stats = { totalAdded, totalRemoved, files: nFiles };
  const meta = { model, gateway, latencyMs, attempts, elapsedMs: Date.now() - t0 };
  const body = formatReviewBody({ pr: pull, review, secFindings, risks, stats, meta, cfg });
  const { event, comments } = mapToGitHubReview({ review, secFindings, cfg });

  if (dryRun) {
    logFn('dry-run: review follows\n' + body);
    return { skipped: false, review, body, event, comments, meta, stats };
  }

  let posted = 'review';
  try {
    await github.createReview(prNumber, { body, event, comments });
  } catch (e) {
    warn(`review post failed (${e.message}) — falling back to plain comment`);
    await github.createComment(prNumber, body);
    posted = 'comment';
  }

  const labels = [];
  const L = cfg.review.labels || {};
  if (event === 'REQUEST_CHANGES') labels.push(L.changes, L.critical).filter?.(Boolean);
  else if (review.findings.length === 0 && !secFindings.length) labels.push(L.clean);
  else labels.push(L.changes).filter?.(Boolean);
  await github.addLabels(prNumber, [...new Set(labels.filter(Boolean))]).catch(() => null);

  logFn(`done: ${event} with ${comments.length} inline comment(s), ${review.findings.length} finding(s), posted=${posted}`);
  return { skipped: false, review, body, event, comments, meta, stats, posted };
}
