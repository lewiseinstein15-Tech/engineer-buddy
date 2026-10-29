// ghapi.test.js — v0.35.0 the GitHub/GitLab API tool (checklist §6 + §9).
// Pure halves offline: remote parsing (incl. credential-bearing URLs), the
// SECURITY contract (an embedded token never reaches a message), provider
// resolution, run/comment/PR normalization + formatting, reply folding, and
// the op dispatcher against a stubbed global fetch (both providers).
// Repl wiring is pinned with source tripwires (the REPL needs a TTY).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repoFromRemote, sanitizeRemote, embeddedToken, resolveGh, GH_OPS,
  normalizeRun, latestRunPerBranch, runsRows, formatRunsPlain,
  prRow, formatPrsPlain, formatPrPlain,
  normalizeComment, organizeComments, formatCommentsPlain,
  ghCiRows, ghPrComments, ghOp, buildGhTool, ago,
} from '../src/tools/ghapi.js';
import { GitLabClient, gitlabProjectId } from '../src/tools/gitlab.js';
import { GitHubClient } from '../src/tools/github.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Remote parsing ───────────────────────────────────────────────────────────

describe('repoFromRemote', () => {
  test('scp-like, https, ssh with port, nested gitlab groups, username-only https', () => {
    assert.deepEqual(repoFromRemote('git@github.com:acme/widgets.git'), { host: 'github.com', owner: 'acme', repo: 'acme/widgets', segments: 2 });
    assert.deepEqual(repoFromRemote('https://github.com/acme/widgets'), { host: 'github.com', owner: 'acme', repo: 'acme/widgets', segments: 2 });
    assert.deepEqual(repoFromRemote('ssh://git@git.corp:2222/team/proj.git'), { host: 'git.corp', owner: 'team', repo: 'team/proj', segments: 2 });
    const gl = repoFromRemote('https://gitlab.com/group/sub/api.git');
    assert.equal(gl.repo, 'group/sub/api');
    assert.equal(gl.owner, 'group/sub');
    const gl2 = repoFromRemote('https://oauth2:TOKEN@gitlab.com/grp/repo.git');
    assert.equal(gl2.repo, 'grp/repo'); // credentials never confuse the path
  });

  test('unparseable shapes → null', () => {
    assert.equal(repoFromRemote(''), null);
    assert.equal(repoFromRemote('/local/path/only'), null);
    assert.equal(repoFromRemote('https://host/one-segment'), null);
    assert.equal(repoFromRemote(null), null);
  });
});

describe('sanitizeRemote — the token can NEVER reach a message', () => {
  test('https with user:token, username-only token, scp-like, plain', () => {
    assert.equal(sanitizeRemote('https://alice:ghp_SECRET123@github.com/acme/w.git'), 'https://***@github.com/acme/w.git');
    assert.equal(sanitizeRemote('https://ghp_SECRET123@gitlab.com/grp/w.git'), 'https://***@gitlab.com/grp/w.git');
    assert.equal(sanitizeRemote('git@github.com:acme/w.git'), '***@github.com:acme/w.git');
    assert.equal(sanitizeRemote('https://github.com/acme/w.git'), 'https://github.com/acme/w.git');
  });
  test('embeddedToken: password form, username-only form, absent', () => {
    assert.equal(embeddedToken('https://alice:ghp_SEC@github.com/a/b.git'), 'ghp_SEC');
    assert.equal(embeddedToken('https://TOKEN@gitlab.com/a/b.git'), 'TOKEN');
    assert.equal(embeddedToken('git@github.com:a/b.git'), '');
    assert.equal(embeddedToken('https://github.com/a/b.git'), '');
  });
});

// ── Provider resolution ──────────────────────────────────────────────────────

describe('resolveGh', () => {
  const ok = (out) => () => ({ ok: true, out });

  test('github.com remote + env token', () => {
    const g = resolveGh({ root: '/x', env: { BUDDY_GITHUB_TOKEN: 't1' }, getRemote: ok('git@github.com:acme/widgets.git') });
    assert.equal(g.provider, 'github');
    assert.equal(g.repo, 'acme/widgets');
    assert.equal(g.token, 't1');
    assert.equal(g.apiBase, 'https://api.github.com');
    assert.ok(g.client instanceof GitHubClient);
  });

  test('embedded remote credential is the fallback token (env still wins)', () => {
    const g = resolveGh({ root: '/x', env: {}, getRemote: ok('https://alice:ghp_EMBED@github.com/acme/w.git') });
    assert.equal(g.token, 'ghp_EMBED');
    const g2 = resolveGh({ root: '/x', env: { GITHUB_TOKEN: 'env-wins' }, getRemote: ok('https://alice:ghp_EMBED@github.com/acme/w.git') });
    assert.equal(g2.token, 'env-wins');
  });

  test('gitlab.com remote, private token, GITLAB fallback key', () => {
    const g = resolveGh({ root: '/x', env: { GITLAB_TOKEN: 'gl1' }, getRemote: ok('https://gitlab.com/group/sub/api.git') });
    assert.equal(g.provider, 'gitlab');
    assert.equal(g.repo, 'group/sub/api');
    assert.equal(g.apiBase, 'https://gitlab.com/api/v4');
    assert.ok(g.client instanceof GitLabClient);
  });

  test('self-hosted hosts route via the API env overrides', () => {
    const g = resolveGh({ root: '/x', env: { BUDDY_GITLAB_API: 'https://git.corp/api/v4' }, getRemote: ok('ssh://git@git.corp/team/proj.git') });
    assert.equal(g.provider, 'gitlab');
    assert.equal(g.apiBase, 'https://git.corp/api/v4');
    const g2 = resolveGh({ root: '/x', env: { BUDDY_GITHUB_API: 'https://ghe.corp/api/v3' }, getRemote: ok('ssh://git@ghe.corp/team/proj.git') });
    assert.equal(g2.provider, 'github');
    assert.equal(g2.apiBase, 'https://ghe.corp/api/v3');
  });

  test('errors: no remote, unknown host, unparseable — and NO raw URL leaks', () => {
    const e1 = resolveGh({ root: '/x', env: {}, getRemote: () => ({ ok: false, err: 'fatal: no origin' }) });
    assert.match(e1.error, /no origin remote/);
    const e2 = resolveGh({ root: '/x', env: {}, getRemote: ok('https://svn.corp/foo/bar') });
    assert.match(e2.error, /BUDDY_GITHUB_API/);
    const e3 = resolveGh({ root: '/x', env: {}, getRemote: ok('nonsense') });
    assert.match(e3.error, /cannot read a GitHub\/GitLab repo/);
    // The security tripwire: even a malformed URL with credentials must not echo them.
    const e4 = resolveGh({ root: '/x', env: {}, getRemote: ok('https://alice:ghp_SUPERSECRET@hostwithnoparse') });
    assert.equal((e4.error || '').includes('ghp_SUPERSECRET'), false);
    assert.equal(JSON.stringify({ e1, e2, e3, e4 }).includes('ghp_SUPERSECRET'), false);
  });
});

// ── Time ─────────────────────────────────────────────────────────────────────

describe('ago', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  test('buckets', () => {
    assert.equal(ago(new Date(now - 30e3).toISOString(), now), 'just now');
    assert.equal(ago(new Date(now - 5 * 60e3).toISOString(), now), '5m ago');
    assert.equal(ago(new Date(now - 3 * 3600e3).toISOString(), now), '3h ago');
    assert.equal(ago(new Date(now - 2 * 86400e3).toISOString(), now), '2d ago');
    assert.equal(ago('not-a-date', now), '');
  });
});

// ── CI runs ──────────────────────────────────────────────────────────────────

describe('normalizeRun + rows', () => {
  test('github states', () => {
    assert.equal(normalizeRun({ status: 'in_progress', head_branch: 'main', name: 'CI', run_number: 7, created_at: '2026-01-01T00:00:00Z' }, 'github').state, 'running');
    assert.equal(normalizeRun({ status: 'completed', conclusion: 'success', head_branch: 'main' }, 'github').state, 'success');
    assert.equal(normalizeRun({ status: 'completed', conclusion: 'failure', head_branch: 'main' }, 'github').state, 'failed');
    assert.equal(normalizeRun({ status: 'completed', conclusion: 'cancelled', head_branch: 'b' }, 'github').state, 'cancelled');
    assert.equal(normalizeRun({ status: 'completed', conclusion: 'skipped', head_branch: 'b' }, 'github').state, 'skipped');
    assert.equal(normalizeRun({ status: 'queued', head_branch: 'b' }, 'github').state, 'queued');
  });

  test('gitlab states', () => {
    const gl = (status) => normalizeRun({ id: 42, ref: 'main', sha: 'abcdef123456', status, web_url: 'https://gitlab.com/g/r/-/pipelines/42', created_at: '2026-01-01T00:00:00Z' }, 'gitlab');
    assert.equal(gl('success').state, 'success');
    assert.equal(gl('failed').state, 'failed');
    assert.equal(gl('canceled').state, 'cancelled');
    assert.equal(gl('manual').state, 'queued');
    assert.equal(gl('running').state, 'running');
    const r = gl('success');
    assert.match(r.name, /#42 · abcdef1/);
    assert.match(r.url, /pipelines\/42$/);
  });

  test('latestRunPerBranch dedupes, newest wins; runsRows reads both envelopes', () => {
    const latest = latestRunPerBranch([
      { branch: 'main', name: 'a', state: 'failed', url: 'u1', at: 'x' },
      { branch: 'feat', name: 'b', state: 'success', url: '', at: 'y' },
      { branch: 'main', name: 'older', state: 'success', url: '', at: 'z' },
    ]);
    assert.equal(latest.length, 2);
    assert.equal(latest.find((r) => r.branch === 'main').name, 'a');
    // RAW provider shapes: github envelope + gitlab bare array
    const rawGh = [
      { status: 'completed', conclusion: 'failure', head_branch: 'main', name: 'CI', run_number: 7, created_at: 'x', html_url: 'u1' },
      { status: 'completed', conclusion: 'success', head_branch: 'feat', name: 'CI', run_number: 4, created_at: 'y' },
      { status: 'completed', conclusion: 'success', head_branch: 'main', name: 'CI', run_number: 6, created_at: 'z' },
    ];
    const ghRows = runsRows({ workflow_runs: rawGh }, 'github');
    assert.equal(ghRows.length, 2);
    assert.equal(ghRows.find((r) => r.branch === 'main').state, 'failed');
    const rawGl = [
      { id: 3, ref: 'main', sha: 'aaa', status: 'failed', web_url: '', created_at: 'x' },
      { id: 2, ref: 'feat', sha: 'bbb', status: 'success', web_url: '', created_at: 'y' },
      { id: 1, ref: 'main', sha: 'ccc', status: 'success', web_url: '', created_at: 'z' },
    ];
    const glRows = runsRows(rawGl, 'gitlab');
    assert.equal(glRows.length, 2);
    assert.equal(glRows.find((r) => r.branch === 'main').state, 'failed');
  });

  test('formatRunsPlain: branch filter message + row shape', () => {
    assert.match(formatRunsPlain([], { branch: 'main' }), /no CI runs for branch "main"/);
    const s = formatRunsPlain([{ branch: 'main', name: 'CI · #7', state: 'failed', url: 'https://u', at: new Date(Date.now() - 3600e3).toISOString() }]);
    assert.match(s, /latest ci run per branch:/);
    assert.match(s, /✗ main — CI · #7 · failed · 1h ago · https:\/\/u/);
  });
});

// ── PRs / MRs ────────────────────────────────────────────────────────────────

describe('prRow / formatters', () => {
  test('github + gitlab shapes', () => {
    const gh = prRow({ number: 7, title: 'fix: trim', draft: true, head: { ref: 'fix/trim' }, base: { ref: 'main' }, user: { login: 'al' }, html_url: 'u', updated_at: '2026-01-01T00:00:00Z' }, 'github');
    assert.equal(gh.number, 7);
    assert.equal(gh.branch, 'fix/trim');
    assert.equal(gh.draft, true);
    const gl = prRow({ iid: 3, title: 'fix: trim', source_branch: 'fix/trim', target_branch: 'main', author: { username: 'al' }, web_url: 'u', updated_at: '2026-01-01T00:00:00Z' }, 'gitlab');
    assert.equal(gl.number, 3);
    assert.equal(gl.base, 'main');
  });

  test('plain formatters', () => {
    assert.match(formatPrsPlain([], { branch: 'x' }), /no open PR\/MR from branch "x"/);
    const rows = [{ number: 7, title: 'fix: trim', branch: 'f', base: 'main', author: 'al', draft: false, url: '', at: '2026-01-01T00:00:00Z' }];
    const s = formatPrsPlain(rows, {});
    assert.match(s, /#7 fix: trim \(f → main · al ·/);
    const one = formatPrPlain(rows[0]);
    assert.match(one, /^#7 fix: trim/);
  });
});

// ── Review comments ──────────────────────────────────────────────────────────

describe('organizeComments — grouping + reply folding', () => {
  const ghRaw = [
    { id: 1, user: { login: 'alice' }, body: 'trim the input', path: 'src/fmt.js', line: 12, html_url: 'u1', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, user: { login: 'bob' }, body: '+1 also tabs', path: 'src/fmt.js', line: 12, in_reply_to_id: 1, html_url: 'u2', created_at: '2026-01-01T00:01:00Z' },
    { id: 3, user: { login: 'carol' }, body: 'reply to reply', path: 'src/fmt.js', line: 12, in_reply_to_id: 2, html_url: 'u3', created_at: '2026-01-01T00:02:00Z' },
    { id: 4, user: { login: 'dave' }, body: 'orphan reply — parent was deleted', path: 'src/fmt.js', line: 12, in_reply_to_id: 99, created_at: '2026-01-01T00:03:00Z' },
    { id: 5, user: { login: 'erin' }, body: 'file-less general remark', created_at: '2026-01-01T00:04:00Z' },
  ];

  test('inline vs general split, chains fold to the ROOT parent, orphans survive', () => {
    const { groups, general } = organizeComments(ghRaw, 'github');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].file, 'src/fmt.js');
    const roots = groups[0].items;
    assert.equal(roots.length, 2); // #1 (with replies) + #4 (orphan)
    assert.equal(roots[0].author, 'alice');
    assert.equal(roots[0].replies.length, 2); // bob AND carol nested to root
    assert.equal(roots[0].replies[1].author, 'carol');
    assert.equal(roots[1].author, 'dave');
    assert.equal(general.length, 1);
    assert.equal(general[0].author, 'erin');
  });

  test('gitlab positions: new_path/new_line, no reply folding', () => {
    const { groups, general } = organizeComments([
      { id: 10, author: { username: 'al' }, body: 'note text', created_at: '2026-01-01T00:00:00Z', position: { position_type: 'text', new_path: 'app.py', new_line: 30, old_path: 'app.py' } },
      { id: 11, author: { username: 'sy' }, body: 'system event — should be filtered by the client, but tolerated here', created_at: '2026-01-01T00:01:00Z' },
    ], 'gitlab');
    assert.equal(groups[0].file, 'app.py');
    assert.equal(groups[0].items[0].line, 30);
    assert.equal(general.length, 1);
  });

  test('normalizeComment github: line falls back to original_line', () => {
    const n = normalizeComment({ id: 1, user: { login: 'x' }, body: 'b', path: 'p', original_line: 44, created_at: '2026-01-01T00:00:00Z' }, 'github');
    assert.equal(n.line, 44);
  });

  test('formatCommentsPlain shape', () => {
    const { groups, general } = organizeComments(ghRaw, 'github');
    const s = formatCommentsPlain({ pr: 7, title: 'fix: trim', groups, general });
    assert.match(s, /pr #7 "fix: trim" — 4 inline comments, 1 general/);
    assert.match(s, /src\/fmt\.js/);
    assert.match(s, /@alice \(L12\).*trim the input/);
    assert.match(s, /└ @bob: \+1 also tabs/);
    assert.match(s, /└ @carol: reply to reply/);
    assert.match(s, /general comments:/);
    assert.match(formatCommentsPlain({ pr: 2, title: '', groups: [], general: [] }), /no review comments yet/);
    // review bodies ride in the attach text — the model needs them to act
    const withBodies = formatCommentsPlain({ pr: 7, title: 't', groups: [], general: [], bodies: [{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'please fix', submitted_at: '2026-01-01T00:00:00Z' }, { user: { login: 'x' }, state: 'COMMENTED', body: '' }] });
    assert.match(withBodies, /review bodies:/);
    assert.match(withBodies, /@bob · CHANGES_REQUESTED.*please fix/);
    assert.equal((withBodies.match(/· COMMENTED/g) || []).length, 0); // empty bodies dropped
  });
});

// ── Clients against a stubbed fetch ──────────────────────────────────────────

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler({ url: String(url), opts });
  };
  return calls;
}

function jsonRes(body, status = 200, headers = {}) {
  return { ok: status < 400, status, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
}

describe('GitHubClient v0.35 reads (stubbed fetch)', () => {
  test('WRITES never auto-retry: a timed-out POST may have landed — exactly one request', async () => {
    // The v0.35.0 drill caught the old behavior red-handed: one pr_comment
    // with a dead-upstream transport produced NINE identical POSTs (3 model
    // calls × 3 client retries) on the mock's posted.log. A write that timed
    // out MAY have succeeded server-side — resending it can double-post
    // comments or open duplicate PRs. Contract: writes fail fast (1 request),
    // the error surfaces honestly, the model/user decides on a retry.
    const calls = stubFetch(() => { throw new Error('timeout after 30000ms'); });
    const c = new GitHubClient({ token: 't', repo: 'acme/w' });
    await assert.rejects(() => c.createComment(7, 'hello'), /network error/);
    assert.equal(calls.length, 1, 'a write must fire exactly ONE request');
    // and the 5xx twin: state unknown → never resend
    const calls5xx = stubFetch(() => jsonRes({ message: 'boom' }, 502));
    const c2 = new GitHubClient({ token: 't', repo: 'acme/w' });
    await assert.rejects(() => c2.createPull({ head: 'a', base: 'b', title: 't', body: '' }), /502/);
    assert.equal(calls5xx.length, 1, 'a 5xx write must fire exactly ONE request');
    // reads keep their retry resilience (idempotent → safe to resend)
    let n = 0;
    const callsGet = stubFetch(() => (++n < 2 ? jsonRes({ message: 'bad gateway' }, 502) : jsonRes({ total_count: 0, workflow_runs: [] })));
    const c3 = new GitHubClient({ token: 't', repo: 'acme/w' });
    const raw = await c3.listActionRuns({});
    assert.equal(n, 2);
    assert.deepEqual(raw.workflow_runs, []);
  });

  test('listActionRuns sends the branch filter; runsRows parses the envelope', async () => {
    const calls = stubFetch(() => jsonRes({ total_count: 1, workflow_runs: [{ status: 'completed', conclusion: 'failure', head_branch: 'main', name: 'CI', run_number: 3, created_at: '2026-01-01T00:00:00Z', html_url: 'https://run' }] }));
    const c = new GitHubClient({ token: 't', repo: 'acme/w' });
    const rows = await ghCiRows({ provider: 'github', client: c }, {});
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/w/actions/runs?per_page=30');
    assert.equal(rows[0].state, 'failed');
    assert.equal(rows[0].branch, 'main');
    const c2 = new GitHubClient({ token: 't', repo: 'acme/w' });
    await ghCiRows({ provider: 'github', client: c2 }, { branch: 'feat/x' });
    assert.match(calls[1].url, /branch=feat%2Fx/);
  });

  test('bad embedded token: GETs retry anonymously — public reads survive', async () => {
    const calls = stubFetch(() => {
      // first call (with the bad token) → 401; retry (anonymous) → 200
      calls.n = (calls.n || 0) + 1;
      return calls.n === 1 ? jsonRes({ message: 'Bad credentials' }, 401) : jsonRes({ total_count: 0, workflow_runs: [] });
    });
    const c = new GitHubClient({ token: 'bad-token', repo: 'acme/w' });
    const raw = await c.listActionRuns({});
    assert.equal(calls.n, 2);
    assert.deepEqual(raw.workflow_runs, []);
    const calls2 = stubFetch(() => {
      calls2.n = (calls2.n || 0) + 1;
      return jsonRes({ message: 'Bad credentials' }, 401);
    });
    // non-GET (write) does NOT retry anonymously — the real 401 surfaces
    const failed = await ghOp('/r', 'pr_comment', { pr: 7, body: 'x' }, { env: {}, getRemote: () => ({ ok: true, out: 'https://alice:bad-token@github.com/acme/w.git' }) });
    assert.equal(calls2.n, 1);
    assert.match(failed, /ERROR: gh pr_comment .*401/);
  });

  test('listOpenPulls head filter + review comments pagination', async () => {
    const calls = stubFetch(() => jsonRes([{ number: 7, title: 't' }]));
    const c = new GitHubClient({ token: 't', repo: 'acme/w' });
    const prs = await c.listOpenPulls({ head: 'acme:feat' });
    assert.match(calls[0].url, /pulls\?state=open&sort=updated&direction=desc&head=acme%3Afeat/);
    assert.equal(prs[0].number, 7);
    await c.listReviewComments(7);
    assert.match(calls[1].url, /pulls\/7\/comments\?sort=created&direction=asc&per_page=100&page=1/);
    await c.listReviews(7);
    assert.match(calls[2].url, /pulls\/7\/reviews\?per_page=100&page=1/);
  });
});

describe('GitLabClient (stubbed fetch)', () => {
  test('MR writes never auto-retry (v0.35.0 drill contract, gitlab twin)', async () => {
    const calls = stubFetch(() => { throw new Error('timeout after 30000ms'); });
    const c = new GitLabClient({ token: 'gl-tok', repo: 'group/sub/api' });
    await assert.rejects(() => c.createMrNote(3, 'hello'), /network error/);
    assert.equal(calls.length, 1, 'a write must fire exactly ONE request');
  });

  test('project path is URL-encoded; PRIVATE-TOKEN header present', async () => {
    const calls = stubFetch(() => jsonRes([]));
    const c = new GitLabClient({ token: 'gl-tok', repo: 'group/sub/api' });
    assert.equal(gitlabProjectId('group/sub/api'), 'group%2Fsub%2Fapi');
    await c.listMrs({ sourceBranch: 'feat/x' });
    assert.equal(calls[0].url, 'https://gitlab.com/api/v4/projects/group%2Fsub%2Fapi/merge_requests?state=opened&order_by=updated_at&per_page=50&source_branch=feat%2Fx');
    assert.equal(calls[0].opts.headers['PRIVATE-TOKEN'], 'gl-tok');
    await c.listPipelines({ ref: 'main' });
    assert.match(calls[1].url, /pipelines\?order_by=updated_at&per_page=30&ref=main/);
  });

  test('listMrNotes filters system notes; createMr posts the right body', async () => {
    const calls = stubFetch(() => jsonRes([{ id: 1, system: true, body: 'changed title' }, { id: 2, system: false, body: 'human note' }]));
    const c = new GitLabClient({ token: 't', repo: 'g/r' });
    const notes = await c.listMrNotes(5);
    assert.deepEqual(notes.map((n) => n.id), [2]);
    await c.createMr({ source_branch: 'f', target_branch: 'main', title: 'T', description: 'D' });
    assert.equal(calls[1].opts.method, 'POST');
    assert.equal(JSON.parse(calls[1].opts.body).source_branch, 'f');
    await c.approveMr(5);
    assert.match(calls[2].url, /merge_requests\/5\/approve$/);
  });
});

// ── ghOp end-to-end on stubbed fetch ─────────────────────────────────────────

describe('ghOp dispatcher', () => {
  const GH = { BUDDY_GITHUB_TOKEN: 'tok' };
  const GL = { BUDDY_GITLAB_TOKEN: 'gl' };
  const ghRemote = () => ({ ok: true, out: 'git@github.com:acme/widgets.git' });
  const glRemote = () => ({ ok: true, out: 'git@gitlab.com:acme/widgets.git' });

  test('unknown op lists the ops; bad args are honest errors', async () => {
    assert.match(await ghOp('/r', 'nope', {}, { env: GH, getRemote: ghRemote }), /unknown gh op/);
    assert.match(await ghOp('/r', 'pr_view', {}, { env: GH, getRemote: ghRemote }), /needs \{"pr"/);
    assert.match(await ghOp('/r', 'pr_create', { title: 'a', branch: 'b' }, { env: GH, getRemote: ghRemote }), /needs \{"title","branch" \(head\),"base"\}/);
    assert.match(await ghOp('/r', 'pr_create', { title: 'a', branch: 'same', base: 'same' }, { env: GH, getRemote: ghRemote }), /head and base are both/);
    assert.match(await ghOp('/r', 'pr_review', { pr: 1, event: 'LGTM' }, { env: GH, getRemote: ghRemote }), /event must be one of/);
    assert.match(await ghOp('/r', 'pr_review', { pr: 1 }, { env: GH, getRemote: ghRemote }), /needs a "body" and\/or inline comments/);
  });

  test('write ops without a reachable API surface the HTTP error, never throw', async () => {
    stubFetch(() => jsonRes({ message: 'Bad credentials' }, 401));
    const out = await ghOp('/r', 'pr_comment', { pr: 7, body: 'hi' }, { env: GH, getRemote: ghRemote });
    assert.match(out, /ERROR: gh pr_comment \(GitHub acme\/widgets\): .*401/);
  });

  test('pr_view happy path (github)', async () => {
    stubFetch(() => jsonRes({ number: 7, title: 'fix: trim', state: 'open', draft: false, head: { ref: 'f' }, base: { ref: 'main' }, user: { login: 'al' }, html_url: 'https://pr', updated_at: '2026-01-01T00:00:00Z', body: 'the body text' }));
    const out = await ghOp('/r', 'pr_view', { pr: 7 }, { env: GH, getRemote: ghRemote });
    assert.match(out, /#7 fix: trim/);
    assert.match(out, /f → main · by al/);
    assert.match(out, /body: the body text/);
  });

  test('pr_comments happy path (github) folds replies + includes review bodies', async () => {
    let i = 0;
    stubFetch(() => {
      i++;
      if (callsReviewed(i)) return jsonRes([{ id: 1, user: { login: 'alice' }, body: 'fix this', path: 'src/f.js', line: 10, created_at: '2026-01-01T00:00:00Z' }]);
      return jsonRes([{ id: 50, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'please', submitted_at: '2026-01-01T00:00:00Z' }]);
    });
    const callsReviewed = (n) => n === 2;
    const out = await ghOp('/r', 'pr_comments', { pr: 7 }, { env: GH, getRemote: ghRemote });
    assert.match(out, /pr #7 — 1 inline comment, 0 general/);
    assert.match(out, /@alice \(L10\).*fix this/);
    assert.match(out, /review bodies:/);
    assert.match(out, /@bob · CHANGES_REQUESTED/);
    // the bodies block renders EXACTLY once (the v0.35.0 pre-flight caught a double render)
    assert.equal((out.match(/review bodies:/g) || []).length, 1);
  });

  test('ci_runs gitlab path', async () => {
    stubFetch(() => jsonRes([{ id: 9, ref: 'main', sha: 'abcdef123456', status: 'failed', web_url: 'https://gl/p/9', created_at: '2026-01-01T00:00:00Z' }]));
    const out = await ghOp('/r', 'ci_runs', {}, { env: GL, getRemote: glRemote });
    assert.match(out, /GitLab acme\/widgets · latest ci run per branch:/);
    assert.match(out, /✗ main/);
  });

  test('pr_create + pr_comment happy paths', async () => {
    const calls = stubFetch(() => jsonRes({ number: 12, title: 'fix: t', head: { ref: 'f' }, base: { ref: 'main' }, html_url: 'https://pr/12' }));
    const out = await ghOp('/r', 'pr_create', { title: 'fix: t', branch: 'f', base: 'main', body: 'b' }, { env: GH, getRemote: ghRemote });
    assert.match(out, /opened GitHub PR #12: fix: t \(f → main\)/);
    assert.equal(JSON.parse(calls[0].opts.body).head, 'f');
    const out2 = await ghOp('/r', 'pr_comment', { pr: 12, body: 'done' }, { env: GH, getRemote: ghRemote });
    assert.match(out2, /comment posted on GitHub #12 \(4 chars\)/);
    assert.equal(JSON.parse(calls[1].opts.body).body, 'done');
  });

  test('pr_review github posts event + inline comments', async () => {
    const calls = stubFetch(() => jsonRes({ id: 77 }));
    const out = await ghOp('/r', 'pr_review', { pr: 7, event: 'REQUEST_CHANGES', body: 'two issues', comments: [{ path: 'src/a.js', line: 3, body: 'x' }, { body: 'dropped — no path' }] }, { env: GH, getRemote: ghRemote });
    assert.match(out, /review REQUEST_CHANGES submitted on GitHub PR #7 \(1 inline comment, 10-char body\)/);
    const sent = JSON.parse(calls[0].opts.body);
    assert.equal(sent.event, 'REQUEST_CHANGES');
    assert.equal(sent.comments.length, 1);
    assert.equal(sent.comments[0].path, 'src/a.js');
  });

  test('gitlab pr_review: inline comments refuse honestly; APPROVE uses the approve endpoint', async () => {
    const calls = stubFetch(() => jsonRes({}));
    const refused = await ghOp('/r', 'pr_review', { pr: 5, comments: [{ path: 'a', body: 'b' }] }, { env: GL, getRemote: glRemote });
    assert.match(refused, /discussions API \(not supported yet\)/);
    const approved = await ghOp('/r', 'pr_review', { pr: 5, event: 'APPROVE' }, { env: GL, getRemote: glRemote });
    assert.match(approved, /approved GitLab MR #5/);
    assert.match(calls[0].url, /merge_requests\/5\/approve$/);
    const reviewed = await ghOp('/r', 'pr_review', { pr: 5, event: 'COMMENT', body: 'looks good overall' }, { env: GL, getRemote: glRemote });
    assert.match(reviewed, /review \(COMMENT\) posted on GitLab MR #5/);
    assert.match(JSON.parse(calls[1].opts.body).body, /\*\*COMMENT\*\*/);
  });
});

// ── /pr-comments resolution helpers ──────────────────────────────────────────

describe('ghPrComments / ghPrForBranch', () => {
  test('no PR for branch → honest error naming the fix', async () => {
    stubFetch(() => jsonRes([]));
    const g = resolveGh({ root: '/x', env: { BUDDY_GITHUB_TOKEN: 't' }, getRemote: () => ({ ok: true, out: 'git@github.com:acme/w.git' }) });
    const r = await ghPrComments(g, { branch: 'nope' });
    assert.match(r.error, /no open PR\/MR from branch "nope"/);
    const r2 = await ghPrComments(g, {});
    assert.match(r2.error, /pass a PR number/);
  });

  test('branch → PR → comments pipeline (github)', async () => {
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) return jsonRes([{ number: 7, title: 'fix: trim', head: { ref: 'f' }, base: { ref: 'main' }, user: { login: 'al' }, html_url: 'u', updated_at: '2026-01-01T00:00:00Z' }]);
      if (n === 2) return jsonRes([{ id: 1, user: { login: 'alice' }, body: 'trim the input', path: 'src/fmt.js', line: 12, created_at: '2026-01-01T00:00:00Z' }]);
      return jsonRes([]);
    });
    const g = resolveGh({ root: '/x', env: { BUDDY_GITHUB_TOKEN: 't' }, getRemote: () => ({ ok: true, out: 'git@github.com:acme/w.git' }) });
    const data = await ghPrComments(g, { branch: 'fix/trim' });
    assert.equal(data.pr, 7);
    assert.equal(data.row.title, 'fix: trim');
    assert.equal(data.groups[0].file, 'src/fmt.js');
  });
});

// ── Tool def + wiring tripwires ──────────────────────────────────────────────

describe('buildGhTool + repl wiring', () => {
  test('tool def: name, riskyWhen split, render', () => {
    const t = buildGhTool({ root: '/r', env: {} });
    assert.equal(t.name, 'gh');
    assert.match(t.description, /GitHub\/GitLab over REST/);
    assert.match(t.description, /USER token/);
    assert.equal(t.maxCalls, 8);
    assert.equal(t.riskyWhen({ op: 'pr_view' }), false);
    assert.equal(t.riskyWhen({ op: 'ci_runs' }), false);
    for (const w of ['pr_create', 'pr_comment', 'pr_review']) assert.equal(t.riskyWhen({ op: w }), true, `${w} must be gated`);
    assert.equal(t.render({ op: 'pr_comments', pr: 7 }), 'gh pr_comments #7');
    assert.equal(t.render({ op: 'ci_runs', branch: 'main' }), 'gh ci_runs main');
    assert.deepEqual(Object.keys(GH_OPS).sort(), ['ci_runs', 'pr_comment', 'pr_comments', 'pr_create', 'pr_list', 'pr_review', 'pr_view']);
  });

  test('repl tripwires: /ci + /pr-comments registered, busy-safe, attach wired', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/terminal/repl.js'), 'utf8');
    assert.match(src, /'channels', 'dictate', 'voice',\n\]/);                     // SLASH_COMMANDS (v0.51 channels, v0.55 voice)
    assert.match(src, /'terminal-setup', 'permissions', 'ci', 'pr-comments', 'channels', 'channel', 'voice'\]/); // BUSY_OK
    assert.match(src, /case 'ci':/);
    assert.match(src, /case 'pr-comments':/);
    assert.match(src, /lastPrComments = \{ pr: data\.pr/);               // attach capture
    assert.match(src, /\[PR review comments — \$\{providerName\(r\.provider\)\}/); // attach block
    assert.match(src, /buildGhTool\(\{ root \}\)/);                      // tool registered
  });

  test('repl tripwire: the new cases never touch the outer `slash` (handleSlash destructures {name, args})', () => {
    // the v0.35.0 drill caught this live: `slash is not defined` inside
    // handleSlash — the variable only exists in the CALLER's scope.
    const src = fs.readFileSync(path.join(__dirname, '../src/terminal/repl.js'), 'utf8');
    for (const name of ['ci', 'pr-comments']) {
      const m = src.match(new RegExp(`case '${name}': \\{([\\s\\S]*?)\\n      \\}`));
      assert.ok(m, `case '${name}' not found`);
      assert.equal(m[1].includes('slash.'), false, `case '${name}' references slash. inside handleSlash — ReferenceError`);
    }
  });
});
