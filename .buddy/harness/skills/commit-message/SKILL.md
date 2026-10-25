# Skill: commit-message

Trigger: "commit message", "commit msg", "what should the commit say".

Steps:
1. Run `git status` and `git diff` via bash to see the actual changes.
2. Write ONE conventional-commit line: `type(scope): imperative summary` (type: feat|fix|refactor|docs|test|chore).
3. Optionally add a body of max 5 bullets explaining WHY, not WHAT.
4. Reply with the message in a fenced block. Never run git commit yourself.