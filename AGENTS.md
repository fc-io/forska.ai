# Forska.ai — Agent Handbook

## Read this first
- Always review [`CLAUDE.md`](./CLAUDE.md) before touching the codebase. That file contains non-negotiable style and architectural rules (naming, export style, recursion preferences, etc.).
- Instructions follow the usual precedence: system > developer > user > AGENTS. If another task adds a more specific `AGENTS.md` deeper in the tree, defer to the most specific file for the files you modify.

## Repository map
- Full-stack project: Elysia (Bun) API under `src/server`, SolidJS client in `src/app`, shared utilities in `src/components`, `src/utils`, `src/stores`, and domain data under `docs/`.
- Database layer uses Drizzle ORM (see `drizzle.config.ts`) with PostgreSQL (Docker compose service `postgres`). Auth flows live in `src/auth.ts` and `src/server/routes/*`.

## Daily workflow
1. Install dependencies with `bun install` (avoid `npm`, `pnpm`, or `yarn`).
2. For development, run `bun run dev:server` (API) and `bun run dev:app` (client). Environment secrets live in `.env.local`; assume required keys already exist.
3. When changing schema or seed data, prefer Drizzle commands (`bun run db:gen`, `bun run db:mig`, `bun run db:seed`). Do not hand-write SQL migrations.

## Quality gates
- Run `bun run lint` and `bun test` after changes. Add additional targeted checks (e.g., `bun run build`) when touching build or deploy paths.
- Database-dependent tests may require the Postgres container (`docker compose up postgres`).
- Keep console/debug statements unless explicitly instructed otherwise (per `CLAUDE.md`).

## Code organization tips
- Create new route files under `src/server/routes` using PascalCase filenames ending in `Routes.ts`.
- Client components should live alongside related helpers in a same-named folder (PascalCase) when they grow beyond ~100 lines.
- Prefer Eden/RPC clients over raw `fetch` calls, and keep data validation near request boundaries using ArkType.

## Documentation & coordination
- Update `docs/` when business logic or terminology changes.
- If you introduce migrations or notable config tweaks, mention them explicitly in the PR summary.
- When a change alters the user-facing UI, capture a screenshot via the provided browser tooling once the dev server is running.

## PR / final message expectations
- Summaries should call out whether the server, client, database, or docs were touched.
- List every command you executed in the testing section, even if skipped due to environment limits, and explain any missing checks.

