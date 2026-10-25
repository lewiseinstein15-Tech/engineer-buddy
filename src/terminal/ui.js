// ui.js — zero-dependency terminal rendering for Buddy Code.
// Respects NO_COLOR and non-TTY output.
const useColor = process.env.NO_COLOR !== '1' && process.stdout.isTTY;

const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  cyan: wrap('36'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  magenta: wrap('35'),
  gray: wrap('90'),
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Simple interval spinner. stop() clears the line. */
export function spinner(text = 'thinking') {
  if (!process.stdout.isTTY) return { stop: () => {} };
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r${c.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${c.dim(text)}…  `);
  }, 90);
  return {
    stop() {
      clearInterval(t);
      process.stdout.write('\r\x1b[K');
    },
  };
}

export function banner(version) {
  return [
    '',
    c.bold(c.cyan('  Engineer Buddy')) + c.dim(` v${version} — Buddy Code`),
    c.dim('  keyless brain · $0/month · zero dependencies'),
    c.dim('  type a task, or /help for commands'),
    '',
  ].join('\n');
}

/** Render a tool call line: ⏺ bash npm test */
export function renderToolCall({ tool, args, denied }) {
  const dot = denied ? c.red('⏺') : c.cyan('⏺');
  return `${dot} ${c.bold(tool)}${denied ? c.red(' (denied)') : ''}`;
}

/** Render a capped observation excerpt. */
export function renderObservation(observation, { maxLines = 5, maxChars = 400 } = {}) {
  const s = String(observation ?? '').trim();
  if (!s) return c.gray('(no output)');
  const lines = s.split('\n');
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  let out = shown.map((l) => c.gray(`  │ ${l.slice(0, maxChars)}`)).join('\n');
  if (more > 0) out += c.gray(`  │ … +${more} more lines`);
  return out;
}

/** Uniform-diff style preview for file writes. */
export function renderFilePreview({ path, op, bytes }) {
  return `  ${c.green(op === 'create' ? '+' : '~')} ${c.bold(path)} ${c.gray(`(${op}, ${bytes ?? '?'} bytes)`)}`;
}

export const BASH_HELP = '  [y] allow once · [n] deny · [a] always allow this tool for this session';
