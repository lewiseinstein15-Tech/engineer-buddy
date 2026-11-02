// computer.js — OS-level computer use (v0.65): the desktop joins the browser
// as an actable surface. The browser tool drives a page; this one drives the
// SCREEN: native apps, OS dialogs, anything with pixels.
//
// Honest by construction: every action probes its backend first and names the
// exact missing piece (no display server, no xdotool, no screen-recording
// permission) instead of pretending. One tool, four actions:
//
//   {"action":"screenshot","path":"shots/screen.png"}   → .png inside the workspace
//   {"action":"click","x":800,"y":400}                  → left click (button: 1-5)
//   {"action":"type","text":"hello world"}              → unicode text
//   {"action":"key","keys":"ctrl+shift+t"}              → combos: mod+mod+key
//
// Backends per platform (first available wins):
//   macOS  — screencapture (images) · cliclick, else osascript System Events (input)
//   Linux  — import/scrot/gnome-screenshot (images) · xdotool (input)
//   Windows— PowerShell CopyFromScreen (images) · SendKeys/user32 (input)
//
// risky: true — moving the user's mouse IS acting on their machine, so every
// action rides the same approval gate as fs_write. The model is told to take
// a screenshot FIRST and act on what is actually on screen, never on memory.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { truncate } from '../util.js';

const pexecFile = promisify(execFile);
const TMO = 15000;

function sh(cmd, args, { timeoutMs = TMO } = {}) {
  return pexecFile(cmd, args, { timeout: timeoutMs, windowsHide: true })
    .then(({ stdout }) => String(stdout || ''))
    .catch((e) => { throw new Error(`${cmd}: ${truncate(String(e.stderr || e.message || e), 160)}`); });
}

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const hasDisplay = () =>
  isMac || isWin || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** macOS modifier words for `keystroke … using …`. Pure. */
const MAC_MODS = { ctrl: 'control', control: 'control', alt: 'option', option: 'option', cmd: 'command', command: 'command', super: 'command', meta: 'command', shift: 'shift' };

/** Parse "ctrl+shift+t" → { mods:['control','shift'], key:'t' }. Pure; null when junk. */
export function parseCombo(keys) {
  const parts = String(keys || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = [];
  for (const m of parts) {
    if (!MAC_MODS[m]) return null;
    mods.push(MAC_MODS[m]);
  }
  if (!/^([a-z0-9]|f([1-9]|1[0-9])|enter|return|tab|escape|esc|space|delete|backspace|up|down|left|right|home|end|pageup|pagedown)$/.test(key)) return null;
  return { mods, key };
}

/** Run one macOS input action via cliclick (preferred) or System Events. */
async function macInput(fn) {
  try {
    await sh('which', ['cliclick']);
    return await fn.cliclick();
  } catch {
    return await fn.osascript();
  }
}

/** Screenshot + input backends. Each returns/throws with the fix named. */
async function screenshotTo(abs) {
  if (isMac) {
    await sh('screencapture', ['-x', abs], { timeoutMs: 20000 });
  } else if (isWin) {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
      `$bmp.Save('${abs.replace(/'/g, "''")}')`,
    ].join('; ');
    await sh('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 30000 });
  } else {
    for (const [cmd, args] of [
      ['import', ['-window', 'root', abs]],
      ['scrot', ['-o', abs]],
      ['gnome-screenshot', ['-f', abs]],
    ]) {
      try { await sh(cmd, args); return; } catch { /* next backend */ }
    }
    throw new Error('no screenshot backend worked — install one: `sudo apt install scrot` (or imagemagick for import), or set DISPLAY');
  }
}

async function clickAt(x, y, button = 1) {
  if (isMac) {
    return macInput({
      cliclick: () => sh('cliclick', [`c:${x},${y}`]),
      osascript: () => sh('osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`]),
    });
  }
  if (isWin) {
    const ps = [
      'Add-Type -MemberDefinition "[DllImport(\'user32.dll\')] public static extern bool SetCursorPos(int x, int y); [DllImport(\'user32.dll\')] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);" -Name U -Namespace W',
      `[W.U]::SetCursorPos(${x}, ${y})`,
      `[W.U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W.U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`,
    ].join('; ');
    await sh('powershell', ['-NoProfile', '-Command', ps]);
    return;
  }
  await sh('xdotool', ['mousemove', String(x), String(y), 'click', String(button)]);
}

async function typeText(text) {
  if (isMac) {
    return macInput({
      cliclick: () => sh('cliclick', [`t:${text}`]),
      osascript: () => sh('osascript', ['-e', `tell application "System Events" to keystroke "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]),
    });
  }
  if (isWin) {
    const sendkeys = text.replace(/'/g, "''");
    await sh('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).SendKeys('${sendkeys}')`]);
    return;
  }
  await sh('xdotool', ['type', '--delay', '20', '--', String(text)]);
}

const MAC_SPECIAL = { enter: 'return', esc: 'escape', super: 'command', cmd: 'command', ctrl: 'control', control: 'control', alt: 'option', option: 'option' };

async function pressKeys(combo) {
  const { mods, key } = combo; // parsed + validated in run()
  if (isMac) {
    // osascript owns the keyboard: modifiers work, cliclick's kp: cannot.
    const macKey = MAC_SPECIAL[key] || key;
    const modTail = mods.length ? ` using ${mods.join(' & ')} down` : '';
    return sh('osascript', ['-e', `tell application "System Events" to keystroke "${macKey}"${modTail}`]);
  }
  if (isWin) {
    const w = { control: '^', ctrl: '^', alt: '%', shift: '+', cmd: '', super: '' };
    let seq = '';
    for (const m of mods) seq += w[m] ?? '';
    const winKey = { enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', space: ' ', backspace: '{BS}', delete: '{DEL}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}' }[key] ?? key.toUpperCase();
    await sh('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).SendKeys('${seq}${winKey.replace(/'/g, "''")}')`]);
    return;
  }
  await sh('xdotool', ['key', '--', [...mods.map((m) => (m === 'option' ? 'alt' : m === 'command' ? 'super' : m)), key].join('+')]);
}

export function buildComputerTool({ scope } = {}) {
  return {
    name: 'computer',
    description:
      'Drive the desktop OS itself: screenshot, click, type, key. For web pages prefer the browser tool; use this for native apps, OS dialogs and anything with pixels. ALWAYS take a screenshot first and act on what it shows, never on memory. Every action needs the operator to exist (a real display) — errors name the exact missing piece.',
    args: '{"action":"screenshot|click|type|key","path":"shots/screen.png","x":800,"y":400,"button":1,"text":"hello","keys":"ctrl+shift+t"}',
    risky: true,
    render: (a) => `computer ${a?.action || '?'} ${[a?.path, a?.x != null ? `${a.x},${a.y}` : '', a?.keys, a?.text].filter(Boolean).join(' ')}`.trim(),
    run: async (a = {}) => {
      const action = String(a?.action || '');
      if (!['screenshot', 'click', 'type', 'key'].includes(action)) {
        return `ERROR: unknown action "${truncate(action, 24)}" — known: screenshot, click, type, key`;
      }
      // Validate ARGS first (display-independent): junk input is junk even on
      // a machine with a screen, and containment must be enforced headless too.
      let abs = null, x = 0, y = 0, button = 1, combo = null;
      if (action === 'screenshot') {
        const rel = String(a?.path || 'screen.png');
        if (!/\.png$/i.test(rel)) return 'ERROR: screenshot path must end .png (saved inside the workspace)';
        try {
          abs = scope ? scope.resolveSafe(rel) : path.resolve(rel);
        } catch (e) {
          return `ERROR: ${truncate(String(e.message || e), 220)}`;
        }
      } else if (action === 'click') {
        x = Math.round(Number(a?.x)); y = Math.round(Number(a?.y));
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return 'ERROR: click needs integer x and y — take a screenshot first and read the coordinates off it';
        button = Math.min(5, Math.max(1, Math.round(Number(a?.button) || 1)));
      } else if (action === 'type') {
        if (!String(a?.text ?? '')) return 'ERROR: type needs text';
      } else if (action === 'key') {
        combo = parseCombo(a?.keys);
        if (!combo) return `ERROR: bad keys "${truncate(String(a?.keys || ''), 40)}" — use mod+key combos like ctrl+s, ctrl+shift+t, enter, cmd+c`;
      }
      if (!hasDisplay()) {
        return `ERROR: no display server — computer use needs a real desktop session (DISPLAY/WAYLAND_DISPLAY on Linux; on macOS/Windows check the terminal has screen + accessibility permissions). The browser tool works headless in the meantime.`;
      }
      try {
        if (action === 'screenshot') {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          await screenshotTo(abs);
          const kb = Math.max(1, Math.round(fs.statSync(abs).size / 1024));
          return `OK screenshot ${path.relative(scope ? scope.root : process.cwd(), abs) || abs} (${kb} KB) — desktop captured`;
        }
        if (action === 'click') {
          await clickAt(x, y, button);
          return `OK click ${x},${y}${button !== 1 ? ` (button ${button})` : ''}`;
        }
        if (action === 'type') {
          await typeText(String(a?.text));
          return `OK type ${truncate(JSON.stringify(String(a?.text)), 40)} — sent to the focused window`;
        }
        await pressKeys(combo);
        return `OK key ${a?.keys} — sent to the focused window`;
      } catch (e) {
        const hint = e.message?.includes('osascript') || e.message?.includes('System Events')
          ? ' (macOS: grant the terminal Accessibility + Screen Recording permissions in System Settings → Privacy & Security)'
          : e.message?.includes('xdotool')
            ? ' (Linux: install it — `sudo apt install xdotool`)'
            : '';
        return `ERROR: computer ${action} failed: ${truncate(String(e.message || e), 220)}${hint}`;
      }
    },
  };
}
