---
alwaysApply: true
---

## Important

IMPORTANT: when writing plans or md files in general; be extremely concise. Sacrifice grammar for the sake of concision.
IMPORTANT: Please don't create postgres migration files for me. Prefer the existing DuckDB SQL migration flow (`bun db:mig`) when schema changes are needed.
IMPORTANT: We use Eden/RPC so derive the types from the API when possible and don't make up new types.
IMPORTANT: I don't like try, catch, finally, throw. Only use when absolutely necessary.
IMPORTANT: Prefer `effect` for new non-trivial async/server flow so control flow, resources, retries, and failures stay explicit.
IMPORTANT: Layout-first UI (shell first; data later; no full-page spinner)
IMPORTANT: Do not add auth/session/user/admin requirements unless explicitly asked. Default to no-auth single-user behavior.

- Never suspend root `<Outlet />` or wrap an entire route in `<Suspense>`
- Keep headers/nav/containers outside any async boundary
- Per `useQuery`: pick ONE loading model
  - (Recommended) `suspense:false` + explicit `isLoading/isError` UI; never treat `undefined` as empty state
  - (Allowed) `suspense:true` + _small_ local `<Suspense fallback=...>` around the FIRST `data` read
- No `<Suspense>` without `fallback`
- Client network via TanStack Query + Eden; `fetch` only if streaming/upload/download forces it (inside mutationFn)

See `plans/old/LOCAL_FIRST_PLAN.md`.

IMPORTANT: Avoid branching. If something can be done without, please do without. For example have an type ArrayThatWillLop = array and initalize with an empty array, instead of type LopIfArray = [] | null.
IMPORTANT: If there is only one export in a file, then the filename should match the name of the exported function
IMPORTANT: On the server – prefer the shared DuckDB service/query helpers over ad hoc DB access
IMPORTANT: For local DuckDB work, never open the live DB file directly. Use `bun run db:studio`, `bun run db:query:snapshot -- --sql="..."`, or maintenance scripts with no running writer.
IMPORTANT: On the client/app – use import {useQuery} from '@tanstack/solid-query' over createQuery
IMPORTANT: only have secrets and values we need to change from outside the app in shell env or secret files.
IMPORTANT: Keep filenames camelCase, even for TSX/JSX React components.
IMPORTANT: Never run DuckDB without an explicit memory cap. Use `SET memory_limit = '20GB'` as the default for direct DuckDB CLI/manual work unless a smaller limit is needed.
IMPORTANT: If you start a local server/process for debugging, stop it before finishing or replying.
Do not rely on `.env` files for normal dev. Pass shell env inline/exported when needed. Use process.env instead of Bun's env functionality to stay compatible with ordinary Node.

## File structure

- IMPORTANT: Keep filenames camelCase, even for TSX/JSX React components.

Components and other util functions that are only used in one file should be saved into a subfolder with the same name as the file it's owned by. The subfolder should be in the same folder as the file (only the folder that holds the routes is an exception). The components in the subfolder should inherit as a prefix the name of the folder. Example:

```
src
├── components
│   ├── main
│   │   ├── subheader
│   │   │   └── subheaderSettingsPanel
│   │   │   │   └── subheaderSettingsPanelDateRangePicker.tsx
│   │   │   └── subheaderSettingsPanel.tsx
│   │   ├── subheader.tsx
│   │   └── unassessedArticles.tsx
│   └── ui
├── lib
└── utils
```

## Coding style

- IMPORTANT: Prefer a functional JavaScript style. Avoid forEach (prefer map, filter, reduce, etc.). Avoid classes (prefer data as objects and pure functions).
- IMPORTANT: Prefer function expressions using arrow functions.
- IMPORTANT: Prefer named module exports (no `export default ...`)
- IMPORTANT: Prefer const instead of let. If you reach for let, some other assumption is probably wrong.
- IMPORTANT: Prefer recursive functions over while/for loops. Bun uses a proper tail-call implementation, so the recursion never grows the stack – use that to code recursive functions and not while/for loops.
- IMPORTANT: Prefer to use named exports in this format `export const Subheader = () => {...` over `const Subheader = () => {...; export {Subheader}`.
- IMPORTANT: Prefer to not declare functions inside components unless you have to.
- IMPORTANT: Prefer to only have one return statement per function. Often, a good way to achieve this is by using a return at the end of the function with a ternary and calling a different function for each path of the ternary.
- IMPORTANT: Avoid nested if/else in a function. Instead, separate code into more functions.
- IMPORTANT: For multi-step async server code, prefer `Effect.gen` over long promise chains.
- IMPORTANT: Prefer `Effect.acquireRelease`/`Scope` for resource lifetime and cleanup.
- IMPORTANT: Prefer `Layer`/`Context` for wiring services like DB access, leases, clients, and runtimes.
- IMPORTANT: Prefer `Schedule` for retries, polling, and backoff over hand-rolled timers.
- Keep pure transforms and very small local handlers as plain functions; don't force Effect everywhere.
- Prefer to handle all errors and throws gracefully if it is easily possible.
- Try to keep code succinct and DRY – simplify code if possible.
- IMPORTANT: Use singular table names when creating new database tables.
- IMPORTANT: Do not remove debugger statements nor console.log unless explicitly asked (no matter what the linter says).
- IMPORTANT: Don't add comments unless asked to. Instead, split out complicated code into separate functions with clear function names.
- Avoid writing one line comments. Instead restructure any complicated code into its own function/component and name the function in a way that helps explain the intent of the code.

### Ternary With Helpers

- Use case: Exactly two mutually exclusive paths with no shared tail logic.
- Rule: Prefer ending a function via ternary: `return cond ? pathA(optionalArg) : pathB(optionalArg)` or `return cond ? value : pathB(optionalArg)`
- Rationale: Keeps a single return, flattens control flow, and makes intent self-documenting through function names.
- Requirements: Extract each branch into small, named helpers; both branches must return the same type; precompute shared inputs before the ternary.
- Shortcuts for ternaries are encouraged, like having `return data ?? []` instead of `return data ? data : []`
- Avoid: More than two branches, large inline expressions, or branches that share significant post-branch logic.
- Avoid: anonymous functions/arrow functions in the ternary.
- Avoid: nested (local) functions (instead create named functions on the root level – i.e top-level helpers)
- Avoid: creating anonymous functions inside functions if the body of the anonymous functions is more than 3 rows
- Avoid: excessive function creation – i.e. calling other functions from functions that don't have a ternary/branching path or functions that don't do anything by themselves
- Avoid: having a return when only returning void/undefined
- Avoid: having a ternary when one path returns void/undefined, instead have a normal if like `if (value) {return doThing(value)}`
- Avoid: having a ternary when both paths return void/undefined, instead have a normal if else like `if (value) {console.log(value)} else {doThing()}`
- Avoid: having any statements or function calls after a return

#### Example – Do

Do:

`return cond ? buildA(x) : buildB(x)`

or

`return cond ? value : buildB(x)`

#### Example – Don't

Don't create functions from functions that don't do anything. This function has a log statement, but that
could easily be placed in the function that called applyCooldownAndEnd or in the applyCooldown function. Other than the
log, there is no need to have this `applyCooldownAndEnd` function at all.

```
const applyCooldownAndEnd = async (
  now: number,
): Promise<void> => {
  applyCooldown(now)
  console.log('end send to LLM')
}
```

Another don't. Don't use ternary if there is only one path and nothing will happen in the other path. There is also no need to
have a return if there is nothing to return (void). Here, instead, do a normal `if (value) {await doSomethingElse(value)}`
and skip the return.

```
const doThing = async (value): Promise<void> => {
  const prompts = await doSomething()

  return value ? doSomethingElse(value) : Promise.resolve()
}
```

Another don't. Don't have statements or function calls after a return.

```
const doThing = async (value): Promise<void> => {
  if (!value) {
    console.log('No value')
    return
  }
  await processValue(value)
}
```

#### Example

Don't explain code with comments, like:

```
// Transform records to database format
const transformedEntries = records.map((entry) => {
  return transformEntry(entry, importRoute)
})
```

Instead explain by making use of function names, like:

```
const getEntriesInDatabaseFormat(importRoute: string, entries: Entry[]) => {
  return entries.map((entry) => {
    return transformEntry(entry, importRoute)
  })
}

const transformedEntries = getEntriesInDatabaseFormat(importRoute, entries)
```

### TypeScript conventions

- IMPORTANT: Prefer `type` over `interface` for type definitions
- IMPORTANT: Prefer inferred/derived types over explicit ones – do not define a type when it can be derived from existing helpers or API contracts.
- Use explicit return types for functions when the return type is not immediately obvious (but only do this for pure functions, and functions that don't call the DB)
- Prefer type unions and intersections over complex inheritance patterns

- IMPORTANT: Avoid shared type definition files – try to keep type definitions local.

### Import organization

- Order imports as follows (automatically handled by eslint-plugin-simple-import-sort):
  1. Node/Bun built-in modules
  2. External packages
  3. Internal aliases and absolute imports
  4. Relative imports from parent directories
  5. Relative imports from the same directory

### Component patterns (SolidJS)

- Use `splitProps` when destructuring component props to maintain reactivity
- Prefer `createSignal` for simple local state, `createStore` for complex nested state
- Use `createMemo` for expensive computed values
- Prefer `Show` and `Switch`/`Match` over ternary operators in JSX
- Use `For` and `Index` components for lists instead of `.map()`
- When a component or its related utilities exceed 100 lines, extract them into a subfolder following the file structure conventions

## Platform and tools

- IMPORTANT: Stack built on DuckDB-native server helpers, Bun, Vite, Solid, Tailwind, TanStack Router, @tanstack/solid-query, date-fns, Elysia (for server) with @elysiajs/cron installed.

Default to using Bun instead of Node.js.

- Use `bunx` instead of `npx`
- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Do not add dotenv.

## Linting/formatting

Don't try to fix linting issues unrelated to the task you are trying to accomplish. Don't remove debugger statements or console.log unless explicitly asked (no matter what the linter says).

We use "eslint-plugin-prettier" so there is no need to run prettier separately.

- Use `bun run lint` to see linting errors
- Use `bun run lint:fix` to fix linting issues

## API/Route naming conventions

- Server routes use `/api/` prefix followed by resource name in plural (e.g., `/api/projects`, `/api/users`)
- Use RESTful conventions: GET for reading, POST for creating, PUT/PATCH for updating, DELETE for removing
- Route files should be named in camelCase like `[resource]Routes.ts` (e.g., `projectsRoutes.ts`, `authRoutes.ts`)
- Complex route logic should be extracted to separate files in a subfolder (e.g., `projectsRoutes/projectsRoutesGetArticlesReviews.ts`). In general, any route logic over 15 lines should be in a separate file.
- Use Elysia framework patterns for route definitions.
- IMPORTANT: Do not nest routes – prefer flat route structures with POST requests and body parameters over nested URL paths
- IMPORTANT: Always use Eden/RPC on the client; avoid fetch. Exception: streaming/upload/download; fetch ok inside TanStack mutationFn.
- Try to keep fetch logic local (in the same file) to the tanstack useQuery. Avoid creating services files for the fetch logic.
- IMPORTANT: Prefer POST with request body over complex nested URL parameters

### Elysia file upload routes

- IMPORTANT: Elysia's `derive` middleware does not propagate context for routes with `t.File()` body schemas. For file upload routes, fetch the session directly from `request.headers` inside the handler instead of relying on `sessionUserId` from auth guard middleware.

## Database patterns

- IMPORTANT: Always prefer the shared DuckDB services/helpers over ad hoc SQL in route handlers
- Use transactions for operations affecting multiple tables
- Prefer `db.select()`, `db.insert()`, `db.update()`, `db.delete()` over `db.execute()`
- Use prepared statements for frequently executed queries
- Handle database errors with proper logging and user-friendly messages

### Database migrations

- IMPORTANT: Prefer the existing SQL migration files under `src/db/duckdbMigrations/`; don't invent a second migration system.

### Judgment queries (model + content filtering)

- IMPORTANT: When querying judgments in the context of a project, ALWAYS filter by model AND content settings. Judgments store which content was used (`useTitle`, `useAbstract`, `useFulltext`, `useFulltextNoImages`) and which model made the judgment (`modelId`). If you don't filter by these, you may include judgments from a different model or content configuration.
- The unique constraint on judgments is: `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages) WHERE deletedAt IS NULL`
- Example pattern for filtering by project settings:

```typescript
const judgmentConfigCondition = and(
  eq(judgments.modelId, project.modelId),
  eq(judgments.useTitle, project.useTitle),
  eq(judgments.useAbstract, project.useAbstract),
  eq(judgments.useFulltext, project.useFulltext),
  eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
)
```

- When querying across multiple source projects, use OR logic for the configurations:

```typescript
const judgmentConfigParts = projects.map((proj) => and(...))
const judgmentConfigCondition = or(...judgmentConfigParts)
```

## Data validation

- Use ArkType for runtime type validation at API boundaries when working above the Eden/RPC/Elysia stack
- Validate all incoming request data before processing
- Use ArkType's composable type definitions to ensure consistency across the codebase
- Define validation schemas close to where they're used

## Testing

When writing tests, try to use the exact boundary condition. Use `bun test` to run tests.

```ts
import {test, expect} from 'bun:test'

test('hello world', () => {
  expect(1).toBe(1)
})
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Solid.js stale data

Here’s the short, practical way to think about stale data in solid.js:

### How to _describe_ stale data in SolidJS

A stale read is a non-tracked snapshot of a reactive value – the code doesn’t re-run on change, so the UI shows old data until you read the reactive source inside a tracking context.

**“Stale data” in SolidJS** = your UI or computation shows an out-of-date value because the read wasn’t _reactively tracked_ or you broke the connection to the reactive source. Solid’s updates flow only to code that _reads_ reactive values (signals, memos, stores, resources) inside a tracking context (effects, memos, JSX). If you read them the “wrong” way, you get a snapshot that never updates – i.e., stale. ([solidjs.com][1])

### The common ways you get stale data (and the fixes)

1. **Reading outside a tracking context**
   If you pull a signal value in plain code (module scope, untracked function, inside a later async callback) Solid won’t know to re-run that code. Read inside `createEffect`, a `createMemo`, or JSX – or explicitly track with helpers. ([solidjs.com][1])

```ts
// Stale
const v = count()
setInterval(() => console.log(v), 1000)

// Fresh
setInterval(() => console.log(count()), 1000) // read accessor at use time
createEffect(() => console.log(count())) // tracked
```

2. **Destructuring props / stores** (breaks reactivity)
   `props` and stores are proxies. Destructuring extracts plain values and severs reactivity – you’ll hold an old snapshot. Use `props.x` directly, wrap in an accessor, or `splitProps`. ([docs.solidjs.com][2])

```ts
// Stale
function User(p:{user:{name:string}}){ const { user } = p; return <span>{user.name}</span> }

// Fresh
function User(props){ return <span>{props.user.name}</span> }
// or
function User(props){ const user = () => props.user; return <span>{user().name}</span> }
// or
const [local] = splitProps(props, ["user"]); <span>{local.user.name}</span>
```

3. **Capturing values instead of accessors** (stale closures)
   Solid’s setters are safe, but if you _store the value_ (`const n = count()`) and reuse it later, it won’t change. Keep and call the accessor (`count`) when you need the current value. ([DEV Community][3])

4. **Async reads not tracked**
   Dependencies are collected during the synchronous run of an effect/memo. Reads that happen later in a Promise/timeout aren’t added as deps – the effect won’t re-run when they change. Ensure the signals are read during the effect’s sync run or restructure with `on(...)` / separate effects. ([solidjs.com][1])

5. **Intentional “stale-while-revalidate” resource data**
   With `createResource` (and router queries), you can _show the previous data while new data loads_ – this is _expected_ staleness. Use `resource.loading` and `resource.latest` to manage it. ([docs.solidjs.com][4])

### What to look for (quick debugging checklist)

- **UI doesn’t change but `console.log(signal())` shows the new value** – likely read happened outside an effect/memo/JSX. Add a `createEffect(() => console.log(signal()))` nearby; if it never logs again, you’re not tracking. ([solidjs.com][1])
- **You destructured `props` or a store** – revert to `props.x`, `splitProps`, or wrap in an accessor. ([docs.solidjs.com][2])
- **Intervals/timeouts/promises hold old numbers/objects** – don’t cache values; call the accessor inside the callback. ([DEV Community][3])
- **Server/loader data shows previous result during refetch** – check `data.loading` and `data.latest`; that’s SWR by design. ([docs.solidjs.com][4])

If you paste a snippet that’s acting “stale”, I’ll point to the exact read that lost tracking and show the minimal fix.

[1]: https://www.solidjs.com/guides/reactivity?utm_source=chatgpt.com 'Guides:Reactivity'
[2]: https://docs.solidjs.com/concepts/components/props?utm_source=chatgpt.com 'Props'
[3]: https://dev.to/aderchox/lets-learn-solidjs-quickly-by-creating-a-usedebounce-hook-3hf0?utm_source=chatgpt.com "Let's learn Solid.js quickly, by creating a useDebounce hook"
[4]: https://docs.solidjs.com/reference/basic-reactivity/create-resource?utm_source=chatgpt.com 'createResource'
