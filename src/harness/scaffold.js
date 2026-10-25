// scaffold.js — harness-as-directory: create, load, and validate the
// .buddy/harness/ surface. Ported from Harness² core/tree.py + core/spec.py
// concepts: a fixed editable surface, whole-proposal validation with
// verbatim-error retry, triggered-skills rule, grader-marker tripwires.
//
// KEY CONVENTION: harness maps use paths RELATIVE to .buddy/harness/
// (e.g. "systemprompt.md", "skills/commit-message/SKILL.md").
import fs from 'node:fs';
import path from 'node:path';
import { globMatches } from '../util.js';
import { isSecretPath } from '../tools/local.js';
import {
  HARNESS_DIR,
  SIZE_CAPS,
  defaultHarnessFiles,
} from './defaults.js';

const SURFACE_RE = /^(systemprompt\.md|guardrails\.md|MEMORY\.md|tool_guidance\.md|skills\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+\.md|skills\/[A-Za-z0-9._-]+\.md)$/;

/** Create any missing default harness files. Returns the list created. */
export function ensureHarness(root = process.cwd()) {
  const created = [];
  for (const [rel, content] of Object.entries(defaultHarnessFiles())) {
    const abs = path.join(root, HARNESS_DIR, rel);
    if (fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    created.push(`${HARNESS_DIR}/${rel}`);
  }
  return created;
}

/** Load the current harness (missing files fall back to defaults). */
export function loadHarness(root = process.cwd()) {
  const merged = {};
  for (const [rel, def] of Object.entries(defaultHarnessFiles())) {
    try {
      merged[rel] = fs.readFileSync(path.join(root, HARNESS_DIR, rel), 'utf8');
    } catch {
      merged[rel] = def;
    }
  }
  // Load any extra user skills.
  const skillsRoot = path.join(root, HARNESS_DIR, 'skills');
  try {
    for (const name of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const skillPath = path.join(skillsRoot, name.name, 'SKILL.md');
      const rel = `skills/${name.name}/SKILL.md`;
      if (fs.existsSync(skillPath) && !(rel in merged)) merged[rel] = fs.readFileSync(skillPath, 'utf8');
    }
  } catch {
    /* no skills dir yet */
  }
  return merged;
}

/** Assemble the always-on context parts the chat loop injects.
 *
 * With `root` set, MEMORY.md `@path` imports are expanded (P1: memory
 * imports) — a whole line starting with `@` pulls that repo file's content
 * into memory at assembly time, so durable notes can reference living docs
 * without duplicating them. Without `root`, behavior is unchanged (tests,
 * pure callers).
 */
export function harnessContext(harness, root = null) {
  const memory = root ? expandMemoryImports(root, harness['MEMORY.md'] || '') : harness['MEMORY.md'];
  return {
    systemprompt: harness['systemprompt.md'],
    guardrails: harness['guardrails.md'],
    memory,
    toolGuidance: harness['tool_guidance.md'],
    skills: Object.fromEntries(Object.entries(harness).filter(([k]) => k.startsWith('skills/'))),
  };
}

// ── Memory @path imports ─────────────────────────────────────────────────────

// Caps mirror the @file mention firewall: one import ≤ 4k chars, all imports
// together ≤ 8k, nesting ≤ 3 deep. Imports are context, not a data feed.
const IMPORT_MAX_FILE = 4000;
const IMPORT_MAX_TOTAL = 8000;
const IMPORT_MAX_DEPTH = 3;

// Whole-line imports only: a trimmed line matching `@<path>` is an import.
// Inline @tokens (emails, prose) are left alone; `@@` renders a literal `@`.
const IMPORT_LINE = /^@((?:[A-Za-z0-9._\/-]|\\ )+)$/;

function importMarker(reason) {
  return `(memory import: ${reason})`;
}

/**
 * Expand `@path` lines in a memory text against the repo root.
 * Honest by construction: refused or missing imports become a visible
 * marker line, never a silent drop. Cycles and nesting are capped.
 */
export function expandMemoryImports(root, text, { depth = 0, seen = new Set(), budget = { left: IMPORT_MAX_TOTAL } } = {}) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith('@@') && IMPORT_LINE.test(trimmed.slice(1))) {
      out.push(`@${trimmed.slice(2)}`);
      continue;
    }
    const m = IMPORT_LINE.exec(trimmed);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1].replace(/\\ /g, ' ');
    if (depth >= IMPORT_MAX_DEPTH) {
      // This line sits inside a level-3 import — reading it would be level 4.
      out.push(importMarker(`@${rel} refused — nesting deeper than 3`));
      continue;
    }
    if (budget.left <= 0) {
      out.push(importMarker(`@${rel} skipped — import budget (8k chars) exhausted`));
      continue;
    }
    if (rel.includes('..')) {
      out.push(importMarker(`@${rel} refused — path escapes the repo`));
      continue;
    }
    if (isSecretPath(rel)) {
      out.push(importMarker(`@${rel} refused — secret paths are never loaded`));
      continue;
    }
    const abs = path.resolve(root, rel);
    if (seen.has(abs)) {
      out.push(importMarker(`@${rel} skipped — circular import`));
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      out.push(importMarker(`@${rel} — file not found`));
      continue;
    }
    seen.add(abs);
    const take = Math.min(content.length, IMPORT_MAX_FILE, budget.left);
    let piece =
      take < content.length
        ? `${content.slice(0, take)}\n${importMarker(`@${rel} truncated at ${take} chars`)}`
        : content;
    budget.left -= take;
    // A file may itself carry @imports — resolve them against ITS directory
    // so relative refs stay relative to the imported file. The depth gate at
    // the read site already refuses level-4 files, so recursion here is safe.
    piece = expandMemoryImports(path.dirname(abs), piece, { depth: depth + 1, seen, budget });
    out.push(`[imported: @${rel}]\n${piece.replace(/\n*$/, '\n')}[/imported]`);
  }
  return out.join('\n');
}

// ── Proposal validation (Harness² core/spec.py rules, adapted) ──────────────

// Grader/eval leak tripwires — benchmark or judge vocabulary must never enter
// the harness ("this is a leak, not a false positive to widen around").
const MARKER_RE = /\b(pass_rate|n_passed|n_failed|judge findings|rubric score|benchmark result)\b/i;

const ALWAYS_ON = ['systemprompt.md', 'guardrails.md', 'MEMORY.md', 'tool_guidance.md'];

export function isHarnessPath(rel) {
  return typeof rel === 'string' && !rel.includes('..') && !rel.includes('\\') && SURFACE_RE.test(rel);
}

function skillNameOf(rel) {
  const m = rel.match(/skills\/([^/]+)\//);
  return m ? m[1] : null;
}

function sizeCapFor(rel) {
  if (rel.startsWith('skills/')) return SIZE_CAPS.skill;
  return SIZE_CAPS[rel] ?? 16000;
}

/**
 * Validate a proposed harness edit set.
 * @param {Object<string,string>} proposal  harness-relative path -> new content
 * @param {Object<string,string>} current   current harness map (same convention)
 * @returns {string[]} errors (empty = valid). Whole proposal is rejected on
 *   any error; the caller retries once with these verbatim, then KEEP_BASE.
 */
export function validateHarnessProposal(proposal, current = {}) {
  const errors = [];
  const rels = Object.keys(proposal);

  if (!rels.length) return ['empty proposal: propose at least one file edit, or propose nothing (KEEP_BASE)'];

  // Surface check — every path must live on the harness surface and be .md.
  for (const rel of rels) {
    if (!isHarnessPath(rel)) {
      errors.push(`off-surface path "${rel}" — edits are allowed only to systemprompt.md, guardrails.md, MEMORY.md, tool_guidance.md, or skills/<name>/*.md`);
    }
  }
  if (errors.length) return errors;

  // Always-on files must stay non-empty and within caps; no grader markers.
  for (const [rel, content] of Object.entries(proposal)) {
    if (typeof content !== 'string') {
      errors.push(`"${rel}": content must be a string`);
      continue;
    }
    const cap = sizeCapFor(rel);
    if (content.length > cap) {
      errors.push(`"${rel}" exceeds the size cap (${content.length}/${cap} chars) — always-on context must stay tight`);
    }
    if (ALWAYS_ON.includes(rel) && !content.trim()) {
      errors.push(`"${rel}" is empty — an always-on file may never be empty`);
    }
    if (MARKER_RE.test(content)) {
      errors.push(`"${rel}" contains evaluation/grader vocabulary — harness files describe the work, never its measurement`);
    }
  }
  if (errors.length) return errors;

  // Triggered-skills rule: a skill file may only be proposed if it is either
  // (a) triggered by name in an always-on file (Harness² rule), or (b) a
  // Skills v2 skill whose frontmatter description lets the model auto-trigger
  // it from the always-on catalog.
  const merged = { ...current, ...proposal };
  const alwaysOnText = ALWAYS_ON.map((f) => merged[f] || '').join('\n');
  for (const rel of rels) {
    const name = skillNameOf(rel);
    if (name && !alwaysOnText.includes(name)) {
      const hasV2Description = /^description:\s*\S/m.test(String(merged[rel] || ''));
      if (!hasV2Description) {
        errors.push(`skill "${name}" is never triggered — add "When <situation>, load the \`${name}\` skill" to tool_guidance.md (or another always-on file) in the same proposal, or give the SKILL.md a frontmatter description (Skills v2 auto-trigger)`);
      }
    }
  }
  return errors;
}

/** Apply a validated proposal with per-file backups; returns applied paths. */
export function applyHarnessProposal(root, proposal) {
  const applied = [];
  for (const [rel, content] of Object.entries(proposal)) {
    const abs = path.join(root, HARNESS_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      const before = fs.readFileSync(abs, 'utf8');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupRel = `backups/${stamp}-${path.basename(rel)}`;
      const backupAbs = path.join(root, HARNESS_DIR, backupRel);
      fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
      fs.writeFileSync(backupAbs, before, 'utf8');
    } catch {
      /* new file — nothing to back up */
    }
    fs.writeFileSync(abs, content, 'utf8');
    applied.push(`${HARNESS_DIR}/${rel}`);
  }
  return applied;
}

/** Glob patterns the agent's own file tools may never touch (self-edit firewall). */
export const AGENT_DENY_GLOBS = [
  `${HARNESS_DIR}/**`,
  '**/.git/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/secrets.*',
  '**/*credentials*',
  '**/*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
];

export function isAgentDeniedPath(rel) {
  return AGENT_DENY_GLOBS.some((g) => globMatches(g, String(rel || '')));
}
