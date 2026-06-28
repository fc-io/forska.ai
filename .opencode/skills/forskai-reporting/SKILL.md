---
name: forskai-reporting
description: Use ONLY when writing plans, PRDs, task breakdowns, reviews, recommended fixes, commit messages, PR descriptions, reports, or quality gates.
---

# Forska Reporting

## Plans And Reports

- Be concise in plans and markdown.
- For any plan, PRD, or task breakdown, include explicit Quality Gates.
- Keep Quality Gates concrete, minimal, pass/fail, and repo-native.
- Use only relevant gates: `bun run lint`, targeted `bun test` or `bun test <file>`, `bun run build` for UI, `bun run db:mig` for schema work, server or app output checks, and browser verification for UI flows.
- In PRs and commits, note touched layers: server, client, database, docs.
- List commands you ran.
- If you skip an obvious command, say why.
- Do not fix unrelated lint issues.
- For shared app, frontend, runtime-path, or server changes, explicitly consider both the browser/web flow and the desktop app flow.
- Verify the relevant browser or desktop flow and call out what you checked.
- For internal intermediate state, queues, caches, and marts, do not add backward-compatibility shims unless explicitly required.
- Prefer a clear cutover that deletes or rebuilds obsolete intermediate state over preserving legacy rows or parallel paths.

## Recommended Fixes

- When explaining recommended fixes, consider a compact `Recommended Fixes` table.
- Keep the table simple and numbered so items are easy to reference.
- Useful columns include `#`, `Fix`, `What It Does Now`, `What It Should Do`, and `Why It Helps`.

## Benchmark Integrity

- Treat model, provider, thinking level, and other reliability-affecting settings as benchmark-critical configuration.
- Never silently retry, downgrade, override, or work around those settings unless the user explicitly asks for that behavior.
- If a request fails under the configured settings, preserve that failure and surface it.

## Testing

- Place tests adjacent to the source file.
- Use exact boundary conditions.
- Use `bun test`.
- Use `mock.module()` when mocking modules.
