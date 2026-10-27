// ghapi.js — the GitHub/GitLab API tool (v0.35.0, checklist §6 + §9).
//
// The harness already talked to GitHub (github.js: issue fixer, triage,
// auditor) — but the AGENT had no door: "check the CI on my branch" meant
// the model burning bash calls on curl, or the user pasting screenshots.
// One tool, provider auto-detected from the origin remote:
//
//   GitHub  — github.com (or BUDDY_GITHUB_API for Enterprise), token from
//             BUDDY_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN
//   GitLab  — gitlab.com (or BUDDY_GITLAB_API self-hosted), token from
//             BUDDY_GITLAB_TOKEN / GITLAB_TOKEN
//
// The checklist's rule holds: the USER's token, never Buddy's own keys.
// Secrets only ever come from the env at call time; nothing lands in the
// transcript, the audit trail, or the model's context.
//
// Read ops are free (public repos work without a token). Write ops
// (pr_create / pr_comment / pr_review) declare riskyWhen → the chat loop's
// approval gate previews and asks, same contract as git_write.
//
// Pure halves (repoFromRemote, normalizers, formatters, ghOp with an
// injectable getRemote) are fully testable offline.
import { spawnSync } from 'node:child_process';
import { truncate } from '../util.js';
import { GitHubClient } from './github.js';
import { GitLabClient } from './gitlab.js';

// ── Remote parsing (pure) ────────────────────────────────────────────────────

function hostPath(host, path) {
  const segs = String(path).split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const h = host.toLowerCase();
  if (h === 'github.com') return { host: h, owner: segs[0], repo: segs.slice(0, 2).join('/'), segments: segs.length };
  if (h === 'gitlab.com') return { host: h, owner: segs.slice(0, -1).join('/'), repo: segs.join('/'), segments: segs.length };
  return { host: h, owner: segs[0], repo: segs.slice(0, 2).join('/'), segments: segs.length };
}

/** Any common remote URL → {host, owner, repo} (null when unparseable). */
export function repoFromRemote(url) {
  const s = String(url || '').trim().replace(/\.git\/?$/, '');
  if (!s) return null;
  let m;
  // scp-like: git@host:owner/repo (host may not carry a scheme)
  if ((m = s.match(/^[^@/]+@([^:/]+):(.+)$/))) return hostPath(m[1], m[2]);
  // scheme URLs: https://host/o/r, ssh://git@host:2222/o/r
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const hm = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);
    if (!hm) return null;
    return hostPath(hm[1], hm[2]);
  }
  return null;
}

/**
 * Remote URLs may embed credentials (https://user:TOKEN@github.com/…) —
 * they must NEVER reach an error message, the transcript, or the model.
 */
export function sanitizeRemote(url) {
  return String(url || '')
    .replace(/^([^/@:]+:)?\/\/[^@/]*@/, (_m, scheme) => `${scheme || ''}//***@`)
    .replace(/^(?:[^@/:\s]+)@([^:]+):/, '***@$1:');
}

/** Extract a credential embedded in the remote URL (user's own git auth). */
export function embeddedToken(url) {
  const s = String(url || '');
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:([^:/@]+)(?::([^@/]*))?|([^:/@]+))@/i);
  if (!m) return '';
  return String(m[2] || m[3] || m[1] || '').trim();
}

// ── Provider resolution ──────────────────────────────────────────────────────

export const GH_OPS = {
  pr_view: { desc: 'one PR/MR: title, branches, state, author, body head', write: false },
  pr_list: { desc: 'open PRs/MRs, newest first (optional branch filter)', write: false },
  pr_comments: { desc: 'inline review comments of a PR/MR, grouped by file, replies folded', write: false },
  ci_runs: { desc: 'latest CI run per branch — or every run of one branch', write: false },
  pr_create: { desc: 'open a PR/MR: title + branch (head) + base', write: true },
  pr_comment: { desc: 'post a general comment on a PR/MR', write: true },
  pr_review: { desc: 'submit a review: event APPROVE|REQUEST_CHANGES|COMMENT + inline comments', write: true },
};

const GITHUB_TOKEN_KEYS = ['BUDDY_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];
const GITLAB_TOKEN_KEYS = ['BUDDY_GITLAB_TOKEN', 'GITLAB_TOKEN'];

export function providerName(p) {
  return p === 'gitlab' ? 'GitLab' : 'GitHub';
}

function defaultGetRemote(root) {
  const r = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, out: '', err: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
  return { ok: true, out: (r.stdout || '').trim() };
}

function firstToken(env, keys) {
  for (const k of keys) if (env[k] && String(env[k]).trim()) return String(env[k]).trim();
  return '';
}

/**
 * Where does this repo's code forge live? Pure (getRemote injectable).
 * Token priority: explicit env (BUDDY_* → generic) > credential embedded in
 * the origin URL (the user's own git auth — many https remotes carry a PAT).
 * The raw remote URL NEVER appears in any message — sanitizeRemote() only.
 */
export function resolveGh({ root, env = process.env, getRemote = defaultGetRemote } = {}) {
  const r = getRemote(root);
  if (!r || !r.ok) return { error: `no origin remote (${r?.err || 'git remote get-url origin failed'}) — the gh tool drives GitHub/GitLab for THIS repository` };
  const remoteUrl = r.out || '';
  const parsed = repoFromRemote(remoteUrl);
  if (!parsed) return { error: `cannot read a GitHub/GitLab repo out of origin remote "${sanitizeRemote(remoteUrl)}"` };
  const ghApi = env.BUDDY_GITHUB_API ? String(env.BUDDY_GITHUB_API) : '';
  const glApi = env.BUDDY_GITLAB_API ? String(env.BUDDY_GITLAB_API) : '';
  let provider = null;
  if (parsed.host === 'github.com') provider = 'github';
  else if (parsed.host === 'gitlab.com') provider = 'gitlab';
  else if (glApi) provider = 'gitlab';
  else if (ghApi) provider = 'github';
  else {
    return {
      error: `origin host "${parsed.host}" is not github.com / gitlab.com — self-hosted? export BUDDY_GITHUB_API (Enterprise) or BUDDY_GITLAB_API (GitLab) and retry`,
    };
  }
  const keys = provider === 'github' ? GITHUB_TOKEN_KEYS : GITLAB_TOKEN_KEYS;
  const token = firstToken(env, keys) || embeddedToken(remoteUrl);
  const apiBase = provider === 'github' ? ghApi || 'https://api.github.com' : glApi || 'https://gitlab.com/api/v4';
  const client = provider === 'github'
    ? new GitHubClient({ token, repo: parsed.repo, apiBase })
    : new GitLabClient({ token, repo: parsed.repo, apiBase });
  return { provider, host: parsed.host, owner: parsed.owner, repo: parsed.repo, token, apiBase, client };
}

// ── Time (pure) ──────────────────────────────────────────────────────────────

export function ago(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── CI runs (normalize → rows) ───────────────────────────────────────────────

/** provider-agnostic state: success|failed|running|queued|cancelled|skipped|other */
export function normalizeRun(raw, provider) {
  if (!raw) return null;
  if (provider === 'gitlab') {
    const map = { success: 'success', failed: 'failed', canceled: 'cancelled', skipped: 'skipped', manual: 'queued', scheduled: 'queued', running: 'running' };
    return {
      branch: raw.ref || '?',
      name: `#${raw.id}${raw.sha ? ` · ${String(raw.sha).slice(0, 7)}` : ''}`,
      state: map[raw.status] || 'queued',
      url: raw.web_url || '',
      at: raw.created_at || raw.updated_at || '',
    };
  }
  const status = raw.status || '';
  const concl = raw.conclusion || '';
  let state;
  if (status === 'in_progress') state = 'running';
  else if (status === 'queued' || status === 'waiting' || status === 'pending') state = 'queued';
  else if (status === 'completed') {
    state = concl === 'success' ? 'success' : concl === 'failure' || concl === 'timed_out' || concl === 'startup_failure' ? 'failed' : concl === 'cancelled' ? 'cancelled' : concl === 'skipped' || concl === 'neutral' ? 'skipped' : 'other';
  } else state = 'queued';
  return {
    branch: raw.head_branch || '?',
    name: `${raw.name || 'run'}${raw.run_number ? ` · #${raw.run_number}` : ''}`,
    state,
    url: raw.html_url || '',
    at: raw.created_at || '',
  };
}

/** Newest row per branch (input is newest-first from both providers). */
export function latestRunPerBranch(runs) {
  const seen = new Map();
  for (const r of runs || []) if (!seen.has(r.branch)) seen.set(r.branch, r);
  return [...seen.values()];
}

export function runsRows(raw, provider, { all = false } = {}) {
  const list = Array.isArray(raw?.workflow_runs) ? raw.workflow_runs : Array.isArray(raw) ? raw : [];
  const norm = list.map((r) => normalizeRun(r, provider)).filter(Boolean);
  return all ? norm : latestRunPerBranch(norm);
}

const STATE_GLYPH = { success: '✓', failed: '✗', running: '●', queued: '○', cancelled: '⊘', skipped: '·', other: '?' };

export function formatRunsPlain(rows, { branch } = {}) {
  if (!rows.length) return branch ? `no CI runs for branch "${branch}"` : 'no CI runs found';
  const head = branch ? `ci runs on ${branch} (newest first):` : 'latest ci run per branch:';
  return [head, ...rows.map((r) => `  ${STATE_GLYPH[r.state] || '?'} ${r.branch} — ${r.name} · ${r.state} · ${ago(r.at)}${r.url ? ` · ${r.url}` : ''}`)].join('\n');
}

// ── PRs / MRs ────────────────────────────────────────────────────────────────

export function prRow(raw, provider) {
  if (!raw) return null;
  if (provider === 'gitlab') {
    return {
      number: raw.iid,
      title: raw.title || '',
      branch: raw.source_branch || '?',
      base: raw.target_branch || '?',
      author: raw.author?.username || '?',
      draft: !!raw.draft,
      url: raw.web_url || '',
      at: raw.updated_at || '',
    };
  }
  return {
    number: raw.number,
    title: raw.title || '',
    branch: raw.head?.ref || '?',
    base: raw.base?.ref || '?',
    author: raw.user?.login || '?',
    draft: !!raw.draft,
    url: raw.html_url || '',
    at: raw.updated_at || '',
  };
}

export function formatPrsPlain(rows, { branch } = {}) {
  if (!rows.length) return branch ? `no open PR/MR from branch "${branch}"` : 'no open PRs/MRs';
  return ['open PRs (newest first):', ...rows.map((r) => `  #${r.number} ${r.draft ? '[draft] ' : ''}${r.title} (${r.branch} → ${r.base} · ${r.author} · ${ago(r.at)})`)].join('\n');
}

export function formatPrPlain(p) {
  if (!p) return 'PR not found';
  return [
    `#${p.number} ${p.draft ? '[draft] ' : ''}${p.title}`,
    `  ${p.branch} → ${p.base} · by ${p.author} · updated ${ago(p.at)}${p.url ? ` · ${p.url}` : ''}`,
  ].join('\n');
}

// ── Review comments ──────────────────────────────────────────────────────────

export function normalizeComment(raw, provider) {
  if (!raw) return null;
  if (provider === 'gitlab') {
    const pos = raw.position && raw.position.position_type === 'text' ? raw.position : null;
    return {
      id: raw.id,
      author: raw.author?.username || '?',
      body: raw.body || '',
      file: pos?.new_path || pos?.old_path || '',
      line: pos ? (pos.new_line ?? pos.old_line ?? null) : null,
      url: '',
      at: raw.created_at || '',
      inReplyTo: null,
      resolved: raw.resolved === true ? true : undefined,
    };
  }
  return {
    id: raw.id,
    author: raw.user?.login || '?',
    body: raw.body || '',
    file: raw.path || '',
    line: raw.line ?? raw.original_line ?? null,
    url: raw.html_url || '',
    at: raw.created_at || '',
    inReplyTo: raw.in_reply_to_id ?? null,
  };
}

/** Full pipeline for a provider's RAW review comments:
 * normalize → split inline/general → nest replies under their root parent.
 */
export function organizeComments(rawComments, provider) {
  const norm = (rawComments || []).map((c) => normalizeComment(c, provider)).filter(Boolean);
  const byId = new Map(norm.map((c) => [c.id, { ...c, replies: [] }]));
  // Deep chains fold to the ROOT parent — display stays one level deep
  // (GitHub-style). Cycle-safe (defensive; the API can't produce cycles).
  const rootOf = (node) => {
    let cur = node;
    const seen = new Set();
    while (cur.inReplyTo && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = byId.get(cur.inReplyTo);
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  const roots = [];
  for (const n of norm) {
    const node = byId.get(n.id);
    let attached = false;
    if (n.inReplyTo) {
      const p = byId.get(n.inReplyTo);
      if (p && p !== node) {
        const root = rootOf(p);
        if (root !== node) {
          root.replies.push(node);
          attached = true;
        }
      }
    }
    if (!attached) roots.push(node);
  }
  const inline = roots.filter((c) => c.file);
  const general = roots.filter((c) => !c.file);
  // preserve file order of first appearance
  const files = [];
  for (const c of inline) if (!files.includes(c.file)) files.push(c.file);
  const groups = files.map((f) => ({ file: f, items: inline.filter((c) => c.file === f) }));
  return { groups, general };
}

export function formatCommentsPlain({ pr, title, groups, general, bodies }) {
  const countAll = (items) => items.reduce((a, c) => a + 1 + countAll(c.replies || []), 0);
  const nInline = groups.reduce((a, g) => a + countAll(g.items), 0);
  const out = [`pr #${pr}${title ? ` "${title}"` : ''} — ${nInline} inline comment${nInline === 1 ? '' : 's'}, ${general.length} general`];
  for (const g of groups) {
    out.push('');
    out.push(`  ${g.file}`);
    for (const c of g.items) {
      out.push(`    @${c.author}${c.line ? ` (L${c.line})` : ''}${c.at ? ` · ${ago(c.at)}` : ''}: ${truncate(c.body.replace(/\s+/g, ' ').trim(), 300)}`);
      for (const r of c.replies || []) {
        out.push(`      └ @${r.author}: ${truncate(r.body.replace(/\s+/g, ' ').trim(), 240)}`);
      }
    }
  }
  if (general.length) {
    out.push('');
    out.push('  general comments:');
    for (const c of general) out.push(`    @${c.author}${c.at ? ` · ${ago(c.at)}` : ''}: ${truncate(c.body.replace(/\s+/g, ' ').trim(), 300)}`);
  }
  if (bodies?.length) {
    out.push('');
    out.push('  review bodies:');
    for (const b of bodies) {
      if (!b || !(b.body || '').trim()) continue;
      out.push(`    @${b.user?.login || '?'} · ${b.state || 'COMMENTED'}${b.submitted_at ? ` · ${ago(b.submitted_at)}` : ''}: ${truncate(String(b.body).replace(/\s+/g, ' ').trim(), 240)}`);
    }
  }
  if (!nInline && !general.length) out.push('  (no review comments yet)');
  return out.join('\n');
}

// ── Fetch helpers (shared by the tool and the slash commands) ────────────────

/** CI rows for /ci + the gh tool. branch=null → latest per branch. */
export async function ghCiRows(g, { branch, all = false } = {}) {
  if (g.provider === 'gitlab') {
    const raw = await g.client.listPipelines({ ref: branch || undefined });
    return runsRows(raw, 'gitlab', { all: all || !!branch });
  }
  const raw = await g.client.listActionRuns({ branch: branch || undefined });
  return runsRows(raw, 'github', { all: all || !!branch });
}

/** Find the open PR/MR of a branch (null when none). */
export async function ghPrForBranch(g, branch) {
  if (!branch) return null;
  if (g.provider === 'gitlab') {
    const mrs = await g.client.listMrs({ sourceBranch: branch, perPage: 5 });
    return mrs?.[0] || null;
  }
  const prs = await g.client.listOpenPulls({ head: `${g.owner}:${branch}` });
  return prs?.[0] || null;
}

/** Everything /pr-comments needs: pr rows + grouped comments (+ review bodies). */
export async function ghPrComments(g, { pr, branch } = {}) {
  let pull = null;
  let number = Number(pr) || 0;
  if (number) pull = g.provider === 'gitlab' ? await g.client.getMr(number) : await g.client.getPull(number);
  else {
    pull = await ghPrForBranch(g, branch);
    if (!pull) return { error: branch ? `no open PR/MR from branch "${branch}" — pass a number: /pr-comments 7` : 'pass a PR number: /pr-comments 7 (or check out the PR branch first)' };
    number = g.provider === 'gitlab' ? pull.iid : pull.number;
  }
  const row = prRow(pull, g.provider);
  let rawComments, bodies = [];
  if (g.provider === 'gitlab') {
    rawComments = await g.client.listMrNotes(number);
  } else {
    [rawComments, bodies] = await Promise.all([g.client.listReviewComments(number), g.client.listReviews(number)]);
  }
  const org = organizeComments(rawComments, g.provider);
  return { pr: number, row, ...org, bodies };
}

// ── The op dispatcher (never throws — observation strings) ───────────────────

const REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

export async function ghOp(root, op, args = {}, ctx = {}) {
  const spec = GH_OPS[op];
  if (!spec) {
    return `ERROR: unknown gh op "${op}" — ops: ${Object.keys(GH_OPS).join(', ')}. Reads: pr_view, pr_list, pr_comments, ci_runs. Writes (approval-gated): pr_create, pr_comment, pr_review.`;
  }
  const g = resolveGh({ root, env: ctx.env, getRemote: ctx.getRemote });
  if (g.error) return `ERROR: ${g.error}`;
  const { provider, client, owner, repo } = g;

  try {
    switch (op) {
      case 'pr_view': {
        const n = Number(args.pr);
        if (!n) return 'ERROR: pr_view needs {"pr": <number>}';
        const raw = provider === 'gitlab' ? await client.getMr(n) : await client.getPull(n);
        const row = prRow(raw, provider);
        const body = truncate(String(raw.body || '').replace(/\s+/g, ' ').trim(), 600);
        return `${formatPrPlain(row)}${body ? `\n  body: ${body}` : ''}`;
      }
      case 'pr_list': {
        const branch = args.branch ? String(args.branch) : '';
        const raw = provider === 'gitlab'
          ? await client.listMrs({ sourceBranch: branch || undefined })
          : await client.listOpenPulls({ head: branch ? `${owner}:${branch}` : undefined });
        const rows = (raw || []).map((p) => prRow(p, provider)).filter(Boolean);
        return `${providerName(provider)} ${repo} · ${formatPrsPlain(rows, { branch })}`;
      }
      case 'pr_comments': {
        const n = Number(args.pr) || 0;
        if (!n && !args.branch) return 'ERROR: pr_comments needs {"pr": <number>} (or {"branch": "…"} to find the branch\'s PR)';
        const data = await ghPrComments({ ...g }, { pr: n, branch: args.branch ? String(args.branch) : '' });
        if (data.error) return `ERROR: ${data.error}`;
        // bodies render inside formatCommentsPlain (v0.35.0) — no second block
        return `${providerName(provider)} ${repo} · ${formatCommentsPlain(data)}`;
      }
      case 'ci_runs': {
        const branch = args.branch ? String(args.branch) : '';
        const rows = await ghCiRows({ ...g }, { branch, all: !!branch || !!args.all });
        return `${providerName(provider)} ${repo} · ${formatRunsPlain(rows, { branch })}`;
      }
      case 'pr_create': {
        const title = String(args.title || '').trim();
        const branch = String(args.branch || '').trim();
        const base = String(args.base || '').trim();
        if (!title || !branch || !base) return 'ERROR: pr_create needs {"title","branch" (head),"base"} — e.g. {"title":"fix: slugify trims input","branch":"fix/slugify","base":"main"}';
        if (branch === base) return `ERROR: head and base are both "${branch}" — push your work to a differently named branch first`;
        const body = String(args.body || '').trim();
        const raw = provider === 'gitlab'
          ? await client.createMr({ source_branch: branch, target_branch: base, title, description: body })
          : await client.createPull({ head: branch, base, title, body });
        const row = prRow(raw, provider);
        return `opened ${providerName(provider)} ${provider === 'gitlab' ? 'MR' : 'PR'} #${row.number}: ${row.title} (${row.branch} → ${row.base})${row.url ? `\n  ${row.url}` : ''}`;
      }
      case 'pr_comment': {
        const n = Number(args.pr);
        const body = String(args.body || '').trim();
        if (!n || !body) return 'ERROR: pr_comment needs {"pr": <number>, "body": "…"}';
        if (provider === 'gitlab') {
          await client.createMrNote(n, body);
        } else {
          await client.createComment(n, body);
        }
        return `comment posted on ${providerName(provider)} #${n} (${body.length} chars)`;
      }
      case 'pr_review': {
        const n = Number(args.pr);
        if (!n) return 'ERROR: pr_review needs {"pr": <number>}';
        const event = String(args.event || 'COMMENT').toUpperCase();
        if (!REVIEW_EVENTS.has(event)) return `ERROR: event must be one of APPROVE, REQUEST_CHANGES, COMMENT (got "${event}")`;
        const body = String(args.body || '').trim();
        const inline = Array.isArray(args.comments)
          ? args.comments.filter((c) => c && c.path && c.body).map((c) => ({ path: String(c.path), line: Number(c.line) || undefined, body: String(c.body) }))
          : [];
        if (provider === 'gitlab') {
          if (inline.length) return 'ERROR: GitLab inline review comments need the discussions API (not supported yet) — post a general review with {"op":"pr_comment"} instead';
          if (event === 'APPROVE') {
            await client.approveMr(n);
            return `approved ${providerName(provider)} MR #${n}${body ? ` — note posted too` : ''}`;
          }
          if (!body) return 'ERROR: pr_review needs a "body" (or inline comments) to review';
          await client.createMrNote(n, `**${event}**\n\n${body}`);
          return `review (${event}) posted on ${providerName(provider)} MR #${n}`;
        }
        if (!body && !inline.length) return 'ERROR: pr_review needs a "body" and/or inline comments [{"path","line","body"}]';
        await client.createReview(n, { body, event, comments: inline });
        return `review ${event} submitted on ${providerName(provider)} PR #${n} (${inline.length} inline comment${inline.length === 1 ? '' : 's'}${body ? `, ${body.length}-char body` : ''})`;
      }
      default:
        return `ERROR: op "${op}" has no handler`;
    }
  } catch (e) {
    return `ERROR: gh ${op} (${providerName(provider)} ${repo}): ${truncate(e.message, 300)}`;
  }
}

// ── Registry-ready tool def ──────────────────────────────────────────────────

export function buildGhTool({ root = process.cwd(), env = process.env, httpMs, maxCalls = 8 } = {}) {
  return {
    name: 'gh',
    description:
      'GitHub/GitLab over REST with the USER token from the env (zero-dep; provider + repo auto-detected from the origin remote): PR/MR view·list·comments·create·comment·review and CI run status. Read ops are free; write ops (pr_create / pr_comment / pr_review) go through the approval gate.',
    args:
      '{"op":"pr_view","pr":7} · {"op":"pr_comments","pr":7} · {"op":"ci_runs"} · {"op":"ci_runs","branch":"main"} · {"op":"pr_list"} · {"op":"pr_create","title":"fix: …","branch":"fix/x","base":"main","body":"…"} · {"op":"pr_comment","pr":7,"body":"…"} · {"op":"pr_review","pr":7,"event":"REQUEST_CHANGES","body":"…","comments":[{"path":"src/a.js","line":12,"body":"…"}]}',
    maxCalls,
    render: (a) => `gh ${a?.op || '?'}${a?.pr ? ` #${a.pr}` : ''}${a?.branch ? ` ${a.branch}` : ''}`,
    riskyWhen: (a) => !!GH_OPS[String(a?.op || '')]?.write,
    run: async (a = {}) => ghOp(root, String(a?.op || ''), a, { env, httpMs }),
  };
}
