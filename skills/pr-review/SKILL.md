---
name: pr-review
description: Engineering-grade pre-review triage of a pull request or uncommitted diff. Use when the user asks to review a PR, a diff, a branch, or "check my changes before merge".
allowed-tools: fs_read, fs_search, fs_list, bash, todo
---

# Skill: pr-review

You are performing staff-level pre-review triage. Your review runs BEFORE the
human team lead reads the code, so surface what would waste their time or
endanger production. Review only ADDED/CHANGED lines — get the diff first:

1. Run `git diff HEAD` (uncommitted) or `git diff main...HEAD` (branch) via bash.
2. Skim the file table first, then read the 1-3 files whose surrounding context
   (callers, imports, config) is essential to judge the changes.

## Hunt for, in priority order

1. **CORRECTNESS BUGS** — logic errors, off-by-one, inverted conditions,
   unhandled null/undefined, wrong variable, broken edge cases, race
   conditions, await-less async calls.
2. **SECURITY** — injection, XSS, IDOR, missing authorization, secrets
   committed to the repo, unsafe deserialization, SSRF, insecure defaults.
3. **MONEY & DATA SAFETY** — balances, payouts, transactions, migrations:
   wrong math, non-atomic updates, missing rollback, RLS/policy bypass.
4. **BREAKING CHANGES** — renamed/removed exports, changed signatures, API
   contract drift, schema changes without migration.
5. **TEST GAPS** — new behavior with zero tests, tests that assert nothing,
   mocks hiding real logic.
6. **ERROR HANDLING** — swallowed exceptions, missing error paths on
   network/DB calls, silent failures.

**Ignore:** formatting/style nits (linters own those), personal preference,
architectural philosophy, generated files, lock files.

## Severity guide

- `critical` — will break production, lose money, leak data, or open an attack path
- `high` — likely bug or significant risk the author must address before merge
- `medium` — worth fixing, not merge-blocking
- `low` — minor improvement
- `praise` — genuinely good pattern worth reinforcing (use sparingly)

## Report format (markdown, to the user)

- **Verdict:** `approve` / `comment` / `request_changes` · **Risk:** low/medium/high
- 2-6 sentence summary: what the change does, overall quality, the one thing
  that matters most.
- Findings list: `- 🚨/⚠️/🔍/💡/👍 **Title** — path:line`, then 1-3 sentences
  naming the failure scenario and the fix in one sentence when obvious.
- Never invent file paths or line numbers — cite only what you read.
- If the PR is solid, say so honestly — false alarms erode trust.
