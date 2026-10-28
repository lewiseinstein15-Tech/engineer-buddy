// plugins.js — the plugin system (v0.39.0, checklist §3).
//
// Buddy already loads user extensions from half a dozen .buddy/ folders
// (skills, agents, commands, tools, reporters, mcp.json, hooks). A PLUGIN is
// the unifying bundle: ONE folder that carries any mix of those surfaces, so
// a whole workflow can be installed with one command and removed just as
// cleanly.
//
// Layout (everything except the manifest is optional):
//
//   my-plugin/
//     buddy.plugin.json      ← REQUIRED: {name, version, description, hooks?}
//     skills/<name>/SKILL.md ← the skills loader gets this dir as a layer
//     agents/<name>.md       ← sub-agent personas for the task tool
//     commands/<name>.md     ← slash commands
//     tools/<name>/…         ← manifest.json + index.js user tools (sandboxed)
//     reporters/<name>.json  ← named API request presets
//     mcp.json               ← {mcpServers:{…}} fragment
//     hooks live in the manifest: "hooks": {"PostToolUse":[{"matcher":"bash",
//                               "command":"…"}]} (same shape as settings)
//
// Discovered from two layers (same discipline as everything else in Buddy):
//   .buddy/plugins/<name>/    project — this repo only
//   ~/.buddy/plugins/<name>/  personal — you, everywhere
// Collision rule everywhere: project > personal > plugin > bundled. A plugin
// can never shadow what the user already has, and never shadows a built-in.
//
// Install: /plugin add <owner>/<repo>   → git clone --depth 1 (github shorthand)
//               | <local path>          → cloned if it is a git repo, copied otherwise
//               | <bundled pack name>   → copied from this package's own packs/
// State:    settings.json → { "plugins": { "disabled": ["name"] } }
//           (disabled plugins stay on disk but contribute nothing)
//
// Zero dependencies: plain files + git clone. No npm, no registry, no keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { truncate } from './util.js';
import { loadSettingsView, updateProjectSetting } from './settings.js';

export const PLUGIN_MANIFEST = 'buddy.plugin.json';
export const PLUGINS_DIR = '.buddy/plugins';
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MARKETPLACE_FILE = 'marketplace.json';

// Package root = parent of src/ — bundled packs + the marketplace seed live here.
const PKG_ROOT = path.dirname(createRequire(import.meta.url).resolve('../package.json'));
export const BUNDLED_PACKS_DIR = path.join(PKG_ROOT, 'packs');
export const MARKETPLACE_SEED = path.join(PKG_ROOT, MARKETPLACE_FILE);

const BUNDLE_KINDS = ['skills', 'agents', 'commands', 'tools', 'reporters'];

function dirCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/** Sanitize an install target into a plugin folder name. Pure. */
export function sanitizePluginName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Validate one buddy.plugin.json object → { ok, manifest?, error? }. Pure.
 * hooks (optional) uses the settings.json shape: event → command | {matcher,
 * command} | [those]; deep validation happens in hooks.js, shared with the
 * settings path — here we only check it is an object of objects/strings.
 */
export function validateManifest(raw, { fallbackName = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not a JSON object' };
  const name = String(raw.name || '').trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: `name must match ${PLUGIN_NAME_RE} (got ${JSON.stringify(raw.name || '')})` };
  }
  const version = String(raw.version ?? '').trim();
  if (!version || version.length > 24) return { ok: false, error: 'version is required (a string, 1-24 chars)' };
  const description = String(raw.description || '').trim();
  if (!description) return { ok: false, error: 'description is required — say what the plugin does' };
  const hooks = raw.hooks;
  if (hooks !== undefined) {
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
      return { ok: false, error: 'hooks must be an object of event → command | [{matcher, command}]' };
    }
    for (const [event, entries] of Object.entries(hooks)) {
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        const command = typeof entry === 'string' ? entry : entry?.command;
        if (!command || typeof command !== 'string') {
          return { ok: false, error: `hooks.${event}: every entry needs a "command" string` };
        }
      }
    }
  }
  return {
    ok: true,
    manifest: {
      name,
      version,
      description: description.slice(0, 200),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(fallbackName && name !== fallbackName ? { __dirMismatch: fallbackName } : {}),
    },
  };
}

/** Parse a manifest file from a plugin dir. Returns {ok, manifest?, error?}. */
export function readManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8');
  } catch {
    return { ok: false, error: `missing ${PLUGIN_MANIFEST}` };
  }
  try {
    return validateManifest(JSON.parse(raw), { fallbackName: path.basename(dir) });
  } catch (e) {
    return { ok: false, error: `${PLUGIN_MANIFEST} is not valid JSON: ${truncate(String(e.message), 90)}` };
  }
}

/** Count what a plugin folder bundles → {skills, agents, commands, tools, reporters, mcp, hooks}. */
export function scanBundles(dir, manifest = null) {
  const bundles = {};
  for (const kind of BUNDLE_KINDS) bundles[kind] = dirCount(path.join(dir, kind));
  bundles.mcp = fs.existsSync(path.join(dir, 'mcp.json')) ? 1 : 0;
  bundles.hooks = manifest?.hooks ? Object.keys(manifest.hooks).length : 0;
  return bundles;
}

/** "1 skill · 1 tool · 1 hook" — the one-line bundle summary. Pure. */
export function summarizeBundles(b) {
  const parts = [];
  const label = { skills: 'skill', agents: 'agent', commands: 'command', tools: 'tool', reporters: 'reporter', mcp: 'mcp server', hooks: 'hook' };
  for (const kind of [...BUNDLE_KINDS, 'mcp', 'hooks']) {
    const n = b?.[kind] || 0;
    if (n > 0) parts.push(`${n} ${label[kind]}${n === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join(' · ') : 'empty bundle (manifest only)';
}

/**
 * Discover installed plugins. Never throws — junk dirs degrade to warnings.
 * Order: project > personal on a name collision (personal copy skipped).
 * @returns {{ plugins: Array, warnings: string[] }}
 */
export function discoverPlugins({ root = process.cwd(), home = os.homedir() } = {}) {
  const warnings = [];
  const view = loadSettingsView(root, { home });
  const disabled = new Set(
    Array.isArray(view?.plugins?.disabled) ? view.plugins.disabled.map(String) : []
  );
  // Project first: the first-wins scan then guarantees the project copy
  // beats the personal one on a name collision (same rule as everywhere).
  const layers = [
    { source: 'project', base: path.join(root, PLUGINS_DIR) },
    { source: 'personal', base: path.join(home, PLUGINS_DIR) },
  ];
  const byName = new Map();
  for (const layer of layers) {
    let entries = [];
    try {
      entries = fs.readdirSync(layer.base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    } catch {
      continue; // layer not installed — normal
    }
    for (const ent of entries) {
      const dir = path.join(layer.base, ent.name);
      const parsed = readManifest(dir);
      if (!parsed.ok) {
        warnings.push(`${layer.source} plugin "${ent.name}": ${parsed.error} — skipped`);
        continue;
      }
      const manifest = parsed.manifest;
      if (manifest.__dirMismatch) {
        warnings.push(`${layer.source} plugin "${ent.name}": manifest name "${manifest.name}" ≠ folder name — using the folder name`);
        manifest.name = ent.name;
        delete manifest.__dirMismatch;
      }
      if (byName.has(ent.name)) {
        // layers run personal first, project second — a repeat here means the
        // project copy wins and the personal one is skipped
        warnings.push(`plugin "${ent.name}": personal copy skipped — the project one wins`);
        continue;
      }
      byName.set(ent.name, {
        name: ent.name,
        version: manifest.version,
        description: manifest.description,
        manifest,
        source: layer.source,
        dir,
        enabled: !disabled.has(ent.name),
        bundles: scanBundles(dir, manifest),
        warnings: [],
      });
    }
  }
  const plugins = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { plugins, warnings };
}

/** discoverPlugins filtered to ENABLED plugins only (what the loaders consume). */
export function enabledPlugins(opts = {}) {
  const { plugins, warnings } = discoverPlugins(opts);
  return { plugins: plugins.filter((p) => p.enabled), warnings };
}

/**
 * The dirs a kind of bundle contributes, from enabled plugins.
 * kind ∈ skills | agents | commands | tools | reporters.
 * @returns [{plugin, dir}] — only dirs that exist on disk.
 */
export function pluginKindDirs(plugins, kind) {
  const out = [];
  for (const p of plugins) {
    const dir = path.join(p.dir, kind);
    try {
      if (fs.statSync(dir).isDirectory()) out.push({ plugin: p.name, dir });
    } catch {
      /* kind not bundled — normal */
    }
  }
  return out;
}

/** The raw hooks objects from enabled plugin manifests (hooks.js consumes). */
export function pluginHookEntries(plugins) {
  return plugins.filter((p) => p.manifest?.hooks && Object.keys(p.manifest.hooks).length).map((p) => ({ plugin: p.name, dir: p.dir, hooks: p.manifest.hooks }));
}

/**
 * Where does an install source come from? Pure (fs checks injectable).
 *   "owner/repo"            → {kind:'repo', url, name}
 *   "https://host/…/repo"   → {kind:'repo', url, name}
 *   "<existing path>"       → {kind:'path', path, name, isGit}
 *   "<bundled pack name>"   → {kind:'bundled', pack, name, from}
 */
export function parsePluginSource(src, { exists = (p) => fs.existsSync(p), packsDir = BUNDLED_PACKS_DIR } = {}) {
  const s = String(src || '').trim();
  if (!s) return { kind: 'error', error: 'nothing to install — /plugin add <owner>/<repo> · <path> · <bundled pack>' };
  const gh = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (gh) return { kind: 'repo', url: `https://github.com/${gh[1]}/${gh[2]}`, name: sanitizePluginName(gh[2]) };
  if (/^https?:\/\//i.test(s)) {
    let name = 'plugin';
    try {
      const u = new URL(s);
      name = sanitizePluginName(path.basename(u.pathname).replace(/\.git$/, '') || 'plugin');
    } catch {
      return { kind: 'error', error: `not a valid URL: ${truncate(s, 80)}` };
    }
    return { kind: 'repo', url: s, name };
  }
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) {
    const p = s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : path.resolve(s);
    if (!exists(p)) return { kind: 'error', error: `path not found: ${truncate(p, 120)}` };
    return { kind: 'path', path: p, name: sanitizePluginName(path.basename(p)), isGit: exists(path.join(p, '.git')) };
  }
  const pack = path.join(packsDir, sanitizePluginName(s));
  if (exists(pack)) return { kind: 'bundled', pack, name: sanitizePluginName(s) };
  return {
    kind: 'error',
    error: `cannot resolve "${truncate(s, 60)}" — use <owner>/<repo> · <local path> · a bundled pack name (/plugin browse)`,
  };
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 120000, ...opts });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || r.error?.message || '').trim() };
}

/** Recursively copy a folder (node has no built-in cp -r; fs.cpSync does it). */
function copyTree(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: false });
}

/**
 * Install a plugin into <root>/.buddy/plugins/<name>. Stages into a hidden
 * dir first: a broken install never leaves a half-plugin behind. Never throws.
 * @returns {{ ok: true, plugin } | { ok: false, error }}
 */
export function installPlugin({ root = process.cwd(), from, home = os.homedir(), exists = (p) => fs.existsSync(p) } = {}) {
  const src = parsePluginSource(from, { exists });
  if (src.kind === 'error') return { ok: false, error: src.error };
  const target = path.join(root, PLUGINS_DIR, src.name);
  if (exists(target)) {
    return { ok: false, error: `"${src.name}" is already installed — /plugin remove ${src.name} first` };
  }
  const staging = path.join(root, PLUGINS_DIR, `.staging-${src.name}`);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* absent */ }

  try {
    if (src.kind === 'repo') {
      fs.mkdirSync(path.dirname(staging), { recursive: true });
      const r = sh('git', ['clone', '--depth', '1', src.url, staging]);
      if (r.code !== 0) return { ok: false, error: `git clone failed: ${truncate(r.stderr || r.stdout || 'unknown error', 300)}` };
    } else if (src.kind === 'path' && src.isGit) {
      const r = sh('git', ['clone', '--depth', '1', src.path, staging]);
      if (r.code !== 0) return { ok: false, error: `git clone failed: ${truncate(r.stderr || r.stdout || 'unknown error', 300)}` };
    } else {
      copyTree(src.kind === 'bundled' ? src.pack : src.path, staging);
    }
    const parsed = readManifest(staging);
    if (!parsed.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, error: `installed folder is not a valid plugin: ${parsed.error}` };
    }
    fs.renameSync(staging, target);
    const manifest = { ...parsed.manifest, name: src.name };
    return {
      ok: true,
      plugin: {
        name: src.name,
        version: manifest.version,
        description: manifest.description,
        manifest,
        source: 'project',
        dir: target,
        enabled: true,
        bundles: scanBundles(target, manifest),
        warnings: [],
      },
    };
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: `install failed: ${truncate(String(e?.message || e), 200)}` };
  }
}

/** Remove an installed plugin folder. Refuses anything outside the plugins dir. */
export function removePlugin({ root = process.cwd(), name } = {}) {
  const clean = sanitizePluginName(name);
  if (!clean || clean !== String(name || '').toLowerCase()) return { ok: false, error: `unknown plugin "${truncate(String(name || ''), 40)}"` };
  const dir = path.join(root, PLUGINS_DIR, clean);
  if (!fs.existsSync(dir)) return { ok: false, error: `"${clean}" is not installed (project) — /plugin lists what is` };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: clean };
}

/** Enable/disable by name → the plugins.disabled list in the PROJECT settings. */
export function setPluginEnabled(root, name, enabled) {
  const clean = sanitizePluginName(name);
  const view = loadSettingsView(root);
  const disabled = new Set(Array.isArray(view?.plugins?.disabled) ? view.plugins.disabled.map(String) : []);
  if (enabled) disabled.delete(clean);
  else disabled.add(clean);
  updateProjectSetting(root, { plugins: { disabled: [...disabled].sort() } });
  return [...disabled].sort();
}

/**
 * The marketplace list. Bundled seed (<pkg>/marketplace.json) is always
 * available offline; when settings carries plugins.marketplaceUrl, ONE fetch
 * refreshes it (5s cap) and any failure falls back to the seed honestly.
 * @returns {{ entries: Array, source: 'bundled'|'remote'|'bundled (remote failed)', warnings: string[] }}
 */
export async function marketplaceEntries({ root = process.cwd(), home = os.homedir(), fetchFn = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const warnings = [];
  const readSeed = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(MARKETPLACE_SEED, 'utf8'));
      const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      return list.filter((e) => e && typeof e === 'object' && e.name).map((e) => ({
        name: String(e.name),
        description: String(e.description || '').slice(0, 140),
        bundled: e.bundled === true,
        repo: e.repo ? String(e.repo) : null,
      }));
    } catch (e) {
      warnings.push(`marketplace seed unreadable: ${truncate(String(e.message), 90)}`);
      return [];
    }
  };
  let seed = readSeed();
  const view = loadSettingsView(root, { home });
  const url = view?.plugins?.marketplaceUrl;
  if (!url || typeof fetchFn !== 'function') {
    return { entries: seed, source: 'bundled', warnings };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchFn(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = JSON.parse(await res.text());
    const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    const remote = list
      .filter((e) => e && typeof e === 'object' && PLUGIN_NAME_RE.test(String(e.name || '')))
      .map((e) => ({ name: String(e.name), description: String(e.description || '').slice(0, 140), bundled: false, repo: e.repo ? String(e.repo) : null }));
    if (!remote.length) throw new Error('no usable entries');
    return { entries: remote, source: 'remote', warnings };
  } catch (e) {
    warnings.push(`remote marketplace failed (${truncate(String(e.message), 80)}) — showing the bundled seed`);
    return { entries: seed, source: 'bundled (remote failed)', warnings };
  }
}

/** Spawn a git clone (live half used by tests/drills that want async). */
export function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}
