// tasks.js — background turns (v0.34.0).
//
// Ctrl+B detaches the RUNNING turn: the prompt returns immediately while the
// turn keeps working with its live output muted into a per-task buffer. The
// mutex stays simple — exactly ONE turn runs on the chat at a time (the REPL's
// runTask loop + message queue already guarantee that); detach only decouples
// the PROMPT from the TURN. /tasks lists detached turns (plus background
// shells), /tasks view N reads the buffered output, /tasks stop N interrupts,
// /tasks attach N follows the running turn live again.
//
// Everything here is pure: records in, strings out. The REPL owns the wiring.
import { c } from './ui.js';
import { SEM, fmtDur, fmtTok, truncateVisible } from './theme.js';

export const BG = {
  BUFFER_CAP: 400,   // buffered output lines per task (head drops, flag set)
  VIEW_TAIL: 24,     // /tasks view shows the last N buffered lines
  HISTORY_CAP: 20,   // finished task records kept for the session list
  TASK_WIDTH: 44,    // task-text column in list + notes
};

/** One detached-turn record. Created the moment ctrl+b lands mid-turn. */
export function createBgTurn({ id, task, startedAt, detachedAt }) {
  return {
    id: Number(id) || 0,
    task: String(task ?? '').replace(/\s+/g, ' ').trim(),
    startedAt: Number(startedAt) || Date.now(),
    detachedAt: Number(detachedAt) || Date.now(),
    endedAt: null,
    status: 'running',        // running | done | stopped | failed
    reattached: false,        // /tasks attach N (or an approval) pulled it back
    steps: 0,
    tools: 0,
    bytes: 0,
    denied: 0,
    errors: 0,
    said: null,
    buffer: [],               // compact one-line summaries, muted output
    truncated: false,
  };
}

/** Fold one chat event into the record (the muted side of onEvent). */
export function bgBufferEvent(rec, ev) {
  if (!rec || !ev) return rec;
  const t = ev.type;
  if (t === 'tool') {
    rec.tools += 1;
    if (ev.denied) rec.denied += 1;
    const head = truncateVisible(String(ev.argText || ev.tool), 58);
    rec.buffer.push(ev.denied
      ? `${c.red('⊗')} ${c.gray(String(ev.tool))} ${c.dim('(denied)')}`
      : `${c.gray('▸')} ${head}`);
  } else if (t === 'say') {
    rec.said = String(ev.text ?? '');
    rec.buffer.push(`${c.gray('✻')} ${truncateVisible(rec.said.replace(/\s+/g, ' '), 76)}`);
  } else if (t === 'error') {
    rec.errors += 1;
    rec.buffer.push(`${c.red('✗')} ${truncateVisible(String(ev.text ?? ''), 76)}`);
  } else if (t === 'interrupted') {
    rec.buffer.push(`${c.yellow('⏸')} interrupted`);
  } else if (t === 'compaction') {
    rec.buffer.push(`${c.gray('⌁')} compacted — kept ${ev.kept ?? '?'}, dropped ${ev.dropped ?? '?'}`);
  }
  if (rec.buffer.length > BG.BUFFER_CAP) {
    rec.buffer.splice(0, rec.buffer.length - BG.BUFFER_CAP);
    rec.truncated = true;
  }
  return rec;
}

/** Streamed bytes while muted (the counter side of onStreamDelta). */
export function bgBytes(rec, n) {
  if (rec) rec.bytes += Math.max(0, Number(n) || 0);
  return rec;
}

/** Close the record. status: aborted → stopped, threw → failed, else done. */
export function bgFinish(rec, { at = Date.now(), steps = 0, said = null, aborted = false, failed = false } = {}) {
  if (!rec || rec.status !== 'running') return rec;
  rec.endedAt = Number(at) || Date.now();
  rec.status = aborted ? 'stopped' : failed ? 'failed' : 'done';
  rec.steps = Number(steps) || rec.steps;
  if (said != null) rec.said = String(said);
  return rec;
}

/** Find a task by id in the session list — accepts `3` and `t3`. */
export function resolveBgId(list, arg) {
  const m = /^\s*t?(\d+)\s*$/i.exec(String(arg ?? ''));
  if (!m) return null;
  const id = Number(m[1]);
  return list.find((r) => r.id === id) || null;
}

/** /tasks [view|stop|attach] [t]<id> — subcommand parser. */
export function parseBgArgs(args) {
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { sub: 'list', id: null };
  const first = parts[0].toLowerCase();
  if (first === 'list') return { sub: 'list', id: null };
  if (['view', 'stop', 'attach'].includes(first)) {
    if (!parts[1]) return { sub: first, id: null }; // subcommand without an id → usage
    return { sub: first, id: parts[1] };
  }
  // bare id = view (fast path: /tasks 1)
  return { sub: 'view', id: parts[0] };
}

const statusMark = (rec) =>
  rec.status === 'running' ? c.green('●')
    : rec.status === 'done' ? c.green('✓')
    : rec.status === 'stopped' ? c.yellow('⏸')
    : c.red('✗');

const statusText = (rec, now) => {
  if (rec.status === 'running') {
    const secs = ((now ?? Date.now()) - rec.detachedAt) / 1000;
    return c.green(`running ${secs.toFixed(0)}s${rec.reattached ? ' · attached' : ' · muted'}`);
  }
  const secs = ((rec.endedAt ?? rec.detachedAt) - rec.startedAt) / 1000;
  return `${rec.status} ${SEM.time(fmtDur(secs * 1000))}`;
};

/** /tasks — the two-section list: detached turns, then background shells. */
export function renderBgList({ turns = [], shells = [], now = null } = {}) {
  const out = [''];
  out.push(`${c.bold('Background tasks')}`);
  if (!turns.length && !shells.length) {
    out.push(`  ${c.dim('nothing in the background — ctrl+b detaches the running turn (output mutes, the prompt stays yours)')}`);
    out.push('');
    return out.join('\n');
  }
  if (turns.length) {
    for (const r of turns) {
      out.push(`  ${statusMark(r)} ${c.bold(`t${r.id}`)} · ${statusText(r, now)} · ${SEM.time(`${r.tools} tool${r.tools === 1 ? '' : 's'}`)} · ${truncateVisible(r.task, BG.TASK_WIDTH)}`);
    }
    out.push(`  ${c.dim('view: /tasks view t1 · stop: /tasks stop t1 · follow live: /tasks attach t1')}`);
  } else {
    out.push(`  ${c.dim('no detached turns — ctrl+b detaches the running turn')}`);
  }
  if (shells.length) {
    out.push(`  ${c.dim('─'.repeat(8))} ${c.bold('shells')}`);
    for (const s of shells) {
      const mark = s.status === 'running' ? c.green('●') : c.dim('○');
      const st = s.status === 'running' ? c.green(`running ${(s.durationMs / 1000).toFixed(1)}s`) : `${s.status}${s.exitCode != null ? ` (${s.exitCode})` : ''}`;
      out.push(`  ${mark} ${c.bold(`#${s.id}`)} · ${st} · ${SEM.time(`${s.bytes}b`)} · ${truncateVisible(String(s.command), BG.TASK_WIDTH)}`);
    }
    out.push(`  ${c.dim('read output: bash_output {"id":N} · stop: kill_shell {"id":N}')}`);
  }
  out.push('');
  return out.join('\n');
}

/** /tasks view tN — header + stats + the buffered output tail. */
export function renderBgView(rec, { tail = BG.VIEW_TAIL } = {}) {
  if (!rec) return null;
  const out = [''];
  out.push(`${c.bold(`Task t${rec.id}`)} ${c.dim('·')} ${statusText(rec)} ${c.dim('·')} ${truncateVisible(rec.task, 60)}`);
  out.push(`  ${SEM.time(`${rec.steps} step${rec.steps === 1 ? '' : 's'} · ${rec.tools} tool${rec.tools === 1 ? '' : 's'} · ↓${fmtTok(rec.bytes)}${rec.denied ? ` · ${rec.denied} denied` : ''}${rec.errors ? ` · ${rec.errors} error${rec.errors === 1 ? '' : 's'}` : ''}`)}`);
  if (!rec.buffer.length) {
    out.push(`  ${c.dim('no output yet — tool calls and replies land here while muted')}`);
  } else {
    if (rec.truncated) out.push(`  ${c.dim(`… buffer capped at ${BG.BUFFER_CAP} lines — older output fell off the top …`)}`);
    for (const line of rec.buffer.slice(-tail)) out.push(`  ${line}`);
    const hidden = rec.buffer.length - tail;
    if (hidden > 0) out.push(`  ${c.dim(`… ${hidden} earlier line${hidden === 1 ? '' : 's'} — the full flow stays in the ctrl+r transcript …`)}`);
  }
  if (rec.status === 'running' && rec.said == null && rec.tools === 0) out.push(`  ${c.dim('/tasks attach ' + rec.id + ' to follow it live again')}`);
  out.push('');
  return out.join('\n');
}

/** The one-line completion note printed when a detached turn ends. */
export function renderBgNote(rec) {
  if (!rec) return null;
  const secs = ((rec.endedAt ?? Date.now()) - rec.startedAt) / 1000;
  const stats = `${rec.steps} step${rec.steps === 1 ? '' : 's'} · ${rec.tools} tool${rec.tools === 1 ? '' : 's'} · ${fmtDur(secs * 1000)} · ↓${fmtTok(rec.bytes)}`;
  const extras = [
    rec.denied ? `${rec.denied} denied` : '',
    rec.errors ? `${rec.errors} error${rec.errors === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  const mark = rec.status === 'done' ? c.green('✓') : rec.status === 'stopped' ? c.yellow('⏸') : c.red('✗');
  const head = rec.status === 'done' ? 'done' : rec.status === 'stopped' ? 'stopped' : 'failed';
  return `  ${mark} ${c.bold(`bg t${rec.id}`)} ${head} · ${truncateVisible(rec.task, BG.TASK_WIDTH)} · ${SEM.time(stats)}${extras ? SEM.time(' · ' + extras) : ''}${SEM.time(' · /tasks view ' + rec.id + ' for output')}`;
}
