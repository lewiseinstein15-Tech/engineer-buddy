---
name: nextjs-app-router
description: Next.js App Router conventions — use whenever a task touches app/, pages, routes, or data fetching in a Next.js repo.
allowed-tools: fs_read, fs_search, fs_write, fs_replace, bash, todo
---

# Next.js App Router playbook

You are working in a Next.js repo. Default to the App Router (`app/`) unless
the repo is demonstrably still on the pages router — never mix the two in one
diff.

## Component discipline

- Server components by default. `"use client"` is a boundary you add at the
  LEAF that needs interactivity — not at the page, not at the layout.
- A client component receives data via props from its server parent whenever
  the data is fetchable server-side; reaching for `useEffect` + `fetch` in a
  client component is the last resort, and says why in a comment.
- No `"use client"` on a file that only exports metadata or static markup.

## Data fetching

- Fetch in server components (`async function Page()`); co-locate the query
  with the UI that owns it.
- Mutations go through route handlers (`app/api/*/route.ts`) or server
  actions — pick whichever the repo already uses and stay consistent.
- Loading/error states are files (`loading.tsx`, `error.tsx`), not spinner
  booleans, when the segment has a real async boundary.

## Routing + metadata

- Route params are async (`const { slug } = await params`) — check the repo's
  Next version before assuming either shape.
- Each page exports `metadata` (static) or `generateMetadata` (dynamic).
  Titles come from the content, not boilerplate.

## Conventions

- Never edit `.next/` output. Never commit it.
- `next.config.js` changes say why in the PR body — they affect every route.
- After edits: run the repo's lint + a production build when feasible
  (`npm run build`); type errors only the build catches must be fixed, not
  silenced.
