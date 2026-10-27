// commitmsg.js — deterministic commit-message drafting (v0.36.0, checklist
// §9 "generated commit messages from the diff" + the co-authored-by trailer).
//
// The model writes good messages when it knows the WHY; the diff knows the
// WHAT. This module drafts the WHAT deterministically — conventional-commit
// type/scope/subject/body from the staged diff alone — so `commit
// {generate:true}` is never an empty stub and the model can send its own
// message whenever it has something better to say (an explicit message
// ALWAYS wins). Everything here is pure and offline: text in, text out.
//
// Signals used (strongest first):
//   git hunk headers  `@@ -12,7 +12,9 @@ function slugify` — git embeds the
//                     enclosing function/class for most languages; that is
//                     the best one-line "what changed" a diff carries.
//   file paths        test/, *.test.*, *.spec.* → test; *.md, docs/ → docs;
//                     lockfiles/manifests → chore(deps); new files → feat.
//   add/del ratio     mostly insertions + new files → feat/add; mostly
//                     deletions → refactor/remove; mixed in src → fix/update
//                     when a test file changed alongside (the classic
//                     fix+regression-test shape).

// ── classification tables ────────────────────────────────────────────────────

const LOCK_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;
const TEST_RE = /(^|\/)(tests?|__tests?__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;
const DOC_RE = /\.(md|mdx|rst|txt)$|(^|\/)(docs?|changelog|license|readme)/i;
const CI_RE = /(^|\/)\.(github|gitlab|circleci)(\/|$)|(^|\/)\.gitlab-ci\.yml$|(^|\/)(Jenkinsfile|\.travis\.yml)$/;
const CONFIG_RE = /\.(json|ya?ml|toml|ini|cfg)$|(^|\/)\.buddy\/|(^|\/)\.eslintrc|(^|\/)tsconfig\.json$/i;

const CODE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|vue|svelte)$/i;

/** Which conventional type does this change set deserve? */
export function classifyChange(files) {
  if (!files || !files.length) return { type: 'chore', why: 'no files' };
  const kinds = { test: 0, docs: 0, deps: 0, ci: 0, code: 0, config: 0, other: 0 };
  for (const f of files) {
    const p = String(f.path || f || '');
    if (LOCK_RE.test(p) || /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile)$/.test(p)) kinds.deps++;
    else if (TEST_RE.test(p)) kinds.test++;
    else if (DOC_RE.test(p)) kinds.docs++;
    else if (CI_RE.test(p)) kinds.ci++;
    else if (CODE_RE.test(p)) kinds.code++;
    else if (CONFIG_RE.test(p)) kinds.config++;
    else kinds.other++;
  }
  const n = files.length;
  if (kinds.deps === n) return { type: 'chore', scope: 'deps', why: 'dependency manifests/lockfiles only' };
  if (kinds.test === n) return { type: 'test', why: 'test files only' };
  if (kinds.docs === n) return { type: 'docs', why: 'documentation only' };
  if (kinds.ci === n) return { type: 'ci', why: 'CI config only' };
  if (kinds.code + kinds.config === n && kinds.code === 0) return { type: 'chore', why: 'config only' };
  if (kinds.test > 0 && kinds.test + kinds.docs + kinds.config === n - kinds.code && kinds.code > 0) {
    // code + its tests → the classic fix shape (a NEW test file alongside a
    // changed source file is a bug fix with a regression test, not a feature;
    // feat needs a new SOURCE file)
    const newSource = files.some((f) => f.isNew && !TEST_RE.test(String(f.path || f)) && !DOC_RE.test(String(f.path || f)));
    return { type: newSource ? 'feat' : 'fix', why: 'code changed with tests alongside' };
  }
  if (kinds.code === 0 && kinds.docs > 0) return { type: 'docs', why: 'mostly documentation' };
  if (kinds.code > 0 && files.some((f) => f.isNew)) return { type: 'feat', why: 'new source files' };
  if (kinds.code > 0) return { type: 'refactor', why: 'existing source changed, no new files' };
  return { type: 'chore', why: 'mixed/other files' };
}

/** Scope = the top-level dir (or src/<dir> when there's a third segment). */
export function inferScope(files) {
  const dirs = new Map();
  for (const f of files || []) {
    const p = String(f.path || f || '');
    const segs = p.split('/');
    if (segs.length < 2) continue; // repo-root files carry no scope
    // generic top dirs say little alone: src/x.js → "src", but src/terminal/repl.js → "src/terminal"
    let d = segs[0];
    if (/^(src|lib|tests?|spec|__tests__)$/i.test(d) && segs.length > 2) d = `${segs[0]}/${segs[1]}`;
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  if (!dirs.size) return '';
  let best = '', n = 0;
  for (const [d, c] of dirs) if (c > n) { best = d; n = c; }
  return n >= Math.max(1, Math.ceil((files?.length || 1) / 2)) ? best : '';
}

// ── subject from hunk headers ────────────────────────────────────────────────

/** Pull the enclosing contexts git names in the hunk headers, best first. */
export function hunkContexts(diff) {
  const out = [];
  for (const m of String(diff || '').matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/gm)) {
    let ctx = (m[1] || '').trim();
    if (!ctx) continue;
    // strip the common prefixes git may include and keep the callable name
    ctx = ctx.replace(/^(public|private|protected|static|final|abstract|async|export|function|def|fn|func)\s+/gi, '');
    ctx = ctx.replace(/\s*\{.*$/, '').trim();
    if (ctx && !out.includes(ctx)) out.push(ctx);
  }
  return out;
}

function shortName(ctx) {
  // "function slugify" / "class Repo" / "it('keeps the tail')" → a short label
  const m = String(ctx).match(/[\w$]+(?=\()|['"`]([^'"`]+)['"`]/);
  return (m && (m[1] || m[0])) || String(ctx).split(/[\s(]/)[0];
}

/** added/deleted line counts from a unified diff (per-file totals work too). */
export function diffShape(diff) {
  let added = 0, deleted = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  return { added, deleted };
}

const VERB = { feat: 'add', fix: 'fix', refactor: 'update', test: 'cover', docs: 'document', chore: 'bump', ci: 'wire' };

/**
 * The draft: `<type>(<scope>): <verb> <thing>` + a body that names the file
 * groups. Honest about being a DRAFT — the caller (model/user) may rewrite.
 */
export function draftCommitMessage({ diff = '', files = [] } = {}) {
  const cls = classifyChange(files);
  // a classify-level scope (chore(deps)) beats path-derived scopes
  const scope = cls.scope || inferScope(files);
  const ctxs = hunkContexts(diff);
  const { added, deleted } = diffShape(diff);
  const verb = VERB[cls.type] || 'update';

  // subject: prefer the top hunk context ("update slugify"), else the
  // dominant file's base name ("update fmt.js"), else the honest count.
  let thing = '';
  if (ctxs.length) thing = shortName(ctxs[0]);
  if (!thing) {
    const dom = [...files].sort((a, b) => ((b.add || 0) + (b.del || 0)) - ((a.add || 0) + (a.del || 0)))[0];
    if (dom?.path) thing = String(dom.path).split('/').pop();
  }
  if (ctxs.length > 1 && thing) {
    const second = shortName(ctxs[1]);
    if (second && second !== thing) thing = `${thing} + ${second}`;
  }
  const subject = thing
    ? `${verb} ${thing}`
    : `${verb} ${files.length} file${files.length === 1 ? '' : 's'}`;

  const head = `(${cls.type}${scope ? `(${scope})` : ''}):`; // used below
  const title = `${cls.type}${scope ? `(${scope})` : ''}: ${subject}`.slice(0, 72);

  // body: the file groups + a shape line
  const isNew = files.filter((f) => f.isNew).map((f) => f.path);
  const gone = files.filter((f) => f.isDeleted).map((f) => f.path);
  const touched = files.filter((f) => !f.isNew && !f.isDeleted).map((f) => f.path);
  const body = [];
  if (isNew.length) body.push(`new: ${isNew.slice(0, 5).join(', ')}${isNew.length > 5 ? ` … +${isNew.length - 5}` : ''}`);
  if (touched.length) body.push(`changed: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ` … +${touched.length - 5}` : ''}`);
  if (gone.length) body.push(`removed: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ` … +${gone.length - 5}` : ''}`);
  body.push(`diff: +${added}/-${deleted} — drafted from the staged diff (${cls.why}); edit if you can say it better`);

  return { title, body: body.join('\n'), type: cls.type, scope, head, verb, contexts: ctxs };
}

// ── the co-authored-by trailer ───────────────────────────────────────────────

export const DEFAULT_COAUTHOR = 'Buddy <buddy@engineer-buddy.dev>';

/** Trailer honoring BUDDY_COAUTHOR / BUDDY_NO_COAUTHOR. '' = do not append. */
export function coAuthorTrailer(env = process.env) {
  if (env.BUDDY_NO_COAUTHOR && String(env.BUDDY_NO_COAUTHOR).trim() !== '' && String(env.BUDDY_NO_COAUTHOR) !== '0') return '';
  const custom = String(env.BUDDY_COAUTHOR || '').trim();
  return custom ? `Co-Authored-By: ${custom}` : `Co-Authored-By: ${DEFAULT_COAUTHOR}`;
}

/** Append the trailer to a body without ever duplicating it. */
export function withTrailer(body, env = process.env) {
  const t = coAuthorTrailer(env);
  if (!t) return body || '';
  const b = String(body || '');
  if (/^Co-Authored-By:/im.test(b)) return b; // respect an explicit one
  return b ? `${b}\n\n${t}` : t;
}
