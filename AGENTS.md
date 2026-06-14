# Forska.ai - Agent Handbook

## Commands

- Use Bun tooling by default.

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
bun run db:duck:request-review-serving-large-rebuild
```

## Plans And Reports

- Be concise in plans and markdown.
- For any plan, PRD, or task breakdown, include explicit Quality Gates. Keep
  them concrete, minimal, pass/fail, and repo-native. Use only relevant gates:
  `bun run lint`, targeted `bun test` or `bun test <file>`, `bun run build` for
  UI, `bun run db:mig` for schema work, sometimes also relevant to read from the
  server or app output, and browser verification for UI flows
  when relevant.
- In PRs and commits, note touched layers: server, client, database, docs.
- List commands you ran. If you skip an obvious command, say why.
- When explaining recommended fixes, consider a compact `Recommended Fixes` table
  in simple terms with a numbered first column so items are easy to reference.
  Useful columns include: `#`, `Fix`, `What It Does Now`, `What It Should Do`,
  and `Why It Helps`.
- Do not fix unrelated lint issues.
- For shared app, frontend, runtime-path, or server changes, explicitly consider both the browser/web flow and the desktop app flow. Verify the relevant one(s) and call out what you checked.
- For internal intermediate state, queues, caches, and marts, do not add backward-compatibility shims unless explicitly required. Prefer a clear cutover that deletes or rebuilds obsolete intermediate state over preserving legacy rows or parallel paths.

## Benchmark Integrity

- Treat model, provider, thinking level, and other reliability-affecting settings as benchmark-critical configuration.
- Never silently retry, downgrade, override, or work around those settings unless the user explicitly asks for that behavior.
- If a request fails under the configured settings, preserve that failure and surface it; do not mutate the execution profile to chase a success.

## OOM Errors

- When fixing any out-of-memory issue, add an entry to `OOM_ERRORS.md` in the same change.
- Keep each entry short: include the error excerpt, affected job/query/command, likely cause, fix, and verification.
- This includes DuckDB OOMs like `Out of Memory Error: failed to pin block` from cron jobs, queues, marts, or large queries.

## Web And Desktop

- Desktop support is additive. Do not break the normal browser flow while adding or changing desktop behavior.
- Keep `bun run dev:server` and `bun run dev:app` working for the web app unless the task explicitly says otherwise.
- When changes affect shared UI, API wiring, runtime asset paths, imports, or local file storage, also check the desktop path with `bun run desktop:build` or `bun run desktop:dev` when relevant.

## File Structure

- Keep filenames camelCase, including TSX and JSX.
- If a file has one export, the filename should match it.
- Components and helpers used by one file should live in a sibling subfolder
  with the same owner name. Route folders are the exception.
- When a component or its related utilities exceed 100 lines, extract them into
  that subfolder.

```text
src/components/main/
subheader.tsx
subheader/
subheaderSettingsPanel.tsx
subheaderSettingsPanel/
subheaderSettingsPanelDateRangePicker.tsx
```

## Code Style

- Prefer functional JavaScript. Use `map`, `filter`, and `reduce` over `forEach`. Avoid classes.
- Prefer arrow function expressions.
- Prefer named exports. Prefer `export const Foo = ...` over separate export blocks.
- Prefer `const` over `let`.
- Prefer recursion over `while` and `for` loops.
- Prefer one return per function.
- Avoid nested `if` and `else`.
- Do not add comments.
- Prefer not to declare functions inside components.
- Prefer `Effect` for new non-trivial async and server flow so control flow, resources, retries, and failures stay explicit.
- Prefer `Effect.gen` over long promise chains.
- Prefer `Effect.acquireRelease` and `Scope` for resource lifetime and cleanup.
- Prefer `Layer` and `Context` for wiring services.
- Prefer `Schedule` for retries, polling, and backoff.
- Keep pure transforms and very small local handlers as plain functions.
- Prefer to handle errors and throws gracefully when easily possible.
- Do not remove `debugger` or `console.log` unless explicitly asked.

## Ternary With Helpers

- Use case: exactly two mutually exclusive paths with no shared tail logic.
- Prefer ending a function with a ternary: `return cond ? pathA(arg) : pathB(arg)` or `return cond ? value : pathB(arg)`.
- Precompute shared inputs before the ternary.
- Extract branches into small named helpers.
- Both branches must return the same type.
- Shortcuts like `return data ?? []` are good.
- Avoid more than two branches, large inline expressions, shared post-branch logic, anonymous functions in the ternary, nested local helpers, anonymous functions longer than three lines, and pointless wrapper helpers.
- Do not use ternary when one or both paths return `void`.
- Do not place statements after a `return`.

Do:

```ts
return cond ? buildA(x) : buildB(x)
return cond ? value : buildB(x)
```

Don't create wrapper functions that do not add real behavior:

```ts
const applyCooldownAndEnd = async (now: number): Promise<void> => {
  applyCooldown(now)
  console.log('end send to LLM')
}
```

Don't use ternary when only one path does work:

```ts
const doThing = async (value): Promise<void> => {
  const prompts = await doSomething()

  return value ? doSomethingElse(value) : Promise.resolve()
}
```

Don't place statements after a return path:

```ts
const doThing = async (value): Promise<void> => {
  if (!value) {
    console.log('No value')
    return
  }
  await processValue(value)
}
```

Don't explain code with comments when function names can do it:

```ts
// Transform records to database format
const transformedEntries = records.map((entry) => {
  return transformEntry(entry, importRoute)
})
```

Instead:

```ts
const getEntriesInDatabaseFormat = (importRoute: string, entries: Entry[]) => {
  return entries.map((entry) => {
    return transformEntry(entry, importRoute)
  })
}

const transformedEntries = getEntriesInDatabaseFormat(importRoute, entries)
```

## TypeScript

- Prefer `type` over `interface`.
- Prefer inferred and derived types from Eden/RPC and local helpers. Do not invent parallel types when existing contracts already define them.
- Keep type definitions local.
- If you add explicit return types, reserve them for pure non-DB functions.
- Prefix intentionally unused vars with `_`.

## Imports

- Order imports as simple-import-sort expects: built-ins, external packages, internal aliases, parent relatives, same-directory relatives.

## Client And UI

- Layout-first UI: shell first, data later, no full-page spinner.
- Do not add auth, session, user, or admin requirements unless explicitly asked. Default to no-auth single-user behavior.
- Never suspend root `<Outlet />` or wrap an entire route in `<Suspense>`.
- Keep headers, nav, and containers outside async boundaries.
- For each `useQuery`, pick one loading model.
- Either use `suspense:false` with explicit `isLoading` and `isError` UI and never treat `undefined` as empty state, or use `suspense:true` with a small local `<Suspense fallback=...>` around the first data read.
- No `<Suspense>` without `fallback`.
- Client network goes through TanStack Query and Eden. Use `fetch` only when streaming, upload, or download forces it, inside the function that needs it.
- Use `splitProps` when destructuring props.
- Use `<Show>` and `<Switch>`/`<Match>` over JSX ternary.
- Use `<For>` and `<Index>` instead of `.map()` for lists.
- Use `useQuery` from `@tanstack/solid-query`, not `createQuery`.

## SolidJS Stale Data

- A stale read is a non-tracked snapshot of a reactive value. The code does not re-run on change, so the UI shows old data until the reactive source is read inside a tracking context.
- Common causes:

1. Reading outside a tracking context.
2. Destructuring props or stores.
3. Capturing values instead of accessors.
4. Async reads that are not tracked.
5. Intentional stale-while-revalidate data during refetch.

```ts
// Stale
const v = count()
setInterval(() => console.log(v), 1000)

// Fresh
setInterval(() => console.log(count()), 1000)
createEffect(() => console.log(count()))

// Stale
function User(p: {user: {name: string}}) {
  const {user} = p
  return <span>{user.name}</span>
}

// Fresh
function User(props) {
  return <span>{props.user.name}</span>
}

function UserWithAccessor(props) {
  const user = () => props.user
  return <span>{user().name}</span>
}

const [local] = splitProps(props, ['user'])
```

- Quick checks:

1. If the UI is stale but `console.log(signal())` shows fresh values, the read likely happened outside an effect, memo, or JSX.
2. If you destructured `props` or a store, switch back to direct reads, `splitProps`, or an accessor.
3. If a timeout, interval, or promise holds old values, call the accessor inside the callback.
4. If loader or resource data shows previous data during refetch, check loading state first. That can be expected behavior.

## API And Routes

- Route files use `src/server/routes/[resource]Routes.ts`.
- Routes use `/api/` plus the plural resource name.
- Prefer flat routes and request bodies over nested URL params.
- Use Eden/RPC on the client. Avoid `fetch` unless streaming, upload, or download requires it.
- Keep fetch logic local to the `useQuery` or mutation file. Do not create services files for it.
- For `t.File()` routes, Elysia `derive` does not propagate auth context. Read the session from `request.headers` inside the handler.

## Database

- Do not create Postgres migrations. Use the existing DuckDB SQL migration flow.
- Prefer the shared DuckDB services and helpers over ad hoc DB access.
- For local DuckDB work, never open the live DB file directly. Use `bun run db:studio`, `bun run db:query:snapshot -- --sql="..."`, or maintenance scripts with no running writer.
- For direct DuckDB CLI or manual work, always set a memory cap. Use `SET memory_limit = '20GB'` unless a smaller limit is needed.
- Use transactions for multi-table operations.
- Prefer `db.select()`, `db.insert()`, `db.update()`, and `db.delete()` over `db.execute()`.
- Use singular table names.
- Keep using the existing SQL migration files under `src/db/duckdbMigrations/`.

### Shared DuckDB Runtime Safety

- Foreground routes, cron jobs, queues, marts, and maintenance tasks share one constrained DuckDB runtime.
- Background jobs should not run unbounded scans over JSON, text, or historical tables.
- Scope background work by active rows, project, dirty token, cursor, batch limit, or an explicit time window.
- Persist relational keys and prefer compact lookup or projection tables for maintenance state.
- Raising `DUCKDB_MEMORY_LIMIT` is an emergency mitigation, not the root fix.

### Judgment Queries

- When querying judgments in a project context, always filter by model and content settings.
- The unique constraint is `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages) WHERE deletedAt IS NULL`.

```ts
const judgmentConfigCondition = and(
  eq(judgments.modelId, project.modelId),
  eq(judgments.useTitle, project.useTitle),
  eq(judgments.useAbstract, project.useAbstract),
  eq(judgments.useFulltext, project.useFulltext),
  eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
)
```

```ts
const judgmentConfigParts = projects.map((proj) => and(...))
const judgmentConfigCondition = or(...judgmentConfigParts)
```

## Validation And Errors

- Avoid `try`, `catch`, `finally`, and `throw` unless necessary.
- Use ArkType for runtime validation at API boundaries.
- Validate incoming request data before processing.

## Environment

- Do not rely on `.env` files for normal dev.
- Use `process.env`, not Bun's env.
- Keep secrets and values that must change outside the app in shell env or secret files.
- Keep shell env use limited to runtime wiring, machine-local paths, and secrets.
- If you start a local server or process for debugging, stop it before finishing or replying.

## Testing

- Place tests adjacent to the source file.
- Use exact boundary conditions.
- Use `bun test`.
- Use `mock.module()` when mocking modules.


<!-- headroom:rtk-instructions -->
# RTK (Rust Token Killer) - Token-Optimized Commands

When `rtk` is available on PATH, prefix shell commands with `rtk`. This reduces
context usage by 60-90% with zero behavior change. If `rtk` is unavailable,
run the underlying command directly instead of failing the task.

## Key Commands
```bash
# Git (59-80% savings)
rtk git status          rtk git diff            rtk git log

# Files & Search (60-75% savings)
rtk ls <path>           rtk read <file>         rtk grep <pattern>
rtk find <pattern>      rtk diff <file>

# Test (90-99% savings) — shows failures only
rtk pytest tests/       rtk cargo test          rtk test <cmd>

# Build & Lint (80-90% savings) — shows errors only
rtk tsc                 rtk lint                rtk cargo build
rtk prettier --check    rtk mypy                rtk ruff check

# Analysis (70-90% savings)
rtk err <cmd>           rtk log <file>          rtk json <file>
rtk summary <cmd>       rtk deps                rtk env

# GitHub (26-87% savings)
rtk gh pr view <n>      rtk gh run list         rtk gh issue list

# Infrastructure (85% savings)
rtk docker ps           rtk kubectl get         rtk docker logs <c>

# Package managers (70-90% savings)
rtk pip list            rtk pnpm install        rtk npm run <script>
```

## Rules
- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`
- For debugging, use raw command without rtk prefix
- `rtk proxy <cmd>` runs command without filtering but tracks usage
<!-- /headroom:rtk-instructions -->
