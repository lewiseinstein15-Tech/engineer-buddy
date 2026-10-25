// dep-auditor.js — Skill #3: npm audit → LLM triage → tracking issue.
// Deterministic scan (npm audit --json) + brain prioritization. The report
// updates ONE tracking issue instead of spamming new ones.
import { extractJson, truncate, log, warn } from '../util.js';
import { runCommand } from '../tools/shell.js';

export const AUDIT_ISSUE_PREFIX = '🔧 Dependency audit';

const TRIAGE_CONTRACT = `Respond with EXACTLY ONE JSON object (no fences, no prose):
{
  "summary": "2-4 sentences: overall dependency health and the #1 action",
  "items": [
    { "module": "npm module name (must match an input advisory module_name)",
      "exploitability": "likely" | "possible" | "unlikely",
      "why": "one sentence tied to how this repo actually uses the module",
      "action": "upgrade to X | replace | mitigate | monitor",
      "priority": "p0" | "p1" | "p2" | "p3" }
  ]
}
Rules: max 12 items, sorted by priority. Base exploitability on the module's ROLE in this repo, not just severity labels.`;

/** Parse `npm audit --json` output into a compact advisory list. */
export function parseAuditJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { advisories: [], counts: {}, error: 'unparsable audit output' };
  }
  // npm 8+ shape: vulnerabilities map. npm 6 shape: advisories map.
  // npm *errors* (e.g. no lockfile) also arrive as JSON — reject those honestly.
  if (data.error || (!data.vulnerabilities && !data.advisories)) {
    const msg = data.error ? `${data.error.summary || data.error.code || 'npm error'} ${data.error.detail || ''}` : 'npm audit produced no vulnerability data';
    return { advisories: [], counts: {}, error: `npm audit failed: ${msg}`.trim() };
  }
  const out = [];
  const counts = {};
  const vulns = data.vulnerabilities || {};
  for (const [name, v] of Object.entries(vulns)) {
    const severity = String(v.severity || 'unknown').toLowerCase();
    counts[severity] = (counts[severity] || 0) + 1;
    const via = (v.via || [])
      .filter((x) => typeof x === 'object')
      .map((x) => ({ title: x.title, url: x.url, range: x.range, cwe: x.cwe?.slice?.(0, 2) }))
      .slice(0, 2);
    const transitives = (v.via || []).filter((x) => typeof x === 'string');
    out.push({
      module: name,
      severity,
      range: v.range,
      isDirect: !(v.effects || []).length || transitives.length === 0,
      via: via.length ? via : transitives.map((t) => ({ title: `via ${t}` })),
      fixAvailable: Boolean(v.fixAvailable),
    });
  }
  const sevRank = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };
  out.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));
  return { advisories: out, counts, metadata: data.metadata?.vulnerabilities || null, error: null };
}

export function auditReportMarkdown({ counts, triage, advisories, note }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sevRank = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };
  const countsStr =
    Object.entries(counts)
      .sort((a, b) => (sevRank[a[0]] ?? 9) - (sevRank[b[0]] ?? 9))
      .map(([k, v]) => `${k}×${v}`)
      .join(' · ') || 'none';
  const lines = [];
  lines.push(`## 🔧 Dependency audit — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`**${total} vulnerable path(s):** ${countsStr}`);
  lines.push('');
  if (triage?.summary) {
    lines.push(`**Assessment:** ${truncate(triage.summary, 900)}`);
    lines.push('');
  }
  if (triage?.items?.length) {
    lines.push('| Module | Sev | Exploitability | Action | Priority | Why |');
    lines.push('|---|---|---|---|---|---|');
    for (const it of triage.items) {
      const adv = advisories.find((a) => a.module === it.module);
      lines.push(
        `| ${it.module} | ${adv?.severity || '?'} | ${it.exploitability} | ${truncate(it.action, 40)} | **${it.priority}** | ${truncate(it.why, 110).replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  } else if (advisories.length) {
    lines.push('> Brain triage unavailable — raw advisory list follows.');
    lines.push('');
    for (const a of advisories.slice(0, 15)) lines.push(`- **${a.severity}** ${a.module} (${a.range})${a.fixAvailable ? ' — fix available' : ''}`);
    lines.push('');
  }
  if (note) {
    lines.push(`_${note}_`);
    lines.push('');
  }
  lines.push('---');
  lines.push('*🧠 Engineer Buddy v0.2 · deterministic `npm audit` + keyless LLM triage · $0.00 — verify upgrades in CI before merging*');
  return lines.join('\n');
}

export async function runDepAudit({ repoSlug, github, router, repoDir, config: cfg, dryRun = false, logFn = log }) {
  logFn(`dep audit: ${repoSlug}`);
  if (!repoDir) throw new Error('dep audit requires a local checkout (--repo-dir)');

  // 1. Deterministic scan ----------------------------------------------------
  logFn('running npm audit --json …');
  const run = await runCommand('npm audit --json', { cwd: repoDir.root || repoDir, timeoutMs: 180000 });
  const { advisories, counts, metadata, error } = parseAuditJson(run.stdout || run.stderr || '');
  if (error) {
    // npm itself broke (e.g. no lockfile) — say so in the run log; the workflow
    // run is visible on GitHub, no need to spam any issue.
    warn(`audit could not run: ${error}`);
    console.error(truncate(`${run.stderr}\n${run.stdout}`, 800));
    return { ok: false, reason: 'audit-unparsable', detail: error };
  }
  logFn(`audit: ${JSON.stringify(counts)}${metadata ? ` (total ${metadata.total})` : ''}`);

  if (!advisories.length) {
    logFn('no vulnerabilities — nothing to do');
    return { ok: true, clean: true, counts };
  }

  // 2. Brain triage ------------------------------------------------------------
  const top = advisories.slice(0, cfg.audit.maxAdvisories);
  const context = top
    .map((a) => `- module: ${a.module} | severity: ${a.severity} | affected range: ${a.range} | direct: ${a.isDirect} | advisory: ${a.via.map((v) => v.title).join('; ')}${a.via[0]?.url ? ` (${a.via[0].url})` : ''} | fix available: ${a.fixAvailable}`)
    .join('\n');

  let triage = null;
  try {
    const { text, model, gateway } = await router.chat(
      [
        {
          role: 'user',
          content: [
            `You are the security engineer for ${repoSlug}. Triage these npm audit findings by REAL exploitability in this codebase (a dev-only script with a critical CVE is p3; an auth/money path is p0).`,
            '',
            'Findings:',
            context,
            '',
            TRIAGE_CONTRACT,
          ].join('\n'),
        },
      ],
      { maxTokens: 2000 }
    );
    const parsed = extractJson(text);
    if (parsed.ok && parsed.value?.items) triage = parsed.value;
    else warn(`audit triage unparsable from ${gateway}/${model} — reporting raw list`);
  } catch (e) {
    warn(`audit triage call failed: ${e.message} — reporting raw list`);
  }

  // 3. Publish: one tracking issue, updated not spammed -----------------------
  const body = auditReportMarkdown({ counts, triage, advisories: top, note: `Run in CI on ${new Date().toISOString().slice(0, 10)} · ${metadata ? `${metadata.total} total deps scanned` : ''}` });
  if (dryRun) {
    logFn('dry-run: audit report follows\n' + body);
    return { ok: true, counts, triage, body, advisories: top };
  }

  const existing = await github.findOpenIssueByTitlePrefix(AUDIT_ISSUE_PREFIX);
  if (existing) {
    await github.createComment(existing.number, `### 🔁 Re-run\n\n${body}`);
    await github.addLabels(existing.number, ['buddy:audit']).catch(() => null);
    logFn(`updated tracking issue #${existing.number}`);
    return { ok: true, counts, triage, trackingIssue: existing.number, updated: true };
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const issue = await github.createIssue({
    title: `${AUDIT_ISSUE_PREFIX} — ${total} finding(s), ${counts.critical || 0} critical / ${counts.high || 0} high`,
    body,
    labels: ['buddy:audit'],
  }).catch(async (e) => {
    warn(`createIssue with labels failed (${e.message}) — retrying without labels`);
    return github.createIssue({ title: `${AUDIT_ISSUE_PREFIX} — ${total} finding(s)`, body });
  });
  logFn(`created tracking issue #${issue.number}`);
  return { ok: true, counts, triage, trackingIssue: issue.number, created: true };
}
