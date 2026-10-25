// diff.js — unified diff parser. Pure functions, no dependencies.
// Produces per-file structures the reviewer needs: added lines with their
// NEW-file line numbers (required to place GitHub inline comments), removals,
// rename/binary detection.

/**
 * Parse a unified diff (as returned by GitHub's
 * `Accept: application/vnd.github.v3.diff`) into structured files.
 *
 * @returns {Array<{
 *   path: string,
 *   oldPath: string|null,
 *   additions: number,
 *   deletions: number,
 *   binary: boolean,
 *   addedLines: Map<number, string>,  // new-file line number -> code
 *   removedLines: string[],            // code removed (no stable line numbers)
 *   hunkHeaders: string[]
 * }>}
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  if (!diffText || typeof diffText !== 'string') return files;

  const lines = diffText.split('\n');
  let cur = null;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = {
        path: m ? m[2] : line.replace('diff --git ', ''),
        oldPath: null,
        additions: 0,
        deletions: 0,
        binary: false,
        addedLines: new Map(),
        removedLines: [],
        hunkHeaders: [],
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        newLine = Number.parseInt(m[1], 10);
        cur.hunkHeaders.push(line);
      }
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.additions++;
      cur.addedLines.set(newLine, line.slice(1));
      newLine++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      cur.deletions++;
      cur.removedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('\\ No newline')) continue;
    // context line
    if (cur.hunkHeaders.length) newLine++;
  }
  return files;
}

/** Serialise parsed files back into a compact, LLM-friendly diff digest. */
export function renderDiffDigest(parsed, { maxPerFile = 8000, maxTotal = 80000 } = {}) {
  const parts = [];
  let total = 0;
  for (const f of parsed) {
    if (f.binary) {
      parts.push(`=== FILE: ${f.path} (binary) ===`);
      continue;
    }
    let body = [];
    for (const [ln, code] of f.addedLines) {
      body.push(`+${ln}: ${code}`);
    }
    for (const code of f.removedLines.slice(0, 400)) {
      body.push(`-: ${code}`);
    }
    let text = body.join('\n');
    if (text.length > maxPerFile) text = text.slice(0, maxPerFile) + `\n…[file truncated at ${maxPerFile} chars]`;
    if (total + text.length > maxTotal) {
      parts.push(`=== FILE: ${f.path} ===\n…[skipped: context budget exhausted]`);
      break;
    }
    total += text.length;
    parts.push(
      `=== FILE: ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ''} | +${f.additions}/-${f.deletions} ===\n${text}`
    );
  }
  return parts.join('\n\n');
}
