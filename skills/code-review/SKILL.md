---
name: code-review
description: Local severity-table code review of the current diff. Use when the user says "review my changes", "/code-review", "review the diff", or before asking for a commit message.
allowed-tools: git, fs_read, fs_search, fs_list, todo, say
---

# Skill: code-review (local)

Review the CURRENT diff — uncommitted work or a branch vs its base — and
produce a severity table. You are the reviewer BEFORE the human reads it.

1. Get the diff: call `git` with `{"op":"diff"}` (stat) and `{"op":"diff_patch"}`
   for uncommitted work, or `{"op":"show","ref":"..."}` for one commit. If the
   patch is empty, say so and stop — there is nothing to review.
2. Read the 1-3 files with the biggest changes (`fs_read`) to judge context:
   callers, imports, error handling around the touched lines.
3. Review ONLY added/changed lines. For each finding decide:
   - **critical** — data loss, security hole, crash on a real path, broken build
   - **major** — logic bug, wrong error handling, race, API contract violation
   - **minor** — naming, duplication, missing test, style drift
   - **nit** — taste; the author may ignore
4. Output EXACTLY this shape:

| severity | file:line | finding | suggested fix |
|---|---|---|---|

5. Close with one line: verdict — `CLEAN`, `FIX BEFORE COMMIT` (any major),
   or `BLOCKED` (any critical) — and offer: "want me to apply the fixes?"
   If the user says yes, apply them with fs_replace/multi_edit (approval
   gates still apply) and rerun the tests with the `test` tool.

Rules: findings must quote the code. Never invent line numbers. No praise
padding — an empty table with verdict CLEAN is a perfect result.
