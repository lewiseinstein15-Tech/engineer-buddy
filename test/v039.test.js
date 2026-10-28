// v0.39.0 — §3 extensibility: the plugin system. ONE folder bundling skills +
// agents + commands + tools + reporters + an mcp.json fragment + manifest
// hooks, discovered from .buddy/plugins/ (project) and ~/.buddy/plugins/
// (personal), installed via /plugin add from a git repo, a local path, or a
// bundled pack.
// Part A: the pure half — manifest validation, name sanitize, source parse,
// bundle scan/summary.
// Part B: discovery — layers, collision rules, disabled state, junk dirs.
// Part C: loader integration — skills, agents, commands, user tools, hooks,
// mcp fragments, reporters.
// Part D: install/remove/enable — git clone from a local repo, bundled pack
// copy, staging hygiene.
// Part E: REPL wiring — /plugin registered, source asserts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  validateManifest, sanitizePluginName, parsePluginSource, scanBundles,
  summarizeBundles, discoverPlugins, installPlugin, removePlugin,
  setPluginEnabled, pluginKindDirs, pluginHookEntries,
} from '../src/plugins.js';
import { loadSkills, describeSkillCatalog } from '../src/skills/loader.js';
import { loadAgents } from '../src/agent/subagents.js';
import { loadCustomCommands, applyCustomCommand } from '../src/terminal/customcommands.js';
import { loadUserTools } from '../src/tools/usertools.js';
import { loadHooks } from '../src/hooks.js';
import { loadReporters } from '../src/tools/reporters.js';
import { connectMcpServers } from '../src/tools/mcp.js';
import { setChatSetting, readProjectSettings } from '../src/settings.js';
import { SLASH_COMMANDS, SLASH_DESCRIPTIONS } from '../src/terminal/repl.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-v039-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

const MANIFEST = (over = {}) => JSON.stringify({ name: 'demo', version: '1.0.0', description: 'a demo plugin', ...over });

// ── Part A: the pure half ────────────────────────────────────────────────────

test('validateManifest: a good manifest passes and normalizes', () => {
  const r = validateManifest(JSON.parse(MANIFEST({ description: '  does things  ' })));
  assert.equal(r.ok, true);
  assert.equal(r.manifest.description, 'does things');
  assert.equal(r.manifest.version, '1.0.0');
});

test('validateManifest: bad name / missing version / missing description all refuse', () => {
  assert.match(validateManifest({ name: 'Bad Name', version: '1', description: 'x' }).error, /name must match/);
  assert.match(validateManifest({ name: 'ok', version: '', description: 'x' }).error, /version is required/);
  assert.match(validateManifest({ name: 'ok', version: '1', description: '' }).error, /description is required/);
  assert.equal(validateManifest('nope').ok, false);
});

test('validateManifest: hooks shape is checked early (every entry needs a command)', () => {
  const ok = validateManifest(JSON.parse(MANIFEST({ hooks: { PostToolUse: [{ matcher: 'bash', command: 'node x.js' }] } })));
  assert.equal(ok.ok, true);
  const bad = validateManifest(JSON.parse(MANIFEST({ hooks: { PostToolUse: [{ matcher: 'bash' }] } })));
  assert.match(bad.error, /needs a "command"/);
  const notObj = validateManifest(JSON.parse(MANIFEST({ hooks: 'node x.js' })));
  assert.match(notObj.error, /hooks must be an object/);
});

test('sanitizePluginName: repo basenames, .git suffix, junk squeezed into a legal name', () => {
  assert.equal(sanitizePluginName('my-plugin.git'), 'my-plugin');
  assert.equal(sanitizePluginName('Cool Tool!'), 'cool-tool');
  assert.equal(sanitizePluginName('../escape'), 'escape');
});

test('parsePluginSource: github shorthand, full URL, local path, bundled pack', () => {
  const repo = parsePluginSource('owner/repo-pack', { exists: () => false });
  assert.equal(repo.kind, 'repo');
  assert.equal(repo.url, 'https://github.com/owner/repo-pack');
  assert.equal(repo.name, 'repo-pack');
  const url = parsePluginSource('https://gitlab.com/g/some-plugin.git', { exists: () => false });
  assert.equal(url.kind, 'repo');
  assert.equal(url.name, 'some-plugin');
  const p = parsePluginSource('/tmp/real-dir', { exists: (x) => x === '/tmp/real-dir' });
  assert.equal(p.kind, 'path');
  assert.equal(p.isGit, false);
  const gitPath = parsePluginSource('/tmp/real-dir', { exists: (x) => x === '/tmp/real-dir' || x === '/tmp/real-dir/.git' });
  assert.equal(gitPath.isGit, true);
  const pack = parsePluginSource('pack-python', { exists: (x) => x.endsWith('packs/pack-python') || x.endsWith('packs' + path.sep + 'pack-python') });
  assert.equal(pack.kind, 'bundled');
  assert.equal(parsePluginSource('').kind, 'error');
  assert.match(parsePluginSource('nope-not-here', { exists: () => false }).error, /cannot resolve/);
});

test('scanBundles + summarizeBundles: counts what the folder carries, one honest line', () => {
  const dir = tmp();
  write(path.join(dir, 'skills', 'a', 'SKILL.md'), '# x');
  write(path.join(dir, 'commands', 'b.md'), 'body');
  write(path.join(dir, 'mcp.json'), '{}');
  const b = scanBundles(dir, { hooks: { PostToolUse: [], Stop: [] } });
  assert.equal(b.skills, 1);
  assert.equal(b.commands, 1);
  assert.equal(b.mcp, 1);
  assert.equal(b.hooks, 2);
  assert.equal(b.agents, 0);
  assert.equal(summarizeBundles(b), '1 skill · 1 command · 1 mcp server · 2 hooks');
  assert.equal(summarizeBundles({}), 'empty bundle (manifest only)');
});

// ── Part B: discovery ────────────────────────────────────────────────────────

test('discoverPlugins: project layer found, bundle counts attached', () => {
  const root = tmp();
  const home = tmp();
  write(path.join(root, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST());
  write(path.join(root, '.buddy', 'plugins', 'demo', 'skills', 's1', 'SKILL.md'), '---\nname: s1\ndescription: d\n---\nbody');
  const { plugins, warnings } = discoverPlugins({ root, home });
  assert.equal(warnings.length, 0);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'demo');
  assert.equal(plugins[0].source, 'project');
  assert.equal(plugins[0].enabled, true);
  assert.equal(plugins[0].bundles.skills, 1);
});

test('discoverPlugins: name collision — project wins, personal skipped with a warning', () => {
  const root = tmp();
  const home = tmp();
  write(path.join(root, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST({ description: 'project copy' }));
  write(path.join(home, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST({ description: 'personal copy' }));
  const { plugins, warnings } = discoverPlugins({ root, home });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].description, 'project copy');
  assert.match(warnings.join(' '), /personal copy skipped/);
});

test('discoverPlugins: plugins.disabled in settings flips enabled=false', () => {
  const root = tmp();
  const home = tmp();
  write(path.join(root, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST());
  const settingsFile = path.join(root, '.buddy', 'settings.json');
  write(settingsFile, JSON.stringify({ plugins: { disabled: ['demo'] } }));
  const { plugins } = discoverPlugins({ root, home });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].enabled, false);
  assert.equal(discoverPlugins({ root, home }).plugins.filter((p) => p.enabled).length, 0);
});

test('discoverPlugins: junk dirs and bad manifests degrade to warnings, never throw', () => {
  const root = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(root, '.buddy', 'plugins', '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(root, '.buddy', 'plugins', 'no-manifest'), { recursive: true });
  write(path.join(root, '.buddy', 'plugins', 'broken', 'buddy.plugin.json'), '{not json');
  const { plugins, warnings } = discoverPlugins({ root, home });
  assert.equal(plugins.length, 0);
  assert.equal(warnings.length, 2, 'hidden dir ignored, two visible junk dirs warned');
  assert.match(warnings.join(' '), /missing buddy\.plugin\.json/);
  assert.match(warnings.join(' '), /not valid JSON/);
});

test('discoverPlugins: manifest name ≠ folder name adopts the folder name with a warning', () => {
  const root = tmp();
  const home = tmp();
  write(path.join(root, '.buddy', 'plugins', 'folder-name', 'buddy.plugin.json'), MANIFEST({ name: 'other-name' }));
  const { plugins, warnings } = discoverPlugins({ root, home });
  assert.equal(plugins[0].name, 'folder-name');
  assert.match(warnings.join(' '), /folder name/);
});

// ── Part C: loader integration ───────────────────────────────────────────────

function fixtureRoot() {
  const root = tmp();
  const home = tmp();
  const pdir = path.join(root, '.buddy', 'plugins', 'demo');
  write(path.join(pdir, 'buddy.plugin.json'), MANIFEST({
    hooks: { PostToolUse: [{ matcher: 'fs_write', command: 'node demo-hook.js' }] },
  }));
  write(path.join(pdir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: from the plugin\n---\nplaybook body');
  write(path.join(pdir, 'agents', 'demo-agent.md'), '---\nname: demo-agent\ndescription: plugin agent\n---\npersona');
  write(path.join(pdir, 'commands', 'demo-cmd.md'), '---\ndescription: plugin command\n---\nrun $ARGUMENTS');
  write(path.join(pdir, 'tools', 'demo-tool', 'manifest.json'), JSON.stringify({ name: 'demo-tool', description: 'plugin tool', version: 1 }));
  write(path.join(pdir, 'tools', 'demo-tool', 'index.js'), 'export async function run(){return "ok"}');
  write(path.join(pdir, 'reporters', 'demo-reporter.json'), JSON.stringify({ description: 'plugin reporter', request: { method: 'GET', url: 'https://example.org/ping' } }));
  write(path.join(pdir, 'mcp.json'), JSON.stringify({ mcpServers: { 'demo-server': { command: 'node', args: ['server.js'] } } }));
  return { root, home, pdir };
}

test('loadSkills: plugin skill appears as a plugin layer; personal shadows it', () => {
  const { root, home } = fixtureRoot();
  const first = loadSkills({ root, home });
  const demo = first.skills.find((s) => s.name === 'demo-skill');
  assert.ok(demo, 'plugin skill in catalog');
  assert.equal(demo.source, 'plugin');
  assert.match(describeSkillCatalog(first.skills), /demo-skill/);
  // the user's own personal skill shadows the plugin's
  write(path.join(home, '.buddy', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: mine\n---\nMINE');
  const second = loadSkills({ root, home });
  assert.equal(second.skills.find((s) => s.name === 'demo-skill').body, 'MINE');
  assert.ok(second.warnings.some((w) => /shadows the plugin one/.test(w)));
});

test('loadAgents: plugin agent visible; project .buddy/agents wins on collision', () => {
  const { root, home } = fixtureRoot();
  const first = loadAgents(root, { home });
  const demo = first.agents.find((a) => a.name === 'demo-agent');
  assert.ok(demo, 'plugin agent loaded');
  assert.match(demo.description, /plugin agent/);
  write(path.join(root, '.buddy', 'agents', 'demo-agent.md'), '---\nname: demo-agent\ndescription: mine wins\n---\nMINE');
  const second = loadAgents(root, { home });
  assert.equal(second.agents.find((a) => a.name === 'demo-agent').description, 'mine wins');
  assert.ok(second.warnings.some((w) => /demo-agent.*shadows/.test(w)));
});

test('loadCustomCommands: plugin command usable and expandable', () => {
  const { root, home } = fixtureRoot();
  const { commands } = loadCustomCommands(root, { home });
  const cmd = commands.get('demo-cmd');
  assert.ok(cmd, 'plugin command loaded');
  assert.equal(applyCustomCommand(cmd, 'with args'), 'run with args');
});

test('loadUserTools: plugin tool joins with the plugin source tag', () => {
  const { root, home } = fixtureRoot();
  const { tools, warnings } = loadUserTools(root, { home });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  const t = tools.find((x) => x.name === 'demo-tool');
  assert.ok(t, 'plugin tool loaded');
  assert.match(t.description, /\[user-tool v1\]/);
});

test('loadHooks: manifest hooks registered after settings hooks; invalid ones warn', () => {
  const { root, home } = fixtureRoot();
  write(path.join(root, '.buddy', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: { matcher: 'bash', command: 'node guard.js' } } }));
  const { hooks, warnings } = loadHooks(root, { home });
  const pre = hooks.get('PreToolUse') || [];
  assert.equal(pre.length, 1, 'settings hook');
  const post = hooks.get('PostToolUse') || [];
  assert.equal(post.length, 1, 'plugin manifest hook');
  assert.equal(post[0].command, 'node demo-hook.js');
  assert.match(post[0].matcherSrc, /fs_write/);
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  // broken plugin hook shape → the manifest gate refuses the WHOLE plugin up
  // front (a plugin with a broken hook contract is not installable at all)
  write(path.join(root, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST({ hooks: { Stop: [{ nope: true }] } }));
  const bad = loadHooks(root, { home });
  assert.equal((bad.hooks.get('Stop') || []).length, 0);
  assert.ok(bad.warnings.some((w) => /hooks\.Stop: every entry needs a "command"/.test(w)), JSON.stringify(bad.warnings));
  assert.ok(bad.warnings.some((w) => /skipped/.test(w)));
});

test('loadReporters: extraDirs merges plugin reporters, name collision keeps the project one', () => {
  const { root, home } = fixtureRoot();
  const first = loadReporters(root, { extraDirs: pluginKindDirs(discoverPlugins({ root, home }).plugins.filter((p) => p.enabled), 'reporters') });
  assert.ok(first.reporters.find((r) => r.name === 'demo-reporter'), 'plugin reporter loaded');
  // project copy wins
  write(path.join(root, '.buddy', 'reporters', 'demo-reporter.json'), JSON.stringify({ description: 'project reporter', request: { method: 'GET', url: 'https://example.org/mine' } }));
  const second = loadReporters(root, { extraDirs: pluginKindDirs(discoverPlugins({ root, home }).plugins.filter((p) => p.enabled), 'reporters') });
  const r = second.reporters.find((x) => x.name === 'demo-reporter');
  assert.match(r.request.url, /\/mine$/);
  assert.ok(second.warnings.some((w) => /duplicate reporter name/.test(w)));
});

test('pluginHookEntries + pluginKindDirs: loader-facing helpers see only enabled plugins', () => {
  const { root, home } = fixtureRoot();
  const all = discoverPlugins({ root, home }).plugins;
  assert.equal(pluginHookEntries(all).length, 1);
  assert.equal(pluginKindDirs(all, 'skills').length, 1);
  setPluginEnabled(root, 'demo', false);
  const off = discoverPlugins({ root, home }).plugins;
  assert.equal(pluginHookEntries(off.filter((p) => p.enabled)).length, 0);
  assert.equal(pluginKindDirs(off.filter((p) => p.enabled), 'skills').length, 0);
});

// ── Part D: install / remove / enable ────────────────────────────────────────

function gitInit(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) write(path.join(dir, p), c);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
}

test('installPlugin: a local git repo is cloned, validated, and discovered', () => {
  const root = tmp();
  const home = tmp();
  const src = tmp();
  gitInit(src, {
    'buddy.plugin.json': MANIFEST({ name: 'remote-plugin' }),
    'skills/s1/SKILL.md': '---\nname: s1\ndescription: d\n---\nx',
  });
  const r = installPlugin({ root, from: src, home });
  assert.equal(r.ok, true, r.error || '');
  // the install name comes from the SOURCE folder basename; the manifest name
  // normalizes to the folder name at discovery (that rule is tested above)
  assert.equal(r.plugin.name, sanitizePluginName(path.basename(src)));
  assert.equal(r.plugin.bundles.skills, 1);
  const { plugins } = discoverPlugins({ root, home });
  assert.ok(plugins.find((p) => p.name === sanitizePluginName(path.basename(src))));
  // clone keeps .git (a later refresh story), but the manifest must be at the
  // root of the installed folder
  assert.ok(fs.existsSync(path.join(root, '.buddy', 'plugins', sanitizePluginName(path.basename(src)), 'buddy.plugin.json')));
});

test('installPlugin: refuses an existing install, cleans staging on a broken source', () => {
  const root = tmp();
  const home = tmp();
  const src = tmp();
  gitInit(src, { 'buddy.plugin.json': MANIFEST({ name: 'good' }) });
  assert.equal(installPlugin({ root, from: src, home }).ok, true);
  const again = installPlugin({ root, from: src, home });
  assert.equal(again.ok, false);
  assert.match(again.error, /already installed/);
  // broken source: staging never leaks
  const bad = tmp();
  write(path.join(bad, 'readme.md'), 'not a plugin');
  const r = installPlugin({ root, from: bad, home });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a valid plugin/);
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'plugins')).filter((n) => n.startsWith('.staging')).length, 0);
});

test('installPlugin: a bundled pack copies from packs/ and lands enabled', () => {
  const root = tmp();
  const home = tmp();
  const r = installPlugin({ root, from: 'pack-nextjs', home });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.plugin.name, 'pack-nextjs');
  assert.equal(r.plugin.bundles.skills, 1);
  assert.equal(r.plugin.bundles.commands, 1);
  assert.ok(fs.existsSync(path.join(root, '.buddy', 'plugins', 'pack-nextjs', 'skills', 'nextjs-app-router', 'SKILL.md')));
  // and it loads as a real skill in the consumer's catalog
  const { skills } = loadSkills({ root, home });
  assert.ok(skills.find((s) => s.name === 'nextjs-app-router'));
});

test('removePlugin deletes the folder; setPluginEnabled round-trips the disabled list', () => {
  const root = tmp();
  const home = tmp();
  installPlugin({ root, from: 'pack-python', home });
  const off = setPluginEnabled(root, 'pack-python', false);
  assert.deepEqual(off, ['pack-python']);
  assert.deepEqual(readProjectSettings(root).plugins.disabled, ['pack-python']);
  assert.equal(discoverPlugins({ root, home }).plugins[0].enabled, false);
  setPluginEnabled(root, 'pack-python', true);
  assert.deepEqual(readProjectSettings(root).plugins.disabled, []);
  assert.equal(removePlugin({ root, name: 'pack-python' }).ok, true);
  assert.equal(fs.readdirSync(path.join(root, '.buddy', 'plugins')).length, 0);
  assert.match(removePlugin({ root, name: 'pack-python' }).error, /not installed/);
});

// ── Part E: REPL wiring ──────────────────────────────────────────────────────

test('connectMcpServers: plugin mcp.json fragments merge; collisions + junk degrade to failed', async () => {
  const { root, home } = fixtureRoot(); // demo plugin carries mcp server "demo-server"
  // a project config that collides with the plugin's server name wins
  write(path.join(root, '.buddy', 'mcp.json'), JSON.stringify({ mcpServers: { 'demo-server': { command: 'node', args: ['mine.js'] } } }));
  const collided = await connectMcpServers(root, { home, initTimeoutMs: 500 });
  assert.ok(collided.failed.some((f) => f.name === 'plugin:demo' && /already defined/.test(f.error)), JSON.stringify(collided.failed));
  // broken fragment → failed entry, never a throw
  const root2 = tmp();
  write(path.join(root2, '.buddy', 'plugins', 'demo', 'buddy.plugin.json'), MANIFEST());
  write(path.join(root2, '.buddy', 'plugins', 'demo', 'mcp.json'), '{oops');
  const broken = await connectMcpServers(root2, { home, initTimeoutMs: 500 });
  assert.ok(broken.failed.some((f) => f.name === 'plugin:demo' && /not valid JSON/.test(f.error)));
  // a clean fragment with no project config survives into the merge (the
  // connect itself fails offline — the server never starts — which proves it
  // was ATTEMPTED, i.e. the fragment reached the connection stage)
  const clean = await connectMcpServers(fixtureRoot().root, { home, initTimeoutMs: 500 });
  assert.ok(clean.failed.some((f) => f.name === 'demo-server'), JSON.stringify(clean.failed));
});

test('SLASH_COMMANDS registers /plugin with a palette description', () => {
  assert.ok(SLASH_COMMANDS.includes('plugin'));
  assert.match(SLASH_DESCRIPTIONS.plugin, /plugins/i);
  assert.match(SLASH_DESCRIPTIONS.plugin, /browse/);
});

test('repl.js source: /plugin dispatch, status line, help row, loader hookups all present', () => {
  const src = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(src, /case 'plugin': \{/);
  assert.match(src, /printPluginStatus\(installedPlugins, pluginWarnings\)/);
  assert.match(src, /marketplaceEntries\(\{ root \}\)/);
  assert.match(src, /extraDirs: pluginKindDirs\(installedPlugins\.filter\(\(p\) => p\.enabled\), 'reporters'\)/);
  assert.match(src, /\['\/plugin',/);
  // every loader gained its plugin layer
  const skills = fs.readFileSync(new URL('../src/skills/loader.js', import.meta.url), 'utf8');
  assert.match(skills, /enabledPlugins\(\{ root, home \}\)/);
  const agents = fs.readFileSync(new URL('../src/agent/subagents.js', import.meta.url), 'utf8');
  assert.match(agents, /pluginKindDirs\(plugins, 'agents'\)/);
  const cmds = fs.readFileSync(new URL('../src/terminal/customcommands.js', import.meta.url), 'utf8');
  assert.match(cmds, /pluginKindDirs\(plugins, 'commands'\)/);
  const tools = fs.readFileSync(new URL('../src/tools/usertools.js', import.meta.url), 'utf8');
  assert.match(tools, /pluginKindDirs\(plugins, 'tools'\)/);
  const hooks = fs.readFileSync(new URL('../src/hooks.js', import.meta.url), 'utf8');
  assert.match(hooks, /pluginHookEntries\(plugins\)/);
  const mcp = fs.readFileSync(new URL('../src/tools/mcp.js', import.meta.url), 'utf8');
  assert.match(mcp, /mcp\.json is not valid JSON/);
});
