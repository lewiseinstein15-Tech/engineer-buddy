// customcommands.test.js — Build 15 (P1): user-defined slash commands.
//
// Locks down:
//   1. frontmatter parsing (description, argument-hint, allowed-tools)
//   2. project + user dirs merge, project wins on clash
//   3. built-in name collisions are skipped with a reason; junk filenames skipped
//   4. $ARGUMENTS and $1..$9 substitution; missing positionals → ''; no
//      placeholder → the tail is appended
//   5. /help renders the custom section; the dispatcher wires lookup →
//      expansion → runTask (source tripwires)
//   6. allowed-tools restriction arms the chat's turn restriction (same
//      mechanism as skills — one integration test through chat.turn)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, loadCustomCommands, applyCustomCommand, renderCustomCommandHelp } from '../src/terminal/customcommands.js';
import { SLASH_COMMANDS } from '../src/terminal/repl.js';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-cmd-'));
}

function writeCmd(base, name, content) {
  const dir = path.join(base, '.buddy', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

const HOME = tmp();

test('custom commands: frontmatter parses description, argument-hint, allowed-tools', () => {
  const { meta, body } = parseFrontmatter('---\ndescription: Explain a file\nargument-hint: path\nallowed-tools: fs_read, say\n---\n\nRead @body here.\n');
  assert.equal(meta.description, 'Explain a file');
  assert.equal(meta['argument-hint'], 'path');
  assert.equal(meta['allowed-tools'], 'fs_read, say');
  assert.equal(body, 'Read @body here.');
  // no frontmatter → whole text is body
  const bare = parseFrontmatter('just a body');
  assert.deepEqual(bare.meta, {});
  assert.equal(bare.body, 'just a body');
});

test('custom commands: project + user merge, project wins; built-ins skipped', () => {
  const root = tmp();
  writeCmd(HOME, 'greet.md', '---\ndescription: home version\n---\nhello from home');
  writeCmd(HOME, 'explain.md', 'home explain');
  writeCmd(root, 'greet.md', '---\ndescription: project version\n---\nhello from project');
  writeCmd(root, 'new.md', 'shadowing a builtin');
  writeCmd(root, 'Bad Name.md', 'junk');
  const { commands, skipped } = loadCustomCommands(root, { home: HOME, builtins: SLASH_COMMANDS });
  assert.equal(commands.get('greet').description, 'project version');
  assert.equal(commands.get('greet').body, 'hello from project');
  assert.equal(commands.get('explain').body, 'home explain');
  assert.equal(commands.has('new'), false, 'built-in name never shadowed');
  assert.ok(skipped.some((s) => s.name === 'new' && /built-in/.test(s.reason)));
  assert.equal(commands.has('Bad Name'), false);
});

test('custom commands: $ARGUMENTS and $1..$9 substitution', () => {
  const cmd = { name: 't', body: 'fix $1 in $2 because $ARGUMENTS' };
  assert.equal(applyCustomCommand(cmd, 'login auth "all tests"'), 'fix login in auth because login auth "all tests"');
  // missing positional → empty string, not "$3"
  const cmd2 = { name: 't2', body: 'only $2 matters' };
  assert.equal(applyCustomCommand(cmd2, 'one'), 'only  matters');
  // no placeholder → tail appended
  const cmd3 = { name: 't3', body: 'plain body' };
  assert.equal(applyCustomCommand(cmd3, 'some tail'), 'plain body\n\nsome tail');
  assert.equal(applyCustomCommand(cmd3, ''), 'plain body');
});

test('custom commands: /help lists custom commands (pure renderer)', () => {
  const commands = new Map([
    ['greet', { name: 'greet', description: 'say hi', argumentHint: '', body: 'x', source: 's' }],
    ['fix', { name: 'fix', description: '', argumentHint: 'area', body: 'fix it', source: 's' }],
  ]);
  const help = renderCustomCommandHelp(commands);
  assert.match(help, /Custom commands/);
  assert.match(help, /greet/);
  assert.match(help, /say hi/);
  assert.match(help, /fix <area>/);
  assert.equal(renderCustomCommandHelp(new Map()), '');
});

test('custom commands: dispatcher wires lookup → expansion → runTask (source tripwires)', async () => {
  const src = fs.readFileSync(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');
  assert.match(src, /loadCustomCommands\(root, \{ builtins: SLASH_COMMANDS \}\)/, 'dispatch looks up custom commands');
  assert.match(src, /applyCustomCommand\(custom, slash\.args\)/, 'expansion uses the raw tail');
  assert.match(src, /custom commands QUEUE/, 'custom commands are tasks, not instant handlers');
  assert.match(src, /renderCustomCommandHelp/, '/help renders the custom section');
});

test('custom commands: allowed-tools arms the chat turn restriction (skills mechanism)', async () => {
  const root = tmp();
  ensureHarness(root);
  const tools = buildLocalTools({ scope: new LocalScope(root) });
  const harness = harnessContext(loadHarness(root));
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages) => {
      calls.push(messages);
      return { text: '{"tool":"fs_list","args":{"path":"."}}', gateway: 'fake' };
    },
  };
  const chat = createChat({ router, tools, harness });
  // allowedTools = say only → fs_list must be refused by the restriction
  const r = await chat.turn('run it', { skill: { name: 'mycmd', allowedTools: ['say'] } });
  const all = calls[calls.length - 1].map((m) => m.content || '').join('\n');
  assert.match(all, /restricts this task to tools: say/);
});

function messages_toolobs(calls) {
  const last = calls[calls.length - 1];
  const obsMsg = [...last].reverse().find((m) => typeof m.content === 'string' && m.content.startsWith('TOOL OBSERVATION'));
  return obsMsg ? obsMsg.content : '';
}
