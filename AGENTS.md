# Forska.ai - Agent Handbook

## Project Defaults

- Use Bun tooling by default.
- Use `process.env`, not Bun's env.
- Do not rely on `.env` files for normal dev.
- Client network goes through TanStack Query and Eden/RPC unless streaming, upload, or download requires `fetch`.
- DuckDB is the database. Do not create Postgres migrations.
- If you start a local server or process for debugging, stop it before finishing or replying.

```bash
bun install
bun run dev:server
bun run dev:app
bun run desktop:dev
bun run desktop:build
bun run build
bun run lint
bun run lint:fix
bun test
bun test path/to/file.test.ts
bun run db:mig
bun run db:duck:request-review-serving-all-projects-rebuild
```

## Non-Negotiables

- Treat model, provider, thinking level, and other reliability-affecting settings as benchmark-critical configuration.
- Never silently retry, downgrade, override, or work around benchmark-critical settings unless the user explicitly asks for that behavior.
- If a request fails under configured benchmark settings, preserve that failure and surface it.
- When fixing any out-of-memory issue, add a short entry to `OOM_ERRORS.md` in the same change.
- Desktop support is additive. Do not break the normal browser flow while adding or changing desktop behavior.
- For shared app, frontend, runtime-path, server, import, or local file storage changes, explicitly consider both browser/web and desktop app flows.
- Do not fix unrelated lint issues.
- Do not add auth, session, user, or admin requirements unless explicitly asked. Default to no-auth single-user behavior.
- Do not remove `debugger` or `console.log` unless explicitly asked.

## Skill Routing

The detailed guidance lives in Markdown files under `.opencode/skills/`. If
your agent runtime does not auto-discover OpenCode project skills, read the
matching `SKILL.md` file directly before starting that kind of work.

- Load `forskai-code-style` before TypeScript, refactor, lint, import, file-structure, or style-sensitive edits.
  Path: `.opencode/skills/forskai-code-style/SKILL.md`
- Load `forskai-frontend-solid` before SolidJS UI, TanStack Query, routing, desktop/web shared UI, Suspense, or stale-data work.
  Path: `.opencode/skills/forskai-frontend-solid/SKILL.md`
- Load `forskai-api-server` before server routes, Eden/RPC, API boundaries, ArkType validation, upload/download, environment wiring, runtime paths, imports, or local file storage.
  Path: `.opencode/skills/forskai-api-server/SKILL.md`
- Load `forskai-duckdb` before DuckDB, migrations, marts, queues, cron jobs, maintenance tasks, judgment queries, OOM errors, database runtime safety, or `db:*` commands.
  Path: `.opencode/skills/forskai-duckdb/SKILL.md`
- Load `forskai-reporting` before plans, PRDs, reviews, commits, PRs, or task breakdowns.
  Path: `.opencode/skills/forskai-reporting/SKILL.md`

## Quality Gates

- For plans, PRDs, and task breakdowns, include explicit Quality Gates.
- Keep gates concrete, minimal, pass/fail, and repo-native.
- Use only relevant gates: `bun run lint`, targeted `bun test` or `bun test <file>`, `bun run build` for UI, `bun run db:mig` for schema work, server/app output checks, and browser verification for UI flows.
- In PRs and commits, note touched layers: server, client, database, docs.
- List commands you ran. If you skip an obvious command, say why.

## Testing

- Place tests adjacent to the source file.
- Use exact boundary conditions.
- Use `bun test`.
- Use `mock.module()` when mocking modules.

## RTK

- When `rtk` is available on PATH, prefix shell commands with `rtk` to reduce tool output.
- If `rtk` is unavailable, run the underlying command directly instead of failing the task.
- For debugging, use raw commands without `rtk` when full output is useful.
