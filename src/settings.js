// settings.js — the shared .buddy/settings.json surface (v0.22.0).
//
// One file, many consumers: hooks (v0.11.0), permissions (v0.19.0), and now
// the UX/narration config (verbosity, theme, output style, statusline).
// updateProjectSetting merges — a UI tweak can never wipe a hooks block.
// User-level settings (~/.buddy/settings.json) still win the same way the
// rules engine merges: project writes go to the PROJECT file only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function settingsPath(root) {
  return path.join(root, '.buddy', 'settings.json');
}

/** Read .buddy/settings.json; junk degrades to {} with a warn. Never throws. */
export function readProjectSettings(root) {
  try {
    const raw = fs.readFileSync(settingsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Deep-merge a patch into the PROJECT settings file (preserves hooks/permissions). */
export function updateProjectSetting(root, patch) {
  const file = settingsPath(root);
  const current = readProjectSettings(root);
  const next = deepMerge(current, isPlainObject(patch) ? patch : {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** Merged VIEW: user ~/.buddy/settings.json under project (project wins). */
export function loadSettingsView(root, { home = os.homedir() } = {}) {
  let user = {};
  try {
    const raw = fs.readFileSync(path.join(home, '.buddy', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) user = parsed;
  } catch {
    /* absent — normal */
  }
  return deepMerge(user, readProjectSettings(root));
}

/** Set one dot-path value in the project file: setChatSetting(root, 'verbosity', 'silent'). */
export function setChatSetting(root, key, value) {
  return updateProjectSetting(root, { chat: { [key]: value } });
}

/** Read one chat.* value from the merged view. */
export function getChatSetting(root, key, fallback = null, opts = {}) {
  const view = loadSettingsView(root, opts);
  const v = view?.chat?.[key];
  return v === undefined ? fallback : v;
}
