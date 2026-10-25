// repl.js — Buddy Code terminal interface (v0.4 — the Claude Code experience).
//
// Interactive: `buddy` opens a session; you type tasks, Buddy plans (todo),
// explores/edits/runs with diff-preview approval gates, you talk back.
// Extras that make it feel like Claude Code, with zero dependencies:
//   Ctrl+C interrupt (kills the running turn AND the running command)
//   `!cmd`           run a shell command yourself (your fingers, your rules)
//   `#note`          remember something in the project harness memory
//   tab completion   slash commands
//   \ continuation   multi-line tasks
//   /compact /cost /model /gateways /permissions /review /export …
// Headless: `buddy -p "task"` runs one turn autonomously (CI-style).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { createChat } from '../agent/chat.js';
import { LocalScope, buildLocalTools, runBash } from '../tools/local.js';
import { ensureHarness, loadHarness, harnessContext } from '../harness/scaffold.js';
import { HARNESS_DIR } from '../harness/defaults.js';
import { SessionRecorder, listSessions, loadSession, sessionInfo, resumeMessages, writeExport } from '../session.js';
import { reflect, recentLessons, experiencePath } from '../learn.js';
import { c, PALETTE, logoBanner, spinner, renderToolCall, renderToolEvent, renderTodo, renderTable, formatMs } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { truncate, debugLog } from '../util.js';

export const VERSION = '0.4.0';

// ── Slash commands (pure, testable) ──────────────────────────────────────────

export const SLASH_COMMANDS = [
  'help', 'new', 'clear', 'screen', 'compact', 'model', 'gateways', 'cost',
  'permissions', 'todo', 'tools', 'memory', 'experience', 'learn', 'review',
  'init', 'export', 'sessions', 'resume', 'status', 'yolo', 'quit', 'exit',
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
  const todoState = { latest: null };
  const tools = buildLocalTools({ scope, todoState });
  return { scope, tools, todoState };
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
  const { tools, todoState } = makeScopeAndTools(root);
  const harness = makeHarness(root);
  const session = createChat({ router, tools, harness, charBudget, approval, onEvent });
  if (resumeFrom) {
    for (const m of resumeMessages(loadSession(resumeFrom))) session.messages.push(m);
  }
  return { chat: session, tools, todoState };
}

function defaultApproval(busy) {
  // Headless/one-shot policy: autonomous on risky tools (they are still
  // hard-blocked by policy), unless --safe.
  return busy.safe ? () => 'no' : () => 'yes';
}

// ── Event rendering (shared by REPL and one-shot) ────────────────────────────

function makeRenderer({ quiet = false, toolByName = new Map() } = {}) {
  return function renderEvent(ev) {
    if (quiet && ev.type !== 'say' && ev.type !== 'error') return;
    if (ev.type === 'say') {
      console.log(`\n${c.bold(c.cyan('●'))} ${c.bold('Buddy')}`);
      console.log(renderMarkdown(ev.text, { color: PALETTE }));
      console.log('');
    } else if (ev.type === 'tool') {
      if (ev.tool === 'todo' && Array.isArray(ev.args?.items)) {
        console.log(renderToolCall({ tool: 'todo', denied: ev.denied, argText: `${ev.args.items.length} items` }));
        console.log(renderTodo(ev.args.items));
        return;
      }
      console.log(renderToolEvent(ev, { preview: !quiet }));
    } else if (ev.type === 'error') {
      console.log(`  ${c.red('!')} ${ev.text}`);
    } else if (ev.type === 'interrupted') {
      console.log(`\n  ${c.yellow('⏸')} interrupted — nothing lost, say "continue" to resume\n`);
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

// ── Memory notes (# prefix) ──────────────────────────────────────────────────

export function appendMemoryNote(root, note) {
  const p = path.join(root, HARNESS_DIR, 'MEMORY.md');
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- (${stamp}) ${note}`;
  let cur = '';
  try {
    cur = fs.readFileSync(p, 'utf8');
  } catch {
    /* new memory file */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!cur.trim()) {
    fs.writeFileSync(p, `# Memory — durable notes about this project (always loaded)\n\n## Notes\n${line}\n`, 'utf8');
    return p;
  }
  if (/^##\s*Notes\b/m.test(cur)) {
    const lines = cur.split('\n');
    const idx = lines.findIndex((l) => /^##\s*Notes\b/.test(l));
    let end = idx + 1;
    while (end < lines.length && !/^##\s/.test(lines[end])) end++;
    lines.splice(end, 0, line);
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
  } else {
    fs.writeFileSync(p, cur.replace(/\n*$/, '\n\n') + `## Notes\n${line}\n`, 'utf8');
  }
  return p;
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
  return { ...out, events };
}

// ── Interactive REPL ─────────────────────────────────────────────────────────

export async function startRepl({ router, root = process.cwd(), config = {}, yolo: yoloFlag = false } = {}) {
  if (!process.stdin.isTTY) {
    console.error('buddy: interactive mode needs a TTY. Use one-shot mode instead:  buddy -p "task"');
    return 2;
  }

  ensureHarness(root);

  // Banner extras (git branch, session count) — best effort, never blocks.
  let git = '';
  try {
    const r = await Promise.race([
      runBash('git branch --show-current', { cwd: root, timeoutMs: 3000 }),
      new Promise((res) => setTimeout(() => res(null), 2500)),
    ]);
    if (r?.stdout?.trim()) git = r.stdout.trim();
  } catch {
    /* no git, no problem */
  }
  const sessionCount = listSessions(root).length;
  console.log(
    logoBanner(VERSION, {
      root,
      brain: router.order.join(' → '),
      harnessDir: path.join(root, HARNESS_DIR),
      sessions: sessionCount,
      git,
    })
  );

  const initialOrder = [...router.order];
  let yolo = Boolean(yoloFlag);
  let events = [];
  let lastTask = null;
  let busy = false;
  let aborter = null;
  let approvalDeny = null;
  let qToken = 0;
  let lastSigintAt = 0;
  let pendingBuf = null; // multi-line input buffer (trailing "\")
  let recorder = null;
  let sessionFile = null;
  let lastGateway = null;
  let toolCallsThisTurn = 0;
  const turnStart = { at: 0 };

  const { chat, tools, todoState } = createBuddySession({
    root,
    router,
    approval: async ({ tool, summary, preview }) => {
      if (yolo) return 'yes';
      return new Promise((resolve) => {
        const token = ++qToken;
        console.log(`\n  ${c.yellow('⚠ approve')} ${c.bold(summary)}`);
        if (preview) console.log(preview);
        approvalDeny = () => {
          if (qToken !== token) return;
          qToken += 1;
          approvalDeny = null;
          resolve('no');
        };
        rl.question(`  ${c.dim(`[y] yes · [n] no · [a] always (${tool}) · Ctrl+C deny`)} > `, (ans) => {
          if (qToken !== token) return; // already resolved (e.g. Ctrl+C deny)
          qToken += 1;
          approvalDeny = null;
          const a = String(ans).trim().toLowerCase();
          resolve(a.startsWith('a') ? 'always' : a.startsWith('n') ? 'no' : 'yes');
        });
      });
    },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool') {
        toolCallsThisTurn += 1;
        spin.setText(`working · ${toolCallsThisTurn} tool call${toolCallsThisTurn === 1 ? '' : 's'}`);
        lastGateway = ev.gateway || lastGateway;
        try {
          recorder?.append({ type: 'tool', tool: ev.tool, args: { _preview: truncate(JSON.stringify(ev.args), 160) }, observation: truncate(ev.observation, 160), denied: ev.denied });
        } catch {
          /* transcript is best-effort */
        }
      }
      render(ev);
    },
  });

  const render = makeRenderer({ toolByName: new Map(tools.map((t) => [t.name, t])) });

  const ensureRecorder = (firstMsg) => {
    if (!recorder) {
      recorder = new SessionRecorder(root, firstMsg);
      sessionFile = recorder.path;
    }
    return recorder;
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan('buddy❯ '),
    historySize: 400,
    completer: (line) => {
      if (line.startsWith('/')) {
        const hits = SLASH_COMMANDS.filter((n) => `/${n}`.startsWith(line)).map((n) => `/${n}`);
        return [hits, line];
      }
      return [[], line];
    },
  });

  const say = (s) => console.log(s);
  const spin = spinner('Buddy working');

  // ── Slash command handlers ────────────────────────────────────────────────

  async function handleSlash({ name, args }) {
    switch (name) {
      case 'help':
        say(
          [
            '',
            c.bold('Buddy Code') + c.dim(` v${VERSION} — commands`),
            '',
            `  ${c.bold('type a task')}      give Buddy work ("add input validation to X")`,
            `  ${c.bold('\\ at line end')}   continue on the next line (multi-line tasks)`,
            `  ${c.bold('!cmd')}            run a shell command yourself (trusted, no gate)`,
            `  ${c.bold('#note')}           remember a note in project memory (${HARNESS_DIR}/MEMORY.md)`,
            `  ${c.bold('Ctrl+C')}          interrupt the running task · twice to quit`,
            '',
            `  ${c.bold(c.cyan('Session'))}`,
            ...[
              ['/new', 'fresh conversation (memory + experience persist)'],
              ['/sessions', 'list saved transcripts'],
              ['/resume <n|prefix>', 'resume a saved session'],
              ['/export', 'write the transcript to .buddy/exports/ as markdown'],
              ['/status', 'session stats'],
              ['/quit', 'leave'],
            ].map(([k, d]) => `    ${c.bold(k.padEnd(20))} ${c.dim(d)}`),
            `  ${c.bold(c.cyan('Brain & context'))}`,
            ...[
              ['/compact', 'summarize old context now to free space'],
              ['/cost', 'usage: brain calls, est. tokens, $0.00'],
              ['/model <name>', 'pin a gateway first (e.g. /model kilo) · /model auto restores'],
              ['/gateways', 'health-probe the keyless chain'],
            ].map(([k, d]) => `    ${c.bold(k.padEnd(20))} ${c.dim(d)}`),
            `  ${c.bold(c.cyan('Harness (Harness²)'))}`,
            ...[
              ['/init', 'scaffold .buddy/harness/'],
              ['/memory', 'show project memory (edit it to teach Buddy)'],
              ['/experience', 'lessons from past tasks'],
              ['/learn', 'reflect on the last task → harness refinement'],
              ['/todo', "show Buddy's current plan"],
            ].map(([k, d]) => `    ${c.bold(k.padEnd(20))} ${c.dim(d)}`),
            `  ${c.bold(c.cyan('Safety & tools'))}`,
            ...[
              ['/tools', "list Buddy's tools"],
              ['/permissions', 'show session approvals · /permissions reset'],
              ['/review [staged]', 'Buddy reviews your uncommitted diff'],
              ['/yolo', 'toggle auto-approval (careful)'],
            ].map(([k, d]) => `    ${c.bold(k.padEnd(20))} ${c.dim(d)}`),
            '',
            c.gray(`  Brain: keyless failover chain — ${router.order.join(' → ')}. $0/month, no API keys.`),
            '',
          ].join('\n')
        );
        break;
      case 'screen':
      case 'cls':
        console.log('\x1b[2J\x1b[H');
        break;
      case 'clear':
        chat.messages.length = 0;
        lastTask = null;
        console.log('\x1b[2J\x1b[H');
        say(c.dim('  conversation cleared — memory and experience persist\n'));
        break;
      case 'new':
        chat.messages.length = 0;
        lastTask = null;
        todoState.latest = null;
        say('\n  (conversation reset — memory and experience persist)\n');
        break;
      case 'compact': {
        const s = spinner('compacting context');
        try {
          const r = await chat.compactNow();
          s.stop();
          say(r.compacted ? `\n  ↺ compacted — ${r.messages} messages remain (summary + recent tail)\n` : '\n  nothing to compact yet — history is short\n');
        } catch (e) {
          s.stop();
          say(`\n  ${c.red('compact failed')}: ${truncate(e.message, 200)}\n`);
        }
        break;
      }
      case 'cost': {
        const u = chat.usage();
        const estK = ((u.charsIn + u.charsOut) / 4 / 1000).toFixed(1);
        say(
          [
            '',
            `  ${c.bold('spend')}        $0.00 ${c.gray('(keyless — the whole point)')}`,
            `  ${c.bold('brain calls')}  ${u.calls}`,
            `  ${c.bold('est. tokens')}  ~${estK}k ${c.gray('(chars ÷ 4, rough)')}`,
            ...Object.entries(u.byGateway).map(([g, v]) => `    ${c.dim(g.padEnd(14))} ${v.calls} calls · ~${(v.charsOut / 4 / 1000).toFixed(1)}k tok out`),
            '',
          ].join('\n')
        );
        break;
      }
      case 'model': {
        if (!args) {
          say(`\n  brain chain: ${router.order.map((n, i) => (i === 0 ? c.bold(n) : c.dim(n))).join(' → ')}\n  pin one: ${c.bold('/model <name>')} · restore: ${c.bold('/model auto')}\n`);
          break;
        }
        if (args === 'auto' || args === 'reset') {
          router.order = [...initialOrder];
          say(`\n  order restored: ${router.order.join(' → ')}\n`);
        } else if (router.gateways.has(args)) {
          router.order = [args, ...initialOrder.filter((n) => n !== args)];
          say(`\n  ${c.green('pinned')} ${c.bold(args)} first — chain: ${router.order.join(' → ')}\n`);
        } else {
          say(`\n  unknown gateway "${args}" — available: ${[...router.gateways.keys()].join(', ')}\n`);
        }
        break;
      }
      case 'gateways': {
        const s = spinner('probing gateways (parallel)');
        const rows = await Promise.all(
          router.order.map(async (name) => {
            const gw = router.gateways.get(name);
            const t0 = Date.now();
            try {
              const out = await Promise.race([
                gw.chat([{ role: 'user', content: 'Reply with exactly: BUDDY_OK' }], { maxTokens: 20 }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
              ]);
              const ok = String(out.text || '').toUpperCase().includes('BUDDY_OK');
              return [ok ? c.green('✓') : c.yellow('?'), name, `${formatMs(Date.now() - t0)}`, `${out.model || '-'} ${ok ? 'round-trip OK' : 'unexpected reply'}`];
            } catch (e) {
              return [c.red('✗'), name, formatMs(Date.now() - t0), truncate(e.message, 48)];
            }
          })
        );
        s.stop();
        say(`\n${renderTable(rows, { headers: ['alive', 'gateway', 'time', 'model / note'] })}\n`);
        break;
      }
      case 'tools':
        say(
          `\n${renderTable(
            tools.map((t) => [c.bold(t.name), t.risky ? c.yellow('gate') : c.green('safe'), t.description]),
            { headers: ['tool', 'gate', 'what it does'] }
          )}\n`
        );
        break;
      case 'permissions':
        if (args === 'reset') {
          chat.resetApprovals();
          say('\n  approvals reset — every risky tool asks again\n');
        } else {
          say(`\n  always-approved: ${chat.alwaysApproved.join(', ') || c.dim('—')} · yolo: ${yolo ? c.yellow('ON') : 'off'}\n  ${c.dim('reset: /permissions reset')}\n`);
        }
        break;
      case 'todo':
        say(todoState.latest ? `\n${renderTodo(todoState.latest)}\n` : '\n  (no plan yet — Buddy builds one with the todo tool when a task has steps)\n');
        break;
      case 'memory': {
        const memPath = path.join(root, HARNESS_DIR, 'MEMORY.md');
        say(`\n${c.bold('Project memory')}: ${memPath}`);
        try {
          say(c.dim(truncate(fs.readFileSync(memPath, 'utf8'), 1200) + '\n'));
        } catch {
          say(c.dim('(missing — run /new or edit the harness)\n'));
        }
        say(c.gray('  tip: type #<note> any time to add a memory note\n'));
        break;
      }
      case 'experience':
        try {
          say(`\n${c.bold('Experience')}: ${experiencePath(root)}\n${c.dim(truncate(fs.readFileSync(experiencePath(root), 'utf8'), 1600))}\n`);
        } catch {
          say('\n(no experience yet — run a task, then /learn)\n');
        }
        break;
      case 'init': {
        const created = ensureHarness(root);
        say(created.length ? `\n  ${c.green('harness scaffolded')}:\n${created.map((f) => `    + ${f}`).join('\n')}\n` : '\n  harness already present — nothing to do\n');
        break;
      }
      case 'review': {
        const staged = args === 'staged' || args === '--staged';
        const r = await runBash(staged ? 'git diff --cached' : 'git diff HEAD', { cwd: root, timeoutMs: 30000 });
        if (!r.ok) {
          say(`\n  ${c.red('git failed')}: ${truncate(r.stderr || r.stdout, 240)}\n`);
          break;
        }
        const diffText = (r.stdout || '').trim();
        if (!diffText) {
          say(`\n  ${staged ? 'nothing staged' : 'working tree clean'} — nothing to review\n`);
          break;
        }
        const s = spinner('reviewing your diff');
        try {
          const out = await router.chat(
            [
              {
                role: 'user',
                content:
                  'Review this uncommitted diff like a careful senior engineer. Reply in markdown: bugs, security issues, missing tests, risky patterns — concrete and tied to the code. If it is clean, say LGTM and why. Keep it under 250 words.\n\n' +
                  `DIFF:\n\`\`\`diff\n${truncate(diffText, 30000)}\n\`\`\``,
              },
            ],
            { maxTokens: 1200 }
          );
          s.stop();
          console.log(`\n${c.bold(c.cyan('●'))} ${c.bold('Review')}`);
          console.log(renderMarkdown(out.text, { color: PALETTE }));
          console.log('');
          lastGateway = out.gateway || lastGateway;
        } catch (e) {
          s.stop();
          say(`\n  ${c.red('review failed')}: ${truncate(e.message, 240)}\n`);
        }
        break;
      }
      case 'export': {
        if (!sessionFile) {
          say('\n  no session to export yet — give Buddy a task first\n');
          break;
        }
        try {
          const out = writeExport(root, sessionFile, { workspace: root });
          say(`\n  ${c.green('exported')} → ${out}\n`);
        } catch (e) {
          say(`\n  ${c.red('export failed')}: ${truncate(e.message, 200)}\n`);
        }
        break;
      }
      case 'sessions': {
        const list = listSessions(root);
        if (!list.length) {
          say('\n  (none yet — sessions save automatically as you work)\n');
          break;
        }
        const rows = list.slice(0, 12).map((f, i) => {
          const info = sessionInfo(f);
          return [i === 0 ? c.bold('0') : String(i), truncate(info.firstUser, 44), `${info.turns}`, (info.mtime || '').slice(0, 16).replace('T', ' ')];
        });
        say(`\n${renderTable(rows, { headers: ['#', 'first task', 'turns', 'saved'] })}\n${c.dim('  resume: /resume <n> or /resume <name-prefix>')}\n`);
        break;
      }
      case 'resume': {
        const list = listSessions(root);
        let pick = null;
        if (/^\d+$/.test(args)) pick = list[Number(args)] || null;
        else if (args) pick = list.find((f) => path.basename(f).includes(args)) || null;
        else pick = list[0] || null;
        if (!pick) {
          say('\n  nothing matched — try /sessions\n');
          break;
        }
        for (const m of resumeMessages(loadSession(pick))) chat.messages.push(m);
        sessionFile = pick;
        const info = sessionInfo(pick);
        say(`\n  ${c.green('resumed')} ${path.basename(pick)} ${c.dim(`(${info.turns} turns, ${chat.messages.length} messages)`)}\n`);
        break;
      }
      case 'yolo':
        yolo = !yolo;
        say(yolo ? c.yellow('\n  YOLO on — edits and commands run without asking. Watch it.\n') : '\n  YOLO off — approvals restored.\n');
        break;
      case 'status':
        say(
          [
            '',
            `  ${c.bold('Buddy Code')} ${c.dim(`v${VERSION}`)} · root: ${root}`,
            `  messages: ${chat.messages.length} · history: ${(chat.historyChars() / 1000).toFixed(1)}k chars · compactions: ${chat.compactCount}`,
            `  approvals: ${chat.alwaysApproved.join(', ') || '—'} · yolo: ${yolo ? c.yellow('ON') : 'off'}`,
            `  chain: ${router.order.join(' → ')}${lastGateway ? c.gray(` (last: ${lastGateway})`) : ''}`,
            sessionFile ? `  session: ${path.basename(sessionFile)}` : `  session: ${c.dim('(starts on first task)')}`,
            '',
          ].join('\n')
        );
        break;
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
      default:
        say(`  unknown command /${name} — try /help`);
    }
    return null;
  }

  // ── Ctrl+C routing: deny approval → interrupt turn → double-tap exit ─────
  rl.on('SIGINT', () => {
    if (approvalDeny) {
      approvalDeny();
      console.log(c.dim('\n  denied (Ctrl+C)'));
      rl.prompt(true);
      return;
    }
    if (busy && aborter) {
      aborter.abort();
      return; // the interrupted event renders when the loop unwinds
    }
    if (pendingBuf !== null) {
      pendingBuf = null;
      rl.setPrompt(c.cyan('buddy❯ '));
      console.log(c.dim('\n  (multi-line input cleared)'));
      rl.prompt(true);
      return;
    }
    if (Date.now() - lastSigintAt < 2000) {
      rl.close();
      return;
    }
    lastSigintAt = Date.now();
    console.log(c.dim('\n  (Ctrl+C again to quit — one more tap or /quit)'));
    rl.prompt(true);
  });

  // ── Input pipeline ─────────────────────────────────────────────────────────
  rl.prompt();
  rl.on('line', async (line) => {
    // Multi-line continuation: trailing "\" parks the line.
    if (pendingBuf !== null) {
      const cont = line.endsWith('\\') ? line.slice(0, -1) : line;
      pendingBuf.push(cont);
      if (line.endsWith('\\')) {
        rl.prompt();
        return;
      }
      const combined = pendingBuf.join('\n').trim();
      pendingBuf = null;
      rl.setPrompt(c.cyan('buddy❯ '));
      if (combined) await dispatch(combined);
      else rl.prompt();
      return;
    }

    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.endsWith('\\') && input.length > 1) {
      pendingBuf = [input.slice(0, -1)];
      rl.setPrompt(c.dim('·······❯ '));
      rl.prompt();
      return;
    }
    await dispatch(input);
  }).on('close', () => {
    console.log(c.dim('\n  bye — sessions and experience are kept in .buddy/\n'));
    process.exit(0);
  });

  async function dispatch(input) {
    // `!` — the user's own shell passthrough (trusted: no gate, full policy bypass)
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) {
        say('  usage: !<command> — runs a shell command yourself (no approval, policy bypassed)');
        rl.prompt();
        return;
      }
      busy = true;
      const r = await runBash(cmd, { cwd: root, trusted: true, timeoutMs: 600000, maxOutputChars: 20000 });
      if (r.stdout?.trim()) console.log(r.stdout.trimEnd());
      if (r.stderr?.trim()) console.log(c.yellow(r.stderr.trimEnd()));
      if (r.interrupted) console.log(c.yellow('  ⏸ interrupted'));
      else if (!r.ok) console.log(c.gray(`  exit ${r.code}${r.blocked ? ` (${r.stderr || 'blocked'})` : ''}`));
      ensureRecorder(input).append({ type: 'shell', command: cmd, code: r.code });
      busy = false;
      rl.prompt();
      return;
    }

    // `#` — remember a note in project memory
    if (input.startsWith('#')) {
      const note = input.slice(1).trim();
      if (!note) {
        say('  usage: #<note> — e.g.  # always run pnpm test, not npm test');
        rl.prompt();
        return;
      }
      try {
        const p = appendMemoryNote(root, note);
        say(`  ${c.green('✓ remembered')} → ${c.dim(p)}${c.gray(' (takes effect on the next turn or /new)')}`);
      } catch (e) {
        say(`  ${c.red('could not save note')}: ${e.message}`);
      }
      rl.prompt();
      return;
    }

    const slash = parseSlash(input);
    if (slash) {
      if (busy) {
        say('  (Buddy is still working — Ctrl+C to interrupt first)');
        rl.prompt();
        return;
      }
      busy = true;
      try {
        const res = await handleSlash(slash);
        if (res !== null) {
          rl.close();
          return;
        }
      } catch (e) {
        say(`  ${c.red('command failed')}: ${truncate(e.message, 240)}`);
      }
      busy = false;
      rl.prompt();
      return;
    }

    // A real task for Buddy.
    if (busy) {
      say('  (Buddy is still working — one task at a time, Ctrl+C to interrupt)');
      rl.prompt();
      return;
    }
    busy = true;
    events = [];
    toolCallsThisTurn = 0;
    lastTask = { task: input, events };
    turnStart.at = Date.now();
    aborter = new AbortController();
    ensureRecorder(input).append({ type: 'user', text: input });
    spin.setText('Buddy working');
    try {
      const out = await chat.turn(input, { signal: aborter.signal });
      spin.stop();
      recorder.append({ type: 'say', text: out.said ?? '' });
      lastTask.events = events;
      // Claude-Code-style turn footer.
      const secs = (Date.now() - turnStart.at) / 1000;
      const ctxK = (chat.historyChars() / 1000).toFixed(1);
      const gw = lastGateway || router.order[0];
      console.log(c.gray(`  ⏱ ${secs.toFixed(1)}s · ${toolCallsThisTurn} tool call${toolCallsThisTurn === 1 ? '' : 's'} · ${ctxK}k ctx${out.steps ? c.gray(` · ${out.steps} steps`) : ''}${gw ? c.gray(` · ${gw}`) : ''}`));
      debugLog(`turn done: steps=${out.steps} said=${out.said ? 'yes' : 'no'}`);
    } catch (e) {
      spin.stop();
      console.log(`  ${c.red('turn failed')}: ${truncate(e.message, 300)}`);
    }
    aborter = null;
    busy = false;
    rl.prompt();
  }

  return null;
}
