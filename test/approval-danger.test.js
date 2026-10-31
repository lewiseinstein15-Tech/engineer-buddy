// Bash approval — danger tiers (v0.64.1). The gate used to fire on EVERY
// bash call (risky: true), which trained the operator to rubber-stamp
// `git status` and `npm test` — the live commit task died of a thousand
// approve round-trips while the real killers sailed through the same
// fatigue. Now bash declares riskyWhen: the gate fires only on the
// destructive shapes that actually reach execution (rm-family, work-
// discarding git checkout --/restore). The worse ones (rm -rf, git push,
// dd, sudo, network) are already REFUSED by the shell blocklist — asking a
// human to approve a command the guard will refuse anyway is a wasted
// round-trip, and `git push` belongs to git_write, whose gate asks on
// EVERY mutating op. Pins that carry the house rules:
//   - a safe command (echo) runs with the approval spy at ZERO calls;
//   - `rm seed.txt` asks; a denial keeps the file; an approval runs it;
//   - "always" is remembered PER CALL SHAPE — `rm a.txt` approved-always
//     never pre-approves `rm b.txt` (a tool-level key would silence every
//     future command once the gate is per-command);
//   - the same exact shape does not ask twice;
//   - the deny/allow rules engine still outranks all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/agent/chat.js';
import { LocalScope, buildLocalTools, isDangerousBash } from '../src/tools/local.js';
import { ensureHarness, harnessContext, loadHarness } from '../src/harness/scaffold.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-danger-'));
}

function makeBuddy(root) {
  ensureHarness(root);
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

function fakeRouter(script) {
  return {
    chat: async () => {
      const text = script.length ? script.shift() : '{"tool":"say","message":"(script exhausted)"}';
      return { text, model: 'fake-model', gateway: 'fake', latencyMs: 1 };
    },
  };
}

const obsOf = (chat) => chat.messages.filter((m) => m.content.startsWith('TOOL OBSERVATION')).map((m) => m.content);

test('a safe command runs SILENT — the approval spy stays at zero calls', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  const asks = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"bash","args":{"command":"echo buddy-safe-marker"}}', '{"tool":"say","message":"done"}']),
    tools, harness,
    approval: async (req) => { asks.push(req); return 'yes'; },
  });
  await chat.turn('run a safe command');
  assert.deepEqual(asks, [], 'echo must never gate');
  assert.match(obsOf(chat)[0], /buddy-safe-marker/, 'the command actually ran');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a destructive command asks — a denial keeps the file on disk', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'keep me');
  const asks = [];
  const chat = createChat({
    router: fakeRouter(['{"tool":"bash","args":{"command":"rm seed.txt"}}', '{"tool":"say","message":"understood"}']),
    tools, harness,
    approval: async (req) => { asks.push(req.tool); return 'no'; },
  });
  await chat.turn('delete the seed');
  assert.deepEqual(asks, ['bash'], 'rm gates');
  assert.match(obsOf(chat)[0], /DENIED by the user/);
  assert.equal(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'keep me', 'denial = nothing ran');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the same destructive command, approved, actually runs', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'gone soon');
  const chat = createChat({
    router: fakeRouter(['{"tool":"bash","args":{"command":"rm seed.txt"}}', '{"tool":"say","message":"deleted"}']),
    tools, harness,
    approval: async () => 'yes',
  });
  await chat.turn('delete the seed');
  assert.equal(fs.existsSync(path.join(root, 'seed.txt')), false, 'approved rm ran');
  fs.rmSync(root, { recursive: true, force: true });
});

test('"always" is remembered PER CALL SHAPE — a.txt never pre-approves b.txt', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  const commands = [];
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"bash","args":{"command":"rm a.txt"}}',
      '{"tool":"bash","args":{"command":"rm b.txt"}}',
      '{"tool":"say","message":"both gone"}',
    ]),
    tools, harness,
    approval: async (req) => { commands.push(req.args.command); return 'always'; },
  });
  await chat.turn('delete two files');
  assert.equal(commands.length, 2, 'the second, different shape asked again');
  assert.deepEqual(commands, ['rm a.txt', 'rm b.txt']);
  assert.ok(chat.alwaysApproved.some((k) => k.startsWith('bash·')), 'the always-key is call-shaped');
  assert.ok(!chat.alwaysApproved.includes('bash'), 'no tool-level bash key can silence future commands');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the same exact shape does not ask twice', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  fs.writeFileSync(path.join(root, 'c.txt'), 'c');
  let asks = 0;
  const chat = createChat({
    router: fakeRouter([
      '{"tool":"bash","args":{"command":"rm c.txt"}}',
      '{"tool":"bash","args":{"command":"rm c.txt"}}',
      '{"tool":"say","message":"done"}',
    ]),
    tools, harness,
    approval: async () => { asks += 1; return 'always'; },
  });
  await chat.turn('delete it twice');
  assert.equal(asks, 1, 'the identical shape rides the remembered key');
  fs.rmSync(root, { recursive: true, force: true });
});

test('isDangerousBash: the tier table', () => {
  // Not gated: reads, tests, builds, read-only git, package scripts.
  for (const cmd of [
    'git status', 'git diff HEAD', 'git log --oneline -5', 'git show', 'git branch -a',
    'npm test', 'npm run lint', 'node --test', 'node src/index.js --version',
    'ls -la', 'cat README.md', 'echo hi', 'mkdir -p a/b', 'cp a b', 'touch f',
    'python3 -V', 'node --test --test-concurrency=4',
  ]) {
    assert.equal(isDangerousBash(cmd), false, `NOT gated: ${cmd}`);
  }
  // Gated: the delete family and the work-discarding git forms. A sudo-wrapped
  // rm gates AND the guard refuses — defense in depth; the human never has to
  // wonder why the sandbox let a sudo through silently.
  for (const cmd of [
    'rm x.txt', 'rm seed.txt', 'rm -v x.txt', 'rmdir empty', 'shred f', 'unlink f', 'del f', 'rd s',
    'git checkout -- src/x.js', 'git restore src/x.js', 'git restore', 'sudo rm x',
  ]) {
    assert.equal(isDangerousBash(cmd), true, `GATED: ${cmd}`);
  }
  // The guard already refuses these outright — they stay OFF the ask list so
  // a human is never asked to approve a command that cannot run.
  for (const cmd of ['rm -rf tmp', 'rm -fr tmp', 'git push origin main', 'git reset --hard', 'dd if=/dev/zero of=x']) {
    assert.equal(isDangerousBash(cmd), false, `guard-refused, never gated: ${cmd}`);
  }
});

test('the rules engine still outranks the tiers: deny refuses a safe shape, allow silences a dangerous one', async () => {
  const root = tmpRoot();
  const { tools, harness } = makeBuddy(root);
  // deny: even a SAFE command is refused by policy, before any human ask.
  const chat1 = createChat({
    router: fakeRouter(['{"tool":"bash","args":{"command":"echo hi"}}']),
    tools, harness, root,
    permissions: { defaultMode: 'ask', allow: [], deny: ['Bash(echo *)'] },
  });
  await chat1.turn('try echo');
  assert.match(obsOf(chat1)[0], /REFUSED by a permissions rule/);
  // allow: a DANGEROUS command the operator explicitly allowlisted runs silent.
  fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
  const chat2 = createChat({
    router: fakeRouter(['{"tool":"bash","args":{"command":"rm ok.txt"}}', '{"tool":"say","message":"done"}']),
    tools, harness, root,
    permissions: { defaultMode: 'ask', allow: ['Bash(rm ok.txt)'], deny: [] },
    approval: async () => { throw new Error('allow rule must skip the gate'); },
  });
  await chat2.turn('delete the allowlisted file');
  assert.equal(fs.existsSync(path.join(root, 'ok.txt')), false, 'allow rule ran it without asking');
  fs.rmSync(root, { recursive: true, force: true });
});
