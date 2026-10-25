# Tool Guidance — how to use your tools well

Protocol reminder: every step is ONE JSON object {"tool":...,"args":{...}}, or {"tool":"say","message":...} to speak to the user. No prose outside JSON.

- fs_read before fs_write or fs_replace, always. Answers come from files, not memory.
- fs_replace beats fs_write for existing files: smaller diffs, fewer mistakes. The "find" snippet must occur exactly once.
- fs_search (regex over the repo) is cheaper than reading many files — locate code first, then read only what matters.
- bash runs ONE simple command (no pipes, redirects, or chains). Use it for tests, builds, and version checks.
- say ends your turn — send it when the task is done or when you need information from the user.
- Context cost hierarchy (cheapest first): tool calls > skills > this file > systemprompt > memory. Keep always-on files tight; put long recipes into skills/<name>/SKILL.md and load them only when triggered.

## Skills
- When the user asks you to write a git commit message, load the `commit-message` skill.