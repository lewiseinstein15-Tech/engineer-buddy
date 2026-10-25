import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHarness, loadHarness, harnessContext, validateHarnessProposal, applyHarnessProposal, isAgentDeniedPath } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-harness-'));
}

test('ensureHarness: scaffolds the Harness² surface, idempotent', () => {
  const root = tmpRoot();
  const created = ensureHarness(root);
  assert.equal(created.length, 6);
  for (const f of ['systemprompt.md', 'guardrails.md', 'MEMORY.md', 'tool_guidance.md', 'skills/README.md', 'skills/commit-message/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(root, '.buddy/harness', f)), f);
  }
  assert.deepEqual(ensureHarness(root), []);
});

test('loadHarness: falls back to defaults for missing files, picks up extra skills', () => {
  const root = tmpRoot();
  ensureHarness(root);
  fs.rmSync(path.join(root, '.buddy/harness/MEMORY.md'));
  fs.mkdirSync(path.join(root, '.buddy/harness/skills/deploy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy/harness/skills/deploy/SKILL.md'), '# Skill: deploy\n');
  const h = loadHarness(root);
  assert.match(h['MEMORY.md'], /durable notes/); // default content
  assert.equal(h['skills/deploy/SKILL.md'], '# Skill: deploy\n');
});

test('harnessContext: exposes the always-on parts', () => {
  const ctx = harnessContext(loadHarness(tmpRoot()));
  for (const k of ['systemprompt', 'guardrails', 'memory', 'toolGuidance']) {
    assert.ok(typeof ctx[k] === 'string' && ctx[k].length > 100, k);
  }
});

test('validateHarnessProposal: off-surface paths rejected wholesale', () => {
  const errors = validateHarnessProposal({ 'src/app.js': 'x' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /off-surface/);
  errors.push('no-apply'); // whole-proposal semantics: caller sees the errors
});

test('validateHarnessProposal: empty always-on file, oversize, grader markers', () => {
  assert.match(validateHarnessProposal({ 'guardrails.md': '   ' })[0], /may never be empty/);
  assert.match(validateHarnessProposal({ 'guardrails.md': 'x'.repeat(8001) })[0], /size cap/);
  assert.match(validateHarnessProposal({ 'MEMORY.md': 'run the grader, pass_rate was high' })[0], /grader vocabulary/);
});

test('validateHarnessProposal: skills must be triggered by always-on text', () => {
  const errors = validateHarnessProposal({ 'skills/new-skill/SKILL.md': '# Skill: new-skill\nsteps' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never triggered/);
  // Same proposal + trigger line passes.
  const ok = validateHarnessProposal(
    {
      'skills/new-skill/SKILL.md': '# Skill: new-skill\nsteps',
      'tool_guidance.md': '## Skills\n- When deploying, load the `new-skill` skill.',
    },
    loadHarness(tmpRoot())
  );
  assert.deepEqual(ok, []);
});

test('validateHarnessProposal: skills must be triggered; loose skill paths rejected', () => {
  assert.match(validateHarnessProposal({ 'skills/bad name/SKILL.md': 'x' })[0], /off-surface/);
  // A SKILL.md without a trigger in always-on text is dead weight.
  assert.match(validateHarnessProposal({ 'skills/ok/SKILL.md': 'x' })[0], /never triggered/);
  // skills/README.md is not a skill (no <name>/ dir) → no trigger requirement.
  assert.deepEqual(validateHarnessProposal({ 'skills/README.md': 'updated docs' }), []);
});

test('applyHarnessProposal: writes files + timestamped backups', () => {
  const root = tmpRoot();
  ensureHarness(root);
  const before = fs.readFileSync(path.join(root, '.buddy/harness/MEMORY.md'), 'utf8');
  const applied = applyHarnessProposal(root, { 'MEMORY.md': '# Memory — rewritten\n' });
  assert.deepEqual(applied, ['.buddy/harness/MEMORY.md']);
  assert.equal(fs.readFileSync(path.join(root, '.buddy/harness/MEMORY.md'), 'utf8'), '# Memory — rewritten\n');
  const backups = fs.readdirSync(path.join(root, '.buddy/harness/backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.buddy/harness/backups', backups[0]), 'utf8'), before);
  // New skill file has no backup.
  applyHarnessProposal(root, { 'skills/x/SKILL.md': 'x' });
  assert.equal(fs.readdirSync(path.join(root, '.buddy/harness/backups')).length, 1);
});

test('isAgentDeniedPath: self-edit firewall + secrets + VCS', () => {
  assert.equal(isAgentDeniedPath('.buddy/harness/MEMORY.md'), true);
  assert.equal(isAgentDeniedPath('.buddy/harness/skills/x/SKILL.md'), true);
  assert.equal(isAgentDeniedPath('.git/config'), true);
  assert.equal(isAgentDeniedPath('deep/nested/.git/objects/ab'), true);
  assert.equal(isAgentDeniedPath('.env'), true);
  assert.equal(isAgentDeniedPath('config/.env.production'), true);
  assert.equal(isAgentDeniedPath('server.pem'), true);
  assert.equal(isAgentDeniedPath('package-lock.json'), true);
  assert.equal(isAgentDeniedPath('src/app.js'), false);
  assert.equal(isAgentDeniedPath('.buddy/sessions/2026.jsonl'), false);
});
