// gitlab.js — minimal GitLab REST client (zero dependencies), v0.35.0.
// The GitLab half of the gh tool + /ci + /pr-comments (checklist §6/§9).
// Auth comes from the USER's token: BUDDY_GITLAB_TOKEN (preferred) or
// GITLAB_TOKEN — Buddy never ships its own keys. Self-hosted instances set
// BUDDY_GITLAB_API (e.g. https://gitlab.example.com/api/v4).
import { fetchWithTimeout, BuddyError, sleep } from '../util.js';

export const GITLAB_DEFAULT_API = 'https://gitlab.com/api/v4';

/** "group/sub/ name" → "group%2Fsub%2Fname" (GitLab's project-path id). */
export function gitlabProjectId(repo) {
  return encodeURIComponent(String(repo).replace(/\/+$/, ''));
}

export class GitLabClient {
  constructor({ token, repo, apiBase = GITLAB_DEFAULT_API, httpMs = 30000 }) {
    if (!repo || !repo.includes('/')) throw new BuddyError(`GitLabClient: bad repo "${repo}"`, { code: 'BAD_REPO' });
    this.repo = repo;
    this.project = gitlabProjectId(repo);
    this.token = token || '';
    this.apiBase = apiBase.replace(/\/$/, '');
    this.httpMs = httpMs;
    this.headers = {
      'User-Agent': 'engineer-buddy',
      ...(token ? { 'PRIVATE-TOKEN': token } : {}),
    };
  }

  async _req(path, { method = 'GET', body } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    let lastErr = null;
    // WRITES NEVER AUTO-RETRY (v0.35.0 drill catch, same rule as github.js):
    // a timed-out POST may have landed — resending it can duplicate comments
    // or MRs. Only idempotent GETs retry; writes fail fast and honestly.
    const isRead = method === 'GET' || method === 'HEAD';
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(
          url,
          {
            method,
            headers: { ...this.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          },
          this.httpMs
        );
      } catch (e) {
        lastErr = new BuddyError(`gitlab: network error ${e.message}`, { code: 'NETWORK', cause: e });
        if (!isRead) break; // writes: fail fast — the request may have landed
        await sleep(1000 * attempt);
        continue;
      }
      // Bad embedded credential → one anonymous retry for GETs (public reads).
      if (res.status === 401 && this.token && method === 'GET') {
        res = await fetchWithTimeout(
          url,
          { method, headers: { 'User-Agent': 'engineer-buddy' } },
          this.httpMs
        ).catch(() => res);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      if ((res.status === 403 || res.status === 429) && retryAfter) {
        await sleep(Math.min(retryAfter * 1000, 60000));
        continue;
      }
      if (res.status >= 500 && attempt < 3 && isRead) {
        // reads: retry through transient 5xx. writes fall THROUGH to the
        // honest HTTP-error path below — state unknown, never resend.
        await sleep(1500 * attempt);
        continue;
      }
      const text = await res.text();
      const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      if (!res.ok) {
        const msg = json?.message || json?.error || text.slice(0, 160);
        throw new BuddyError(`gitlab: ${method} ${path.replace(this.project, '…')} → HTTP ${res.status} ${msg}`, {
          code: 'GITLAB_' + res.status,
          data: json,
        });
      }
      return json;
    }
    throw lastErr || new BuddyError('gitlab: retries exhausted', { code: 'RETRIES_EXHAUSTED' });
  }

  getProject() {
    return this._req(`/projects/${this.project}`);
  }

  /** Open MRs, newest-updated first. `sourceBranch` filters server-side. */
  listMrs({ sourceBranch, perPage = 50 } = {}) {
    const n = Math.min(Math.max(Number(perPage) || 50, 1), 100);
    const q = sourceBranch ? `&source_branch=${encodeURIComponent(String(sourceBranch))}` : '';
    return this._req(`/projects/${this.project}/merge_requests?state=opened&order_by=updated_at&per_page=${n}${q}`);
  }

  getMr(iid) {
    return this._req(`/projects/${this.project}/merge_requests/${Number(iid)}`);
  }

  /** MR notes (human comments only — `system` notes are events, filtered here). */
  async listMrNotes(iid) {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const items = await this._req(`/projects/${this.project}/merge_requests/${Number(iid)}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`);
      if (!Array.isArray(items) || items.length === 0) break;
      all.push(...items.filter((n) => !n.system));
      if (items.length < 100) break;
    }
    return all;
  }

  createMr({ source_branch, target_branch, title, description }) {
    return this._req(`/projects/${this.project}/merge_requests`, {
      method: 'POST',
      body: { source_branch, target_branch, title, description, remove_source_branch: false },
    });
  }

  createMrNote(iid, body) {
    return this._req(`/projects/${this.project}/merge_requests/${Number(iid)}/notes`, { method: 'POST', body: { body } });
  }

  approveMr(iid) {
    return this._req(`/projects/${this.project}/merge_requests/${Number(iid)}/approve`, { method: 'POST' });
  }

  /** CI pipelines, newest first. `ref` filters server-side. */
  listPipelines({ ref, perPage = 30 } = {}) {
    const n = Math.min(Math.max(Number(perPage) || 30, 1), 100);
    const q = ref ? `&ref=${encodeURIComponent(String(ref))}` : '';
    return this._req(`/projects/${this.project}/pipelines?order_by=updated_at&per_page=${n}${q}`);
  }
}
