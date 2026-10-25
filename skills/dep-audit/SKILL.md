---
name: dep-audit
description: Audit project dependencies and produce a prioritized, exploitability-based triage. Use when the user asks about dependency health, vulnerabilities, npm audit, or "is it safe to upgrade".
allowed-tools: fs_read, fs_search, fs_list, bash, todo
---

# Skill: dep-audit

Deterministic scan first, brain second: never invent vulnerabilities — every
item must trace to real tool output.

## Pipeline

1. Detect the ecosystem from the repo (package.json → `npm audit --json`;
   requirements.txt → suggest `pip-audit` and ask before installing anything).
2. Run the audit via bash (one simple command, no pipes). If it fails (no
   lockfile, private registry), report that honestly and stop.
3. For each advisory, judge **exploitability by the module's ROLE in this
   repo**, not by the severity label: is it a dev-only build tool, a transitive
   peer, or does it touch money/auth/user input? Read the imports if unsure.
4. Classify each item: `likely` / `possible` / `unlikely` exploitable here, and
   pick an action: `upgrade to X` / `replace` / `mitigate` / `monitor`.

## Report format (markdown, to the user)

- 2-4 sentence summary of overall dependency health and the #1 action.
- Table, sorted by priority, max 12 rows:
  `| module | severity | exploitable here? why | action |`
- Close with the single command the user should run first (e.g.
  `npm install pkg@version`), but do not run installs yourself.

## Honesty rules

- npm 6 (`advisories`) and npm 8+ (`vulnerabilities`) output shapes both occur.
- If audit JSON contains an error (e.g. no lockfile), surface it verbatim —
  it may be the actual finding.
