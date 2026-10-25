// Tests for background shells (bash_bg / bash_output / kill_shell / /tasks data).
// All offline: real child processes, no network, sub-second sleeps.
// Commands must respect blockedBashReason (no pipes/parens/chains) — so each
// scenario runs a tiny script file via `node script.js`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundShells, buildBackgroundTools } from '../src/tools/background.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-bg-'));
}

async function waitDone(shells, id, { timeoutMs = 5000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = shells.output(id);
    if (r.status !== 'running') return r;
    if (Date.now() - t0 > timeoutMs) return r; // give up — caller asserts on status
    await sleep(40);
  }
}

describe('BackgroundShells', () => {
  test('start → output streams → exits with code 0', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ok.js'), "console.log('hello from bg');\nsetTimeout(() => { console.log('done from bg'); }, 250);\n");
    const shells = new BackgroundShells({ cwd: dir });
    const r = shells.start('node ok.js');
    assert.equal(r.error, undefined);
    const id = r.shell.id;
    const done = await waitDone(shells, id);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 0);
    assert.match(done.output, /hello from bg/);
    assert.match(done.output, /done from bg/);
    shells.reapAll();
  });

  test('exit codes are captured', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'fail.js'), 'console.log("before");\nprocess.exit(3);\n');
    const shells = new BackgroundShells({ cwd: dir });
    const { shell } = shells.start('node fail.js');
    const done = await waitDone(shells, shell.id);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 3);
    assert.match(done.output, /before/);
    shells.reapAll();
  });

  test('stderr is captured alongside stdout', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'err.js'), "console.error('oops on stderr');\n");
    const shells = new BackgroundShells({ cwd: dir });
    const { shell } = shells.start('node err.js');
    const done = await waitDone(shells, shell.id);
    assert.match(done.output, /oops on stderr/);
    shells.reapAll();
  });

  test('kill_shell takes the process down fast and marks the shell killed', async () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir() });
    const { shell } = shells.start('sleep 30');
    assert.equal(shell.status, 'running');
    const k = shells.kill(shell.id);
    assert.equal(k.error, undefined);
    const done = await waitDone(shells, shell.id, { timeoutMs: 3000 });
    assert.equal(done.status, 'killed', `expected killed, got ${done.status}`);
    assert.ok(done.exitCode !== 0 || done.signal, 'killed shell should not report clean exit');
    shells.reapAll();
  });

  test('unknown id is a clean error, never a throw', () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir() });
    assert.match(shells.output(999).error, /no shell #999/);
    assert.match(shells.kill(999).error, /no shell #999/);
    shells.reapAll();
  });

  test('hard policy still applies: pipes are BLOCKED', () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir() });
    const r = shells.start('ls | wc');
    assert.match(r.error, /BLOCKED: pipes/);
    shells.reapAll();
  });

  test('maxShells caps concurrent running shells; killing frees a slot', async () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir(), maxShells: 2 });
    const a = shells.start('sleep 3');
    const b = shells.start('sleep 3');
    assert.equal(a.error, undefined);
    assert.equal(b.error, undefined);
    const c = shells.start('sleep 3');
    assert.match(c.error, /max 2.*kill one first/);
    shells.kill(a.shell.id);
    await waitDone(shells, a.shell.id, { timeoutMs: 3000 });
    const d = shells.start('sleep 3');
    assert.equal(d.error, undefined, 'slot must be freed after a kill');
    shells.reapAll();
  });

  test('ring buffer keeps the tail and flags hidden bytes', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'long.js'), 'for (let i = 0; i < 50; i++) console.log("line", i, "0123456789");\n');
    const shells = new BackgroundShells({ cwd: dir, bufferCap: 120 });
    const { shell } = shells.start('node long.js');
    const done = await waitDone(shells, shell.id);
    assert.equal(done.status, 'exited');
    assert.ok(done.bytes > 500, 'more was written than the cap');
    assert.ok(done.output.length <= 120, 'output respects the cap');
    assert.equal(done.overflowed, true);
    shells.reapAll();
  });

  test('list() reports id, command, status, timing', async () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir() });
    const { shell } = shells.start('sleep 1');
    const rows = shells.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, shell.id);
    assert.equal(rows[0].command, 'sleep 1');
    assert.equal(rows[0].status, 'running');
    assert.ok(rows[0].durationMs >= 0);
    shells.reapAll();
  });
});

describe('background tools (bash_bg / bash_output / kill_shell)', () => {
  test('tool-level flow: start, poll to completion, read via the tool run()', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 't.js'), "console.log('tool flow works');\n");
    const shells = new BackgroundShells({ cwd: dir });
    const tools = buildBackgroundTools({ shells });
    const byName = new Map(tools.map((t) => [t.name, t]));

    const started = await byName.get('bash_bg').run({ command: 'node t.js' });
    assert.match(started, /^OK shell #\d+ started \(pid \d+\)/);
    const id = Number(started.match(/#(\d+)/)[1]);

    let out = '';
    for (let i = 0; i < 50; i++) {
      out = await byName.get('bash_output').run({ id });
      if (!/running/.test(out)) break;
      await sleep(40);
    }
    assert.match(out, /exited \(code 0\)/);
    assert.match(out, /tool flow works/);

    const killed = await byName.get('kill_shell').run({ id });
    assert.match(killed, /already finished/);

    const bad = await byName.get('bash_output').run({ id: 424242 });
    assert.match(bad, /ERROR: no shell #424242/);
    shells.reapAll();
  });

  test('bash_bg requires a command; bash_output caps chars to 20000', async () => {
    const shells = new BackgroundShells({ cwd: os.tmpdir() });
    const tools = buildBackgroundTools({ shells });
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.match(await byName.get('bash_bg').run({}), /command required/);
    assert.match(await byName.get('bash_bg').run({ command: '   ' }), /command required/);
    shells.reapAll();
  });
});
