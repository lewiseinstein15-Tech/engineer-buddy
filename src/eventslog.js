// eventslog.js — structured JSON event log for every agent action (v0.25.0).
//
// The session transcript (.buddy/sessions/*.jsonl) is human-oriented: it
// records what was SAID. This log records what HAPPENED — every tool call,
// denial, compaction, turn boundary and error, one JSON object per line with
// an ISO timestamp, written to .buddy/events.jsonl.
//
// Why: debugging a multi-agent cascade (or a "why did it edit that file"
// moment) needs machine-readable facts, not a chat transcript. The format is
// deliberately JSONL so `jq`, `tail -1 | jq` or plain grep all work, and
// Buddy can later ship it to an OTel collector — opt-in, zero deps, via the
// same append point.
//
// Safety: append-only, size-capped with a single-file rotation, and every
// failure is swallowed — telemetry must never break a turn.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB, keep one old file

export function eventsLogPath(root) {
  return path.join(root, '.buddy', 'events.jsonl');
}

/** Append one structured event. Best-effort by design — never throws. */
export function appendEvent(root, ev, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    const file = eventsLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`;
    // Rotate before the append pushes us over the cap (transcript files can
    // vanish mid-write in parallel sessions — rotation failure must not
    // block the write).
    try {
      if (fs.existsSync(file) && fs.statSync(file).size + line.length > maxBytes) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* rotation is an optimization, not a requirement */
    }
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the last n events, oldest → newest. Torn final line (concurrent
 * writers) is tolerated: partial JSON is skipped, never surfaced.
 */
export function readEvents(root, n = 20) {
  try {
    const raw = fs.readFileSync(eventsLogPath(root), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-Math.max(1, n * 2))) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* torn or foreign line — skip */
      }
    }
    return out.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Whitelist projection for the log: keep the facts, drop the bulk (full tool
 * observations and message bodies can be huge — the transcript has them;
 * here we keep identity + outcome + sizes).
 */
export function projectEvent(ev) {
  const base = { type: ev.type };
  switch (ev.type) {
    case 'user':
      return { ...base, chars: String(ev.text || '').length };
    case 'say':
      return { ...base, chars: String(ev.text || '').length };
    case 'tool':
      return {
        ...base,
        tool: ev.tool,
        denied: Boolean(ev.denied),
        gateway: ev.gateway || null,
        model: ev.model || null,
        obsChars: String(ev.observation || '').length,
        // Decision rationale (v0.37.0): the model's why-this-step sentence,
        // when it shipped one — the event log is the "why did it edit that
        // file" answer machine.
        ...(ev.why ? { why: String(ev.why) } : {}),
        // The why contract (v0.46.0): the loop BOUNCED this call once for
        // missing its why — enforcement is a fact the audit keeps.
        ...(ev.whyBounced ? { whyBounced: true } : {}),
      };
    case 'compaction':
      return { ...base, kept: ev.kept, dropped: ev.dropped, auto: Boolean(ev.auto) };
    case 'interrupted':
      return { ...base, at: ev.at };
    case 'subagent':
      // v0.44.0 — sub-agent narration keeps its facts in the log (the type
      // alone used to fall through `default` and tell nobody anything).
      return {
        ...base,
        agent: String(ev.agent || ''),
        tool: ev.tool || null,
        phase: String(ev.phase || ''),
        obsChars: ev.observation ? String(ev.observation).length : 0,
      };
    case 'mcp':
      // v0.44.0 — the unified protocol: server→client notifications
      // (progress / log) land here, facts only, values truncated by the parser.
      return {
        ...base,
        server: String(ev.server || ''),
        phase: String(ev.phase || ''),
        ...(ev.phase === 'progress' ? { progress: ev.progress, total: ev.total ?? null } : { level: ev.level || 'info' }),
        chars: String(ev.data || ev.message || '').length,
      };
    case 'error':
      return { ...base, text: String(ev.text || '').slice(0, 300) };
    case 'lessonRecall':
      // v0.52.0 — cross-session recall is an auditable fact: how many lessons
      // rode into the task and how strong the top match was. The block itself
      // lives in the task text; the log keeps counts, never the bulk.
      return { ...base, count: Number(ev.count) || 0, topScore: typeof ev.topScore === 'number' ? ev.topScore : null };
    case 'turn_end':
      return {
        ...base,
        steps: ev.steps,
        durationMs: ev.durationMs,
        calls: ev.calls,
        tokIn: ev.tokIn,
        tokOut: ev.tokOut,
        said: Boolean(ev.said),
        error: Boolean(ev.error),
      };
    default:
      return base;
  }
}
