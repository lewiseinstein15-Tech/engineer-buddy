// repl.js — Buddy Code terminal interface.
//
// Interactive (like Claude Code): `buddy` opens a session; you type tasks,
// Buddy explores/edits/runs with approval gates, you talk back.
// Headless: `buddy -p "task"` runs one turn autonomously (CI-style).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createChat } from '../agent/chat.js';
import { LocalScope, buildLocalTools } from '../tools/local.js';
import { ensureHarness, loadHarness, harnessContext } from '../harness/scaffold.js';
import { HARNESS_DIR } from '../harness/defaults.js';
import { SessionRecorder, listSessions, loadSession, resumeMessages } from '../session.js';
import { reflect, recentLessons, experiencePath } from '../learn.js';
import { c, banner, spinner, renderToolCall, renderObservation } from './ui.js';
import { truncate, debugLog } from '../util.js';

export const VERSION = '0.3.0';

// ── Slash commands (pure, testable) ──────────────────────────────────────────

export const SLASH_COMMANDS = [
  'help', 'new', 'tools', 'memory', 'experience', 'yolo', 'learn',
  'sessions', 'resume', 'status', 'quit', 'exit', 'clear',
];

export function parseSlash(input) {
  const s = String(input || '').trim();
  if (!s.startsWith('/')) return null;
  const [name, ...rest] = s.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), args: rest.join(' ') };
}

// ── Session factory ──────────────────────────────────────────────────────────

function makeScopeAndTools(root) {
  const scope = new LocalScope(root);
  const tools = buildLocalTools({ scope });
  return { scope, tools };
}

function makeHarness(root) {
  ensureHarness(root);
  const hctx = harnessContext(loadHarness(root));
  const lessons = recentLessons(root);
  if (lessons.length) {
    hctx.memory += `\n\n## Lessons from past tasks\n${lessons.map((l) => `- ${l}`).join('\n')}`;
  }
  return hctx;
}

/** Create a chat session bound to a workspace root. */
export function createBuddySession({ root = process.cwd(), router, yolo = false, approval = null, charBudget, resumeFrom = null, onEvent = () => {} } = {}) {
  const { tools } = makeScopeAndTools(root);
  const harness = makeHarness(root);
  const session = createChat({ router, tools, harness, charBudget, approval, onEvent });
  if (resumeFrom) {
    for (const m of resumeMessages(loadSession(resumeFrom))) session.messages.push(m);
  }
  return { chat: session, tools };
}

function defaultApproval(busy) {
  // Headless/one-shot policy: autonomous on risky tools (they are still
  // hard-blocked by policy), unless --safe.
  return busy.safe ? () => 'no' : () => 'yes';
}

// ── Event rendering (shared by REPL and one-shot) ────────────────────────────

function makeRenderer({ quiet = false } = {}) {
  return function renderEvent(ev) {
    if (quiet && ev.type !== 'say' && ev.type !== 'error') return;
    if (ev.type === 'say') {
      console.log(`\n${c.bold('Buddy')}: ${ev.text}\n`);
    } else if (ev.type === 'tool') {
      console.log(renderToolCall(ev));
      console.log(renderObservation(ev.observation));
    } else if (ev.type === 'error') {
      console.log(`  ${c.red('!')} ${ev.text}`);
    } else if (ev.type === 'compaction') {
      console.log(c.gray(`  ↺ context compacted (${ev.dropped} messages summarized)`));
    }
  };
}

/** Collect tool events of a turn for /learn. */
function collectEvents(sink) {
  return (ev) => {
    sink.push(ev);
  };
}

// ── Headless one-shot ────────────────────────────────────────────────────────

export async function runOneShot({ router, root = process.cwd(), task, safe = false, yolo = false, quiet = false, config = {} } = {}) {
  const events = [];
  const render = makeRenderer({ quiet });
  const { chat } = createBuddySession({
    root,
    router,
    yolo,
    approval: defaultApproval({ safe }),
    charBudget: config.chat?.charBudget,
    onEvent: (ev) => {
      events.push(ev);
      render(ev);
    },
  });
  const out = await chat.turn(task);
  // Fire-and-forget style reflection for scripted one-shots is skipped here —
  // callers decide (CI keeps transcripts; interactive users use /learn).
  return { ...out, events };
}

// ── Interactive REPL ─────────────────────────────────────────────────────────

export async function startRepl({ router, root = process.cwd(), config = {} } = {}) {
  if (!process.stdin.isTTY) {
    console.error('buddy: interactive mode needs a TTY. Use one-shot mode instead:  buddy -p "task"');
    return 2;
  }

  ensureHarness(root);
  console.log(banner(VERSION));
  console.log(c.dim(`  workspace: ${root}`));
  console.log(c.dim(`  harness:   ${path.join(root, HARNESS_DIR)}  (edit it to shape Buddy)\n`));

  let yolo = false;
  let events = [];
  let lastTask = null;
  let busy = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('buddy❯ ') });
  const render = makeRenderer();

  const { chat, tools } = createBuddySession({
    root,
    router,
    approval: async ({ tool, summary }) => {
      if (yolo) return 'yes';
      return new Promise((resolve) => {
        rl.question(`  ${c.yellow('approve')} ${summary}\n  ${c.dim('[y] yes · [n] no · [a] always (' + tool + ')')} > `, (ans) => {
          const a = String(ans).trim().toLowerCase();
          resolve(a.startsWith('a') ? 'always' : a.startsWith('n') ? 'no' : 'yes');
        });
      });
    },
    onEvent: (ev) => {
      events.push(ev);
      render(ev);
    },
  });

  const recorder = new SessionRecorder(root, 'repl');
  const say = (s) => console.log(s);

  async function handleSlash({ name, args }) {
    switch (name) {
      case 'help':
        say(
          [
            `\n${c.bold('Buddy Code commands')}`,
            `  <task>          give Buddy a coding task ("add input validation to X")`,
            `  /learn          reflect on the last task → experience + optional harness edit (Harness²)`,
            `  /memory         show project memory file (edit it to teach Buddy the project)`,
            `  /experience     show lessons learned so far`,
            `  /tools          list Buddy's tools`,
            `  /yolo           toggle auto-approval of edits/commands (careful)`,
            `  /status         session stats (steps, context size, compactions)`,
            `  /new            fresh conversation (keeps memory + experience)`,
            `  /sessions       list saved transcripts`,
            `  /quit           leave`,
            ``,
            `Brain: keyless failover chain — ${router.order.join(' → ')}. $0/month, no API keys.\n`,
          ].join('\n')
        );
        break;
      case 'tools':
        say(`\n${tools.map((t) => `  ${c.bold(t.name)}${t.risky ? c.yellow(' (approved)') : ''} — ${t.description}`).join('\n')}\n`);
        break;
      case 'memory': {
        const memPath = path.join(root, HARNESS_DIR, 'MEMORY.md');
        say(`\n${c.bold('Project memory')}: ${memPath}`);
        try {
          say(c.dim(truncate(fs.readFileSync(memPath, 'utf8'), 1200) + '\n'));
        } catch {
          say(c.dim('(missing — run /new or edit the harness)\n'));
        }
        break;
      }
      case 'experience':
        try {
          say(`\n${c.bold('Experience')}: ${experiencePath(root)}\n${c.dim(truncate(fs.readFileSync(experiencePath(root), 'utf8'), 1600))}\n`);
        } catch {
          say('\n(no experience yet — run a task, then /learn)\n');
        }
        break;
      case 'yolo':
        yolo = !yolo;
        say(yolo ? c.yellow('\n  YOLO on — edits and commands run without asking. Watch it.\n') : '\n  YOLO off — approvals restored.\n');
        break;
      case 'status':
        say(
          `\n  messages: ${chat.messages.length} · history: ${(chat.historyChars() / 1000).toFixed(1)}k chars · compactions: ${chat.compactCount} · auto-approved: ${chat.alwaysApproved.join(', ') || '—'} · gateway: ${router.order[0]}\n`
        );
        break;
      case 'new':
        chat.messages.length = 0;
        lastTask = null;
        say('\n  (conversation reset — memory and experience persist)\n');
        break;
      case 'sessions': {
        const list = listSessions(root);
        say(`\n${list.length ? list.map((f, i) => `  ${i === 0 ? c.bold('latest') : '      '} ${path.basename(f)}`).join('\n') : '  (none yet)'}\n`);
        break;
      }
      case 'resume': {
        const list = listSessions(root);
        const pick = args ? list.find((f) => path.basename(f).includes(args)) : list[0];
        if (!pick) {
          say('\n  nothing to resume\n');
          break;
        }
        for (const m of resumeMessages(loadSession(pick))) chat.messages.push(m);
        say(`\n  resumed ${path.basename(pick)} (${chat.messages.length} messages)\n`);
        break;
      }
      case 'learn': {
        if (!lastTask) {
          say('\n  nothing learned yet this session — give Buddy a task first\n');
          break;
        }
        const s = spinner('reflecting (Harness² propose → validate → compose)');
        try {
          const out = await reflect({ router, root, task: lastTask.task, events: lastTask.events });
          s.stop();
          if (out.status === 'applied') say(`\n  ${c.green('harness updated')}: ${out.detail}`);
          else if (out.status === 'entry') say(`\n  ${c.green('lesson recorded')}: ${out.detail}`);
          else if (out.status === 'no_entry') say(`\n  ${c.gray('no_entry')} — ${out.detail}`);
          else if (out.status === 'keep_base') say(`\n  ${c.yellow('KEEP_BASE')} — ${out.detail}${out.proposalErrors?.length ? `\n    reasons: ${out.proposalErrors.join('; ')}` : ''}`);
          else say(`\n  ${c.gray('skipped')}: ${out.detail}`);
        } catch (e) {
          s.stop();
          say(`\n  ${c.red('reflection failed')}: ${e.message}\n`);
        }
        say('');
        break;
      }
      case 'quit':
      case 'exit':
        rl.close();
        return 0;
      case 'clear':
        console.log('\x1b[2J\x1b[H');
        break;
      default:
        say(`  unknown command /${name} — try /help`);
    }
    return null;
  }

  rl.prompt();
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (busy) {
      say('  (Buddy is still working — one task at a time)');
      rl.prompt();
      return;
    }
    const slash = parseSlash(input);
    if (slash) {
      busy = true;
      const res = await handleSlash(slash);
      busy = false;
      if (res !== null) {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    busy = true;
    events = [];
    lastTask = { task: input, events };
    recorder.append({ type: 'user', text: input });
    const spin = spinner('Buddy working');
    try {
      const out = await chat.turn(input);
      spin.stop();
      recorder.append({ type: 'say', text: out.said ?? '' });
      lastTask.events = events;
      debugLog(`turn done: steps=${out.steps} said=${out.said ? 'yes' : 'no'}`);
    } catch (e) {
      spin.stop();
      console.log(`  ${c.red('turn failed')}: ${truncate(e.message, 300)}`);
    }
    busy = false;
    rl.prompt();
  }).on('close', () => {
    console.log(c.dim('\n  bye — sessions and experience are kept in .buddy/\n'));
    process.exit(0);
  });

  return null;
}
