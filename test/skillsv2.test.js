// skillsv2.test.js — Skills v2: SKILL.md frontmatter, 3-layer catalog,
// the skill tool, allowed-tools enforcement in the chat loop, and the
// v2-aware harness validator rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillMd,
  loadSkills,
  describeSkillCatalog,
  BUNDLED_SKILLS_DIR,
  SKILL_BODY_SOFT_CAP,
} from '../src/skills/loader.js';
import { buildSkillTool } from '../src/tools/skill.js';
import { createChat, buildSystemPrompt } from '../src/agent/chat.js';
import { validateHarnessProposal } from '../src/harness/scaffold.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-skills-'));
}

function fakeRouter(script, calls = []) {
  return {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

// ── parseSkillMd ─────────────────────────────────────────────────────────────

test('parseSkillMd: full frontmatter (name, description, allowed-tools, disable-model-invocation)', () => {
  const raw = [
    '---',
    'name: pr-review',
    'description: Review diffs like a staff engineer.',
    'allowed-tools: fs_read, fs_search, bash',
    'disable-model-invocation: true',
    '---',
    '# Skill: pr-review',
    'Body line.',
  ].join('\n');
  const { meta, body, warnings } = parseSkillMd(raw, { fallbackName: 'ignored' });
  assert.equal(meta.name, 'pr-review');
  assert.equal(meta.description, 'Review diffs like a staff engineer.');
  assert.deepEqual(meta.allowedTools, ['fs_read', 'fs_search', 'bash']);
  assert.equal(meta.disableModelInvocation, true);
  assert.ok(body.startsWith('# Skill: pr-review'));
  assert.ok(!body.includes('---'));
  assert.deepEqual(warnings, []);
});

test('parseSkillMd: no frontmatter — name falls back to dir, description from Trigger line, body intact', () => {
  const raw = ['# Skill: commit-message', '', 'Trigger: "commit message".', '', 'Steps: 1. do it.'].join('\n');
  const { meta, body, warnings } = parseSkillMd(raw, { fallbackName: 'commit-message' });
  assert.equal(meta.name, 'commit-message');
  assert.equal(meta.description, 'Trigger: "commit message".');
  assert.equal(meta.allowedTools, null);
  assert.equal(meta.disableModelInvocation, false);
  assert.equal(body, raw); // untouched
  assert.deepEqual(warnings, []);
});

test('parseSkillMd: unterminated frontmatter warns and keeps the whole file as body', () => {
  const raw = ['---', 'name: broken', 'no closing fence here'].join('\n');
  const { meta, body, warnings } = parseSkillMd(raw, { fallbackName: 'broken' });
  assert.equal(meta.name, 'broken'); // fallback used
  assert.equal(body, raw);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /never closed/);
});

test('parseSkillMd: unknown frontmatter keys are ignored, empty allowed-tools becomes []', () => {
  const raw = ['---', 'name: x', 'model: opus', 'allowed-tools:', '---', 'body'].join('\n');
  const { meta, warnings } = parseSkillMd(raw, { fallbackName: 'x' });
  assert.equal(meta.name, 'x');
  assert.deepEqual(meta.allowedTools, []);
  assert.deepEqual(warnings, []);
});

// ── loadSkills ───────────────────────────────────────────────────────────────

function writeSkill(base, layer, name, { frontmatter = true, files = {} } = {}) {
  const dir = path.join(base, layer === 'project' ? '.buddy/harness/skills' : layer === 'personal' ? 'home-skills' : 'bundled', name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = frontmatter
    ? `---\nname: ${name}\ndescription: ${name} description for testing.\nallowed-tools: fs_read, bash\n---\n`
    : `# Skill: ${name}\n\nTrigger: ${name}.\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + `Playbook body of ${name}.\n`, 'utf8');
  for (const [fname, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, fname), content, 'utf8');
  return dir;
}

test('loadSkills: project layer discovery + supporting files', () => {
  const root = tmp();
  writeSkill(root, 'project', 'deploy', { files: { 'checklist.md': '1. ping', 'envs.json': '{}' } });
  const { skills, warnings } = loadSkills({ root, home: path.join(root, 'no-home') });
  const s = skills.find((x) => x.name === 'deploy');
  assert.ok(s, 'deploy found');
  assert.equal(s.source, 'project');
  assert.deepEqual(s.files, ['checklist.md', 'envs.json']);
  assert.equal(s.dir, path.join(root, '.buddy/harness/skills/deploy'));
  assert.deepEqual(warnings, []);
});

test('loadSkills: personal layer discovered via injected home', () => {
  const root = tmp();
  const home = tmp();
  writeSkill(home, 'personal', 'everywhere', {});
  // the personal layer sits under <home>/.buddy/skills — write there directly
  const dir = path.join(home, '.buddy/skills/everywhere');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: everywhere\ndescription: mine.\n---\nbody', 'utf8');
  const { skills } = loadSkills({ root, home });
  const s = skills.find((x) => x.name === 'everywhere');
  assert.ok(s, 'personal skill found');
  assert.equal(s.source, 'personal');
});

test('loadSkills: project shadows personal shadows bundled (same name)', () => {
  const root = tmp();
  const home = tmp();
  const bundled = path.join(root, 'fake-bundled');
  // three layers all define "shadow-me"
  fs.mkdirSync(path.join(bundled, 'shadow-me'), { recursive: true });
  fs.writeFileSync(path.join(bundled, 'shadow-me/SKILL.md'), '---\nname: shadow-me\ndescription: bundled.\n---\nB', 'utf8');
  fs.mkdirSync(path.join(home, '.buddy/skills/shadow-me'), { recursive: true });
  fs.writeFileSync(path.join(home, '.buddy/skills/shadow-me/SKILL.md'), '---\nname: shadow-me\ndescription: personal.\n---\nP', 'utf8');
  fs.mkdirSync(path.join(root, '.buddy/harness/skills/shadow-me'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy/harness/skills/shadow-me/SKILL.md'), '---\nname: shadow-me\ndescription: project.\n---\nJ', 'utf8');
  const { skills, warnings } = loadSkills({ root, home });
  const s = skills.find((x) => x.name === 'shadow-me');
  assert.equal(s.description, 'project.'); // project wins
  assert.ok(warnings.some((w) => /shadows/.test(w)));
});

test('loadSkills: invalid folder names are skipped with a warning, session keeps going', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.buddy/harness/skills/Bad_Name'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy/harness/skills/Bad_Name/SKILL.md'), '---\nname: Bad_Name\ndescription: nope.\n---\nb', 'utf8');
  fs.mkdirSync(path.join(root, '.buddy/harness/skills/empty-dir'), { recursive: true }); // no SKILL.md — silently ignored
  const { skills, warnings } = loadSkills({ root, home: path.join(root, 'no-home') });
  assert.ok(!skills.some((s) => s.name === 'Bad_Name'));
  assert.ok(warnings.some((w) => /invalid name/.test(w)));
});

test('loadSkills: the 5 migrated GitHub-bot skills ship as bundled SKILL.md playbooks', () => {
  const { skills } = loadSkills({ root: os.tmpdir() });
  for (const name of ['pr-review', 'fix-issue', 'dep-audit', 'triage', 'release-notes']) {
    const s = skills.find((x) => x.name === name);
    assert.ok(s, `${name} bundled`);
    assert.equal(s.source, 'bundled');
    assert.ok(s.description.length > 20, `${name} has a real description`);
    assert.ok(s.body.includes('# Skill:'), `${name} has a playbook body`);
  }
  // cwd-proof: the bundled dir hangs off the package root (repo/test/..),
  // regardless of where node --test was launched from.
  assert.equal(BUNDLED_SKILLS_DIR, path.join(import.meta.dirname, '..', 'skills'));
});

// ── describeSkillCatalog ─────────────────────────────────────────────────────

test('describeSkillCatalog: lists invocable skills, hides user-only ones, empty when none', () => {
  const all = [
    { name: 'a', description: 'Do A.' },
    { name: 'hidden', description: 'Only via /hidden.', disableModelInvocation: true },
  ];
  const block = describeSkillCatalog(all);
  assert.match(block, /## Skills/);
  assert.match(block, /- a — Do A\./);
  assert.ok(!block.includes('hidden'));
  assert.equal(describeSkillCatalog([{ name: 'x', description: 'y', disableModelInvocation: true }]), '');
  assert.equal(describeSkillCatalog([]), '');
});

// ── skill tool ───────────────────────────────────────────────────────────────

test('buildSkillTool: body load, allowed-tools header, supporting file, errors', async () => {
  const root = tmp();
  const dir = writeSkill(root, 'project', 'deploy', { files: { 'checklist.md': '1. ping prod' } });
  const { skills } = loadSkills({ root, home: path.join(root, 'no-home') });
  const tool = buildSkillTool({ skills });
  assert.equal(tool.risky, undefined); // safe tool — no approval gate
  const out = await tool.run({ name: 'deploy' });
  assert.match(out, /^SKILL: deploy \(source: project\)/);
  assert.match(out, /Allowed tools for this skill: fs_read, bash/);
  assert.match(out, /Playbook body of deploy/);
  assert.match(out, /Supporting files: checklist\.md/);
  const f = await tool.run({ name: 'deploy', file: 'checklist.md' });
  assert.match(f, /SKILL FILE deploy\/checklist\.md:\n1\. ping prod/);
  assert.match(await tool.run({ name: 'nope' }), /ERROR: unknown skill "nope"\. Available: .+deploy/);
  assert.match(await tool.run({ name: 'deploy', file: 'evil.js' }), /not a supporting file/);
  assert.ok(dir); // keep dir referenced
});

test('buildSkillTool: user-only skills are invisible to the model', async () => {
  const skills = [{ name: 'secret', description: 'd', body: 'B', dir: '/x', source: 'project', files: [], disableModelInvocation: true }];
  const tool = buildSkillTool({ skills });
  assert.match(await tool.run({ name: 'secret' }), /unknown skill/);
});

// ── chat integration: catalog + allowed-tools enforcement ────────────────────

const CATALOG = [
  { name: 'reader', description: 'Read-only skill.', allowedTools: ['echo'], disableModelInvocation: false },
  { name: 'quiet', description: 'User only.', disableModelInvocation: true },
];
const HARNESS = { systemprompt: 'sp', guardrails: 'gr', memory: 'me', toolGuidance: 'tg' };
const ECHO_TOOLS = [
  { name: 'echo', description: 'Echo back.', args: '{"text":"x"}', run: async ({ text }) => `ECHO: ${text}` },
  {
    name: 'forbidden',
    description: 'Not allowed by the reader skill.',
    args: '{}',
    run: async () => 'SHOULD NOT RUN',
  },
];

test('buildSystemPrompt: skill catalog injected, user-only hidden, absent when no skills', () => {
  const withSkills = buildSystemPrompt({ harness: HARNESS, tools: ECHO_TOOLS, skills: CATALOG });
  assert.match(withSkills, /## Skills/);
  assert.match(withSkills, /- reader — Read-only skill\./);
  assert.ok(!withSkills.includes('quiet'));
  const without = buildSystemPrompt({ harness: HARNESS, tools: ECHO_TOOLS, skills: [] });
  assert.ok(!without.includes('## Skills'));
});

test('chat: model-loaded skill arms allowed-tools and blocks other tools until say', async () => {
  const events = [];
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"skill","args":{"name":"reader"}}',
      '{"tool":"forbidden","args":{}}',
      '{"tool":"echo","args":{"text":"allowed"}}',
      '{"tool":"say","message":"done"}',
    ]),
    tools: [...ECHO_TOOLS, { name: 'skill', description: 'x', args: '{}', run: async () => 'SKILL: reader (source: project)\nbody' }],
    harness: HARNESS,
    skills: CATALOG,
    onEvent: (e) => events.push(e),
  });
  const out = await chat.turn('use the reader skill');
  assert.equal(out.said, 'done');
  const forbiddenEv = events.find((e) => e.type === 'tool' && e.tool === 'forbidden');
  assert.match(forbiddenEv.observation, /"reader" skill restricts this task to tools: echo, skill, say/);
  assert.equal(forbiddenEv.observation.startsWith('ERROR:'), true);
  const echoEv = events.find((e) => e.type === 'tool' && e.tool === 'echo');
  assert.equal(echoEv.denied, false);
  assert.match(echoEv.observation, /ECHO: allowed/);
});

test('chat: restriction does not leak into the next turn', async () => {
  const events = [];
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"skill","args":{"name":"reader"}}',
      '{"tool":"forbidden","args":{}}',
      '{"tool":"say","message":"t1"}',
      '{"tool":"forbidden","args":{}}',
      '{"tool":"say","message":"t2"}',
    ]),
    tools: [...ECHO_TOOLS, { name: 'skill', description: 'x', args: '{}', run: async () => 'SKILL: reader (source: project)\nbody' }],
    harness: HARNESS,
    skills: CATALOG,
    onEvent: (e) => events.push(e),
  });
  await chat.turn('t1');
  const out2 = await chat.turn('t2');
  assert.equal(out2.said, 't2');
  const forbiddenEvs = events.filter((e) => e.type === 'tool' && e.tool === 'forbidden');
  assert.equal(forbiddenEvs.length, 2);
  assert.match(forbiddenEvs[0].observation, /"reader" skill restricts/); // turn 1: blocked
  assert.equal(forbiddenEvs[1].observation, 'SHOULD NOT RUN'); // turn 2: actually ran
});

test('chat: user-invoked skill (turn option) enforces allowed-tools from step one', async () => {
  const events = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"forbidden","args":{}}', '{"tool":"echo","args":{"text":"ok"}}', '{"tool":"say","message":"fin"}']),
    tools: ECHO_TOOLS,
    harness: HARNESS,
    onEvent: (e) => events.push(e),
  });
  const out = await chat.turn('run it', { skill: CATALOG[0] });
  assert.equal(out.said, 'fin');
  const forbiddenEv = events.find((e) => e.type === 'tool' && e.tool === 'forbidden');
  assert.match(forbiddenEv.observation, /"reader" skill restricts/);
  assert.equal(events.filter((e) => e.type === 'tool' && e.tool === 'forbidden').length, 1);
});

// ── harness validator: v2 skills self-trigger via description ────────────────

test('validateHarnessProposal: v2 skill with frontmatter description needs no always-on trigger', () => {
  const proposal = { 'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy checklist. Use when deploying.\n---\n1. ping' };
  assert.deepEqual(validateHarnessProposal(proposal, {}), []);
});

test('validateHarnessProposal: legacy skill without description still requires an always-on trigger', () => {
  const proposal = { 'skills/old-style/SKILL.md': '# Skill: old-style\n\nSteps.' };
  const errors = validateHarnessProposal(proposal, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never triggered/);
  assert.match(errors[0], /frontmatter description/);
});

test('validateHarnessProposal: legacy skill WITH an always-on trigger still passes', () => {
  const current = { 'tool_guidance.md': 'When shipping, load the `old-style` skill.' };
  const proposal = { 'skills/old-style/SKILL.md': '# Skill: old-style\n\nSteps.' };
  assert.deepEqual(validateHarnessProposal(proposal, current), []);
});

test('SKILL_BODY_SOFT_CAP guards context: oversized bodies warn but still load', () => {
  const big = '---\nname: big\ndescription: d.\n---\n' + 'x'.repeat(SKILL_BODY_SOFT_CAP + 1);
  const { warnings } = parseSkillMd(big, { fallbackName: 'big' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /soft cap/);
});
