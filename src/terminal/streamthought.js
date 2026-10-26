// streamthought.js — live "streaming thought" extraction for the TUI (v0.28.0).
//
// Buddy's protocol is strict JSON: the brain answers {"tool":…} or
// {"tool":"say","message":"…"}. While that JSON streams in, the raw bytes
// are noise to a human — but a tolerant incremental parse can surface the
// GOOD parts as they arrive:
//   - the tool being called (the moment `"tool":"bash"` completes)
//   - the args being typed (the raw tail: `{"args":{"command":"npm te…`)
//   - the actual words of a say message, unescaped as they land
//
// Design: pure module (no TUI imports), rolling buffer, re-extract per
// push — deltas arrive at human speeds (10–100ms), a ≤16k regex is nothing.
// Malformed/partial JSON can never throw; the extractor just reports what
// it can see so far. The final reply still comes from the REAL parse in
// chat.js — this module is display-only and never feeds the loop.

const MAX_BUF = 16000;

/** Decode a (possibly incomplete) JSON string body: escapes → characters.
 *  A dangling `\` or `\u` with fewer than 4 hex digits at the END is dropped
 *  (the next push will complete it). Returns '' for garbage. */
export function decodeJsonStringPart(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break; // dangling backslash — wait for more
    if (next === 'n') { out += '\n'; i++; continue; }
    if (next === 't') { out += '\t'; i++; continue; }
    if (next === 'r') { out += '\r'; i++; continue; }
    if (next === 'b') { out += '\b'; i++; continue; }
    if (next === 'f') { out += '\f'; i++; continue; }
    if (next === '"') { out += '"'; i++; continue; }
    if (next === '\\') { out += '\\'; i++; continue; }
    if (next === '/') { out += '/'; i++; continue; }
    if (next === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete \u — more bytes complete it later
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    break; // unknown escape — stop decoding this part
  }
  return out;
}

/**
 * Create an extractor. push(fragment) folds one gateway delta in and returns
 * a snapshot { tool, message, messageClosed, raw } (null when nothing
 * interesting yet):
 *   tool          — last completed `"tool":"<name>"` seen, or null
 *   message       — decoded `"message"` body so far ('' while absent)
 *   messageClosed — true once the message string's closing quote arrived
 *   raw           — printable tail of the raw stream (for the args ticker)
 */
export function makeThoughtExtractor() {
  let buf = '';
  return {
    push(fragment) {
      const frag = String(fragment ?? '');
      if (frag) buf = (buf + frag).slice(-MAX_BUF);
      if (!buf) return null;
      const hasAnything = /["{}]/.test(buf);
      if (!hasAnything) return null;

      // Tool name: COMPLETE strings only (a name half-arrived is not a name).
      let tool = null;
      const toolRe = /"tool"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = toolRe.exec(buf)) !== null) {
        const decoded = decodeJsonStringPart(m[1]);
        if (decoded) tool = decoded;
      }

      // Message body: incomplete string allowed — that's the whole point.
      // Last occurrence wins (a repaired protocol turn may have two).
      let message = '';
      let messageClosed = false;
      const msgRe = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/g;
      let g;
      while ((g = msgRe.exec(buf)) !== null) {
        message = decodeJsonStringPart(g[1]);
        // Closed if the char right after the captured run is a real quote.
        const after = buf[g.index + g[0].length];
        messageClosed = after === '"';
      }

      // No signal yet (raw JSON prefix, nothing decodable) — stay quiet; the
      // repl only paints when there is something worth reading.
      if (!tool && !message) return null;

      return {
        tool,
        message,
        messageClosed,
        raw: buf.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(-64),
      };
    },
    reset() {
      buf = '';
    },
    /** Bytes streamed through this extractor since creation/reset. */
    get bytes() {
      return buf.length;
    },
  };
}

/** Single-line thought for the busy footer, width-capped. Pure formatter. */
export function formatThought(snap, cols = 80) {
  if (!snap) return null;
  const width = Math.max(20, (cols || 80) - 6);
  const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
  if (snap.message && snap.message.trim()) {
    const msg = clean(snap.message);
    const body = msg.length > width ? `…${msg.slice(-(width - 1))}` : msg;
    return `✻ ${body}`;
  }
  if (snap.tool) {
    const raw = clean(snap.raw);
    const args = raw.replace(new RegExp(`^\\s*\\{?\\s*"tool"\\s*:\\s*"${snap.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '').replace(/^[\s,:]*/, '');
    const body = `→ ${snap.tool}${args ? ` ${args}` : ''}`;
    return body.length > width ? `${body.slice(0, width - 1)}…` : body;
  }
  return null; // raw JSON prefix with no signal yet — stay quiet
}
