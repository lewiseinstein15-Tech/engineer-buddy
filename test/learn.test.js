import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reflect, recentLessons, experiencePath } from '../src/learn.js';
import { ensureHarness, loadHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-learn-'));
  ensureHarness(root);
  return root;
}

function fakeRouter(replies, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push(messages);
      return { text: replies.length ? replies.shift() : '{"experience":null,"proposal":null}', model: 'fake', gateway: 'fake', latencyMs: 1 };
    },
  };
}

const EVENTS = [
  { type: 'tool', tool: 'fs_read', args: { path: 'src/app.js' }, observation: 'export const add = ...' },
  { type: 'tool', tool: 'bash', args: { command: 'npm test' }, observation: 'exit 1\nFAIL add.test.js' },
  { type: 'tool', tool: 'fs_replace', args: { path: 'src/app.js' }, observation: 'OK replaced' },
  { type: 'tool', tool: 'bash', args: { command: 'npm test' }, observation: 'exit 0' },
  { type: 'say', text: 'fixed' },
];

test('reflect: records one evidence-backed experience entry', async () => {
  const root = tmpRoot();
  const router = fakeRouter([
    JSON.stringify({
      experience: { cue: 'npm test fails after edits', lesson: 'always re-run npm test before saying done', evidence: 'bash npm test → exit 1 FAIL, then exit 0 after fix', confidence: 'high' },
      proposal: null,
    }),
  ]);
  const out = await reflect({ router, root, task: 'fix the add function', events: EVENTS });
  assert.equal(out.status, 'entry');
  const exp = fs.readFileSync(experiencePath(root), 'utf8');
  assert.match(exp, /# Experience — lessons carried across tasks/);
  assert.match(exp, /cue: npm test fails after edits/);
  assert.match(exp, /confidence: high/);
  assert.deepEqual(recentLessons(root), ['always re-run npm test before saying done']);
});

test('reflect: honest NO_ENTRY when the transcript shows no contrast', async () => {
  const root = tmpRoot();
  const router = fakeRouter([]);
  const out = await reflect({ router, root, task: 'smooth task, nothing surprising', events: [{ type: 'say', text: 'done' }] });
  assert.equal(out.status, 'no_entry');
  const exp = fs.readFileSync(experiencePath(root), 'utf8');
  assert.match(exp, /NO_ENTRY/);
});

test('reflect: invalid harness proposal → KEEP_BASE, harness untouched', async () => {
  const root = tmpRoot();
  const before = loadHarness(root);
  const router = fakeRouter([
    JSON.stringify({ experience: null, proposal: { path: 'src/sneaky.js', content: 'agent code' } }),
    '{"experience":null,"proposal":null}',
  ]);
  const out = await reflect({ router, root, task: 'try to escape', events: EVENTS });
  assert.equal(out.status, 'keep_base');
  assert.match(out.proposalErrors[0], /off-surface/);
  assert.deepEqual(loadHarness(root), before); // unchanged
});

test('reflect: valid MEMORY.md proposal is applied with a backup', async () => {
  const root = tmpRoot();
  const memoryBefore = fs.readFileSync(path.join(root, '.buddy/harness/MEMORY.md'), 'utf8');
  const router = fakeRouter([
    JSON.stringify({
      experience: null,
      proposal: { path: 'MEMORY.md', content: '# Memory — build with `node --test`\n\n## Build & test\n- node --test\n' },
    }),
  ]);
  const out = await reflect({ router, root, task: 'learn the test command', events: EVENTS });
  assert.equal(out.status, 'applied');
  assert.equal(fs.readFileSync(path.join(root, '.buddy/harness/MEMORY.md'), 'utf8'), '# Memory — build with `node --test`\n\n## Build & test\n- node --test\n');
  const backups = fs.readdirSync(path.join(root, '.buddy/harness/backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.buddy/harness/backups', backups[0]), 'utf8'), memoryBefore);
});

test('reflect: untriggered skill is rejected even after one retry', async () => {
  const root = tmpRoot();
  const router = fakeRouter([
    JSON.stringify({ experience: null, proposal: { path: 'skills/wild/SKILL.md', content: '# Skill: wild' } }),
    JSON.stringify({ experience: null, proposal: { path: 'skills/wild/SKILL.md', content: '# Skill: wild v2' } }),
  ]);
  const out = await reflect({ router, root, task: 'add skill', events: EVENTS });
  assert.equal(out.status, 'keep_base');
  assert.match(out.proposalErrors[0], /never triggered/);
  assert.ok(!fs.existsSync(path.join(root, '.buddy/harness/skills/wild')));
});

test('reflect: retry with validator errors can rescue a proposal', async () => {
  const root = tmpRoot();
  // First attempt: skill without a trigger → rejected.
  // Retry (same reflect() call): a standalone tool_guidance.md edit → valid.
  const guidance = '## Skills\n- Before releases, load the `deploy-check` skill (coming soon).';
  const router = fakeRouter([
    JSON.stringify({ experience: null, proposal: { path: 'skills/deploy-check/SKILL.md', content: '# Skill: deploy-check\nRun the deploy checklist.' } }),
    JSON.stringify({ experience: null, proposal: { path: 'tool_guidance.md', content: guidance } }),
  ]);
  const out = await reflect({ router, root, task: 'add deploy skill', events: EVENTS });
  assert.equal(out.status, 'applied');
  assert.match(fs.readFileSync(path.join(root, '.buddy/harness/tool_guidance.md'), 'utf8'), /deploy-check/);
  assert.ok(!fs.existsSync(path.join(root, '.buddy/harness/skills/deploy-check')));
});

test('reflect: brain offline → skipped, never throws', async () => {
  const root = tmpRoot();
  const router = { order: ['fake'], chat: async () => { throw new Error('all gateways down'); } };
  const out = await reflect({ router, root, task: 'x', events: EVENTS });
  assert.equal(out.status, 'skipped');
});

test('reflect: garbage reply → skipped, harness unchanged', async () => {
  const root = tmpRoot();
  const before = loadHarness(root);
  const router = fakeRouter(['I am sorry, I cannot comply.']);
  const out = await reflect({ router, root, task: 'x', events: EVENTS });
  assert.equal(out.status, 'skipped');
  assert.deepEqual(loadHarness(root), before);
});
