// roots.js — multi-root workspace support (v0.26.0): /add-dir for monorepos.
//
// Claude Code calls them "additional working directories"; Buddy calls them
// extra ROOTS. Each added directory gets an ALIAS (derived from its basename
// unless given) and every fs tool then addresses files inside it as
//   "<alias>/relative/path"   e.g.  fs_read('api/src/server.js')
//
// Where the config lives: `permissions.additionalDirectories` in
// .buddy/settings.json — the key the rules engine already parsed since
// v0.19.0 (back then it was parsed but not enforced; the /permissions UI
// even promised "enforcement lands with a multi-root LocalScope"). This is
// that landing.
//
// Persistence rules:
//   - STARTUP merges user (~/.buddy/settings.json) + project lists.
//   - /add-dir <path> writes the PROJECT list only (workspaces are
//     project-scoped by nature). The deep-merge in settings.js replaces the
//     array wholesale while preserving every other permissions key.
//   - Removal edits the project list; an entry that also exists at user
//     level keeps coming back — the UI says which list each root came from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateProjectSetting } from '../settings.js';

export const MAX_EXTRA_ROOTS = 8;

/** Derive an alias from a directory path: basename, sanitized to [a-z0-9_-]. Pure. */
export function aliasFor(dir) {
  const base = path.basename(String(dir || '').replace(/[\\/]+$/, '')) || 'dir';
  const a = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return a || 'dir';
}

/** First free alias among taken: name, name-2, name-3… Pure. */
export function dedupeAlias(base, taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  if (!set.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** Pick an alias for a LIVE add: skip aliases already mounted AND names that
 *  exist in the main workspace (addRoot would refuse them — better to never
 *  propose one). */
export function pickAlias(base, existingAliases, mainRoot) {
  const taken = existingAliases instanceof Set ? new Set(existingAliases) : new Set(existingAliases || []);
  for (let i = 0; i < 100; i++) {
    const cand = i === 0 ? base : `${base}-${i + 1}`;
    if (taken.has(cand)) continue;
    try {
      if (fs.existsSync(path.join(mainRoot, cand))) continue;
    } catch {
      /* unreadable main root — let addRoot decide */
    }
    return cand;
  }
  return `${base}-${Date.now()}`;
}

function readDirsFrom(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a = j?.permissions?.additionalDirectories;
    return Array.isArray(a) ? a.map((d) => String(d)).filter((d) => d.trim()) : [];
  } catch {
    return [];
  }
}

/** The raw additionalDirectories lists: user + project + merged order. */
export function listConfiguredDirs(root, { home = os.homedir() } = {}) {
  const user = readDirsFrom(path.join(home, '.buddy', 'settings.json'));
  const project = readDirsFrom(path.join(root, '.buddy', 'settings.json'));
  return { user, project, merged: [...user, ...project] };
}

/** Overwrite the PROJECT additionalDirectories list (other keys preserved). */
export function saveProjectDirs(root, dirs) {
  const list = (Array.isArray(dirs) ? dirs : []).map(String).filter((d) => d.trim()).slice(0, MAX_EXTRA_ROOTS);
  updateProjectSetting(root, { permissions: { additionalDirectories: list } });
  return list;
}

/** Append one abs dir to the project list (idempotent). */
export function addProjectDir(root, absPath) {
  const { project } = listConfiguredDirs(root);
  const abs = path.resolve(String(absPath));
  if (project.some((d) => path.resolve(d) === abs)) return project;
  return saveProjectDirs(root, [...project, abs]);
}

/** Remove one abs dir from the project list. Returns { list, removed }. */
export function removeProjectDir(root, absPath) {
  const { project } = listConfiguredDirs(root);
  const abs = path.resolve(String(absPath));
  const list = project.filter((d) => path.resolve(d) !== abs);
  saveProjectDirs(root, list);
  return { list, removed: project.length !== list.length };
}

/**
 * Settings → ready extra-root entries for LocalScope: existing directories
 * only (missing ones are skipped silently — a deleted checkout must never
 * block startup), aliases derived + deduped, capped at MAX_EXTRA_ROOTS.
 */
export function buildExtraRoots(root, dirs = null, { home = os.homedir() } = {}) {
  const merged = Array.isArray(dirs) ? dirs : listConfiguredDirs(root, { home }).merged;
  const out = [];
  const taken = new Set();
  for (const d of merged.slice(0, MAX_EXTRA_ROOTS * 2)) {
    if (out.length >= MAX_EXTRA_ROOTS) break;
    const abs = path.isAbsolute(d) ? d : path.resolve(root, d);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const alias = dedupeAlias(aliasFor(abs), taken);
    taken.add(alias);
    out.push({ alias, path: abs });
  }
  return out;
}
