// github.js — minimal GitHub REST client (zero dependencies).
// Auth comes from GITHUB_TOKEN in Actions (no secrets to configure) or
// BUDDY_GITHUB_TOKEN for local runs. A credential embedded in the origin
// remote URL (https://user:TOKEN@github.com/…) also works — v0.35.0 — and a
// BAD embedded token falls back to anonymous reads on public repos.
import { fetchWithTimeout, BuddyError, sleep } from '../util.js';

export class GitHubClient {
  constructor({ token, repo, apiBase = 'https://api.github.com', httpMs = 30000 }) {
    if (!repo || !repo.includes('/')) throw new BuddyError(`GitHubClient: bad repo "${repo}"`, { code: 'BAD_REPO' });
    this.repo = repo;
    this.token = token || '';
    this.apiBase = apiBase.replace(/\/$/, '');
    this.httpMs = httpMs;
    this.headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'engineer-buddy',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  _headers(unauth = false) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'engineer-buddy',
      ...(this.token && !unauth ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async _req(path, { method = 'GET', body, raw = false, accept } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    let lastErr = null;
    // WRITES NEVER AUTO-RETRY (v0.35.0 drill catch): a timed-out POST may
    // still have landed server-side — retrying it can double-post comments
    // or open duplicate PRs. Only idempotent GETs (and the 401-anon fallback)
    // retry; every write failure surfaces honestly so the model/user decides.
    const isRead = method === 'GET' || method === 'HEAD';
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(
          url,
          {
            method,
            headers: { ...this._headers(), ...(accept ? { Accept: accept } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          },
          this.httpMs
        );
      } catch (e) {
        lastErr = new BuddyError(`github: network error ${e.message}`, { code: 'NETWORK', cause: e });
        if (!isRead) break; // writes: fail fast — the request may have landed
        await sleep(1000 * attempt);
        continue;
      }
      // A bad/expired embedded credential (remote URL) must not break reads
      // that would work anonymously on a public repo: one unauthenticated
      // retry for GETs. Writes and private repos still surface the real 401.
      if (res.status === 401 && this.token && method === 'GET') {
        res = await fetchWithTimeout(
          url,
          { method, headers: { ...this._headers(true), ...(accept ? { Accept: accept } : {}) } },
          this.httpMs
        ).catch(() => res);
      }
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = res.headers.get('x-ratelimit-reset');
        if (remaining === '0' && reset) {
          const waitMs = Math.min(Math.max(Number(reset) * 1000 - Date.now(), 2000), 60000);
          await sleep(waitMs);
          continue; // rate-limit waits are safe for writes too (nothing landed)
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter) {
          await sleep(Math.min(retryAfter * 1000, 60000));
          continue;
        }
      }
      if (res.status >= 500 && attempt < 3 && isRead) {
        // reads: retry through transient 5xx. writes fall THROUGH to the
        // honest HTTP-error path below — state unknown, never resend.
        await sleep(1500 * attempt);
        continue;
      }
      if (raw) return res;
      const text = await res.text();
      const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      if (!res.ok) {
        throw new BuddyError(`github: ${method} ${path} → HTTP ${res.status} ${json?.message || text.slice(0, 160)}`, {
          code: 'GITHUB_' + res.status,
          data: json,
        });
      }
      return json;
    }
    throw lastErr || new BuddyError('github: retries exhausted', { code: 'RETRIES_EXHAUSTED' });
  }

  _paginate(path, accept) {
    const out = [];
    return (async () => {
      for (let page = 1; page <= 10; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const items = await this._req(`${path}${sep}per_page=100&page=${page}`, { accept });
        if (!Array.isArray(items) || items.length === 0) break;
        out.push(...items);
        if (items.length < 100) break;
      }
      return out;
    })();
  }

  getUser() {
    return this._req('/user');
  }

  getPull(number) {
    return this._req(`/repos/${this.repo}/pulls/${number}`);
  }

  getFiles(number) {
    return this._paginate(`/repos/${this.repo}/pulls/${number}/files`);
  }

  getDiff(number) {
    return (async () => {
      const res = await this._req(`/repos/${this.repo}/pulls/${number}`, { accept: 'application/vnd.github.v3.diff', raw: true });
      if (!res.ok) throw new BuddyError(`github: diff fetch HTTP ${res.status}`, { code: 'GITHUB_' + res.status });
      return res.text();
    })();
  }

  async createReview(number, { body, event = 'COMMENT', comments = [] }) {
    return this._req(`/repos/${this.repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { body, event, comments },
    });
  }

  async addLabels(number, labels) {
    if (!labels?.length) return null;
    try {
      return await this._req(`/repos/${this.repo}/issues/${number}/labels`, { method: 'POST', body: { labels } });
    } catch (e) {
      console.error(`[buddy] WARN could not add labels: ${e.message}`);
      return null;
    }
  }

  async createComment(number, body) {
    return this._req(`/repos/${this.repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }

  permissionOf(username) {
    return (async () => {
      try {
        const j = await this._req(`/repos/${this.repo}/collaborators/${encodeURIComponent(username)}/permission`);
        return j?.permission || 'none';
      } catch {
        return 'none';
      }
    })();
  }

  // ---------- write-path APIs (issue fixer, triage, auditor) ----------

  getRepository() {
    return this._req(`/repos/${this.repo}`);
  }

  getIssue(number) {
    return this._req(`/repos/${this.repo}/issues/${number}`);
  }

  getIssueComments(number, { max = 20 } = {}) {
    return (async () => {
      const all = await this._paginate(`/repos/${this.repo}/issues/${number}/comments`);
      return all.slice(-max);
    })();
  }

  getRef(branch) {
    return this._req(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  }

  /** Create a branch pointing at `sha`. 422 = already exists → fetch it instead. */
  async createBranch(branch, sha) {
    try {
      return await this._req(`/repos/${this.repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha },
      });
    } catch (e) {
      if (e.code === 'GITHUB_422') return this.getRef(branch); // already exists
      throw e;
    }
  }

  createPull({ head, base, title, body }) {
    return this._req(`/repos/${this.repo}/pulls`, {
      method: 'POST',
      body: { head, base, title, body },
    });
  }

  createIssue({ title, body, labels }) {
    return this._req(`/repos/${this.repo}/issues`, {
      method: 'POST',
      body: { title, body, ...(labels?.length ? { labels } : {}) },
    });
  }

  listMergedPulls({ max = 30, since } = {}) {
    return (async () => {
      const all = await this._paginate(`/repos/${this.repo}/pulls?state=closed&sort=updated&direction=desc`);
      return all
        .filter((p) => p.merged_at)
        .filter((p) => !since || new Date(p.merged_at) >= new Date(since))
        .slice(0, max);
    })();
  }

  listOpenIssues({ max = 100, excludePRs = true } = {}) {
    return (async () => {
      const all = await this._paginate(`/repos/${this.repo}/issues?state=open&sort=updated&direction=desc`);
      return (excludePRs ? all.filter((i) => !i.pull_request) : all).slice(0, max);
    })();
  }

  /** Find an open issue whose title starts with the given prefix (audit tracking). */
  async findOpenIssueByTitlePrefix(prefix) {
    const issues = await this.listOpenIssues({ max: 100 });
    return issues.find((i) => (i.title || '').startsWith(prefix)) || null;
  }

  // ---------- agent-facing reads (v0.35.0 gh tool / /ci / /pr-comments) ----------

  /** Workflow runs, newest first. `branch` uses the API's server-side filter. */
  listActionRuns({ branch, perPage = 30 } = {}) {
    const n = Math.min(Math.max(Number(perPage) || 30, 1), 100);
    const q = branch ? `&branch=${encodeURIComponent(String(branch))}` : '';
    return this._req(`/repos/${this.repo}/actions/runs?per_page=${n}${q}`);
  }

  /** Open PRs, newest-updated first. `head` filters ("owner:branch" or full ref). */
  listOpenPulls({ head } = {}) {
    const q = head ? `&head=${encodeURIComponent(head)}` : '';
    return this._paginate(`/repos/${this.repo}/pulls?state=open&sort=updated&direction=desc${q}`);
  }

  /** Inline review comments of a PR (file/line-positioned). */
  listReviewComments(number) {
    return this._paginate(`/repos/${this.repo}/pulls/${number}/comments?sort=created&direction=asc`);
  }

  /** Review bodies of a PR (the "reviewed with these remarks" wrappers). */
  listReviews(number) {
    return this._paginate(`/repos/${this.repo}/pulls/${number}/reviews`);
  }
}
