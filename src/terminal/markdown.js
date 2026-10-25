// markdown.js — markdown-lite renderer for Buddy's replies (zero-dependency).
// Keyless models answer in markdown, so the REPL renders it like Claude Code
// does: headings, bullets, inline code, bold, fenced code blocks, quotes.
//
// renderMarkdown(md, {color}) -> string with ANSI codes (or plain when NO_COLOR).

const CODE_TOKEN = '\u0000BUDDYCODE';

function inline(s, c) {
  let out = String(s ?? '');
  // protect inline code spans from other transforms
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, k) => {
    codes.push(k);
    return `${CODE_TOKEN}${codes.length - 1}${CODE_TOKEN}`;
  });
  // links: [text](url) -> text + dim url
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `${t}${c.dim(` (${u})`)}`);
  // bold / italic
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, p, t) => `${p}${c.italic(t)}`);
  // bare urls
  out = out.replace(/(^|[\s])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}${c.underline(u)}`);
  // restore code spans
  out = out.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, 'g'), (_, i) => c.cyan(codes[Number(i)] ?? ''));
  return out;
}

/**
 * Render markdown-ish text for the terminal.
 * Supported: fenced code blocks, # headings, -/* bullets, 1. lists,
 * > quotes, **bold**, *italic*, `code`, [text](url), bare URLs.
 */
export function renderMarkdown(md, { color = null, indent = '' } = {}) {
  const c = color || {
    dim: (x) => x,
    bold: (x) => x,
    italic: (x) => x,
    cyan: (x) => x,
    green: (x) => x,
    yellow: (x) => x,
    underline: (x) => x,
    gray: (x) => x,
  };
  const lines = String(md ?? '').split('\n');
  const out = [];
  let inCode = false;
  let codeLang = '';

  for (const raw of lines) {
    if (!inCode && /^\s*```/.test(raw)) {
      inCode = true;
      codeLang = raw.replace(/^\s*```/, '').trim();
      const label = codeLang ? `─ ${codeLang} ` : '';
      out.push(`${indent}${c.dim('  ┌' + label + '─'.repeat(Math.max(2, 26 - label.length)))}`);
      continue;
    }
    if (inCode) {
      if (/^\s*```/.test(raw)) {
        inCode = false;
        out.push(`${indent}${c.dim('  └' + '─'.repeat(26))}`);
      } else {
        out.push(`${indent}${c.gray(`  │ ${raw}`)}`);
      }
      continue;
    }
    if (!raw.trim()) {
      out.push('');
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = inline(h[2], c);
      out.push(`${indent}${level <= 2 ? c.bold(c.cyan(text)) : c.bold(text)}`);
      continue;
    }
    const bullet = raw.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${indent}${bullet[1]}${c.cyan('•')} ${inline(bullet[2], c)}`);
      continue;
    }
    const num = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (num) {
      out.push(`${indent}${num[1]}${c.bold(c.cyan(`${num[2]}.`))} ${inline(num[3], c)}`);
      continue;
    }
    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(`${indent}${c.gray(`  │ ${inline(quote[1], c)}`)}`);
      continue;
    }
    out.push(`${indent}${inline(raw, c)}`);
  }
  if (inCode) out.push(`${indent}${c.dim('  └' + '─'.repeat(26))}`);
  return out.join('\n');
}

/**
 * Very short plain-text summary of a markdown reply (for transcript exports
 * and session titles): first heading or first sentence, max ~80 chars.
 */
export function mdTitle(md) {
  const s = String(md ?? '').replace(/```[\s\S]*?```/g, ' ');
  const h = s.match(/^#{1,4}\s+(.+)$/m);
  const first = (h ? h[1] : s).trim().replace(/[*`>]/g, '');
  const line = first.split('\n').find((l) => l.trim()) || '(reply)';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
