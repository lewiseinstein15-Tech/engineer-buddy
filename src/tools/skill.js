// skill.js — the `skill` tool: the ONLY door to skill bodies.
//
// Why a dedicated tool? The harness firewall (AGENT_DENY_GLOBS) blocks
// .buddy/harness/** from fs_read/fs_search — skills were unreachable text.
// The tool reads from the already-loaded catalog (no disk access for the
// body), and can also fetch supporting files that ship next to SKILL.md.
import fs from 'node:fs';
import path from 'node:path';
import { truncate } from '../util.js';

/**
 * @param {Array} skills catalog from loadSkills()
 * @param {object} p
 * @param {number} p.maxFileChars cap for supporting-file reads
 */
export function buildSkillTool({ skills = [], maxFileChars = 12000 } = {}) {
  const byName = new Map(skills.filter((s) => !s.disableModelInvocation).map((s) => [s.name, s]));
  const names = () => [...byName.keys()].join(', ') || '(none — add .buddy/harness/skills/<name>/SKILL.md)';
  return {
    name: 'skill',
    description: 'Load an on-demand skill (a playbook) by name. Call this FIRST when the task matches a skill from the catalog.',
    args: '{"name":"pr-review"} or {"name":"pr-review","file":"examples.md"}',
    maxCalls: 4,
    render: (a) => `skill ${a?.name ?? ''}${a?.file ? ` · ${a.file}` : ''}`,
    run: async ({ name, file } = {}) => {
      const rec = byName.get(String(name || '').trim());
      if (!rec) return `ERROR: unknown skill "${name}". Available: ${names()}`;
      if (file) {
        const fname = String(file).trim();
        if (!rec.files.includes(fname)) {
          return `ERROR: "${fname}" is not a supporting file of skill "${rec.name}". Available: ${rec.files.join(', ') || '(none)'}`;
        }
        try {
          const content = fs.readFileSync(path.join(rec.dir, fname), 'utf8');
          return `SKILL FILE ${rec.name}/${fname}:\n${truncate(content, maxFileChars)}`;
        } catch (e) {
          return `ERROR: could not read ${fname}: ${e.message}`;
        }
      }
      const head = [
        `SKILL: ${rec.name} (source: ${rec.source})`,
        rec.allowedTools?.length ? `Allowed tools for this skill: ${rec.allowedTools.join(', ')}` : '',
        'Follow this playbook for the current task.',
      ].filter(Boolean);
      const tail = rec.files.length
        ? `\n\nSupporting files: ${rec.files.join(', ')} — load one with {"tool":"skill","args":{"name":"${rec.name}","file":"<filename>"}}`
        : '';
      return head.join('\n') + '\n\n' + rec.body + tail;
    },
  };
}
