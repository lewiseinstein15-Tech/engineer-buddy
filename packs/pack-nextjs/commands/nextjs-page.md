---
description: Scaffold a Next.js App Router page or route segment with conventions
argument-hint: <route-path> [interactive|static]
allowed-tools: fs_read, fs_search, fs_write, bash, todo
---
Scaffold the Next.js App Router segment `$ARGUMENTS` following the
nextjs-app-router skill:

1. Confirm the repo actually uses the App Router (app/ directory present).
2. Create the segment folder with `page.tsx` (server component by default).
3. Add `loading.tsx` when the page fetches; `error.tsx` when it can fail.
4. Export `metadata` with a title derived from the route purpose.
5. If the second word is `interactive`, extract the interactive leaf into a
   `"use client"` child component and pass data via props.
6. Wire any navigation link the user asked for and run the repo's lint.
