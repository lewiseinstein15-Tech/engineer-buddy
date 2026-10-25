import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTriage, triageCommentBody, runIssueTriage } from '../src/skills/issue-triage.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();

test('normalizeTriage: clamps and prioritizes', () => {
  const t = normalizeTriage({ type: 'bug', priority: 'P1', labels: ['Bug', 'frontend', 'bad label!', 'p9'], response: 'x'.repeat(2000), needs_more_info: 1 });
  assert.equal(t.type, 'bug');
  assert.equal(t.priority, 'p1');
  assert.ok(t.labels.includes('p1'));
  assert.ok(!t.labels.includes('bad label!'));
  assert.ok(!t.labels.includes('p9'));
  assert.equal(t.needs_more_info, true);
  assert.ok(t.response.length <= 1500);
});

test('normalizeTriage: junk input → safe defaults', () => {
  const t = normalizeTriage(null);
  assert.equal(t.type, 'question');
  assert.equal(t.priority, 'p2');
  assert.deepEqual(t.labels, ['p2']);
});

test('triageCommentBody: includes type, priority, labels', () => {
  const body = triageCommentBody({ triage: normalizeTriage({ type: 'bug', priority: 'p0', labels: ['bug', 'p0'], response: 'Looks real and urgent.' }), issue: { number: 5 } });
  assert.match(body, /Triage — bug/);
  assert.match(body, /p0/);
  assert.match(body, /Looks real and urgent/);
  assert.match(body, /@engineer-buddy fix #5/);
});

test('runIssueTriage: labels + comments via fake github', async () => {
  const calls = { labels: [], comments: [] };
  const github = {
    getIssue: async (n) => ({ number: n, title: 'Wallet balance wrong after payout', body: 'Balance decreases twice', user: { login: 'bob', type: 'User' }, state: 'open' }),
    getIssueComments: async () => [],
    addLabels: async (n, l) => {
      calls.labels.push(l);
      return {};
    },
    createComment: async (n, b) => {
      calls.comments.push(b);
      return {};
    },
  };
  const router = {
    chat: async () => ({
      text: JSON.stringify({ type: 'bug', priority: 'p0', labels: ['bug', 'wallet'], response: 'Confirmed double-decrement; needs a transaction.', needs_more_info: false }),
      model: 'm', gateway: 'g', latencyMs: 5,
    }),
  };
  const r = await runIssueTriage({ repoSlug: 'me/demo', issue: 3, github, router, repo: null, config: cfg, logFn: () => {} });
  assert.equal(r.skipped, false);
  assert.equal(r.triage.type, 'bug');
  assert.deepEqual(calls.labels, [r.triage.labels]);
  assert.match(calls.comments[0], /double-decrement/);
});

test('runIssueTriage: skips PRs and bots', async () => {
  const gh1 = { getIssue: async () => ({ number: 1, pull_request: { url: 'x' }, title: 'PR', user: { login: 'a', type: 'User' } }) };
  const r1 = await runIssueTriage({ repoSlug: 'm/d', issue: 1, github: gh1, router: { chat: async () => { throw new Error('should not call'); } }, config: cfg, logFn: () => {} });
  assert.equal(r1.skipped, true);

  const gh2 = { getIssue: async () => ({ number: 2, title: 'x', user: { login: 'bot[bot]', type: 'Bot' } }) };
  const r2 = await runIssueTriage({ repoSlug: 'm/d', issue: 2, github: gh2, router: { chat: async () => { throw new Error('should not call'); } }, config: cfg, logFn: () => {} });
  assert.equal(r2.skipped, true);
});
