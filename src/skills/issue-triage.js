// issue-triage.js — Skill #4: classify + label + first-respond to new issues.
// Runs automatically on issue opened (and on demand via @engineer-buddy triage).
import { extractJson, truncate, log, warn } from '../util.js';

const TRIAGE_CONTRACT = `Respond with EXACTLY ONE JSON object (no fences, no prose):
{
  "type": "bug" | "feature" | "question" | "docs" | "security" | "chore",
  "priority": "p0" | "p1" | "p2" | "p3",
  "labels": ["2-4 lowercase labels, e.g. bug, frontend, p1"],
  "duplicate_of": null,
  "response": "2-5 sentences: acknowledge, state what you understood, ask the ONE most useful clarifying question if info is missing, or say what happens next",
  "needs_more_info": true | false
}`;

export function normalizeTriage(raw, { labelPrefix = 'p' } = {}) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const types = ['bug', 'feature', 'question', 'docs', 'security', 'chore'];
  const type = types.includes(v.type) ? v.type : 'question';
  const priority = /^(p0|p1|p2|p3)$/i.test(String(v.priority)) ? String(v.priority).toLowerCase() : 'p2';
  const labels = [
    ...new Set(
      (Array.isArray(v.labels) ? v.labels : [])
        .map((l) => String(l).toLowerCase().trim().slice(0, 30))
        .filter((l) => l && /^[\w:-]+$/.test(l) && !/^p[0-9]$/.test(l)) // priority labels are canonicalized below
        .slice(0, 5)
    ),
  ];
  if (!labels.includes(priority)) labels.unshift(priority);
  return {
    type,
    priority,
    labels,
    response: String(v.response || '').slice(0, 1500),
    needs_more_info: Boolean(v.needs_more_info),
  };
}

export function triageCommentBody({ triage, issue }) {
  const icon = { bug: '🐛', feature: '✨', question: '❓', docs: '📝', security: '🛡️', chore: '🧹' }[triage.type] || '❓';
  const pIcon = { p0: '🚨', p1: '⚠️', p2: '👀', p3: '🧊' }[triage.priority] || '👀';
  return [
    `## ${icon} Triage — ${triage.type} · ${pIcon} ${triage.priority}`,
    '',
    triage.response,
    '',
    `*Labeled \`${triage.labels.join('`, `')}\` by Engineer Buddy (keyless, $0.00) — say \`@engineer-buddy fix #${issue.number}\` if you want me to attempt a fix, or \`@engineer-buddy triage\` to re-classify.*`,
  ].join('\n');
}

export async function runIssueTriage({ repoSlug, issue: issueNumber, github, router, repo = null, config: cfg, dryRun = false, logFn = log }) {
  logFn(`triage: ${repoSlug}#${issueNumber}`);
  const issue = await github.getIssue(issueNumber);
  if (!issue || !issue.title) throw new Error(`issue #${issueNumber} not found`);
  if (issue.pull_request) return { skipped: true, reason: 'is-pr' };
  if (cfg.review.skipBots && (issue.user?.type === 'Bot' || String(issue.user?.login || '').endsWith('[bot]'))) {
    return { skipped: true, reason: 'bot-issue' };
  }

  const comments = await github.getIssueComments(issueNumber, { max: 10 });
  const repoContext = repo
    ? [`README excerpt:`, truncate(repo.readFile('README.md', 3000)?.content || '(none)', 1500), '', `Top-level files: ${repo.listFiles('', { maxDepth: 1, max: 60 }).join(', ')}`].join('\n')
    : '(repo checkout unavailable — classify from the issue text alone)';

  const { text, model, gateway } = await router.chat(
    [
      {
        role: 'user',
        content: [
          `You are triaging a new issue in ${repoSlug}. Be concrete and honest; do not pad.`,
          '',
          `Issue #${issue.number}: ${issue.title}`,
          `Author: ${issue.user?.login || 'unknown'}`,
          issue.body ? `Body:\n${truncate(issue.body, 4000)}` : 'Body: (empty)',
          comments.length ? `\nExisting comments (${comments.length}):\n${comments.map((c) => `- ${c.user?.login}: ${truncate(c.body, 300)}`).join('\n')}` : '',
          '',
          repoContext,
          '',
          TRIAGE_CONTRACT,
        ].join('\n'),
      },
    ],
    { maxTokens: 1200 }
  );
  const parsed = extractJson(text);
  if (!parsed.ok) throw new Error(`triage: unparsable response (${gateway}/${model})`);
  const triage = normalizeTriage(parsed.value);

  if (!dryRun) {
    await github.addLabels(issueNumber, triage.labels).catch((e) => warn(`labeling failed (labels may not exist): ${e.message}`));
    await github.createComment(issueNumber, triageCommentBody({ triage, issue }));
  }
  logFn(`triaged: ${triage.type}/${triage.priority} labels=[${triage.labels.join(',')}]`);
  return { skipped: false, triage, meta: { model, gateway } };
}
