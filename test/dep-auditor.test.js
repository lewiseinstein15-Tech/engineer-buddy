import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAuditJson, auditReportMarkdown, AUDIT_ISSUE_PREFIX } from '../src/skills/dep-auditor.js';
import { runDepAudit } from '../src/skills/dep-auditor.js';
import { loadConfig } from '../src/config.js';
import { LocalRepo } from '../src/tools/repo.js';

const cfg = loadConfig();

const NPM8_AUDIT = JSON.stringify({
  vulnerabilities: {
    'semver-dirty': { severity: 'high', range: '<7.5.3', via: [{ title: 'ReDoS', url: 'https://example.com/advisory', range: '<7.5.3' }], effects: [], fixAvailable: true },
    'dev-only-pkg': { severity: 'critical', range: '<1.0.1', via: ['transitive-dep'], effects: [], fixAvailable: false },
  },
  metadata: { vulnerabilities: { critical: 1, high: 1, moderate: 0, low: 0, total: 2 } },
});

test('parseAuditJson: npm 8 shape', () => {
  const { advisories, counts, metadata, error } = parseAuditJson(NPM8_AUDIT);
  assert.equal(error, null);
  assert.equal(advisories.length, 2);
  assert.equal(counts.critical, 1);
  assert.equal(counts.high, 1);
  assert.equal(metadata.total, 2);
  // critical sorts first
  assert.equal(advisories[0].module, 'dev-only-pkg');
  const direct = advisories.find((a) => a.module === 'semver-dirty');
  assert.equal(direct.via[0].title, 'ReDoS');
  assert.equal(direct.fixAvailable, true);
});

test('parseAuditJson: garbage input never throws', () => {
  const r = parseAuditJson('not json at all');
  assert.ok(r.error);
  assert.deepEqual(r.advisories, []);
  assert.deepEqual(parseAuditJson('').advisories, []);
});

test('auditReportMarkdown: table + counts + disclaimer', () => {
  const { advisories, counts } = parseAuditJson(NPM8_AUDIT);
  const md = auditReportMarkdown({
    counts,
    advisories,
    triage: {
      summary: 'The critical one is dev-only; the high one touches request parsing.',
      items: [
        { module: 'dev-only-pkg', exploitability: 'unlikely', why: 'only used in build scripts', action: 'upgrade to 1.0.1', priority: 'p3' },
        { module: 'semver-dirty', exploitability: 'likely', why: 'parses user-supplied range strings', action: 'upgrade to 7.5.3', priority: 'p0' },
      ],
    },
    note: 'test note',
  });
  assert.match(md, /🔧 Dependency audit/);
  assert.match(md, /critical×1 · high×1/);
  assert.match(md, /\| semver-dirty \| high \| likely \|.*\*\*p0\*\*/);
  assert.match(md, /dev-only/);
  assert.match(md, /\$0\.00/);
  assert.match(md, /test note/);
});

test('runDepAudit: unparsable audit → ok:false, no crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-'));
  // no package.json/lock → npm audit errors → unparsable output path
  const github = { createComment: async () => ({}), createIssue: async () => { throw new Error('should not create issue'); } };
  const router = { chat: async () => { throw new Error('should not triage'); } };
  const r = await runDepAudit({ repoSlug: 'me/demo', github, router, repoDir: new LocalRepo(dir), config: cfg, logFn: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unparsable|audit/);
});

test('runDepAudit: clean repo → ok, no issue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: {} }));
  // No registry access guaranteed offline: if npm audit errors → ok:false; if it
  // returns zero vulns → ok:true + clean. Both are acceptable CI-safe outcomes.
  const github = { createIssue: async () => { throw new Error('should not create issue'); } };
  const router = { chat: async () => { throw new Error('should not triage'); } };
  const r = await runDepAudit({ repoSlug: 'me/demo', github, router, repoDir: new LocalRepo(dir), config: cfg, logFn: () => {} });
  if (r.ok) assert.equal(r.clean, true);
  else assert.match(r.reason, /unparsable|audit/);
});

test('runDepAudit: findings → brain triage → single tracking issue (create)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-'));
  fs.writeFileSync(path.join(dir, 'audit-fixture.json'), NPM8_AUDIT);
  // Stub the shell layer by planting a fake npm on PATH.
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'npm'),
    `#!/bin/sh\ncat "${path.join(dir, 'audit-fixture.json')}"\n`,
    { mode: 0o755 }
  );

  const calls = { issues: [], comments: [] };
  const github = {
    findOpenIssueByTitlePrefix: async () => null,
    createIssue: async (p) => {
      calls.issues.push(p);
      return { number: 42, ...p };
    },
    addLabels: async () => ({}),
    createComment: async (n, b) => {
      calls.comments.push({ n, b });
      return {};
    },
  };
  const router = {
    chat: async () => ({
      text: JSON.stringify({
        summary: 'One real risk, one dev-only.',
        items: [{ module: 'semver-dirty', exploitability: 'likely', why: 'parses user input', action: 'upgrade to 7.5.3', priority: 'p0' }],
      }),
      model: 'm', gateway: 'g', latencyMs: 5,
    }),
  };

  // runCommand scrubs env but keeps PATH; prepend our fake npm bin.
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const r = await runDepAudit({ repoSlug: 'me/demo', github, router, repoDir: new LocalRepo(dir), config: cfg, logFn: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.trackingIssue, 42);
    assert.equal(calls.issues.length, 1);
    assert.match(calls.issues[0].title, /^🔧 Dependency audit/);
    assert.match(calls.issues[0].title, /1 critical/);
    assert.match(calls.issues[0].body, /parses user input/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('runDepAudit: existing tracking issue gets updated, not spammed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-'));
  fs.writeFileSync(path.join(dir, 'audit-fixture.json'), NPM8_AUDIT);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\ncat "${path.join(dir, 'audit-fixture.json')}"\n`, { mode: 0o755 });

  const calls = { issues: [], comments: [] };
  const github = {
    findOpenIssueByTitlePrefix: async () => ({ number: 7, title: `${AUDIT_ISSUE_PREFIX} — old` }),
    createIssue: async () => {
      calls.issues.push('SHOULD NOT CREATE');
      return {};
    },
    addLabels: async () => ({}),
    createComment: async (n, b) => {
      calls.comments.push({ n, b });
      return {};
    },
  };
  const router = { chat: async () => { throw new Error('triage failed — should degrade to raw list'); } };

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const r = await runDepAudit({ repoSlug: 'me/demo', github, router, repoDir: new LocalRepo(dir), config: cfg, logFn: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.updated, true);
    assert.equal(r.trackingIssue, 7);
    assert.equal(calls.issues.length, 0); // never created a new one
    assert.match(calls.comments[0].b, /Re-run/);
    assert.match(calls.comments[0].b, /raw advisory list/); // triage failure degraded honestly
  } finally {
    process.env.PATH = oldPath;
  }
});
