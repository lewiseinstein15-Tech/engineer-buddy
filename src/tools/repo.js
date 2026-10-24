// repo.js — local repository access (the checked-out PR head in CI).
// Read-only: the reviewer never mutates the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { BuddyError } from '../util.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__', '.venv']);

export class LocalRepo {
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) {
      throw new BuddyError(`LocalRepo: root does not exist: ${this.root}`, { code: 'NO_ROOT' });
    }
  }

  resolveSafe(rel) {
    const p = path.resolve(this.root, rel);
    if (!p.startsWith(this.root)) throw new BuddyError(`path escapes repo root: ${rel}`, { code: 'PATH_ESCAPE' });
    return p;
  }

  fileExists(rel) {
    try {
      return fs.statSync(this.resolveSafe(rel)).isFile();
    } catch {
      return false;
    }
  }

  /** Read a file, capped; returns { content, truncated, size } or null. */
  readFile(rel, maxChars = 30000) {
    try {
      const p = this.resolveSafe(rel);
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size > 2_000_000) return null;
      const buf = fs.readFileSync(p, 'utf8');
      return {
        content: buf.length > maxChars ? buf.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars]` : buf,
        truncated: buf.length > maxChars,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  listFiles(dir = '', { max = 500, maxDepth = 4 } = {}) {
    const out = [];
    const walk = (rel, depth) => {
      if (out.length >= max || depth > maxDepth) return;
      const abs = this.resolveSafe(dir ? path.join(dir, rel) : rel);
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
        } else if (e.isFile()) {
          out.push(rel ? `${rel}/${e.name}` : e.name);
        }
      }
    };
    walk('', 0);
    return out;
  }

  /** Grep-like search; returns first N matches as { file, line, text }. */
  search(needle, { regex = false, max = 20, caseSensitive = false, globSuffix = null } = {}) {
    const results = [];
    let re = null;
    try {
      re = regex ? new RegExp(needle, caseSensitive ? '' : 'i') : null;
    } catch {
      re = null;
    }
    const needleLc = caseSensitive ? needle : needle.toLowerCase();
    for (const f of this.listFiles('', { max: 3000 })) {
      if (globSuffix && !f.endsWith(globSuffix)) continue;
      if (results.length >= max) break;
      const r = this.readFile(f, 200000);
      if (!r) continue;
      const lines = r.content.split('\n');
      for (let i = 0; i < lines.length && results.length < max; i++) {
        const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needleLc);
        if (hit) results.push({ file: f, line: i + 1, text: lines[i].slice(0, 200) });
      }
    }
    return results;
  }

  headCommit() {
    try {
      const p = path.join(this.root, '.git', 'HEAD');
      const head = fs.readFileSync(p, 'utf8').trim();
      const m = head.match(/^ref: (.+)$/);
      if (m) {
        return fs.readFileSync(path.join(this.root, '.git', m[1]), 'utf8').trim().slice(0, 12);
      }
      return head.slice(0, 12);
    } catch {
      return null;
    }
  }
}
