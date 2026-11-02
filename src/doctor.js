// doctor.js — the workspace half of `buddy doctor` (v0.66.0). The gateway
// probe in index.js answers "can the brain think?"; these checks answer "is
// the WORKSPACE sane?" — the failure class that bit real users: pulls blocked
// by untracked files colliding with incoming commits (watched live on a user
// laptop in the v0.65 era: five untracked test files froze a fast-forward for
// weeks), config JSON a hand-edit corrupted, an upstream nobody set, a stash
// pile nobody remembers. Every check is local, bounded (5s git timeouts, 1.5s
// ollama probe) and every non-ok result NAMES THE FIX. Never throws — a
// doctor that crashes is not a doctor.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;
const OLLAMA_PROBE_MS = 1500;

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = new Error(String((e.stderr || e.message || '')).split('\n')[0].slice(0, 120) || 'git failed');
    err.code = e.code;
    throw err;
  }
}

/**
 * Run every workspace check. Returns [{ name, level, detail }] with level
 * 'ok' | 'info' | 'warn' | 'fail'; ordering is stable so renders diff clean.
 * @param {string} root workspace root (the cwd buddy runs in)
 * @param {{ ollamaEnabled?: boolean, ollamaUrl?: string }} opts
 */
export async function runDoctorChecks(root, { ollamaEnabled = false, ollamaUrl = 'http://127.0.0.1:11434' } = {}) {
  const out = [];
  const push = (name, level, detail) => out.push({ name, level, detail });

  // 1. .buddy/settings.json — hooks, permissions, chat settings live here.
  const settingsPath = path.join(root, '.buddy', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      push('settings.json', 'ok', 'parses clean');
    } catch (e) {
      push('settings.json', 'fail', `unparseable JSON: ${e.message} — fix or delete ${settingsPath}`);
    }
  } else {
    push('settings.json', 'info', 'not present — defaults apply (created on first save)');
  }

  // 2. buddy.config.json — gateway overrides; a hand-edit typo silently
  // degrades to defaults (loadConfig WARNs only in stderr).
  const cfgPath = path.join(root, 'buddy.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      push('buddy.config.json', 'ok', `parses clean (${Object.keys(cfg).join(', ') || 'empty override'})`);
    } catch (e) {
      push('buddy.config.json', 'fail', `unparseable JSON: ${e.message} — the file is silently IGNORED until fixed`);
    }
  } else {
    push('buddy.config.json', 'info', 'not present — built-in keyless chain only');
  }

  // 3. Harness scaffold — memory, lessons, experience live under .buddy/harness.
  if (fs.existsSync(path.join(root, '.buddy', 'harness'))) {
    push('harness', 'ok', '.buddy/harness present');
  } else {
    push('harness', 'info', 'no .buddy/harness yet — created on first session start');
  }

  // 4+. Git state — only when this is a git repo at all.
  if (!fs.existsSync(path.join(root, '.git'))) {
    push('git', 'info', 'not a git repo — git checks skipped');
  } else {
    push('git', 'ok', 'repository present');
    let upstream = null;
    try {
      upstream = git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    } catch {
      push('upstream', 'warn', 'no upstream set — `git pull` cannot work; `git branch -u origin/<branch>`');
    }
    if (upstream) {
      push('upstream', 'ok', `tracking ${upstream}`);
      try {
        const [ahead, behind] = git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/).map(Number);
        if (behind > 0) push('sync', 'warn', `${behind} commit${behind === 1 ? '' : 's'} behind ${upstream} — \`git stash push -u\` (the -u parks untracked files too), then \`git pull\``);
        else if (ahead > 0) push('sync', 'info', `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${upstream} — push when ready`);
        else push('sync', 'ok', 'in sync with upstream');
      } catch (e) {
        push('sync', 'info', `upstream unreachable right now (${String(e.message).split('\n')[0].slice(0, 80)})`);
      }
      // The live-watched failure: untracked local files that a fast-forward
      // would overwrite — merge aborts until they move. Name every one.
      try {
        const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
        const incoming = new Set(git(root, ['ls-tree', '-r', '--name-only', upstream]).split('\n'));
        const collide = untracked.filter((f) => incoming.has(f));
        if (collide.length) {
          push('untracked-collision', 'fail', `${collide.length} untracked file${collide.length === 1 ? '' : 's'} exist on ${upstream} and will BLOCK any pull: ${collide.slice(0, 5).join(', ')}${collide.length > 5 ? ` (+${collide.length - 5} more)` : ''} — they are drafts of already-shipped work: \`git stash push -u\` or move them out, then pull (recover from the stash later)`);
        } else {
          push('untracked-collision', 'ok', `no untracked file collides with ${upstream}`);
        }
      } catch {
        push('untracked-collision', 'info', 'upstream tree not fetched yet — run `git fetch` for this check to be exact');
      }
      // Dirty tracked files that the incoming commits also touch — pull will
      // refuse those too ("local changes would be overwritten").
      try {
        const dirty = git(root, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
        const incomingChanged = new Set(git(root, ['diff', '--name-only', `HEAD...${upstream}`]).split('\n'));
        const overlap = dirty.filter((f) => incomingChanged.has(f));
        if (overlap.length) {
          push('dirty-collision', 'warn', `${overlap.length} modified file${overlap.length === 1 ? '' : 's'} also changed upstream (${overlap.slice(0, 5).join(', ')}) — stash before pulling or the merge refuses`);
        } else {
          push('dirty-collision', 'ok', 'no modified file overlaps upstream changes');
        }
      } catch {
        /* upstream absent or unfetched — already reported */
      }
    }
    try {
      const stashes = git(root, ['stash', 'list']).split('\n').filter(Boolean);
      if (stashes.length) {
        push('stash', 'info', `${stashes.length} stash${stashes.length === 1 ? '' : 'es'} parked — \`git stash list\` to review, \`git stash show -p stash@{0}\` to read, nothing is lost`);
      } else {
        push('stash', 'ok', 'stash empty');
      }
    } catch {
      /* git broken already reported */
    }
  }

  // 5. Ollama — only worth probing when the config actually uses it.
  if (ollamaEnabled) {
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), OLLAMA_PROBE_MS);
      const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: ctl.signal });
      clearTimeout(timer);
      const tags = await res.json().catch(() => null);
      const models = Array.isArray(tags?.models) ? tags.models.length : 0;
      push('ollama', res.ok && models > 0 ? 'ok' : 'warn', res.ok ? `daemon up, ${models} model${models === 1 ? '' : 's'} (${Date.now() - t0}ms)` : `HTTP ${res.status} — daemon answering but tag list unreadable`);
    } catch {
      push('ollama', 'warn', `no daemon at ${ollamaUrl} (${Date.now() - t0}ms) — every call fails over to the cloud chain; start ollama or disable the gateway`);
    }
  }

  return out;
}

/** Render the checks as doctor's workspace section. */
export function renderDoctorChecks(checks) {
  const icon = { ok: '[ ok]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
  const lines = checks.map((c) => `  ${icon[c.level] || '[ ? ]'} ${c.name.padEnd(20)} ${c.detail}`);
  const n = (lvl) => checks.filter((c) => c.level === lvl).length;
  lines.push('');
  lines.push(`  workspace: ${n('ok')} ok · ${n('info')} info · ${n('warn')} warn · ${n('fail')} fail — every warn/fail above names its fix.`);
  return lines.join('\n');
}
