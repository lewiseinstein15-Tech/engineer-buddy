// termkeys.js — /terminal-setup (v0.33.0): the pure half.
//
// Shift+Enter cannot reach a CLI by itself: in legacy wire mode most
// terminals send the SAME byte (CR) for Enter and Shift+Enter, so the
// box cannot tell them apart. Every real terminal can be taught to send
// a distinct byte — the portable choice is LF (0x0A, what Ctrl+J sends),
// which this TUI already understands. Claude Code ships the same idea as
// its /terminal-setup.
//
// This module only DETECTS and INSTRUCTS (zero-dep, honest):
//   detectTerminal(env) → { id, name, matched }  — from TERM_PROGRAM/TERM
//   setupSteps(id)      → string[]               — exact per-terminal steps
//   NO_SETUP            → string[]               — fallbacks that work today
// Reconfiguring the user's terminal config files is deliberately NOT done
// from here — a CLI silently rewriting editor settings is how trust dies.

export const NO_SETUP = [
  'no setup needed — these work in every terminal right now:',
  '  ctrl+j        insert a newline (LF — what Shift+Enter will send)',
  '  alt+enter     insert a newline (most terminals)',
  '  \\ + enter     park the line and continue on the next (classic)',
];

const CATALOG = {
  iterm: {
    name: 'iTerm2',
    steps: [
      'iTerm2 → Settings → Profiles → Keys → Key Bindings → +',
      '  Shortcut: Shift-Enter   Action: "Send Hex Codes"   0a',
    ],
  },
  vscode: {
    name: 'VS Code integrated terminal',
    steps: [
      'Command Palette → "Preferences: Open Keyboard Shortcuts (JSON)" → add:',
      '  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",',
      '    "args": { "text": "\\u000a" }, "when": "terminalFocus" }',
    ],
  },
  kitty: {
    name: 'kitty',
    steps: [
      'kitty.conf → map shift+enter send_text all \\x0a',
    ],
  },
  ghostty: {
    name: 'Ghostty',
    steps: [
      'config file → keybind = shift+enter=text:\\x0a',
    ],
  },
  wezterm: {
    name: 'WezTerm',
    steps: [
      'wezterm.lua → keys: { key = "Enter", mods = "SHIFT", action =',
      '  wezterm.action.SendString("\\x0a") }',
    ],
  },
  alacritty: {
    name: 'Alacritty',
    steps: [
      'alacritty.toml → keybindings:',
      '  { key = "Enter", mods = "Shift", chars = "\\u000a" }',
    ],
  },
  foot: {
    name: 'foot',
    steps: [
      'foot.ini → [keybinds] shift+enter=text \\x0a  (or bind to SelfInsert with LF)',
    ],
  },
  generic: {
    name: 'your terminal',
    steps: [
      'any terminal with key remapping: bind Shift+Enter to send byte 0x0A (LF).',
      'That is the byte ctrl+j sends — Buddy treats them identically.',
    ],
  },
};

/** Detect the running terminal from env. Pure — pass a fake env in tests. */
export function detectTerminal(env = process.env) {
  const tp = String(env.TERM_PROGRAM || '');
  const term = String(env.TERM || '');
  if (/iTerm\.app/i.test(tp)) return { id: 'iterm', name: CATALOG.iterm.name, matched: 'TERM_PROGRAM=iTerm.app' };
  if (/vscode/i.test(tp)) return { id: 'vscode', name: CATALOG.vscode.name, matched: 'TERM_PROGRAM=vscode' };
  if (/ghostty/i.test(tp) || /ghostty/i.test(term)) return { id: 'ghostty', name: CATALOG.ghostty.name, matched: 'TERM/GHOSTTY' };
  if (/WezTerm/i.test(tp)) return { id: 'wezterm', name: CATALOG.wezterm.name, matched: 'TERM_PROGRAM=WezTerm' };
  if (/alacritty/i.test(term)) return { id: 'alacritty', name: CATALOG.alacritty.name, matched: 'TERM=alacritty' };
  if (/xterm-kitty|^kitty/.test(term)) return { id: 'kitty', name: CATALOG.kitty.name, matched: 'TERM=xterm-kitty' };
  if (/^foot/.test(term)) return { id: 'foot', name: CATALOG.foot.name, matched: 'TERM=foot' };
  if (/Apple_Terminal/i.test(tp)) return { id: 'generic', name: 'Apple Terminal', matched: 'TERM_PROGRAM=Apple_Terminal' };
  if (/tmux/.test(term)) return { id: 'generic', name: 'tmux (configure the outer terminal)', matched: 'TERM=*tmux*' };
  return { id: 'generic', name: CATALOG.generic.name, matched: 'TERM_PROGRAM/TERM unmatched' };
}

/** Exact setup steps for a detected terminal id. Pure. */
export function setupSteps(id) {
  const c = CATALOG[id] || CATALOG.generic;
  return c.steps.slice();
}
