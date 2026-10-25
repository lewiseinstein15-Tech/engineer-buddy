// ui.js — zero-dependency terminal rendering for Buddy Code.
// Respects NO_COLOR and non-TTY output. All painters are pure except spinner.
const useColor = process.env.NO_COLOR !== '1' && process.stdout.isTTY;

const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  italic: wrap('3'),
  underline: wrap('4'),
  cyan: wrap('36'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  blue: wrap('34'),
  magenta: wrap('35'),
  gray: wrap('90'),
  inverse: wrap('7'),
};

/** The color set for markdown/diff renderers (safe fallbacks when off-TTY). */
export const PALETTE = useColor
  ? c
  : { dim: (x) => x, bold: (x) => x, italic: (x) => x, underline: (x) => x, cyan: (x) => x, green: (x) => x, yellow: (x) => x, red: (x) => x, blue: (x) => x, magenta: (x) => x, gray: (x) => x };

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Interval spinner with live label updates. stop() clears the line. */
export function spinner(text = 'thinking') {
  if (!process.stdout.isTTY) return { stop: () => {}, setText: () => {} };
  let i = 0;
  let label = text;
  const t = setInterval(() => {
    process.stdout.write(`\r${c.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${c.dim(label)}…  \x1b[K`);
  }, 90);
  return {
    setText(s) {
      label = String(s ?? text);
    },
    stop() {
      clearInterval(t);
      process.stdout.write('\r\x1b[K');
    },
  };
}

function visibleLen(s) {
  // strip ANSI for alignment
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Hard-cut a styled string to `max` visible columns, ANSI codes preserved.
function truncateVisible(s, max) {
  const str = String(s);
  if (visibleLen(str) <= max) return str;
  let out = '';
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\x1b') {
      const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (w >= max - 1) break;
    out += str[i];
    w++;
  }
  return out + '…';
}

/** Draw a rounded box around text rows, sized to the widest row.
 *  Width is capped to the terminal (minus indent + safety margin) so the
 *  borders can never wrap on narrow terminals — that wrap is what mangled
 *  the banner on <80-col terminals in v0.5.0. */
export function box(rows, { width = null, color = null, pad = 1, maxWidth = null } = {}) {
  const paint = color || ((x) => x);
  const termCap = Math.max(30, (process.stdout.columns || 80) - 4); // 2-space indent + 2-col margin
  const cap = Math.min(maxWidth ?? Infinity, termCap);
  const fitted = rows.map((r) => truncateVisible(r, Math.max(10, cap - pad * 2)));
  const inner = Math.max(width ?? 0, ...fitted.map((r) => visibleLen(r))) + pad * 2;
  const top = paint(`  ╭${'─'.repeat(inner)}╮`);
  const bot = paint(`  ╰${'─'.repeat(inner)}╯`);
  const mid = fitted.map((r) => paint(`  │${' '.repeat(pad)}${r}${' '.repeat(Math.max(0, inner - pad - visibleLen(r)))}│`));
  return [top, ...mid, bot].join('\n');
}

const BUDDY_ART = [
  '  ____             _   __  __      _ _       ',
  ' | __ )  ___   ___| | |  \\/  | __ | | | _____',
  ' |  _ \\ / _ \\ / __| | | |\\/| |/ _`| | |/ / _ \\',
  ' | |_) | (_) | (__| | | |  | | (_| | |   <  __/',
  ' |____/ \\___/ \\___|_| |_|  |_|\\__,_|_|_|\\_\\___|',
];

/** The big Claude-Code-style welcome panel shown when the REPL starts. */
export function logoBanner(version, { root, brain, harnessDir, sessions = 0, git = '' } = {}) {
  const rows = [
    `${c.bold(c.cyan('Buddy Code'))} ${c.dim(`v${version}`)}  ${c.dim('— keyless terminal engineer')}`,
    `${c.gray('$0/month · no API keys · zero dependencies')}`,
    '',
    `${c.dim('brain:')}     ${brain}`,
    `${c.dim('workspace:')} ${root}${git ? c.gray(` (${git})`) : ''}`,
    `${c.dim('harness:')}   ${harnessDir}${sessions ? c.gray(` · ${sessions} saved session${sessions === 1 ? '' : 's'}`) : ''}`,
    '',
    `${c.dim('type a task,')} ${c.bold('/help')} ${c.dim('for commands,')} ${c.bold('!')} ${c.dim('for shell,')} ${c.bold('#')} ${c.dim('to remember, Ctrl+C to interrupt')}`,
  ];
  return ['', ...BUDDY_ART.map((l) => c.cyan(l)), '', box(rows, { color: c.dim }), ''].join('\n');
}

/** Legacy banner (kept for compatibility) — now delegates to the panel style. */
export function banner(version) {
  return logoBanner(version, { root: '', brain: '', harnessDir: '' });
}

/** Render a tool call line: ⏺ bash npm test */
export function renderToolCall({ tool, args, denied, argText = '' }) {
  const dot = denied ? c.red('⏺') : c.cyan('⏺');
  let suffix = String(argText ?? '').trim();
  if (suffix.startsWith(String(tool))) suffix = suffix.slice(String(tool).length).trim(); // render() already repeats the name
  return `${dot} ${c.bold(tool)}${suffix ? c.gray(` ${truncatePlain(suffix, 110)}`) : ''}${denied ? c.red(' (denied)') : ''}`;
}

function truncatePlain(s, n) {
  const s2 = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s2.length <= n ? s2 : `${s2.slice(0, n - 1)}…`;
}

/** Render a capped observation excerpt. */
export function renderObservation(observation, { maxLines = 5, maxChars = 400 } = {}) {
  const s = String(observation ?? '').trim();
  if (!s) return c.gray('  ⎿ (no output)');
  const lines = s.split('\n');
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  let out = shown.map((l) => `${c.gray('  ⎿')} ${l.slice(0, maxChars)}`).join('\n');
  if (more > 0) out += c.gray(`  ⎿ … +${more} more lines`);
  return out;
}

/** Uniform-diff style preview for file writes. */
export function renderFilePreview({ path, op, bytes }) {
  return `  ${c.green(op === 'create' ? '+' : '~')} ${c.bold(path)} ${c.gray(`(${op}, ${bytes ?? '?'} bytes)`)}`;
}

/** Context budget bar — where the window actually goes (/context). */
export function renderContextBar({ parts, system, conversation, budget, turns, planMode, autoAt }, { indent = '  ' } = {}) {
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  const tok = (n) => `~${Math.round(n / 4 / 100) / 10}k tok`;
  const width = 26;
  const used = conversation;
  const frac = Math.max(0, Math.min(1, used / Math.max(budget, 1)));
  const filled = Math.round(frac * width);
  const barColor = frac > 0.8 ? c.red : frac > 0.6 ? c.yellow : c.green;
  const bar = barColor('█'.repeat(filled)) + c.gray('░'.repeat(width - filled));
  const rows = Object.entries(parts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => [name, `${k(n)} chars`, tok(n)]);
  return [
    '',
    `${indent}${c.bold('Context')} ${c.dim(`— ${turns} message${turns === 1 ? '' : 's'}${planMode ? ' · plan mode' : ''}`)}`,
    `${indent}${c.gray('conversation')} ${bar} ${c.bold(k(used))} / ${k(budget)} chars ${c.gray(`(${Math.round(frac * 100)}%) · est. ${tok(used)}`)}`,
    `${indent}${c.gray('system prompt (always loaded)')}`,
    renderTable(rows, { indent: indent + '  ' }),
    `${indent}${c.gray('system total')} ${c.bold(k(system))} chars ${c.gray(tok(system))} · ${c.gray('compaction keeps the last 4 messages and summarizes the rest')}`,
    ...(autoAt
      ? [`${indent}${c.gray(`auto-compact at ~${k(autoAt)} chars (80% of budget) — the loop summarizes BEFORE the wall, /compact forces it anytime`)}`]
      : []),
    '',
  ].join('\n');
}

/** Todo checklist — Claude Code's signature plan UI (v2: ids + blocked_by). */
export function renderTodo(items, { indent = '  ' } = {}) {
  const ICON = { done: c.green('✓'), in_progress: c.cyan('▸'), pending: c.gray('○') };
  return items
    .map((it) => {
      const status = ['pending', 'in_progress', 'done'].includes(it.status) ? it.status : 'pending';
      const text = status === 'done' ? c.gray(String(it.text)) : status === 'in_progress' ? c.bold(String(it.text)) : String(it.text);
      const id = it.id != null && String(it.id) !== '' ? c.gray(`#${it.id} `) : '';
      const blocked = it.blocked_by?.length ? c.gray(` · after #${[].concat(it.blocked_by).join(', #')}`) : '';
      return `${indent}${ICON[status]} ${id}${text}${blocked}`;
    })
    .join('\n');
}

/** Compact right-aligned table for /tools, /gateways, /sessions. */
export function renderTable(rows, { headers = null, indent = '  ' } = {}) {
  const all = headers ? [headers, ...rows] : rows;
  const cols = Math.max(...all.map((r) => r.length));
  const widths = [];
  for (let i = 0; i < cols; i++) widths[i] = Math.max(...all.map((r) => visibleLen(r[i] ?? '')));
  const fmt = (r) => r.map((cell, i) => String(cell ?? '').trimEnd() + ' '.repeat(Math.max(0, widths[i] - visibleLen(cell ?? '')))).join('  ');
  const out = [];
  if (headers) {
    out.push(`${indent}${c.bold(fmt(headers))}`);
    out.push(`${indent}${c.gray('─'.repeat(widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2))}`);
  }
  for (const r of (headers ? rows : all)) out.push(`${indent}${fmt(r)}`);
  return out.join('\n');
}

/** Render one chat tool event as a Claude-Code-style card. */
export function renderToolEvent(ev, { preview = true } = {}) {
  const parts = [];
  parts.push(renderToolCall({ tool: ev.tool, args: ev.args, denied: ev.denied, argText: ev.argText }));
  if (preview && ev.preview) parts.push(String(ev.preview));
  parts.push(renderObservation(ev.observation));
  return parts.join('\n');
}

/** Human ms: 850ms / 4.2s / 1m06s */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export const BASH_HELP = '  [y] allow once · [n] deny · [a] always allow this tool for this session · Ctrl+C deny';
