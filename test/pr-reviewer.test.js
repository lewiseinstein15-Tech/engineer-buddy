// pr-reviewer.test.js — unit tests for normalization/formatting, plus a full
// dry-run end-to-end with fake GitHub + fake router (zero network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/diff.js';
import { normalizeReview, formatReviewBody, mapToGitHubReview, runPrReview } from '../src/skills/pr-reviewer.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const cfg = DEFAULT_CONFIG;

const DIFF = `diff --git a/src/wallet.js b/src/wallet.js
--- a/src/wallet.js
+++ b/src/wallet.js
@@ -10,6 +10,8 @@ function pay(user, amount) {
   const fee = 0;
+  const total = amount - fee;
+  await db.update(user).set({ balance: total }); // non-atomic
   return total;
diff --git a/src/tiny.js b/src/tiny.js
--- a/src/tiny.js
+++ b/src/tiny.js
@@ -1,1 +1,2 @@
+export const ok = true;
`;

const parsed = parseUnifiedDiff(DIFF);

test('normalizeReview: clamps verdict/risk and validates line anchors', () => {
  const r = normalizeReview(
    {
      verdict: 'SUPER_APPROVE',
      risk: 'EXTREME',
      summary: 'x',
      findings: [
        { file: 'src/wallet.js', line: 11, severity: 'critical', title: 't1', body: 'b1' },
        { file: 'src/wallet.js', line: 9999, severity: 'high', title: 'bad anchor', body: 'b2' },
        { file: 'src/does/not/exist.js', line: 3, severity: 'low', title: 'ghost', body: 'b3' },
      ],
    },
    parsed,
    cfg
  );
  assert.equal(r.verdict, 'comment');
  assert.equal(r.risk, 'medium');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, 't1');
  // invalid anchors are displaced, not silently dropped
  assert.equal(r.displaced.length, 2);
});

test('normalizeReview: sorts by severity and caps to maxFindings', () => {
  const findings = [4, 3, 2, 1, 0].flatMap((i) =>
    ['low', 'critical', 'high', 'medium'].map((sev, j) => ({
      file: 'src/wallet.js',
      line: 11 + ((i + j) % 2),
      severity: sev,
      title: `f${i}${j}${sev}`,
      body: 'x',
    }))
  );
  const r = normalizeReview({ findings }, parsed, cfg);
  assert.ok(r.findings.length <= cfg.review.maxFindings);
  const ranks = { critical: 0, high: 1, medium: 2, low: 3, praise: 4 };
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(ranks[r.findings[i - 1].severity] <= ranks[r.findings[i].severity]);
  }
});

test('mapToGitHubReview: critical forces REQUEST_CHANGES; comments anchored to added lines', () => {
  const review = normalizeReview(
    { verdict: 'request_changes', findings: [{ file: 'src/wallet.js', line: 11, severity: 'critical', title: 'race', body: 'x' }] },
    parsed,
    cfg
  );
  const { event, comments } = mapToGitHubReview({ review, secFindings: [], cfg });
  assert.equal(event, 'REQUEST_CHANGES');
  assert.equal(comments[0].path, 'src/wallet.js');
  assert.equal(comments[0].side, 'RIGHT');
  assert.equal(comments[0].line, 11);
});

test('mapToGitHubReview: no critical → COMMENT', () => {
  const review = normalizeReview(
    { verdict: 'comment', findings: [{ file: 'src/wallet.js', line: 11, severity: 'low', title: 'nit', body: 'x' }] },
    parsed,
    cfg
  );
  const { event } = mapToGitHubReview({ review, secFindings: [], cfg });
  assert.equal(event, 'COMMENT');
});

test('formatReviewBody: includes verdict, findings, footer with $0.00', () => {
  const review = normalizeReview(
    { verdict: 'comment', summary: 'Non-atomic balance update.', risk: 'high', tests_added: false, findings: [{ file: 'src/wallet.js', line: 11, severity: 'high', title: 'Race on balance', body: 'Two concurrent pays can lose money.' }] },
    parsed,
    cfg
  );
  const body = formatReviewBody({
    pr: { number: 5, title: 'Fix wallet' },
    review,
    secFindings: [],
    risks: [{ file: 'src/wallet.js', note: 'touches money surface' }],
    stats: { totalAdded: 3, totalRemoved: 1, files: 2 },
    meta: { model: 'test', gateway: 'fake', latencyMs: 1200, attempts: [] },
    cfg,
  });
  assert.ok(body.includes('Engineer Buddy'));
  assert.ok(body.includes('Race on balance'));
  assert.ok(body.includes('$0.00 keyless'));
  assert.ok(body.includes('human review still required'));
  assert.ok(body.includes('touches money surface'));
});

// ---------- end-to-end dry run with fakes ----------

function fakeGithub() {
  return {
    async getPull(n) {
      return {
        number: n,
        title: 'feat: wallet math fix',
        user: { login: 'lewis', type: 'User' },
        draft: false,
        head: { ref: 'feat/wallet' },
        base: { ref: 'main' },
        body: 'Fixes the math',
      };
    },
    async getFiles() {
      return [{ filename: 'src/wallet.js', additions: 2, deletions: 0 }];
    },
    async getDiff() {
      return DIFF;
    },
    async createReview(n, payload) {
      this.review = payload;
      return { id: 1 };
    },
    async createComment() {
      return { id: 2 };
    },
    async addLabels() {
      return null;
    },
  };
}

function fakeRouter(replyText) {
  return {
    async chat(messages) {
      return { text: replyText, model: 'fake-model', gateway: 'fake', latencyMs: 500, attempts: [] };
    },
  };
}

test('runPrReview: end-to-end dry run produces validated review', async () => {
  const reply = JSON.stringify({
    verdict: 'request_changes',
    summary: 'Balance update is non-atomic; concurrent payouts can lose money.',
    risk: 'high',
    tests_added: false,
    findings: [{ file: 'src/wallet.js', line: 11, severity: 'critical', title: 'Non-atomic balance write', body: 'read-modify-write without transaction' }],
  });
  const github = fakeGithub();
  const result = await runPrReview({
    repoSlug: 'OpenAImakers/efoootball',
    pr: 5,
    github,
    router: fakeRouter(reply),
    repo: null,
    config: cfg,
    dryRun: true,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.event, 'REQUEST_CHANGES');
  assert.equal(result.review.findings[0].title, 'Non-atomic balance write');
  assert.ok(result.body.includes('Non-atomic balance write'));
});

test('runPrReview: skips bot authors', async () => {
  const github = fakeGithub();
  github.getPull = async () => ({ number: 1, user: { login: 'helper-bot', type: 'Bot' }, draft: false, head: { ref: 'x' }, base: { ref: 'main' } });
  const result = await runPrReview({
    repoSlug: 'o/r',
    pr: 1,
    github,
    router: fakeRouter('{}'),
    repo: null,
    config: cfg,
    dryRun: true,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'bot-author');
});

test('runPrReview: deterministic secret finding is merged even if LLM missed it', async () => {
  const SECRET_DIFF = DIFF.replace(
    '  const total = amount - fee;',
    '  const KEY = "AKIAIOSFODNN7EXAMPLE";\n  const total = amount - fee;'
  );
  const github = fakeGithub();
  github.getDiff = async () => SECRET_DIFF;
  const reply = JSON.stringify({ verdict: 'approve', summary: 'fine', risk: 'low', findings: [] });
  const result = await runPrReview({
    repoSlug: 'o/r',
    pr: 5,
    github,
    router: fakeRouter(reply),
    repo: null,
    config: cfg,
    dryRun: true,
  });
  const body = result.body;
  assert.ok(body.includes('Deterministic secret scan'));
  assert.equal(result.event, 'REQUEST_CHANGES'); // secrets force critical
});
