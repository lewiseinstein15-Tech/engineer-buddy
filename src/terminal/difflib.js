// difflib.js — minimal zero-dependency line diff (LCS) for edit previews.
// Claude Code shows you the diff BEFORE you approve an edit; this module is
// what makes that possible for fs_write / fs_replace / fs_append.

const MAX_SIDE = 300; // lines per side before we degrade to a summary form

function splitLines(s) {
  return String(s ?? '').split('\n');
}

/**
 * Line diff via common prefix/suffix trim + LCS DP on the middle.
 * @returns {Array<{t:' '|'-'|'+', s:string}>}
 */
export function diffLines(oldStr, newStr) {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const pre = a.slice(0, start).map((s) => ({ t: ' ', s }));
  const suf = a.slice(endA).map((s) => ({ t: ' ', s }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  // Degraded path: sides too big for O(n*m) DP — show a replace summary.
  if (midA.length > MAX_SIDE || midB.length > MAX_SIDE || midA.length * midB.length > 120000) {
    const ops = [];
    if (midA.length) ops.push({ t: '-', s: `… ${midA.length} removed lines …` });
    if (midB.length) ops.push({ t: '+', s: `… ${midB.length} added lines …` });
    return [...pre, ...ops, ...suf];
  }

  // LCS table.
  const n = midA.length;
  const m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ t: ' ', s: midA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: midA[i] });
      i++;
    } else {
      ops.push({ t: '+', s: midB[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', s: midA[i++] });
  while (j < m) ops.push({ t: '+', s: midB[j++] });

  return [...pre, ...ops, ...suf];
}

/**
 * Render a diff with colors. Context lines dim, additions green, deletions red.
 * Long diffs are capped with an omitted-lines marker.
 */
export function renderDiff(diff, { maxLines = 24, useColorFn = null, indent = '  ' } = {}) {
  const paint = useColorFn || ((t, s) => s);
  const lines = diff.map(({ t, s }) => {
    const body = `${t === ' ' ? ' ' : t} ${s}`;
    if (t === '+') return paint('green', body);
    if (t === '-') return paint('red', body);
    return paint('dim', body);
  });
  if (lines.length <= maxLines) return lines.map((l) => `${indent}│ ${l}`).join('\n');
  const hidden = lines.length - maxLines;
  return [...lines.slice(0, maxLines).map((l) => `${indent}│ ${l}`), paint('dim', `${indent}│ … +${hidden} more diff lines`)].join('\n');
}

/** Convenience: diff two strings and render. Never throws. */
export function renderTextDiff(oldStr, newStr, opts = {}) {
  try {
    return renderDiff(diffLines(oldStr, newStr), opts);
  } catch {
    return null;
  }
}

/** Summarise a diff: {added, removed, context} line counts. */
export function diffStats(diff) {
  const stats = { added: 0, removed: 0, context: 0 };
  for (const { t } of diff) {
    if (t === '+') stats.added++;
    else if (t === '-') stats.removed++;
    else stats.context++;
  }
  return stats;
}
