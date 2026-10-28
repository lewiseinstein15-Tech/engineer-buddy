// loader.js — Skills v2: the SKILL.md open standard, Buddy edition.
//
// A skill is a folder with a SKILL.md playbook. Frontmatter is a tiny
// zero-dependency subset of YAML:
//
//   ---
//   name: pr-review
//   description: Engineering-grade review of a diff. Use when asked to review a PR.
//   allowed-tools: fs_read, fs_search, bash
//   disable-model-invocation: false
//   ---
//   (markdown body — the playbook Buddy follows)
//
// Four layers, later wins (same shadowing rule as Claude Code):
//   1. bundled  — shipped with Buddy (skills/ in the package root)
//   2. plugin   — every enabled plugin's skills/ dir (v0.39.0 §3)
//   3. personal — ~/.buddy/skills/<name>/SKILL.md   (you, everywhere)
//   4. project  — .buddy/harness/skills/<name>/SKILL.md (this repo only)
//
// Only `name` + `description` are always in context (progressive disclosure);
// the body loads on demand through the `skill` tool — the harness firewall
// (.buddy/harness/** is deny-globbed) hides these files from fs_read, so the
// skill tool is the ONLY door.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { enabledPlugins, pluginKindDirs } from '../plugins.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PERSONAL_SKILLS_DIR = '.buddy/skills';
// Soft size guard: a skill body is injected into a free-model context when
// loaded. Oversized skills still load, but get flagged in /skills output.
export const SKILL_BODY_SOFT_CAP = 12000;
const SUPPORTING_EXT_RE = /\.(md|txt|json|csv|ya?ml)$/i;
const MAX_SUPPORTING_FILES = 8;

// Package root = parent of src/ — bundled skills live in <root>/skills/.
const PKG_ROOT = path.dirname(createRequire(import.meta.url).resolve('../../package.json'));
export const BUNDLED_SKILLS_DIR = path.join(PKG_ROOT, 'skills');

/** Parse SKILL.md content into { meta, body, warnings }. Never throws. */
export function parseSkillMd(raw, { fallbackName = '' } = {}) {
  const warnings = [];
  const text = String(raw ?? '');
  let meta = { name: '', description: '', allowedTools: null, disableModelInvocation: false };
  let body = text;

  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    const front = m[1];
    body = text.slice(m[0].length);
    for (const line of front.split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'name') meta.name = value;
      else if (key === 'description') meta.description = value;
      else if (key === 'allowed-tools' || key === 'allowed_tools') {
        meta.allowedTools = value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
      } else if (key === 'disable-model-invocation') {
        meta.disableModelInvocation = /^(true|yes|1)$/i.test(value);
      }
      // unknown keys are ignored (forward compatibility with the open standard)
    }
  } else if (/^\s*---/.test(text)) {
    warnings.push('frontmatter opened but never closed — treating the whole file as the body');
  }

  if (!meta.name) meta.name = fallbackName;
  if (!meta.description) {
    // Descriptionless skills are legal (Harness² heritage files look like this):
    // derive a one-liner from the body. A bare "# Skill: <name>" heading says
    // nothing — prefer the Trigger: line, then any other non-empty line.
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const selfTitle = lines.findIndex((l) => /^#\s+skill:/i.test(l));
    const trigger = lines.slice(selfTitle + 1).find((l) => /^trigger\s*:/i.test(l));
    const candidate = trigger || lines[selfTitle + 1] || lines[0] || '';
    meta.description = candidate.replace(/^#+\s*/, '').slice(0, 200);
  }
  if (body.length > SKILL_BODY_SOFT_CAP) {
    warnings.push(`body is ${body.length} chars (soft cap ${SKILL_BODY_SOFT_CAP}) — long skills burn context when loaded`);
  }
  return { meta, body, warnings };
}

function supportingFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name !== SKILL_FILE && SUPPORTING_EXT_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_SUPPORTING_FILES);
  } catch {
    return [];
  }
}

function scanLayer(dir, source) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return found; // layer not present — normal
  }
  for (const entry of entries) {
    const skillPath = path.join(dir, entry.name, SKILL_FILE);
    let raw;
    try {
      raw = fs.readFileSync(skillPath, 'utf8');
    } catch {
      continue; // folder without SKILL.md is not a skill
    }
    const { meta, body, warnings } = parseSkillMd(raw, { fallbackName: entry.name });
    if (!SKILL_NAME_RE.test(meta.name)) {
      found.push({ __invalid: entry.name, source, warning: `skill folder "${entry.name}" has invalid name "${meta.name}" — skipped (use a-z, 0-9, dashes)` });
      continue;
    }
    found.push({
      name: meta.name,
      description: meta.description,
      allowedTools: meta.allowedTools,
      disableModelInvocation: meta.disableModelInvocation,
      body,
      dir: path.dirname(skillPath),
      source,
      files: supportingFiles(path.dirname(skillPath)),
      warnings,
    });
  }
  return found;
}

/**
 * Load the skill catalog. Later layers shadow earlier ones by name.
 * @returns {{skills: Array, warnings: string[]}}
 */
export function loadSkills({ root = process.cwd(), home = os.homedir() } = {}) {
  const warnings = [];
  const byName = new Map();
  // Enabled plugins contribute their skills/ dirs between bundled and
  // personal — a plugin can extend the catalog, the user's own always wins.
  const { plugins: plugged, warnings: pluginWarnings } = enabledPlugins({ root, home });
  warnings.push(...pluginWarnings);
  const layers = [
    [BUNDLED_SKILLS_DIR, 'bundled'],
    ...pluginKindDirs(plugged, 'skills').map((d) => [d.dir, 'plugin']),
    [path.join(home, PERSONAL_SKILLS_DIR), 'personal'],
    [path.join(root, '.buddy/harness/skills'), 'project'],
  ];
  for (const [dir, source] of layers) {
    for (const rec of scanLayer(dir, source)) {
      if (rec.__invalid) {
        warnings.push(rec.warning);
        continue;
      }
      if (byName.has(rec.name) && rec.source !== 'bundled') {
        warnings.push(`skill "${rec.name}" (${rec.source}) shadows the ${byName.get(rec.name).source} one`);
      }
      byName.set(rec.name, rec);
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of skills) for (const w of s.warnings) warnings.push(`skill "${s.name}": ${w}`);
  return { skills, warnings };
}

/** Format the always-on catalog block for the system prompt (progressive disclosure). */
export function describeSkillCatalog(skills) {
  const invocable = (skills || []).filter((s) => !s.disableModelInvocation);
  if (!invocable.length) return '';
  return [
    '## Skills',
    'On-demand playbooks. When the user\'s request matches a skill description, call {"tool":"skill","args":{"name":"<name>"}} FIRST and follow it before acting.',
    ...invocable.map((s) => `- ${s.name} — ${s.description}`),
  ].join('\n');
}
