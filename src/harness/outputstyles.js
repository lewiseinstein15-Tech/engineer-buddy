// outputstyles.js — /output-style (v0.22.0): swap the system-prompt wrapper.
//
// A style is a markdown file that REPLACES the harness systemprompt for the
// session — Claude Code's /output-style. Layers: project
// .buddy/harness/output-styles/*.md wins over personal ~/.buddy/output-styles/.
// `default` is not a file — it means "no override".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function styleDirs(root, home) {
  return [
    { source: 'project', dir: path.join(root, '.buddy', 'harness', 'output-styles') },
    { source: 'personal', dir: path.join(home, '.buddy', 'output-styles') },
  ];
}

/** Every available style: [{name, source, description}]. Never throws. */
export function listOutputStyles(root, { home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();
  for (const { source, dir } of styleDirs(root, home)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of entries) {
      const name = f.replace(/\.md$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      let description = '';
      try {
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        const fm = /^---\n([\s\S]*?)\n---/.exec(body);
        const dm = fm && /description:\s*(.+)/.exec(fm[1]);
        description = dm ? dm[1].trim() : (body.split('\n').find((l) => l.trim().startsWith('# ')) || '').replace(/^#\s*/, '').trim();
      } catch {
        /* unreadable — name only */
      }
      out.push({ name, source, description });
    }
  }
  return out;
}

/** One style's full body (systemprompt replacement), or null. */
export function loadOutputStyle(root, name, { home = os.homedir() } = {}) {
  const clean = String(name || '').trim();
  if (!clean || clean === 'default') return null;
  for (const { source, dir } of styleDirs(root, home)) {
    const file = path.join(dir, `${path.basename(clean)}.md`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // frontmatter (---...---) is metadata — the body is the prompt
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      if (body) return { name: clean, source, body };
    } catch {
      continue;
    }
  }
  return null;
}
