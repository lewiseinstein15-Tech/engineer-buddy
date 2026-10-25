// learn.js — Buddy Code's Harness² self-improvement step (k=1 sequential).
//
// After a completed task, buddy may:
//   1. record one EXPERIENCE.md entry (cue / lesson / evidence / confidence)
//      — the "harnessing-level recursion": lessons carry to future tasks;
//   2. propose ONE edit to its own harness (systemprompt / guardrails /
//      MEMORY.md / tool_guidance.md / skills) — the task-level recursion,
//      adapted cheaply: 1 propose call, whole-proposal validation with a
//      single verbatim-error retry, and KEEP_BASE as the default outcome.
//
// Honesty rules ported from Harness²: no concrete contrast in the transcript
// → NO_ENTRY, not a made-up lesson. Unverifiable proposals → KEEP_BASE.
import fs from 'node:fs';
import path from 'node:path';
import { extractJson, truncate } from './util.js';
import { EXPERIENCE_DIR } from './harness/defaults.js';
import { loadHarness, validateHarnessProposal, applyHarnessProposal } from './harness/scaffold.js';

const PROPOSE_PROMPT = `You are the harness editor for "Engineer Buddy", an AI coding agent that just completed a task in this repository. Your job (Harness² "recursive agent harnessing"): improve the agent's harness based on what actually happened, with the model weights untouched.

Study the task transcript below. Then decide:

1. EXPERIENCE entry — one concrete, evidence-supported lesson. Fields:
   - "cue": when this lesson applies (short trigger phrase)
   - "lesson": what to do differently
   - "evidence": the exact moment in the transcript (quote the tool call or output that proves it)
   - "confidence": "low" | "medium" | "high"
   If the transcript shows NO concrete contrast (no failed attempt, no surprise, nothing that would change future behavior), set experience to null. Do NOT invent lessons. Honest nulls are the expected outcome for smooth tasks.

2. Harness proposal — OPTIONAL and rare. Only when the transcript proves the harness itself (instructions, memory, tool guidance, a skill) is missing or wrong in a way that will recur. Edits are allowed ONLY to these files:
   - systemprompt.md, guardrails.md, MEMORY.md, tool_guidance.md
   - skills/<name>/*.md (if you add a skill, an always-on file must reference it, e.g. "When <situation>, load the \`<name>\` skill" in tool_guidance.md — include that edit in the SAME proposal)
   Format: {"path": "<file>", "content": "<full new file content>"} — omit "proposal" entirely to KEEP_BASE (the safe default; most good runs propose nothing).

Reply with EXACTLY ONE JSON object:
{"experience":{"cue":"...","lesson":"...","evidence":"...","confidence":"low|medium|high"},"proposal":{"path":"...","content":"..."}}
or {"experience":null,"proposal":null}

Constraints: MEMORY.md ≤ 16000 chars, tool_guidance.md ≤ 12000, systemprompt.md ≤ 16000, guardrails.md ≤ 8000, skills ≤ 8000 each. Never include evaluation/benchmark/grader vocabulary. Plain markdown only.

TASK TRANSCRIPT:
`;

export function experiencePath(root) {
  return path.join(root, EXPERIENCE_DIR, 'EXPERIENCE.md');
}

function appendExperience(root, { cue, lesson, evidence, confidence }, taskText) {
  const file = experiencePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let header = '';
  if (!fs.existsSync(file)) {
    header = [
      '# Experience — lessons carried across tasks (Harness² experience library)',
      '',
      'Format per entry: cue / lesson / evidence / confidence. Entries marked NO_ENTRY',
      'record honest "nothing worth carrying" outcomes — they prevent lesson inflation.',
      '',
    ].join('\n');
  }
  const entry = [
    `## ${new Date().toISOString().slice(0, 10)} — ${truncate(taskText.replace(/\s+/g, ' '), 90)}`,
    `- cue: ${cue}`,
    `- lesson: ${lesson}`,
    `- evidence: ${truncate(evidence, 300)}`,
    `- confidence: ${confidence}`,
    '',
  ].join('\n');
  fs.appendFileSync(file, (fs.existsSync(file) && fs.statSync(file).size > 0 ? '' : header) + entry, 'utf8');
  return file;
}

function appendNoEntry(root, taskText, reason) {
  const file = experiencePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = `## ${new Date().toISOString().slice(0, 10)} — ${truncate(taskText.replace(/\s+/g, ' '), 90)}\n- NO_ENTRY (${reason})\n\n`;
  fs.appendFileSync(file, entry, 'utf8');
  return file;
}

/** Recent lessons to inject into future sessions (kept tiny). */
export function recentLessons(root, max = 6) {
  try {
    const raw = fs.readFileSync(experiencePath(root), 'utf8');
    const lessons = [...raw.matchAll(/^- lesson: (.+)$/gm)].map((m) => m[1]);
    return lessons.slice(-max);
  } catch {
    return [];
  }
}

/**
 * Run one reflection step. Never throws (returns {status, ...}).
 * @param {object} p
 * @param {object} p.router     GatewayRouter
 * @param {string} p.root       workspace root
 * @param {string} p.task       the user's task text
 * @param {Array}  p.events     chat events [{type:'tool'|'say'|'error'|'compaction',...}]
 * @returns {{status:'entry'|'no_entry'|'applied'|'keep_base'|'skipped', detail, proposalErrors?, applied?}}
 */
export async function reflect({ router, root, task, events = [] }) {
  // Build the evidence digest (Harness²: evidence-as-files, small in context).
  const digest = events
    .filter((e) => e.type === 'tool' || e.type === 'error')
    .map((e) =>
      e.type === 'error'
        ? `ERROR: ${truncate(e.text, 200)}`
        : `${e.tool}(${truncate(JSON.stringify(e.args ?? {}), 140)})${e.denied ? ' [DENIED]' : ''} → ${truncate(String(e.observation ?? ''), 220)}`
    )
    .join('\n');

  let raw;
  try {
    const { text } = await router.chat([{ role: 'user', content: PROPOSE_PROMPT + truncate(digest || '(no tool activity)', 14000) }], { maxTokens: 2600 });
    raw = text;
  } catch (e) {
    return { status: 'skipped', detail: `brain unavailable for reflection: ${truncate(e.message, 120)}` };
  }

  const parsed = extractJson(raw);
  if (!parsed.ok || typeof parsed.value !== 'object' || !parsed.value) {
    return { status: 'skipped', detail: 'reflector returned no parseable JSON — harness unchanged' };
  }
  const { experience, proposal } = parsed.value;
  const outcome = { status: 'no_entry', detail: '' };

  // 1) Experience entry — with the NO_ENTRY honesty rule.
  if (experience && typeof experience === 'object' && experience.cue && experience.lesson && experience.evidence) {
    const conf = ['low', 'medium', 'high'].includes(experience.confidence) ? experience.confidence : 'low';
    const file = appendExperience(root, { ...experience, confidence: conf }, task);
    outcome.status = 'entry';
    outcome.detail = `experience recorded in ${file}`;
  } else if (!proposal) {
    const file = appendNoEntry(root, task, 'no concrete contrast in transcript');
    outcome.status = 'no_entry';
    outcome.detail = `no_entry recorded in ${file}`;
  }

  // 2) Harness proposal — validate whole-proposal, 1 verbatim-error retry, KEEP_BASE default.
  if (proposal && typeof proposal === 'object' && proposal.path && typeof proposal.content === 'string') {
    const current = loadHarness(root);
    let errors = validateHarnessProposal({ [proposal.path]: proposal.content }, current);
    if (errors.length) {
      // One retry with the validator errors verbatim (Harness² repair rule).
      try {
        const { text } = await router.chat(
          [
            {
              role: 'user',
              content:
                `Your harness proposal was rejected by the validator:\n- ${errors.join('\n- ')}\n\nFix the proposal and reply again with EXACTLY ONE JSON object of the same shape ({"experience":...,"proposal":{...}}), or reply {"experience":null,"proposal":null} to KEEP_BASE.\n\nOriginal proposal: ${truncate(JSON.stringify(proposal), 4000)}`,
            },
          ],
          { maxTokens: 2600 }
        );
        const retry = extractJson(text);
        if (retry.ok && retry.value && retry.value.proposal && retry.value.proposal.path && typeof retry.value.proposal.content === 'string') {
          errors = validateHarnessProposal({ [retry.value.proposal.path]: retry.value.proposal.content }, current);
          if (!errors.length) {
            const applied = applyHarnessProposal(root, { [retry.value.proposal.path]: retry.value.proposal.content });
            outcome.status = 'applied';
            outcome.detail = `${outcome.detail ? outcome.detail + '; ' : ''}harness updated: ${applied.join(', ')}`;
            return outcome;
          }
        }
      } catch {
        /* fall through to KEEP_BASE */
      }
      outcome.status = 'keep_base';
      outcome.detail = `${outcome.detail ? outcome.detail + '; ' : ''}proposal rejected — harness unchanged (KEEP_BASE)`;
      outcome.proposalErrors = errors;
      return outcome;
    }
    const applied = applyHarnessProposal(root, { [proposal.path]: proposal.content });
    outcome.status = 'applied';
    outcome.detail = `${outcome.detail ? outcome.detail + '; ' : ''}harness updated: ${applied.join(', ')}`;
    return outcome;
  }

  if (outcome.status === 'no_entry' && !outcome.detail) outcome.detail = 'nothing to record';
  return outcome;
}
