# CLEAN_CLAUDE_PLAN

## Goal

- Keep `AGENTS.md` as the primary root doc.
- Decide every section or bullet in `AGENTS.md` and `CLAUDE.md` as `keep` or `remove`.
- Round 1 only: move needed content from `CLAUDE.md` into `AGENTS.md`, then delete or shrink `CLAUDE.md`.
- Round 1 does not create skills.
- `Keep` = keep in root docs, consolidated into `AGENTS.md`.
- Round 1 has no skill-extraction bucket.
- `Remove` = delete fully.

## Round 1 Rule

- Do not extract anything into skills in round 1.
- If a `CLAUDE.md` item is marked `keep`, move it into `AGENTS.md`.
- If a `CLAUDE.md` item should survive round 1, keep it in `AGENTS.md`.
- If an item is marked `remove`, delete it in round 1.
- End of round 1: one merged root doc in `AGENTS.md`; `CLAUDE.md` deleted or reduced to a tiny shim.

## AGENTS.md / Precedence

- REMOVE: section.
- Remove: `Always read CLAUDE.md before touching the codebase`.
- REMOVE: `If a more specific AGENTS.md exists deeper in the tree, defer to it`.

## AGENTS.md / Build Lint Test Commands

- Keep: section, but cut comments.
- Keep: `bun install`.
- Keep: `bun run dev:server`.
- Keep: `bun run dev:app`.
- Keep: `bun run build`.
- Remove: `bun run preview`.
- Keep: `bun run lint`.
- Keep: `bun run lint:fix`.
- Keep: `bun test`.
- Keep: `bun test path/to/file.test.ts`.
- Remove: `bun test --watch`.
- Remove: `bun test --grep "pattern"`.
- Keep: `bun run db:mig`.
- Remove: `bun run db:duck:mig`.
- Keep: `bun run db:duck:rebuild-marts`.

## AGENTS.md / Repository Map

- Remove: section.

## AGENTS.md / Code Style Guidelines

- Keep: section, cut hard.

## AGENTS.md / General Principles

- Keep: functional style.
- Keep: arrow functions.
- Keep: named exports only.
- Keep: `const` over `let`.
- Keep: recursion over loops.
- keep: single return per function.
- Keep: avoid nested if/else.
- Keep: no comments.
- Remove: keep `debugger` and `console.log`.

## AGENTS.md / Ternary Patterns

- Keep: section.

## AGENTS.md / TypeScript

- Keep: section, cut to the few rules that matter.
- Keep: `type` over `interface`.
- Keep: infer or derive types from Eden/RPC and local builders.
- Keep: no shared type files.
- Keep: explicit returns only for pure functions.
- Keep: unused vars prefix `_`.

## AGENTS.md / Imports

- Keep: section.

## AGENTS.md / File Structure

- Keep: section.
- Keep: filenames are camelCase.
- Keep: single export file matches exported name.
- Keep: one-owner helpers/components live in a sibling subfolder.
- Keep: example tree.

## AGENTS.md / SolidJS Patterns

- Keep: section, cut to repo-specific rules.
- Keep: use `splitProps` when destructuring props.
- Remove: prefer `createSignal` for simple state, `createStore` for nested.
- Remove: use `createMemo` for expensive computations.
- Keep: use `<Show>` and `<Switch>`/`<Match>` over JSX ternary.
- Keep: use `<For>`/`<Index>` instead of `.map()` for lists.
- Keep: use `useQuery`, not `createQuery`.
- Keep: extract components `>100` lines into subfolders.

## AGENTS.md / Reactivity Gotchas

- Keep: section.

## AGENTS.md / API Routes

- Keep: section.
- Keep: route files use `[resource]Routes.ts`.
- Keep: URL prefix is `/api/` plus plural resource.
- Keep: flat routes, prefer POST plus body over nested params.
- Keep: Eden/RPC on client, no direct `fetch` by default.
- Keep: keep fetch logic local to `useQuery`; no services files.
- Remove: extract handlers `>15` lines.

## AGENTS.md / Elysia File Uploads

- Keep: section.
- Keep: `derive` does not propagate for `t.File()`; fetch session from `request.headers`.

## AGENTS.md / Database DuckDB

- Keep: section.
- Keep: use shared DuckDB helpers.
- Keep: use transactions for multi-table ops.
- Keep: singular table names.
- Remove: `Apply migrations: bun run db:mig`.

## AGENTS.md / Judgment Queries

- Keep: section.
- Keep: always filter by model and content settings.
- Keep: example query block.

## AGENTS.md / Testing

- Keep: section, cut examples.
- Remove: `Tests use Bun's test runner with bun:test`.
- Remove: test example block.
- Keep: place tests adjacent to source.
- Keep: use exact boundary conditions.
- Keep: `mock.module()` guidance.

## AGENTS.md / Error Handling

- Keep: section, trimmed.
- Keep: avoid `try`/`catch`/`throw` unless necessary.
- Remove: handle errors gracefully with proper logging.
- Keep: use ArkType at API boundaries.

## AGENTS.md / Environment

- Keep: section.
- Keep: no `.env` for normal dev.
- Keep: use `process.env`, not Bun env.
- Keep: shell env only for runtime wiring, machine-local paths, and secrets.

## AGENTS.md / PR Commit Expectations

- Keep: section.
- Keep: note touched layers.
- Keep: list commands executed with explanations.
- Keep: do not fix unrelated lint issues.

## CLAUDE.md / Frontmatter

- Remove: `alwaysApply: true` frontmatter.

## CLAUDE.md / Important

- Remove: section title.
- Keep: be extremely concise in plans and markdown.
- Keep: always include explicit Quality Gates in plans/PRDs/task breakdowns.
- Keep: do not create Postgres migrations; use DuckDB SQL migrations.
- Keep: derive types from API when possible.
- Keep: avoid `try`, `catch`, `finally`, `throw` unless necessary.
- Keep: prefer `effect` for new non-trivial async/server flow.
- Keep: layout-first UI.
- Keep: do not add auth/session/user/admin requirements unless asked.
- Keep: never suspend root `<Outlet />` or entire route.
- Keep: keep headers/nav/containers outside async boundaries.
- Keep: `useQuery` loading-model rules.
- Keep: `suspense:false` recommendation details.
- Keep: `suspense:true` allowed pattern details.
- Keep: no `<Suspense>` without `fallback`.
- Keep: client network via TanStack Query + Eden; `fetch` only when forced.
- Remove: `See plans/old/LOCAL_FIRST_PLAN.md`.
- Remove: avoid branching rule.
- Keep: single export filename matches exported function.
- Keep: prefer shared DuckDB helpers over ad hoc DB access.
- Keep: never open live DuckDB file directly.
- Keep: use `useQuery`, not `createQuery`.
- Keep: secrets and externalized values live in shell env or secret files.
- Keep: filenames stay camelCase.
- Keep: manual DuckDB work must set memory cap.
- Keep: stop local debug servers/processes before finishing.
- Keep: no `.env` for normal dev; use `process.env`.

## CLAUDE.md / File Structure

- Keep: section.
- Keep: filenames are camelCase.
- Keep: one-owner helpers/components live in a sibling subfolder.
- Remove: example tree.

## CLAUDE.md / Coding Style

- Keep: section, cut hard.
- Keep: functional JavaScript style.
- Keep: arrow functions.
- Keep: named exports.
- Keep: `const` over `let`.
- Remove: recursive functions over loops.
- Keep: prefer `export const Foo = ...` over separate export statement.
- keep: do not declare functions inside components.
- keep: one return statement per function.
- keep: avoid nested if/else.
- Keep: prefer `Effect.gen` over long promise chains.
- Keep: prefer `Effect.acquireRelease` and `Scope`.
- Keep: prefer `Layer` and `Context`.
- Keep: prefer `Schedule` for retries, polling, backoff.
- Keep: keep tiny handlers plain; do not force Effect everywhere.
- keep: prefer to handle all errors and throws gracefully if easily possible.
- Remove: keep code succinct and DRY.
- Keep: singular table names.
- Keep: do not remove `debugger` or `console.log`.
- Remove: do not add comments unless asked.
- Remove: avoid one-line comments.

## CLAUDE.md / Ternary With Helpers

- Keep: section.
- Keep: all rules in this section.
- Keep: all examples in this section.

## CLAUDE.md / TypeScript Conventions

- Keep: section, cut to short rules.
- Keep: `type` over `interface`.
- Keep: prefer inferred or derived types.
- Remove: explicit return types when return type is not obvious.
- Remove: prefer unions/intersections over complex inheritance.
- Remove: avoid shared type definition files.

## CLAUDE.md / Import Organization

- Remove: section.
- Remove: import order list.

## CLAUDE.md / Component Patterns SolidJS

- Keep: section, cut to repo-specific rules.
- Keep: use `splitProps` when destructuring props.
- Remove: prefer `createSignal` for simple state, `createStore` for complex state.
- Remove: use `createMemo` for expensive computed values.
- Keep: prefer `Show` and `Switch`/`Match` over JSX ternary.
- Keep: use `For` and `Index` instead of `.map()`.
- Remove: extract components over `100` lines.

## CLAUDE.md / Platform And Tools

- Remove: section title.
- Remove: stack summary line.
- Keep: default to Bun instead of Node.
- Remove: `bunx` instead of `npx`.
- Remove: `bun <file>` instead of `node <file>`.
- Remove: `bun test` instead of `jest` or `vitest`.
- Remove: `bun build` instead of `webpack` or `esbuild`.
- Remove: `bun install` instead of `npm`/`yarn`/`pnpm`.
- Remove: `bun run <script>` instead of `npm run`/`yarn run`/`pnpm run`.
- Remove: do not add dotenv.

## CLAUDE.md / Linting Formatting

- Remove: section title.
- Keep: do not fix unrelated lint issues.
- Keep: do not remove `debugger` or `console.log`.
- Remove: `eslint-plugin-prettier` explanation.
- Keep: `bun run lint`.
- Keep: `bun run lint:fix`.

## CLAUDE.md / API Route Naming Conventions

- Keep: section.
- Keep: `/api/` plus plural resource.
- Remove: RESTful conventions line.
- Keep: `[resource]Routes.ts` file naming.
- Remove: extract route logic over `15` lines.
- Remove: `Use Elysia framework patterns`.
- Keep: do not nest routes; prefer flat routes.
- Keep: use Eden/RPC on client; `fetch` only for streaming/upload/download.
- Keep: keep fetch logic local to `useQuery`; avoid services files.
- Remove: `Prefer POST with request body` duplicate.

## CLAUDE.md / Elysia File Upload Routes

- Keep: section.
- Keep: fetch session from `request.headers` for `t.File()` routes.

## CLAUDE.md / Database Patterns

- Keep: section.
- Keep: prefer shared DuckDB services/helpers.
- Keep: use transactions for multi-table operations.
- Keep: prefer `db.select/insert/update/delete` over `db.execute`.
- Remove: use prepared statements for frequently executed queries.
- Remove: handle database errors with proper logging and user-friendly messages.

## CLAUDE.md / Database Migrations

- Remove: section title.
- Keep: use existing SQL migration files under `src/db/duckdbMigrations/`.

## CLAUDE.md / Judgment Queries

- Keep: section.
- Keep: filter judgments by model and content settings.
- Keep: unique constraint details.
- Keep: single-project example query block.
- Keep: multi-project OR example query block.

## CLAUDE.md / Data Validation

- Remove: section title.
- Keep: use ArkType for runtime validation at API boundaries.
- keep: validate all incoming request data before processing.
- Remove: ArkType composable type definitions line.
- Remove: define validation schemas close to where they are used.

## CLAUDE.md / Testing

- Keep: section, trimmed.
- Keep: use exact boundary conditions.
- Keep: use `bun test`.
- Remove: Bun test example block.
- Remove: `read the Bun API docs in node_modules`.

## CLAUDE.md / Solid.js Stale Data

- Keep: entire section.

## End State

- Round 1 end state: one merged `AGENTS.md` root doc; `CLAUDE.md` deleted or reduced to a tiny shim.
- Later round: move low-value or situational material from `AGENTS.md` into skills.

## Quality Gates

- Pass: every section or bullet from both files has a decision.
- Pass: every decision is only `keep` or `remove`.
- Pass: `AGENTS.md` stays primary.
- Pass: round 1 clearly does not create skills.
