// release-notes.js — Skill #5: draft release notes from merged PRs.
// Groups merged work into Breaking / Features / Fixes / Maintenance and
// writes human-ready markdown. Output: stdout (dry-run), a comment on the
// triggering issue, or a new "Release notes draft" issue.
import { extractJson, truncate, log, warn } from '../util.js';

const NOTES_CONTRACT = `Respond with EXACTLY ONE JSON object (no fences, no prose):
{
  "title": "Release title, e.g. vNext — Survivor pools, hardened wallet",
  "intro": "1-3 sentences: the headline of this release",
  "breaking": [{"pr": 12, "entry": "one line for humans"}],
  "features": [{"pr": 13, "entry": "one line for humans"}],
  "fixes": [{"pr": 14, "entry": "one line for humans"}],
  "maintenance": [{"pr": 15, "entry": "one line for humans"}],
  "contributors": ["login1", "login2"]
}
Rules: entries are user-facing language (no PR jargon), max 12 per section, only reference PRs from the provided list.`;

function section(md, title, items) {
  if (!items?.length) return md;
  md.push(`### ${title}`, '');
  for (const it of items) md.push(`- ${it.entry} (#${it.pr})`);
  md.push('');
  return md;
}

export function formatReleaseNotes(draft, { since } = {}) {
  const md = [`## 🚀 ${draft.title || 'Release notes draft'}`, ''];
  if (draft.intro) md.push(draft.intro, '');
  section(md, '⚠️ Breaking changes', draft.breaking);
  section(md, '✨ Features', draft.features);
  section(md, '🐛 Fixes', draft.fixes);
  section(md, '🧹 Maintenance', draft.maintenance);
  if (draft.contributors?.length) {
    md.push(`**Thanks:** ${draft.contributors.map((c) => `@${c}`).join(' ')}`, '');
  }
  md.push('---');
  md.push(`*🧠 Drafted by Engineer Buddy from merged PRs${since ? ` since \`${since}\`` : ''} · keyless · $0.00 — human edit encouraged*`);
  return md.join('\n');
}

export async function runReleaseNotes({ repoSlug, github, router, since = null, max = 30, config: cfg, dryRun = false, logFn = log, postToIssue = null }) {
  logFn(`release notes: ${repoSlug}${since ? ` since ${since}` : ''}`);
  const pulls = await github.listMergedPulls({ max, since });
  if (!pulls.length) {
    logFn('no merged PRs found in range');
    const msg = `No merged PRs found${since ? ` since ${since}` : ' recently'} — nothing to draft.`;
    if (postToIssue && !dryRun) await github.createComment(postToIssue, msg);
    return { ok: true, empty: true, message: msg };
  }

  const list = pulls
    .map((p) => `- PR #${p.number} "${truncate(p.title, 120)}" by ${p.user?.login || 'unknown'}${p.labels?.length ? ` [labels: ${p.labels.map((l) => l.name).join(', ')}]` : ''}\n  body: ${truncate((p.body || '').replace(/\r/g, ''), 300)}`)
    .join('\n');

  const { text, model, gateway } = await router.chat(
    [
      {
        role: 'user',
        content: [
          `Draft release notes for ${repoSlug} from these ${pulls.length} merged PRs${since ? ` (since ${since})` : ''}.`,
          '',
          list,
          '',
          NOTES_CONTRACT,
        ].join('\n'),
      },
    ],
    { maxTokens: 1800 }
  );
  const parsed = extractJson(text);
  if (!parsed.ok) throw new Error(`release notes: unparsable draft (${gateway}/${model})`);

  // Only allow PR numbers that actually appeared in the merged set.
  const valid = new Set(pulls.map((p) => p.number));
  const d = parsed.value || {};
  for (const key of ['breaking', 'features', 'fixes', 'maintenance']) {
    if (Array.isArray(d[key])) d[key] = d[key].filter((it) => it && valid.has(Number(it.pr)));
  }
  const body = formatReleaseNotes(d, { since });

  if (dryRun) {
    logFn('dry-run: notes follow\n' + body);
    return { ok: true, body, draft: d, meta: { model, gateway }, pulls: pulls.length };
  }
  if (postToIssue) {
    await github.createComment(postToIssue, body);
    logFn(`posted notes to issue #${postToIssue}`);
  } else {
    const issue = await github.createIssue({ title: `📝 Release notes draft — ${new Date().toISOString().slice(0, 10)}`, body, labels: ['buddy:notes'] });
    logFn(`created notes issue #${issue.number}`);
  }
  return { ok: true, body, draft: d, meta: { model, gateway }, pulls: pulls.length };
}
