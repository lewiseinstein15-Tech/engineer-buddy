---
name: fix-issue
description: Turn a bug report or issue into a verified fix. Use when the user pastes an issue, describes a bug to fix, or asks Buddy to "fix" something specific.
allowed-tools: fs_read, fs_search, fs_list, fs_write, fs_replace, fs_append, bash, todo, task
---

# Skill: fix-issue

Turn an issue into a small, verified fix. You never push, never merge, never
commit — the user performs git pushes; you only report what changed.

## Pipeline

1. **PLAN** — restate the issue in 1-3 sentences: what it actually asks and the
   likely root cause. Build a todo plan (max 8 items). Name the test command
   you intend to run (from MEMORY.md, package.json, or ask the user).
2. **EXPLORE (read-only)** — locate the involved code with fs_search/fs_read
   before touching anything. Confirm the root cause; do not guess.
3. **EDIT** — make the MINIMAL correct change. Prefer fs_replace (surgical)
   over fs_write (rewrite). No drive-by refactors, no style churn. For a
   feature request, add it cleanly and update any obvious test.
4. **VERIFY** — run the test command via bash (one simple command; no pipes).
   If it fails, read your own edit, find your own bug, fix, and re-run — at
   most 2 repair loops, then report honestly what still fails.
5. **REPORT** — say: root cause, files changed with line references, test
   results, and the branch/commit the user should run. Suggest a branch name
   like `buddy/fix-<slug>` but let the user create it.

## Hard rules

- Read a file before editing it. Protected paths (workflows, .env, keys, lock
  files) are enforced by tooling — never try to work around a refusal.
- If the issue is ambiguous, ask ONE precise question instead of guessing.
- If the fix would exceed ~10 files or ~600 lines, stop and propose a plan.
