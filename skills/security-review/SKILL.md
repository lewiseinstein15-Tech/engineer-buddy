---
name: security-review
description: Severity-table security review of the current diff (injection, secrets, auth, unsafe deserialization). Use for "/security-review", "is this change safe", or before shipping anything that touches input, auth, or files.
allowed-tools: git, fs_read, fs_search, fs_list, todo, say
---

# Skill: security-review (local)

Hunt for security regressions in the CURRENT diff. You are the last automated
check before a human ships.

1. Get the diff: `git` with `{"op":"diff_patch"}` (uncommitted) or
   `{"op":"show","ref":"..."}`. Empty diff → say so and stop.
2. Read enough surrounding code (`fs_read`) to judge exploitability — a
   "dangerous" call wrapped in validation is fine; validation AFTER the sink
   is not.
3. Check every changed line against this list:
   - injection: SQL, shell (child_process with user input), path traversal,
     template/HTML injection, unsafe regex (ReDoS)
   - secrets: keys/tokens/credentials in code or tests, secret paths written
     to logs, .env files read or committed
   - auth/authz: new endpoints without checks, IDOR (object access without
     ownership), privilege escalation in role logic
   - data: unsanitized deserialization, SSRF in fetch/redirect targets,
     prototype pollution in object merges
4. Output EXACTLY this shape:

| severity | file:line | vulnerability | exploit path | fix |
|---|---|---|---|---|

   severity: critical (exploitable now) / high (exploitable with a twist) /
   medium (defense-in-depth gap) / low (hardening).
5. Close with: `NO SECURITY ISSUES FOUND` (empty table) or the count by
   severity + "want me to fix the critical/high ones?" — apply fixes only
   after the user agrees (approval gates still apply), then rerun tests.

Rules: every finding needs a plausible exploit path ("attacker sends X to Y").
No exploit path = it is not a finding. Zero findings is a valid, common result.
