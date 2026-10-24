// github.js — minimal GitHub REST client (zero dependencies).
// Auth comes from GITHUB_TOKEN in Actions (no secrets to configure) or
// BUDDY_GITHUB_TOKEN for local runs.
import { fetchWithTimeout, BuddyError, sleep } from '../util.js';

export class GitHubClient {
  constructor({ token, repo, apiBase = 'https://api.github.com', httpMs = 30000 }) {
    if (!repo || !repo.includes('/')) throw new BuddyError(`GitHubClient: bad repo "${repo}"`, { code: 'BAD_REPO' });
    this.repo = repo;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.httpMs = httpMs;
    this.headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'engineer-buddy',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async _req(path, { method = 'GET', body, raw = false, accept } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(
          url,
          {
            method,
            headers: { ...this.headers, ...(accept ? { Accept: accept } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          },
          this.httpMs
        );
      } catch (e) {
        lastErr = new BuddyError(`github: network error ${e.message}`, { code: 'NETWORK', cause: e });
        await sleep(1000 * attempt);
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = res.headers.get('x-ratelimit-reset');
        if (remaining === '0' && reset) {
          const waitMs = Math.min(Math.max(Number(reset) * 1000 - Date.now(), 2000), 60000);
          await sleep(waitMs);
          continue;
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter) {
          await sleep(Math.min(retryAfter * 1000, 60000));
          continue;
        }
      }
      if (res.status >= 500 && attempt < 3) {
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
}
