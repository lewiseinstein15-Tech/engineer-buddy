// commands.js — parse "@engineer-buddy <command>" chat comments into skill
// invocations. Only comments that START with the handle trigger anything;
// everything else is ignored (no ambient autonomy, no loops).
import { toInt } from './util.js';

export const DEFAULT_HANDLE = '@engineer-buddy';

/**
 * @param {string} body      comment body
 * @param {object} ctx       { isPR } — whether the comment is on a PR
 * @returns {null | {skill, issue?, since?, help?, unknown?}}
 */
export function parseCommand(body, { handle = DEFAULT_HANDLE, isPR = false } = {}) {
  if (typeof body !== 'string') return null;
  const h = String(handle || DEFAULT_HANDLE);
  if (!body.trimStart().toLowerCase().startsWith(h.toLowerCase())) return null;
  const rest = body.trimStart().slice(h.length).trim().toLowerCase();

  // fix #123 / fix issue #123 / try #123 / patch #123
  let m = rest.match(/^(?:fix|try|patch|solve)\s+(?:issue\s+)?#?(\d+)/);
  if (m) return { skill: 'fix', issue: toInt(m[1]) };

  // review / re-review / review this
  if (/^(re-?review|review)(\b|$)/.test(rest)) return { skill: 'review' };

  // audit / audit deps / audit dependencies
  if (/^audit\b/.test(rest)) return { skill: 'audit' };

  // notes --since v1.2.0  |  release notes --since v1.2.0
  m = rest.match(/^(?:release[- ]?notes|notes|changelog)(?:\s+(?:--since\s+)?(\S+))?$/);
  if (m) return { skill: 'notes', since: m[1] || null };

  // triage (manual re-triage of the current issue)
  if (/^triage\b/.test(rest)) return { skill: 'triage' };

  if (/^(help|commands|what can you do)\b/.test(rest)) return { skill: 'help' };

  return { skill: 'unknown', unknown: rest.slice(0, 80) };
}

export function helpMarkdown(handle = DEFAULT_HANDLE) {
  return [
    `**${handle} commands** — I am a keyless AI engineer ($0/month, zero API keys):`,
    '',
    '| Command | Where | What I do |',
    '|---|---|---|',
    '| `@engineer-buddy review` | PR comment | full engineering re-review of this PR |',
    '| `@engineer-buddy fix #12` | issue or PR comment | investigate issue #12, implement a fix, run tests, open a PR (`buddy/*` branch, never main) |',
    '| `@engineer-buddy audit` | any issue/PR comment | run `npm audit`, triage advisories with the brain, update the dependency-audit issue |',
    '| `@engineer-buddy notes` | any comment | draft release notes from recently merged PRs |',
    '| `@engineer-buddy triage` | issue comment | re-classify and label this issue |',
    '| `@engineer-buddy help` | anywhere | this table |',
    '',
    '*New issues are triaged automatically. All fixes ship as PRs for human review — I never merge, never approve, never touch `main`.*',
  ].join('\n');
}
