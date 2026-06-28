---
name: forskai-code-style
description: Use ONLY when touching TypeScript, JavaScript, imports, lint fixes, refactors, file structure, component extraction, ternary helpers, or code style.
---

# Forska Code Style

## File Structure

- Keep filenames camelCase, including TSX and JSX.
- If a file has one export, the filename should match it.
- Components and helpers used by one file should live in a sibling subfolder with the same owner name. Route folders are the exception.
- When a component or its related utilities exceed 100 lines, extract them into that subfolder.

```text
src/components/main/
subheader.tsx
subheader/
subheaderSettingsPanel.tsx
subheaderSettingsPanel/
subheaderSettingsPanelDateRangePicker.tsx
```

## JavaScript And TypeScript

- Prefer functional JavaScript.
- Use `map`, `filter`, and `reduce` over `forEach`.
- Avoid classes.
- Prefer arrow function expressions.
- Prefer named exports: `export const Foo = ...` over separate export blocks.
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

## Types

- Prefer `type` over `interface`.
- Prefer inferred and derived types from Eden/RPC and local helpers.
- Do not invent parallel types when existing contracts already define them.
- Keep type definitions local.
- If you add explicit return types, reserve them for pure non-DB functions.
- Prefix intentionally unused vars with `_`.

## Imports

- Order imports as simple-import-sort expects: built-ins, external packages, internal aliases, parent relatives, same-directory relatives.

## Ternary With Helpers

- Use a ternary only for exactly two mutually exclusive paths with no shared tail logic.
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

Do not create wrapper functions that do not add real behavior:

```ts
const applyCooldownAndEnd = async (now: number): Promise<void> => {
  applyCooldown(now)
  console.log('end send to LLM')
}
```

Do not use ternary when only one path does work:

```ts
const doThing = async (value): Promise<void> => {
  const prompts = await doSomething()

  return value ? doSomethingElse(value) : Promise.resolve()
}
```

Do not place statements after a return path:

```ts
const doThing = async (value): Promise<void> => {
  if (!value) {
    console.log('No value')
    return
  }
  await processValue(value)
}
```

Do not explain code with comments when function names can do it:

```ts
// Transform records to database format
const transformedEntries = records.map((entry) => {
  return transformEntry(entry, importRoute)
})
```

Prefer:

```ts
const getEntriesInDatabaseFormat = (importRoute: string, entries: Entry[]) => {
  return entries.map((entry) => {
    return transformEntry(entry, importRoute)
  })
}

const transformedEntries = getEntriesInDatabaseFormat(importRoute, entries)
```
