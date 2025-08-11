---
alwaysApply: true
---
## Important

IMPORTANT: on the server – prefer drizzle orm over executing pure sql commands
IMPORTANT: on the client/app - use import {useQuery} from '@tanstack/solid-query' over createQuery
IMPORTANT: Keep filenames pascal case. Even for tsx/jsx react components.
there is an .env.local file in the project, you just can't read it beacuse of secuity concerns. Always assume the .env files are correct unless the env.ts file throws an error. Use process.env instead of buns env functionaltiy to stay compatible with ordinary node.

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
* IMPORTANT: Prefer recursive functions over while/for loops. Bun uses proper‑tail‑call implementation, so the recursion never grows the stack – use that do code recursive functions and not while/for loops.
* IMPORTANT: Prefer to use named exports.
* IMPORTANT: Prefer to use `export const Subheader = () => {...` over `const Subheader = () => {...; export {Subheader}`
* IMPORTANT: Prefer to not declare functions inside components unless you have to.
* IMPORTANT: Prefer tp only have one return statement per functions
* Prefer to handle all errors and throws gracefully if easily possible.
* Try to keep code succinct and DRY – simplify code if possible.

* IMPORTANT: Do not remove debugger statements nor console.log unless explicitly asked (no matter what the linter says).
* IMPORTANT: don't add comments, unless asked to. Instead split out complicated code into seperate functions with clear function names.

## Platform and tools

* IMPORTANT: Stack built on drizzle with postgres (in docker), Bun, Vite, solid, tailwind, tanstack-router, @tanstack/solid-query.

Default to using Bun instead of Node.js.

- Use `bunx` instead of `npx`
- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Linting/formating

Don't try to fix liniting issues unrelated to the task you are trying to accomplish. Don't remove debugger statements or console.log unless explicitly asked (no matter what the linter says).

We use "eslint-plugin-prettier" so no need to run prettier seperatly.

- Use `bun run lint` to see linting errors
- Use `bun run lint:fix` to fix linting issues

## Testing

When writing tests try to use the exact boundary condition. Use `bun test` to run tests.

```ts
import {test, expect} from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
