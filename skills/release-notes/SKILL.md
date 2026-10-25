---
name: release-notes
description: Draft human-ready release notes from recent git history. Use when the user asks for release notes, a changelog entry, or a version summary.
allowed-tools: fs_read, fs_search, fs_list, bash, todo
---

# Skill: release-notes

Draft release notes that users read — not a git log dump.

## Pipeline

1. Determine the range: the user's `since` tag, else the latest tag
   (`git describe --tags --abbrev=0`), else the last ~50 commits
   (`git log --oneline -50`). One simple bash command per call.
2. Group the work:
   - **⚠️ Breaking changes** — renamed/removed exports, changed signatures,
     schema/config migrations, dropped runtimes.
   - **✨ Features** — new user-facing capability.
   - **🐛 Fixes** — behavior that was wrong and now works.
   - **🧹 Maintenance** — deps, CI, refactors, docs.
3. Write entries in **user-facing language** ("Wallet withdrawals now retry
   automatically", not "refactor retry logic in payout.ts"). One line each,
   max 12 per section. Reference `(#<number>)` only when the commit cites an
   issue/PR number.
4. Collect contributors from the commit authors in range (`git log --format=%an`)
   and thank them by handle when the mapping is obvious.

## Output

```
## 🚀 <Release title>
<intro: 1-3 sentences — the headline of this release>
### ⚠️ Breaking changes / ✨ Features / 🐛 Fixes / 🧹 Maintenance
- entry (#123)
**Thanks:** @a, @b
```

Mark it clearly as a DRAFT for the user to edit. Never create tags, never
push — the user owns releases.
