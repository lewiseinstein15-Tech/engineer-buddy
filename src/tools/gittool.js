// gittool.js — the read-only git tool (v0.20.0): parsed summaries, not shell soup.
//
// The model abused fs_search for "where does X come from" and burned bash
// calls on `git log` parsing. One tool, six READ-ONLY ops (status, diff,
// log, blame, branch, show), output parsed and capped so the model sees the
// diagnosis instead of raw porcelain. Write operations are refused BY DESIGN
// — since v0.27.0 they have their own approval-gated home: the git_write tool.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { truncate } from '../util.js';

const READ_OPS = {
  status: { desc: 'working-tree state (porcelain + branch)', args: [], git: (a) => ['status', '--porcelain=v1', '-b'] },
  diff: { desc: 'uncommitted changes (stat + capped patch)', args: ['path?'], git: (a) => ['diff', '--stat', ...(a?.path ? ['--', String(a.path)] : [])] },
  diff_patch: { desc: 'the actual patch of uncommitted changes (capped)', args: ['path?'], git: (a) => ['diff', '-U3', ...(a?.path ? ['--', String(a.path)] : [])] },
  log: { desc: 'recent commits (oneline, newest first)', args: ['count?'], git: (a) => ['log', '--oneline', `-n${Math.min(Math.max(Number(a?.count) || 20, 1), 100)}`] },
  blame: { desc: 'who last touched each line of a file', args: ['path'], git: (a) => ['blame', String(a?.path || '')] },
  branch: { desc: 'local + remote branches, current starred', args: [], git: () => ['branch', '-a', '-v'] },
  show: { desc: 'one commit: message + stat', args: ['ref?'], git: (a) => ['show', '--stat', '--oneline', String(a?.ref || 'HEAD')] },
};

function runGit(root, argv, timeoutMs = 15000) {
  const r = spawnSync('git', ['-C', root, ...argv], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  if (r.error) return { ok: false, out: '', err: `git not runnable: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, out: r.stdout || '', err: (r.stderr || `exit ${r.status}`).trim() };
  return { ok: true, out: r.stdout || '', err: r.stderr || '' };
}

/** Parse `status --porcelain=v1 -b` into a human table. */
export function formatStatus(raw) {
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return 'working tree clean — nothing to commit';
  const branch = lines.find((l) => l.startsWith('##'));
  const head = branch ? `${branch.slice(2).trim()}\n` : '';
  const body = lines
    .filter((l) => !l.startsWith('##'))
    .map((l) => {
      const code = l.slice(0, 2);
      const file = l.slice(3).trim();
      const tag = code.trim() === '??' ? 'new' : code.includes('D') ? 'deleted' : code.includes('M') || code.includes('T') ? 'modified' : 'changed';
      return `  ${code} ${file} (${tag})`;
    });
  return `${head}${body.join('\n')}`;
}

/** One read-only git op → model-friendly string. Never throws. */
export function gitOp(root, op, args = {}, { maxChars = 6000 } = {}) {
  const spec = READ_OPS[op];
  if (!spec) {
    const list = Object.keys(READ_OPS).join(', ');
    return `ERROR: unknown git op "${op}" — read-only ops: ${list}. Write operations (commit/push/merge/…) belong to the approval-gated git_write tool.`;
  }
  if (spec.args.includes('path') && !args?.path) return 'ERROR: path required for this op';
  const r = runGit(root, spec.git(args));
  if (!r.ok) {
    const msg = r.err || 'no output';
    if (/not a git repository/i.test(msg)) return `ERROR: ${root} is not a git repository`;
    if (/\bblame\b/i.test(msg) && /no such path|does not exist/i.test(msg)) return `ERROR: git blame: ${msg}`;
    return `ERROR: git ${op}: ${truncate(msg, 300)}`;
  }
  if (op === 'status') return formatStatus(r.out);
  const body = r.out.trim();
  if (!body) return `(no output — e.g. an empty diff means the working tree is clean)`;
  const label = `git ${op}${args?.path ? ` ${args.path}` : ''}${args?.ref ? ` ${args.ref}` : ''}:`;
  return `${label}\n${truncate(body, maxChars)}`;
}

/** Registry-ready tool def. */
export function buildGitTool({ root = process.cwd(), maxCalls = 8 } = {}) {
  return {
    name: 'git',
    description:
      'READ-ONLY git in one tool: status, diff (stat), diff_patch, log, blame, branch, show. Parsed and capped — no shell soup. Write ops (commit/merge/…) live in the git_write tool, which previews and asks first.',
    args: '{"op":"diff","path":"src/app.js"}  ·  {"op":"log","count":20}  ·  {"op":"blame","path":"src/app.js"}',
    maxCalls,
    render: (a) => `git ${a?.op || '?'}${a?.path ? ` ${a.path}` : ''}${a?.ref ? ` ${a.ref}` : ''}`,
    run: async ({ op = 'status', ...rest } = {}) => gitOp(root, String(op), rest),
  };
}

export const GIT_READ_OPS = Object.keys(READ_OPS);
export const gitToolsDir = (root) => path.join(root, '.git');
