// hooks.test.js — the deterministic guarantee layer: user-defined shell
// commands at lifecycle points, JSON on stdin, exit 0 = allow / 2 = block.
//
// CC parity item from the checklist P0 list. These tests pin the contract:
// config parsing (+ warnings for junk), matcher filtering, block semantics
// (PreToolUse stops the tool BEFORE the gate/caps; UserPromptSubmit refuses
// the prompt BEFORE a brain call), PostToolUse annotation, OnError + Stop
// side effects, PreCompact veto, and /hooks registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHooks, HookRunner, HOOK_EVENTS, HOOK_ALIASES } from '../src/hooks.js';
import { createChat } from '../src/agent/chat.js';
import { SLASH_COMMANDS } from '../src/terminal/repl.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hooks-'));
}

function writeSettings(root, cfg) {
  fs.mkdirSync(path.join(root, '.buddy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.buddy/settings.json'), JSON.stringify(cfg));
}

function writeScript(root, name, body) {
  fs.writeFileSync(path.join(root, name), body);
  return `node ${name}`;
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { scope, tools, harness };
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

async function waitFor(file, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return null;
}

test('hooks: loadHooks parses object and array forms, expands aliases', () => {
  const root = tmpRoot();
  writeSettings(root, {
    hooks: {
      PreToolUse: { matcher: 'bash', command: 'node a.js' },
      PostToolUse: [{ command: 'node b.js' }, { matcher: 'fs_write', command: 'node c.js' }],
      pre_edit: 'node d.js',
      on_error: { command: 'node e.js' },
    },
  });
  const { hooks, warnings } = loadHooks(root);
  assert.equal(warnings.length, 0);
  assert.deepEqual([...hooks.keys()].sort(), ['OnError', 'PostToolUse', 'PreToolUse']);
  const pre = hooks.get('PreToolUse');
  assert.equal(pre.length, 2); // explicit bash matcher + pre_edit's fs_* matcher
  assert.equal(pre[1].matcherSrc, 'fs_write|fs_replace|fs_append|multi_edit');
  const runner = new HookRunner({ root });
  const flat = runner.list();
  assert.ok(flat.some((h) => h.event === 'PreToolUse' && h.matcher === 'bash' && h.command === 'node a.js'));
  assert.ok(flat.some((h) => h.event === 'OnError'));
  assert.equal(runner.size, 5);
});

test('hooks: pre_edit alias covers every mutating file tool (v0.11.2 live leak: a fs_write-only rule was routed via fs_append)', () => {
  const re = new RegExp(`^(?:${HOOK_ALIASES.pre_edit.matcher})$`);
  for (const t of ['fs_write', 'fs_replace', 'fs_append', 'multi_edit']) {
    assert.ok(re.test(t), `pre_edit matches ${t}`);
  }
  assert.equal(re.test('fs_read'), false, 'read tools stay untouched');
  assert.equal(re.test('bash'), false, 'commands are pre_command territory');
});

test('hooks: explicit matcher alternation covers sibling tools', async () => {
  const root = tmpRoot();
  const cmd = writeScript(root, 'block-edits.js', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stderr.write("writes are frozen today");process.exit(2);});');
  writeSettings(root, { hooks: { PreToolUse: { matcher: 'fs_write|fs_append', command: cmd } } });
  const runner = new HookRunner({ root });
  assert.equal((await runner.run('PreToolUse', { tool: 'fs_write', args: {} })).blocked, true);
  assert.equal((await runner.run('PreToolUse', { tool: 'fs_append', args: {} })).blocked, true, 'the fs_append escape route is closed');
  assert.equal((await runner.run('PreToolUse', { tool: 'fs_read', args: {} })).blocked, false, 'read tools stay untouched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hooks: junk config degrades to warnings, never throws', () => {
  const root = tmpRoot();
  writeSettings(root, {
    hooks: {
      NotAnEvent: 'node x.js', // unknown event
      Stop: { command: '' }, // missing command
      PreToolUse: { matcher: '([', command: 'node y.js' }, // bad regex
      SessionStart: 42, // entry without a command
    },
  });
  const { hooks, warnings } = loadHooks(root);
  assert.equal(hooks.size, 0);
  assert.equal(warnings.length, 4);
  const runner = new HookRunner({ root });
  assert.equal(runner.size, 0);
  assert.deepEqual(runner.list(), []);
  // broken JSON in settings is a warning, not a crash
  fs.writeFileSync(path.join(root, '.buddy/settings.json'), '{ oops');
  const { warnings: w2 } = loadHooks(root);
  assert.ok(w2.some((s) => /settings unreadable/.test(s)));
  assert.deepEqual(loadHooks(tmpRoot()).hooks.size, 0, 'missing file = no hooks');
});

test('hooks: runner passes the event JSON on stdin and matches tool matchers', async () => {
  const root = tmpRoot();
  // exits 2 only when the payload looks right for bash; otherwise exits 3 (non-blocking)
  const cmd = writeScript(
    root,
    'check.js',
    `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const e = JSON.parse(d);
      if (e.event !== 'PreToolUse' || e.tool === undefined || !('args' in e)) process.exit(3);
      if (/rm /.test(e.args.command || '')) { process.stderr.write('no destructive commands'); process.exit(2); }
      process.exit(0);
    });`
  );
  const runner = new HookRunner({ root, loaded: loadHooks(writeSettingsRunner(root, 'PreToolUse', cmd)) });
  const ok = await runner.run('PreToolUse', { tool: 'bash', args: { command: 'npm test' } });
  assert.deepEqual(ok, { blocked: false });
  const blocked = await runner.run('PreToolUse', { tool: 'bash', args: { command: 'rm -rf /tmp/x' } });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.stderr, 'no destructive commands');
  // a matcher limits the blast radius: bash-hook never blocks fs_write
  const fsRunner = new HookRunner({ root, loaded: loadHooks(writeSettingsRunner(root, 'PreToolUse', { matcher: 'bash', command: cmd })) });
  assert.deepEqual(await fsRunner.run('PreToolUse', { tool: 'fs_write', args: { path: 'x' } }), { blocked: false });
  // non-2 exits never block
  const odd = writeScript(root, 'odd.js', 'process.exit(1);');
  const oddRunner = new HookRunner({ root, loaded: loadHooks(writeSettingsRunner(root, 'PreToolUse', odd)) });
  assert.deepEqual(await oddRunner.run('PreToolUse', { tool: 'bash', args: {} }), { blocked: false });
});

function writeSettingsRunner(root, event, entry) {
  writeSettings(root, { hooks: { [event]: entry } });
  return root;
}

test('chat: PreToolUse exit-2 stops the tool BEFORE it runs', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const target = path.join(root, 'out.txt');
  const cmd = writeScript(root, 'block-write.js', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);if(e.tool==="fs_write"){process.stderr.write("writes are frozen today");process.exit(2);}process.exit(0);});');
  writeSettings(root, { hooks: { PreToolUse: { matcher: 'fs_write', command: cmd } } });
  const hooks = new HookRunner({ root });
  const events = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"fs_write","args":{"path":"out.txt","content":"nope"}}', '{"tool":"say","message":"done"}']),
    tools,
    harness,
    hooks,
    approval: () => 'yes',
    onEvent: (e) => events.push(e),
  });
  const out = await chat.turn('write the file');
  assert.equal(out.said, 'done');
  assert.ok(!fs.existsSync(target), 'the write NEVER happened');
  const ev = events.find((e) => e.type === 'tool' && e.tool === 'fs_write');
  assert.match(ev.observation, /BLOCKED by hook: writes are frozen today/);
  assert.match(ev.observation, /Do not retry the exact same call/);
});

test('chat: UserPromptSubmit exit-2 refuses the prompt before any brain call', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const cmd = writeScript(root, 'block-prompt.js', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);if(/deploy/.test(e.prompt||"")){process.stderr.write("deployments need the human");process.exit(2);}process.exit(0);});');
  writeSettings(root, { hooks: { UserPromptSubmit: { command: cmd } } });
  const hooks = new HookRunner({ root });
  const calls = [];
  const events = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"say","message":"should never run"}'], calls),
    tools,
    harness,
    hooks,
    onEvent: (e) => events.push(e),
  });
  const out = await chat.turn('please deploy to production');
  assert.equal(out.said, null);
  assert.equal(out.hookBlocked, true);
  assert.equal(calls.length, 0, 'zero brain calls for a blocked prompt');
  assert.ok(events.some((e) => e.type === 'error' && /prompt blocked by hook: deployments need the human/.test(e.text)));
  assert.equal(chat.messages.length, 0, 'the refused prompt never entered the history');
  // a benign prompt passes the same hook
  const out2 = await chat.turn('fix the readme typo');
  assert.equal(out2.said, 'should never run');
});

test('chat: PostToolUse exit-2 annotates the observation; OnError fires on tool errors', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const log = path.join(root, 'hooklog.txt');
  const post = writeScript(root, 'post.js', `let d="";const fs=require("node:fs");process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);if(e.tool==="bash"&&e.observation&&e.observation.includes("exit ")){process.stderr.write("remember to cite the exit code");process.exit(2);}fs.appendFileSync(${JSON.stringify(log)}, "post:"+e.tool+";");process.exit(0);});`);
  const onerr = writeScript(root, 'onerr.js', `let d="";const fs=require("node:fs");process.stdin.on("data",c=>d+=c).on("end",()=>{fs.appendFileSync(${JSON.stringify(log)}, "onerror:"+JSON.parse(d).tool+";");process.exit(0);});`);
  writeSettings(root, { hooks: { PostToolUse: { matcher: 'bash', command: post }, OnError: { command: onerr } } });
  const hooks = new HookRunner({ root });
  const events = [];
  const chat = createChat({
    // step 1: bash exit 1 (PostToolUse annotation — a failed command is normal
    // signal, NOT an OnError); step 2: fs_read of a missing file (a real tool
    // ERROR → OnError fires); step 3: wrap up.
    router: fakeRouter([
      '{"tool":"bash","args":{"command":"false"}}',
      '{"tool":"fs_read","args":{"path":"no-such-file.txt"}}',
      '{"tool":"say","message":"ok"}',
    ]),
    tools,
    harness,
    hooks,
    approval: () => 'yes',
    onEvent: (e) => events.push(e),
  });
  await chat.turn('run a failing command then a bad read');
  const bashEv = events.find((e) => e.type === 'tool' && e.tool === 'bash');
  assert.match(bashEv.observation, /\[hook\] remember to cite the exit code/, 'PostToolUse annotation appended');
  const logged = await waitFor(log);
  assert.ok(logged && logged.includes('onerror:fs_read'), 'OnError saw the tool error (not the bash exit code)');
});

test('chat: Stop fires when the turn ends with a say', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const log = path.join(root, 'stoplog.txt');
  const stop = writeScript(root, 'stop.js', `let d="";const fs=require("node:fs");process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);fs.appendFileSync(${JSON.stringify(log)}, "stop:"+(e.said||"")+";");process.exit(0);});`);
  writeSettings(root, { hooks: { Stop: { command: stop } } });
  const hooks = new HookRunner({ root });
  const chat = createChat({
    router: fakeRouter(['{"tool":"say","message":"all done"}']),
    tools,
    harness,
    hooks,
  });
  const out = await chat.turn('finish up');
  assert.equal(out.said, 'all done');
  const logged = await waitFor(log);
  assert.ok(logged && logged.includes('stop:all done'));
});

test('chat: PreCompact exit-2 vetoes compaction', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const cmd = writeScript(root, 'veto.js', 'process.exit(2);');
  writeSettings(root, { hooks: { PreCompact: { command: cmd } } });
  const hooks = new HookRunner({ root });
  const calls = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"say","message":"hi"}'], calls),
    tools,
    harness,
    hooks,
    charBudget: 10,
  });
  for (let i = 0; i < 6; i++) chat.messages.push({ role: i % 2 ? 'assistant' : 'user', content: `old message ${i} padding` });
  await chat.turn('go on');
  assert.equal(chat.compactCount, 0, 'the veto held — no compaction happened');
  assert.ok(calls.length >= 1);
});

test('hooks: SessionStart fires for one-shot sessions and /hooks is registered', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const log = path.join(root, 'startlog.txt');
  const start = writeScript(root, 'start.js', `let d="";const fs=require("node:fs");process.stdin.on("data",c=>d+=c).on("end",()=>{fs.appendFileSync(${JSON.stringify(log)}, "start:"+JSON.parse(d).mode+";");process.exit(0);});`);
  writeSettings(root, { hooks: { SessionStart: { command: start } } });
  const hooks = new HookRunner({ root });
  hooks.fireAndForget('SessionStart', { mode: 'one-shot' });
  const logged = await waitFor(log);
  assert.ok(logged && logged.includes('start:one-shot'), 'SessionStart hook saw the one-shot mode');
  assert.ok(SLASH_COMMANDS.includes('hooks'), '/hooks is in the slash palette');
  assert.ok(HOOK_EVENTS.includes('OnError'));
});

