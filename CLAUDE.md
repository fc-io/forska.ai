---
alwaysApply: true
---
## Important

IMPORTANT: Avoid `try`, `catch`, `finally`, and `throw` unless absolutely necessary.
IMPORTANT: If there is only one export in a file, the filename must match the exported function's name.
IMPORTANT: On the server, prefer Drizzle ORM over executing plain SQL commands.
IMPORTANT: On the client/app, import `useQuery` from `@tanstack/solid-query` instead of using `createQuery`.
IMPORTANT: Keep filenames in PascalCase, including TSX/JSX React components.
IMPORTANT: Do not remove `debugger` statements or `console.log` unless explicitly asked (no matter what the linter says).

There is a `.env.local` file in the project, but you cannot read it because of security concerns. Always assume the `.env` files are correct unless `env.ts` throws an error. Use `process.env` instead of Bun's env functionality to stay compatible with ordinary Node.

## File structure

Components and other utility functions that are only used in one file should live in a subfolder with the same name as the parent file. Place the subfolder alongside the parent file (the routes folder is the only exception). Components in the subfolder should inherit the folder name as a prefix. Example:

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
├── types
└── utils
```


## Coding style

* IMPORTANT: Prefer a functional JavaScript style. Avoid `forEach` (use `map`, `filter`, `reduce`, etc.). Avoid classes; prefer data as objects and pure functions.
* IMPORTANT: Prefer function expressions using arrow functions.
* IMPORTANT: Use named module exports—never `export default`—and prefer the style `export const Subheader = () => { ... }` instead of exporting at the bottom of the file.
* IMPORTANT: Prefer `const` instead of `let`. If you reach for `let`, another assumption is probably wrong.
* IMPORTANT: Prefer recursive functions over `while`/`for` loops. Bun uses proper tail-call implementation, so recursion never grows the stack—use it instead of loops.
* IMPORTANT: Avoid declaring functions inside components unless absolutely necessary.
* IMPORTANT: Prefer to have only one return statement per function. A good approach is to return at the end of the function with a ternary and call a helper for each branch.
* IMPORTANT: Avoid nested `if`/`else` blocks. Instead, separate the code into additional functions.
* Prefer to handle all errors gracefully whenever possible.
* Keep code succinct and DRY—simplify code when possible.

* IMPORTANT: Don't add comments unless asked to. Instead, split complicated code into separate functions with clear function names.

### Ternary With Helpers

* Use case: Exactly two mutually exclusive paths with no shared tail logic.
* Rule: Prefer ending a function via ternary: `return cond ? pathA(optionalArg) : pathB(optionalArg)` or `return cond ? value : pathB(optionalArg)`.
* Rationale: Keeps a single return, flattens control flow, and makes intent self-documenting through function names.
* Requirements: Extract each branch into small, named helpers; both branches must return the same type; precompute shared inputs before the ternary.
* Shortcuts for ternaries are encouraged, like `return data ?? []` instead of `return data ? data : []`.
* Avoid: More than two branches, large inline expressions, or branches that share significant post-branch logic.
* Avoid: anonymous functions or arrow functions in the ternary.
* Avoid: nested (local) functions; create named functions at the root level (i.e., top-level helpers).
* Avoid: creating anonymous functions inside functions if the body spans more than three lines.
* Avoid: excessive function creation—do not call other functions from helpers that lack branching or meaningful logic.
* Avoid: returning when the function's result is `void`/`undefined`.
* Avoid: ternaries when one path returns `void`/`undefined`; use a regular `if` instead, e.g., `if (value) { return doThing(value) }`.
* Avoid: ternaries when both paths return `void`/`undefined`; use an `if`/`else` instead, e.g., `if (value) { console.log(value) } else { doThing() }`.
* Avoid: placing statements or function calls after a `return`.

#### Example – Do

Do:

`return cond ? buildA(x) : buildB(x)`

or

`return cond ? value : buildB(x)`


#### Example – Don't

Don't create functions that offer no additional value. This function has a log statement, but that could easily be placed in the caller or inside `applyCooldown`. Other than the log, there is no reason for `applyCooldownAndEnd` to exist.

```
const applyCooldownAndEnd = async (
  now: number,
): Promise<void> => {
  applyCooldown(now)
  console.log('end send to LLM')
}
```

Another don't: avoid ternaries when only one branch does anything. There is also no need to return if the function returns `void`. Instead, use `if (value) { await doSomethingElse(value) }` and skip the `return`.

```
const doThing = async (value): Promise<void> => {
  const prompts = await doSomething()

  return value ? doSomethingElse(value) : Promise.resolve()
}
```

Another don't: never place statements or function calls after a `return`.

```
const doThing = async (value): Promise<void> => {
  if (!value) {
    console.log('No value')
    return
  }
  await processValue(value)
}
```

### TypeScript conventions

* IMPORTANT: Prefer `type` over `interface` for type definitions.
* Use explicit return types for functions when the return type is not immediately obvious.
* Prefer type unions and intersections over complex inheritance patterns.

### Import organization

* Order imports as follows (automatically handled by eslint-plugin-simple-import-sort):
  1. Node/Bun built-in modules
  2. External packages
  3. Internal aliases and absolute imports
  4. Relative imports from parent directories
  5. Relative imports from the same directory

### Component patterns (SolidJS)

* Use `splitProps` when destructuring component props to maintain reactivity.
* Prefer `createSignal` for simple local state, `createStore` for complex nested state.
* Use `createMemo` for expensive computed values.
* Prefer `Show` and `Switch`/`Match` over ternary operators in JSX.
* Use `For` and `Index` components for lists instead of `.map()`.
* When a component or its related utilities exceed 100 lines, extract them into a subfolder following the file structure conventions.

## Platform and tools

* IMPORTANT: Stack built on Drizzle with Postgres on the server, Bun, Vite, Solid, Tailwind, TanStack Router, `@tanstack/solid-query`, `date-fns`, and Elysia (with `@elysiajs/cron`).

Default to using Bun instead of Node.js.

- Use `bunx` instead of `npx`
- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Linting/formatting

Don't try to fix linting issues unrelated to the task at hand. Remember the earlier rule: do not remove `debugger` statements or `console.log` unless explicitly asked (no matter what the linter says).

We use `eslint-plugin-prettier`, so there is no need to run Prettier separately.

- Use `bun run lint` to see linting errors.
- Use `bun run lint:fix` to fix linting issues.

## API/Route naming conventions

* Server routes use the `/api/` prefix followed by the resource name in plural (e.g., `/api/projects`, `/api/users`).
* Use RESTful conventions: GET for reading, POST for creating, PUT/PATCH for updating, DELETE for removing.
* Route files should be named in camelCase, like `[resource]Routes.ts` (e.g., `projectsRoutes.ts`, `authRoutes.ts`).
* Complex route logic should be extracted to separate files in a subfolder (e.g., `projectsRoutes/projectsRoutesGetArticlesReviews.ts`). In general, any route logic over 15 lines should be in a separate file.
* Use Elysia framework patterns for route definitions.
* IMPORTANT: Do not nest routes—prefer flat route structures with POST requests and body parameters over nested URL paths.
* IMPORTANT: Always use Eden/RPC on the client; never use `fetch` directly.
* IMPORTANT: Prefer POST requests with a body over complex nested URL parameters.

## Database patterns

* IMPORTANT: Always use Drizzle ORM query builder methods instead of raw SQL.
* Use transactions for operations affecting multiple tables.
* Prefer `db.select()`, `db.insert()`, `db.update()`, `db.delete()` over `db.execute()`.
* Use prepared statements for frequently executed queries.
* Handle database errors with proper logging and user-friendly messages.

## Data validation

* Use ArkType for runtime type validation at API boundaries when working above the Eden/RPC/Elysia stack.
* Validate all incoming request data before processing.
* Use ArkType's composable type definitions to ensure consistency across the codebase.
* Define validation schemas close to where they're used.

## Testing

When writing tests, try to target exact boundary conditions. Use `bun test` to run tests.

```ts
import {test, expect} from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
