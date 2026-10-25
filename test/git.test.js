import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBranchName } from '../src/tools/git.js';

test('sanitizeBranchName: safe slugs', () => {
  assert.equal(sanitizeBranchName('Fix the login bug!!!'), 'fix-the-login-bug');
  assert.equal(sanitizeBranchName('  Add   FEATURE: xyz  '), 'add-feature-xyz');
  assert.equal(sanitizeBranchName('..weird..name..'), 'weird-name');
  assert.equal(sanitizeBranchName(''), 'change');
  assert.equal(sanitizeBranchName(null), 'change');
});

test('sanitizeBranchName: rejects git-invalid sequences', () => {
  const out = sanitizeBranchName('a..b/c:d?e*f~g^h');
  assert.ok(!out.includes('..'));
  assert.ok(!out.includes(':'));
  assert.ok(!out.includes('?'));
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('~'));
  assert.ok(!out.includes('^'));
});

test('sanitizeBranchName: length capped', () => {
  const out = sanitizeBranchName('x'.repeat(200));
  assert.ok(out.length <= 60);
});
