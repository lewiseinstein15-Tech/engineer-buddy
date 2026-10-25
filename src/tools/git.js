// git.js — local git plumbing for the write path (branch → commit → push).
// Uses the git CLI in the CI checkout. The push URL embeds the Actions token
// ONLY for the single push command; it is never written to disk or config.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { BuddyError } from '../util.js';

function exec(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().slice(0, 500);
        reject(new BuddyError(`git ${args.join(' ')} failed: ${msg}`, { code: 'GIT_ERROR' }));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

export function sanitizeBranchName(s) {
  const base = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '-') // '..' sequences become dashes, never stay
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return base || 'change';
}

export class GitWorktree {
  constructor(root, { identityName = 'engineer-buddy[bot]', identityEmail = 'engineer-buddy[bot]@users.noreply.github.com' } = {}) {
    this.root = path.resolve(root);
    this.identityName = identityName;
    this.identityEmail = identityEmail;
  }

  async _git(args, opts = {}) {
    return exec('git', args, { cwd: this.root, ...opts });
  }

  async currentBranch() {
    const out = await this._git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  }

  async defaultBranch() {
    try {
      const out = await this._git(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
      return out.trim().replace(/^origin\//, '');
    } catch {
      return 'main';
    }
  }

  async status() {
    return (await this._git(['status', '--porcelain'])).trim();
  }

  async isClean() {
    return (await this.status()) === '';
  }

  /** Restore the workspace: discard tracked changes + untracked files created by the buddy. */
  async resetHard() {
    await this._git(['checkout', '--', '.']).catch(() => {});
    await this._git(['clean', '-fd']).catch(() => {});
  }

  async createBranch(name, { from } = {}) {
    if (from) await this._git(['checkout', from]);
    await this._git(['checkout', '-b', name]);
    return name;
  }

  async checkoutExisting(name) {
    await this._git(['checkout', name]);
  }

  /** Stage + commit everything changed. Returns commit summary line. */
  async commitAll(message) {
    await this._git(['add', '-A']);
    await this._git(['-c', `user.name=${this.identityName}`, '-c', `user.email=${this.identityEmail}`, 'commit', '-m', message]);
    return (await this._git(['log', '-1', '--format=%h %s'])).trim();
  }

  /** Changed-file stats for the audit trail. */
  async diffStat({ against = 'HEAD~1' } = {}) {
    const out = await this._git(['diff', '--numstat', against]).catch(() => '');
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [add, del, file] = l.split('\t');
        return { file, additions: add === '-' ? 0 : Number(add), deletions: del === '-' ? 0 : Number(del) };
      });
  }

  /**
   * Push the branch to origin using a bearer token for THIS command only.
   * @param {string} branch
   * @param {{token:string, repo:string}} p repo is OWNER/NAME
   */
  async push(branch, { token, repo }) {
    if (!token) throw new BuddyError('git push: no token available', { code: 'NO_TOKEN' });
    const url = `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`;
    // URL never persisted: we pass it on argv of a single git invocation.
    await this._git(['push', url, `HEAD:refs/heads/${branch}`, '--force-with-lease=refs/heads/' + branch], { timeoutMs: 120000 });
    return `https://github.com/${repo}/tree/${branch}`;
  }
}
