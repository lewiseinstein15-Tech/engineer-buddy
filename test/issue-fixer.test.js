import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runIssueFix, detectTestCommand } from '../src/skills/issue-fixer.js';
import { loadConfig } from '../src/config.js';
import { LocalRepo } from '../src/tools/repo.js';
import { GitWorktree } from '../src/tools/git.js';

const cfg = loadConfig();

/** Router stub: pops scripted LLM replies. */
function scriptedRouter(replies) {
  const q = [...replies];
  return {
    chat: async () => {
      if (!q.length) throw new Error('script exhausted');
      const text = q.shift();
      return { text, model: 'fake-model', gateway: 'fake-gw', latencyMs: 5 };
    },
    order: ['fake-gw'],
    gateways: new Map(),
  };
}

function fakeGithub() {
  const calls = { comments: [], prs: [], labels: [] };
  return {
    calls,
    token: 'fake-token',
    getIssue: async (n) => ({ number: n, title: 'Add a greeting constant', body: 'Please add GREETING to src/app.js', user: { login: 'alice', type: 'User' }, state: 'open' }),
    getIssueComments: async () => [],
    createComment: async (n, body) => {
      calls.comments.push(body);
      return {};
    },
    addLabels: async (n, labels) => {
      calls.labels.push(labels);
      return {};
    },
    createPull: async (p) => {
      calls.prs.push(p);
      return { number: 99, ...p };
    },
  };
}

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-fix-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'check.js'), 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return new LocalRepo(dir);
}

const PLAN = JSON.stringify({
  understanding: 'The repo needs a GREETING constant.',
  type: 'feature',
  confidence: 'high',
  files_to_read: ['src/app.js'],
  plan: ['read app.js', 'append constant'],
});

const DIAG = JSON.stringify({
  tool: 'finish',
  result: {
    root_cause: 'GREETING is missing from src/app.js.',
    files_to_edit: [{ path: 'src/app.js', change: 'add export const GREETING' }],
    tests_to_run: ['node check.js'],
    confidence: 'high',
  },
});

test('detectTestCommand: package.json script wins', () => {
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo.root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
  assert.equal(detectTestCommand(repo), 'npm test');
  assert.equal(detectTestCommand(tmpGitRepo()), null);
});

test('issue fix: happy path (dry run) produces PR body with plan + verification', async () => {
  const repo = tmpGitRepo();
  const github = fakeGithub();
  const router = scriptedRouter([
    PLAN,
    DIAG,
    JSON.stringify({ tool: 'read_file', args: { path: 'src/app.js' } }),
    JSON.stringify({ tool: 'replace_in_file', args: { path: 'src/app.js', find: 'export const add = (a, b) => a + b;', replace: 'export const GREETING = "hello";\nexport const add = (a, b) => a + b;' } }),
    JSON.stringify({ tool: 'finish', result: { summary: 'added GREETING' } }),
  ]);

  const result = await runIssueFix({
    repoSlug: 'me/demo',
    issue: 7,
    github,
    router,
    repoDir: repo,
    config: cfg,
    dryRun: true,
    logFn: () => {},
  });

  assert.equal(result.outcome, 'dry-run');
  assert.match(result.branch, /^buddy\/fix-issue-7-/);
  assert.equal(result.verify.verified, true);
  assert.ok(result.prBody.includes('Fixes #7'));
  assert.ok(result.prBody.includes('Root cause'));
  assert.ok(result.prBody.includes('`node check.js`'));
  assert.ok(result.prBody.includes('src/app.js'));
  assert.equal(github.calls.comments.length, 0); // dry run posts nothing
  // the file really changed on disk
  assert.match(repo.readFile('src/app.js').content, /GREETING/);
});

test('issue fix: failing tests → discard, comment, workspace restored', async () => {
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo.root, 'check.js'), 'console.error("boom: expected 4 got 3"); process.exit(1);\n');
  const github = fakeGithub();
  const router = scriptedRouter([
    PLAN,
    DIAG,
    JSON.stringify({ tool: 'replace_in_file', args: { path: 'src/app.js', find: 'a + b', replace: 'a + b + 1' } }),
    JSON.stringify({ tool: 'finish', result: { summary: 'tried a fix' } }),
    JSON.stringify({ tool: 'finish', result: { summary: 'repair attempt' } }),
  ]);

  const result = await runIssueFix({
    repoSlug: 'me/demo',
    issue: 8,
    github,
    router,
    repoDir: repo,
    config: { ...cfg, write: { ...cfg.write, maxRepairLoops: 1 } },
    dryRun: false,
    logFn: () => {},
  });

  assert.equal(result.outcome, 'verification-failed-discarded');
  assert.equal(github.calls.comments.length, 1);
  assert.match(github.calls.comments[0], /aborted before PR/);
  assert.match(github.calls.comments[0], /node check\.js/);
  // workspace was restored
  const git = new GitWorktree(repo.root);
  assert.equal(await git.isClean(), true);
  assert.ok(!repo.readFile('src/app.js').content.includes('a + b + 1'));
});

test('issue fix: low confidence → needs-human, no PR', async () => {
  const repo = tmpGitRepo();
  const github = fakeGithub();
  const router = scriptedRouter([
    PLAN,
    JSON.stringify({ tool: 'finish', result: { root_cause: 'Cannot determine cause from repo alone.', files_to_edit: [], confidence: 'low' } }),
  ]);

  const result = await runIssueFix({
    repoSlug: 'me/demo',
    issue: 9,
    github,
    router,
    repoDir: repo,
    config: cfg,
    dryRun: false,
    logFn: () => {},
  });

  assert.equal(result.outcome, 'needs-human');
  assert.equal(github.calls.comments.length, 1);
  assert.match(github.calls.comments[0], /could not confidently locate/);
  assert.equal(github.calls.prs.length, 0);
});

test('issue fix: policy-guarded path never changes files', async () => {
  const repo = tmpGitRepo();
  const github = fakeGithub();
  const router = scriptedRouter([
    PLAN,
    DIAG,
    JSON.stringify({ tool: 'write_file', args: { path: '.github/workflows/evil.yml', content: 'on: push' } }),
    JSON.stringify({ tool: 'finish', result: { summary: 'done?' } }),
  ]);

  await assert.rejects(
    runIssueFix({ repoSlug: 'me/demo', issue: 10, github, router, repoDir: repo, config: cfg, dryRun: true, logFn: () => {} }),
    /no files changed/
  );
  // nothing written
  assert.ok(!fs.existsSync(path.join(repo.root, '.github', 'workflows', 'evil.yml')));
});
