# Forska.ai — Agent Handbook

## Precedence

1. Always read [`CLAUDE.md`](./CLAUDE.md) before touching the codebase — it contains non-negotiable style rules.
2. If a more specific `AGENTS.md` exists deeper in the tree, defer to it for files you modify.

---

## Build / Lint / Test Commands

```bash
# Install dependencies (NEVER use npm/yarn/pnpm)
bun install

# Development servers
bun run dev:server          # API (Elysia) with hot reload
bun run dev:app             # SolidJS client (Vite)

# Production build + preview
bun run build               # Vite build
bun run preview             # Serve built app

# Linting (Prettier is integrated via eslint-plugin-prettier)
bun run lint                # Check errors
bun run lint:fix            # Auto-fix

# Testing (Bun's built-in test runner)
bun test                    # Run all tests
bun test path/to/file.test.ts          # Single file
bun test --watch            # Watch mode
bun test --grep "pattern"   # Filter by name

# Database (Drizzle ORM + PostgreSQL)
bun run db:gen              # Generate migration from schema changes
bun run db:mig              # Apply migrations
bun run db:seed             # Seed database
bun run db:studio           # Drizzle Studio UI
```

---

## Repository Map

| Path                        | Description                     |
| --------------------------- | ------------------------------- |
| `src/server/`               | Elysia API, routes in `routes/` |
| `src/app/`                  | SolidJS client                  |
| `src/components/`           | Shared UI components            |
| `src/utils/`, `src/stores/` | Helpers, state                  |
| `src/db/`                   | Drizzle schema, migrations      |
| `docs/`                     | Domain documentation            |
| `scripts/`                  | CLI utilities, DB ops           |

---

## Code Style Guidelines

### General Principles

- **Functional style** — prefer `map`, `filter`, `reduce` over `forEach`; avoid classes (use objects + pure functions)
- **Arrow functions** — use function expressions: `const foo = () => { ... }`
- **Named exports only** — `export const Foo = ...` (no `export default`)
- **`const` over `let`** — if you reach for `let`, rethink the approach
- **Recursion over loops** — Bun has proper tail-call optimization; avoid `while`/`for`
- **Single return per function** — use ternary + helper functions: `return cond ? buildA(x) : buildB(x)`
- **Avoid nested if/else** — split into separate functions
- **No comments** — use descriptive function names instead
- **Keep `debugger`/`console.log`** — don't remove unless explicitly asked

### Ternary Patterns

```ts
// DO: single return with ternary
return isValid ? processData(input) : handleError(input)

// DON'T: ternary when one path is void
// Instead: if (value) { return doThing(value) }

// DON'T: statements after return
```

### TypeScript

- **`type` over `interface`** — always prefer type aliases
- **Infer types** — derive from Drizzle schema, Eden/RPC; avoid manual type definitions
- **No shared type files** — keep types local to usage
- **Explicit returns only for pure functions** — skip for DB-calling functions
- **Unused vars** — prefix with `_` (e.g., `_unused`)

### Imports (auto-sorted by eslint-plugin-simple-import-sort)

```ts
// 1. Node/Bun built-ins
// 2. External packages
// 3. Internal aliases (~/...)
// 4. Relative parent (..)
// 5. Relative same dir (.)
```

### File Structure

- **Filenames**: camelCase, even for TSX (e.g., `subheaderSettingsPanel.tsx`)
- **Single export** → filename matches exported name
- **Subfolders for related code**: components used only by `foo.tsx` go in `foo/fooHelper.tsx`

```
src/components/main/
├── subheader/
│   ├── subheaderSettingsPanel/
│   │   └── subheaderSettingsPanelDateRangePicker.tsx
│   └── subheaderSettingsPanel.tsx
└── subheader.tsx
```

---

## SolidJS Patterns

- Use `splitProps` when destructuring props to preserve reactivity
- Prefer `createSignal` for simple state, `createStore` for nested
- Use `createMemo` for expensive computations
- Use `<Show>`, `<Switch>`/`<Match>` over ternary in JSX
- Use `<For>`/`<Index>` instead of `.map()` for lists
- Use `import { useQuery } from '@tanstack/solid-query'` (not `createQuery`)
- Extract components >100 lines into subfolders

### Reactivity Gotchas

```ts
// Stale: reading outside tracking context
const v = count(); setInterval(() => console.log(v), 1000)
// Fresh: read inside callback
setInterval(() => console.log(count()), 1000)

// Stale: destructuring props
const { user } = props; return <span>{user.name}</span>
// Fresh: access directly
return <span>{props.user.name}</span>
```

---

## API / Routes

- Route files: `src/server/routes/[resource]Routes.ts` (camelCase)
- URL prefix: `/api/` + plural resource (e.g., `/api/projects`)
- **Flat routes** — prefer POST + body over nested URL params
- **Eden/RPC only** — never use `fetch` directly on client
- Keep fetch logic local to `useQuery` calls; no services files
- Extract handlers >15 lines to `[route]/[route]Handler.ts`

### Elysia File Uploads

`derive` middleware doesn't propagate for `t.File()` routes — fetch session from `request.headers` directly.

---

## Database (Drizzle + PostgreSQL)

- **Drizzle ORM only** — no raw SQL, no `db.execute()`
- Use `db.select()`, `db.insert()`, `db.update()`, `db.delete()`
- Transactions for multi-table ops
- **Singular table names** (e.g., `article`, not `articles`)
- Generate migrations: `bun run db:gen` then `bun run db:mig`

### Judgment Queries

Always filter by model AND content settings:

```ts
const condition = and(
  eq(judgments.modelId, project.modelId),
  eq(judgments.useTitle, project.useTitle),
  eq(judgments.useAbstract, project.useAbstract),
  // ...
)
```

---

## Testing

Tests use Bun's test runner with `bun:test`:

```ts
import {test, expect, mock} from 'bun:test'

test('description', () => {
  expect(actual).toBe(expected)
})
```

- Place tests adjacent to source: `foo.ts` → `foo.test.ts`
- Use exact boundary conditions
- Mock modules via `mock.module()`

---

## Error Handling

- **Avoid try/catch/throw** — only when absolutely necessary
- Handle errors gracefully with proper logging
- Use ArkType for runtime validation at API boundaries

---

## Environment

- Secrets in `.env.local` (never commit)
- Use `process.env` (not Bun's `env`) for Node compatibility
- Bun auto-loads `.env` files

---

## PR / Commit Expectations

- Note which layers touched: server / client / database / docs
- List all commands executed (even if skipped) with explanations
- Don't fix unrelated lint issues
