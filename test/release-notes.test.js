import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReleaseNotes, runReleaseNotes } from '../src/skills/release-notes.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();

test('formatReleaseNotes: sections + contributors', () => {
  const md = formatReleaseNotes({
    title: 'vNext — pools live',
    intro: 'Big one.',
    breaking: [{ pr: 2, entry: 'Wallet API renamed' }],
    features: [{ pr: 3, entry: 'Survivor pools' }],
    fixes: [],
    maintenance: [{ pr: 4, entry: 'Bump deps' }],
    contributors: ['alice', 'bob'],
  }, { since: 'v1.0.0' });
  assert.match(md, /vNext — pools live/);
  assert.match(md, /### ⚠️ Breaking changes/);
  assert.match(md, /Survivor pools \(#3\)/);
  assert.ok(!md.includes('### 🐛 Fixes\n')); // empty section omitted
  assert.match(md, /@alice @bob/);
  assert.match(md, /since `v1\.0\.0`/);
});

function fakeGithub(prs) {
  const calls = { issues: [], comments: [] };
  return {
    calls,
    listMergedPulls: async () => prs,
    createIssue: async (p) => {
      calls.issues.push(p);
      return { number: 77, ...p };
    },
    createComment: async (n, b) => {
      calls.comments.push({ n, b });
      return {};
    },
  };
}

const MERGED = [
  { number: 3, title: 'feat: survivor pools', user: { login: 'alice' }, body: 'adds pools', labels: [{ name: 'feature' }], merged_at: '2026-10-20' },
  { number: 4, title: 'fix: payout race', user: { login: 'bob' }, body: 'atomic now', labels: [], merged_at: '2026-10-21' },
  { number: 5, title: 'chore: cleanup', user: { login: 'alice' }, body: '', labels: [], merged_at: '2026-10-22' },
];

test('release notes: full run creates a draft issue with filtered PR refs', async () => {
  const github = fakeGithub(MERGED);
  const router = {
    chat: async () => ({
      text: JSON.stringify({
        title: 'vNext',
        intro: 'Solid release.',
        features: [{ pr: 3, entry: 'Pools' }],
        fixes: [{ pr: 4, entry: 'Payout race fixed' }],
        maintenance: [{ pr: 999, entry: 'hallucinated' }, { pr: 5, entry: 'Cleanup' }],
        contributors: ['alice', 'bob'],
      }),
      model: 'm', gateway: 'g', latencyMs: 5,
    }),
  };
  const r = await runReleaseNotes({ repoSlug: 'me/demo', github, router, config: cfg, logFn: () => {} });
  assert.equal(r.ok, true);
  const issue = github.calls.issues[0];
  assert.match(issue.title, /Release notes draft/);
  assert.match(issue.body, /Pools \(#3\)/);
  assert.match(issue.body, /Payout race fixed \(#4\)/);
  assert.match(issue.body, /Cleanup \(#5\)/);
  assert.ok(!issue.body.includes('#999')); // hallucinated PR filtered out
});

test('release notes: dry-run + postToIssue', async () => {
  const github = fakeGithub(MERGED);
  const router = { chat: async () => ({ text: JSON.stringify({ title: 'T', features: [{ pr: 3, entry: 'x' }] }), model: 'm', gateway: 'g', latencyMs: 5 }) };
  const r = await runReleaseNotes({ repoSlug: 'me/demo', github, router, config: cfg, dryRun: true, logFn: () => {} });
  assert.equal(r.ok, true);
  assert.equal(github.calls.issues.length, 0);
  assert.equal(github.calls.comments.length, 0);

  const r2 = await runReleaseNotes({ repoSlug: 'me/demo', github, router, config: cfg, postToIssue: 12, logFn: () => {} });
  assert.equal(r2.ok, true);
  assert.deepEqual(github.calls.comments.map((c) => c.n), [12]);
});

test('release notes: empty range → graceful empty', async () => {
  const github = fakeGithub([]);
  const router = { chat: async () => { throw new Error('should not be called'); } };
  const r = await runReleaseNotes({ repoSlug: 'me/demo', github, router, config: cfg, logFn: () => {} });
  assert.equal(r.empty, true);
  assert.match(r.message, /No merged PRs/);
});
