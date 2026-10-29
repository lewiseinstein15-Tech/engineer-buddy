// background.js — long-running shell sessions (Claude Code's BashOutput /
// KillShell, Buddy edition).
//
// Why: `bash` blocks the turn until the command exits — useless for dev
// servers, watchers, and builds you want to poll. Background shells run
// detached from the turn, capture output into a tail ring buffer, and are
// inspected on demand:
//   bash_bg     {command}        start a shell (same hard policy as `bash`)
//   bash_output {id, chars?}     read the output tail + status
//   kill_shell  {id}             kill the whole process group
//   /tasks                       slash-command view of every shell
//
// Safety model mirrors runBash: the same blocklist policy (no pipes/chains/
// sudo/network/git-write), sanitized env, own process group so kills take
// out the whole tree, and everything is reaped when Buddy exits.
import { spawn } from 'node:child_process';
import { blockedBashReason } from './local.js';
import { baseSpawnEnv } from '../util.js';

// All live registries share ONE process-exit listener (reaping must be sync —
// 'exit' handlers cannot await). Registered lazily, never per-instance, so
// tests can create many registries without tripping listener warnings.
const LIVE = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const reg of LIVE) reg.reapAll();
  });
}

let nextShellId = 1;

export class BackgroundShells {
  /**
   * @param {object} [p]
   * @param {string} [p.cwd]           working directory for spawned shells
   * @param {number} [p.maxShells]     max shells alive at once (default 8)
   * @param {number} [p.bufferCap]     per-shell output ring cap in chars (default 200k, tail kept)
   */
  constructor({ cwd = process.cwd(), maxShells = 8, bufferCap = 200000 } = {}) {
    this.cwd = cwd;
    this.maxShells = maxShells;
    this.bufferCap = bufferCap;
    this.shells = new Map(); // id -> shell record
    installExitHook();
    LIVE.add(this);
  }

  /** Sync reap for the process-exit hook — SIGKILL everything, no cleanup promises. */
  reapAll() {
    for (const sh of this.shells.values()) {
      if (sh.status === 'running') this._killTree(sh);
    }
    LIVE.delete(this);
  }

  _killTree(sh) {
    try {
      if (process.platform !== 'win32' && sh.child.pid) process.kill(-sh.child.pid, 'SIGKILL');
      else sh.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /** Spawn a policy-checked background shell. Returns an error string or the shell record. */
  start(command) {
    const blocked = blockedBashReason(command);
    if (blocked) return { error: `BLOCKED: ${blocked}` };
    const running = [...this.shells.values()].filter((s) => s.status === 'running').length;
    if (running >= this.maxShells) {
      return { error: `${running} background shells already running (max ${this.maxShells}) — kill one first (kill_shell)` };
    }
    const id = nextShellId++;
    let child;
    try {
      child = spawn(String(command).trim().replace(/\s+/g, ' '), {
        cwd: this.cwd,
        shell: true,
        detached: process.platform !== 'win32', // own process group → killable as a tree
        env: baseSpawnEnv(),
      });
    } catch (e) {
      return { error: e.message };
    }
    const sh = {
      id,
      command: String(command).trim().replace(/\s+/g, ' '),
      child,
      pid: child.pid,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running', // running | exited | killed
      exitCode: null,
      signal: null,
      killRequested: false,
      buffer: '',
      bytes: 0,
      overflowed: false,
    };
    const append = (chunk) => {
      sh.bytes += chunk.length;
      sh.buffer += chunk;
      if (sh.buffer.length > this.bufferCap) {
        sh.buffer = sh.buffer.slice(-this.bufferCap);
        sh.overflowed = true;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      append(`\nspawn error: ${e.message}\n`);
    });
    child.on('close', (code, signal) => {
      sh.status = sh.killRequested ? 'killed' : 'exited';
      sh.exitCode = code;
      sh.signal = signal;
      sh.endedAt = Date.now();
    });
    this.shells.set(id, sh);
    return { shell: sh };
  }

  _get(id) {
    const sh = this.shells.get(Number(id));
    if (!sh) return null;
    return sh;
  }

  /** Read the output tail + status of one shell. Never throws. */
  output(id, { chars = 4000 } = {}) {
    const sh = this._get(id);
    if (!sh) return { error: `no shell #${id} — see /tasks for live ids` };
    const want = Math.max(200, Math.min(Number(chars) || 4000, 20000));
    const buf = sh.buffer;
    const tail = buf.length > want ? buf.slice(-want) : buf;
    const hidden = buf.length - tail.length;
    return {
      id: sh.id,
      status: sh.status,
      exitCode: sh.exitCode,
      bytes: sh.bytes,
      hidden,
      overflowed: sh.overflowed,
      output: tail,
    };
  }

  /** Kill one shell (whole process group). Returns {ok,status} or {error}. */
  kill(id) {
    const sh = this._get(id);
    if (!sh) return { error: `no shell #${id} — see /tasks for live ids` };
    if (sh.status !== 'running') return { ok: true, status: sh.status, note: `shell #${id} already finished (${sh.status})` };
    sh.killRequested = true;
    this._killTree(sh);
    return { ok: true, status: 'killing' };
  }

  /** Rows for /tasks and for model-facing summaries. */
  list() {
    return [...this.shells.values()]
      .sort((a, b) => a.id - b.id)
      .map((sh) => ({
        id: sh.id,
        command: sh.command,
        status: sh.status,
        exitCode: sh.exitCode,
        bytes: sh.bytes,
        startedAt: sh.startedAt,
        durationMs: (sh.endedAt ?? Date.now()) - sh.startedAt,
      }));
  }
}

/** Build the three model-facing tools bound to one registry instance. */
export function buildBackgroundTools({ shells }) {
  return [
    {
      name: 'bash_bg',
      description:
        'Start a LONG-RUNNING command in the background (dev servers, watchers, builds). Same one-simple-command policy as bash. Returns a shell id — poll its output with bash_output, stop it with kill_shell.',
      args: '{"command":"npm run dev"}',
      risky: true,
      render: (a) => `bash_bg ${a?.command}`,
      run: async ({ command }) => {
        if (typeof command !== 'string' || !command.trim()) return 'ERROR: command required';
        const r = shells.start(command);
        if (r.error) return `ERROR: ${r.error}`;
        return `OK shell #${r.shell.id} started (pid ${r.shell.pid}) — read output with bash_output {"id":${r.shell.id}}, stop with kill_shell {"id":${r.shell.id}}`;
      },
    },
    {
      name: 'bash_output',
      description:
        'Read the output tail of a background shell started with bash_bg. Safe to poll repeatedly while it runs.',
      args: '{"id":1,"chars":4000}',
      render: (a) => `bash_output #${a?.id}`,
      run: async ({ id, chars }) => {
        const r = shells.output(id, { chars });
        if (r.error) return `ERROR: ${r.error}`;
        const sh = shells.shells.get(Number(id));
        const dur = (((sh?.endedAt ?? Date.now()) - (sh?.startedAt ?? Date.now())) / 1000).toFixed(1);
        const status =
          r.status === 'running'
            ? `running (${dur}s)`
            : `${r.status}${r.exitCode != null ? ` (code ${r.exitCode})` : ''} in ${dur}s`;
        const hiddenNote = r.hidden > 0 ? ` (+${r.hidden} older chars hidden — raise chars to see more)` : '';
        return `shell #${r.id} — ${status}${hiddenNote}\n${r.output || '(no output yet)'}`;
      },
    },
    {
      name: 'kill_shell',
      description: 'Kill a background shell (and its whole process tree) started with bash_bg.',
      args: '{"id":1}',
      render: (a) => `kill_shell #${a?.id}`,
      run: async ({ id }) => {
        const r = shells.kill(id);
        if (r.error) return `ERROR: ${r.error}`;
        return r.note ? `OK ${r.note}` : `OK killing shell #${id}`;
      },
    },
  ];
}
