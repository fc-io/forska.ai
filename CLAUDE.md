---
alwaysApply: true
---
## Important

IMPORTANT: I don't like try, catch, finally, throw. Only use when absolutely necessary.
IMPORTANT: if there only is one export in a file, than the filename should match the name of the exported function
IMPORTANT: on the server – prefer drizzle orm over executing pure sql commands
IMPORTANT: on the client/app - use import {useQuery} from '@tanstack/solid-query' over createQuery
IMPORTANT: Keep filenames pascal case. Even for tsx/jsx react components.
there is an .env.local file in the project, you just can't read it because of security concerns. Always assume the .env files are correct unless the env.ts file throws an error. Use process.env instead of buns env functionaltiy to stay compatible with ordinary node.


## File structure

* IMPORTANT: Keep filenames pascal case. Even for tsx/jsx react components.

Components and other util functions that are only used in one file should be saved into a subfolder with the same name as the file its owned by. The subfolder should be in the same folder as the file (only the folder that holds the routes are an exemption). The components in subfolder should inherit as a prefix the name of the folder. Example:

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

* IMPORTANT: Prefer a functional javascript style. Avoid forEach (prefer map, filter, reduce etc.). Avoid classes (prefer data as objects and pure functions).
* IMPORTANT: Prefer function expressions using arrow functions.
* IMPORTANT: Prefer named module exports (no `export default ...`)
* IMPORTANT: Prefer const instead of let. If you reach for let some other assumption is probably wrong.
* IMPORTANT: Prefer recursive functions over while/for loops. Bun uses proper-tail-call implementation, so the recursion never grows the stack – use that do code recursive functions and not while/for loops.
* IMPORTANT: Prefer to use named exports in this format `export const Subheader = () => {...` over `const Subheader = () => {...; export {Subheader}`.
* IMPORTANT: Prefer to not declare functions inside components unless you have to.
* IMPORTANT: Prefer to only have one return statement per function. Often a good way to achive this is by using a return at the end of the function with a ternary and calling a different function for each path of the ternary.
* IMPORTANT: Avoid nested if/else in a function. Instead seperate code into more functions.
* Prefer to handle all errors and throws gracefully if easily possible.
* Try to keep code succinct and DRY – simplify code if possible.

* IMPORTANT: Do not remove debugger statements nor console.log unless explicitly asked (no matter what the linter says).
* IMPORTANT: don't add comments, unless asked to. Instead split out complicated code into seperate functions with clear function names.

### Ternary With Helpers

* Use-case: Exactly two mutually exclusive paths with no shared tail logic.
* Rule: Prefer ending a function via ternary: `return cond ? pathA(optionalArg) : pathB(optionalArg)` or `return cond ? value : pathB(optionalArg)`
* Rationale: Keeps a single return, flattens control flow, and makes intent self-documenting through function names.
* Requirements: Extract each branch into small, named helpers; both branches must return the same type; precompute shared inputs before the ternary.
* Shortcuts for ternaries are encouraged, like having `return data ?? []` instead of `return data ? data : []`
* Avoid: More than two branches, large inline expressions, or branches that share significant post-branch logic.
* Avoid: anonymous functions/arrow functions in the ternary.
* Avoid: avoid nested (local) functions (instead create named functions on the root level – i.e top-level helpers)
* Avoid: creating anonymous functions inside functions if the body of the anonymous functions is more than 3 rows
* Avoid: excesive function creation – i.e. calling other functions from functions that don't have a ternary/branching path or functions that don't do anything by themselves
* Avoid: having a return when only returning void/undefined
* Avoid: having a ternary when one path returns void/undefined, instead have a normal if like `if (value) {return doThing(value)}`
* Avoid: having a ternary when both pathes returns void/undefined, instead have a normal if else like `if (value) {console.log(value)} else {doThing()}`
* Avoid: having any statements or function calls after a return

#### Example – Do

Do:

`return cond ? buildA(x) : buildB(x)`

or

`return cond ? value : buildB(x)`


#### Example – Don't

Don't create functions from functions that don't do anything. This functions has a log statement, but that
could easily be placed in the function that called applyCooldownAndEnd or in the applyCooldown function. Other than the
log there is no need to have this `applyCooldownAndEnd` function at all.

```
const applyCooldownAndEnd = async (
  now: number,
): Promise<void> => {
  applyCooldown(now)
  console.log('end send to LLM')
}
```

Another don't. Don't use ternary if there is only one path and nothing will happen in the other path. Also no need to
have a return if there is nothing to return (void). Here instead do a normal `if (value) {await doSomethingElse(value)}`
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

### TypeScript conventions

* IMPORTANT: Prefer `type` over `interface` for type definitions
* Use explicit return types for functions when the return type is not immediately obvious
* Prefer type unions and intersections over complex inheritance patterns

* IMPORTANT: Avoid shared type definition files – try to keep type definitions local.
* IMPORTANT: Prefer inferred/derived types over explicit ones – do not define a type when it can be derived. Especially try to infer types from the drizzle src/db/schema.ts.

### Import organization

* Order imports as follows (automatically handled by eslint-plugin-simple-import-sort):
  1. Node/Bun built-in modules
  2. External packages
  3. Internal aliases and absolute imports
  4. Relative imports from parent directories
  5. Relative imports from the same directory

### Component patterns (SolidJS)

* Use `splitProps` when destructuring component props to maintain reactivity
* Prefer `createSignal` for simple local state, `createStore` for complex nested state
* Use `createMemo` for expensive computed values
* Prefer `Show` and `Switch`/`Match` over ternary operators in JSX
* Use `For` and `Index` components for lists instead of `.map()`
* When a component or its related utilities exceed 100 lines, extract them into a subfolder following the file structure conventions

## Platform and tools

* IMPORTANT: Stack built on drizzle with postgres on the server, Bun, Vite, solid, tailwind, tanstack-router, @tanstack/solid-query, date-fns, elysia (for server) with @elysiajs/cron installed.

Default to using Bun instead of Node.js.

- Use `bunx` instead of `npx`
- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Linting/formating

Don't try to fix linting issues unrelated to the task you are trying to accomplish. Don't remove debugger statements or console.log unless explicitly asked (no matter what the linter says).

We use "eslint-plugin-prettier" so no need to run prettier separately.

- Use `bun run lint` to see linting errors
- Use `bun run lint:fix` to fix linting issues

## API/Route naming conventions

* Server routes use `/api/` prefix followed by resource name in plural (e.g., `/api/projects`, `/api/users`)
* Use RESTful conventions: GET for reading, POST for creating, PUT/PATCH for updating, DELETE for removing
* Route files should be named in camelCase like `[resource]Routes.ts` (e.g., `projectsRoutes.ts`, `authRoutes.ts`)
* Complex route logic should be extracted to separate files in a subfolder (e.g., `projectsRoutes/projectsRoutesGetArticlesReviews.ts`). In general any route logic over 15 lines should be in a seperate file.
* Use Elysia framework patterns for route definitions.
* IMPORTANT: Do not nest routes - prefer flat route structures with POST requests and body parameters over nested URL paths
* IMPORTANT: Always use Eden/RPC on the client, never use fetch directly
* IMPORTANT: Prefer POST with request body over complex nested URL parameters

## Database patterns

* IMPORTANT: Always use Drizzle ORM query builder methods instead of raw SQL
* Use transactions for operations affecting multiple tables
* Prefer `db.select()`, `db.insert()`, `db.update()`, `db.delete()` over `db.execute()`
* Use prepared statements for frequently executed queries
* Handle database errors with proper logging and user-friendly messages

## Data validation

* Use ArkType for runtime type validation at API boundaries when working above the Eden/RPC/Elysia stack
* Validate all incoming request data before processing
* Use ArkType's composable type definitions to ensure consistency across the codebase
* Define validation schemas close to where they're used

## Testing

When writing tests try to use the exact boundary condition. Use `bun test` to run tests.

```ts
import {test, expect} from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
