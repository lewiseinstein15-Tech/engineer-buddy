// shell.js — sandboxed command execution for the verify/build phase.
//
// The agent may RUN a narrow allowlist of commands (tests, linters, audits)
// inside the CI checkout — nothing else. Every run gets: a timeout, a hard
// output cap, a scrubbed environment (no GitHub token leakage into
// subprocesses beyond what Actions already provides), and captured exit code.
import { spawn } from 'node:child_process';
import { BuddyError, truncate } from '../util.js';

/** Commands the buddy is allowed to execute (first token + optional shape). */
const ALLOWLIST = [
  { re: /^npm (test|run [\w@:./-]+|audit( --json)?|ls|ci|install --ignore-scripts|rebuild)$/ },
  { re: /^npx (jest|vitest|mocha|eslint|tsc --noEmit)$/ },
  { re: /^node (--test( .+)?|[\w@:./-]+)$/ },
  { re: /^(yarn|pnpm) (test|audit|run [\w@:./-]+)$/ },
  { re: /^pytest( --maxfail=\d+)?$/ },
  { re: /^python(3)? -m (pytest|unittest)( [\w@:./-]+)?$/ },
  { re: /^git (status|diff|log|branch)( .*)?$/ }, // read-only git here; writes go through git.js
  { re: /^make test$/ },
];

export function isAllowedCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const c = cmd.trim().replace(/\s+/g, ' ');
  if (!c || c.length > 300) return false;
  // hard rejects — even if an allowlist regex ever slips, these never run
  if (/(\||&&|;|`|\$\(|\b_rm\b|\bmkfs\b|\bshutdown\b|>\s*\/|curl|wget|chmod|chown|eval)/.test(c)) return false;
  return ALLOWLIST.some(({ re }) => re.test(c));
}

/**
 * Run an allowlisted command.
 * @returns {{ok, code, stdout, stderr, durationMs, timedOut, command}}
 */
export function runCommand(cmd, { cwd = process.cwd(), timeoutMs = 300000, maxOutputChars = 40000, env = {} } = {}) {
  return new Promise((resolve) => {
    const command = String(cmd || '').trim();
    if (!isAllowedCommand(command)) {
      resolve({ ok: false, code: -1, stdout: '', stderr: `command not allowed: ${truncate(command, 120)}`, durationMs: 0, timedOut: false, command });
      return;
    }
    const t0 = Date.now();
    let timedOut = false;
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME || '/tmp',
          LANG: 'C.UTF-8',
          CI: '1',
          NO_COLOR: '1',
          ...env,
        },
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message, durationMs: 0, timedOut: false, command });
      return;
    }

    let out = '';
    let err = '';
    const cap = (s, chunk) => (s.length < maxOutputChars ? s + chunk : s);
    child.stdout.on('data', (d) => { out = cap(out, d.toString()); });
    child.stderr.on('data', (d) => { err = cap(err, d.toString()); });

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);

    const finish = (code) => {
      clearTimeout(killer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout: truncate(out, maxOutputChars),
        stderr: truncate(err, maxOutputChars),
        durationMs: Date.now() - t0,
        timedOut,
        command,
      });
    };
    child.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, code: -1, stdout: truncate(out, maxOutputChars), stderr: e.message, durationMs: Date.now() - t0, timedOut, command }); });
    child.on('close', finish);
  });
}

/** Extract the failing test names / first error block from common test output. */
export function digestTestFailure(output, maxChars = 3000) {
  if (!output) return '';
  const lines = output.split('\n');
  const hot = [];
  let capture = 0;
  for (const line of lines) {
    const l = line.trimEnd();
    if (/^(FAIL|✕|×|not ok|AssertionError|Error:|Cannot find|SyntaxError|ReferenceError|TypeError)/i.test(l)) {
      capture = 6;
      hot.push(l);
      continue;
    }
    if (capture > 0) {
      hot.push(l);
      capture--;
    }
    if (hot.join('\n').length > maxChars) break;
  }
  return truncate(hot.join('\n') || output.split('\n').slice(-30).join('\n'), maxChars);
}
