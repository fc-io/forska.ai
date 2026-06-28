---
name: forskai-frontend-solid
description: Use ONLY when touching SolidJS, TSX, TanStack Query, Eden client calls, Suspense, stale data, UI loading states, browser flow, desktop flow, or shared frontend runtime paths.
---

# Forska Frontend And Solid

## Web And Desktop

- Desktop support is additive.
- Do not break the normal browser flow while adding or changing desktop behavior.
- Keep `bun run dev:server` and `bun run dev:app` working for the web app unless the task explicitly says otherwise.
- When changes affect shared UI, API wiring, runtime asset paths, imports, or local file storage, also check the desktop path with `bun run desktop:build` or `bun run desktop:dev` when relevant.

## Client And UI

- Layout-first UI: shell first, data later, no full-page spinner.
- Do not add auth, session, user, or admin requirements unless explicitly asked.
- Default to no-auth single-user behavior.
- Never suspend root `<Outlet />` or wrap an entire route in `<Suspense>`.
- Keep headers, nav, and containers outside async boundaries.
- For each `useQuery`, pick one loading model.
- Use `suspense:false` with explicit `isLoading` and `isError` UI and never treat `undefined` as empty state, or use `suspense:true` with a small local `<Suspense fallback=...>` around the first data read.
- No `<Suspense>` without `fallback`.
- Client network goes through TanStack Query and Eden.
- Use `fetch` only when streaming, upload, or download forces it, inside the function that needs it.
- Use `splitProps` when destructuring props.
- Use `<Show>` and `<Switch>` or `<Match>` over JSX ternary.
- Use `<For>` and `<Index>` instead of `.map()` for lists.
- Use `useQuery` from `@tanstack/solid-query`, not `createQuery`.

## SolidJS Stale Data

- A stale read is a non-tracked snapshot of a reactive value.
- The code does not re-run on change, so the UI shows old data until the reactive source is read inside a tracking context.
- Common causes are reading outside a tracking context, destructuring props or stores, capturing values instead of accessors, async reads that are not tracked, and intentional stale-while-revalidate data during refetch.

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

## Quick Checks

- If the UI is stale but `console.log(signal())` shows fresh values, the read likely happened outside an effect, memo, or JSX.
- If props or a store were destructured, switch back to direct reads, `splitProps`, or an accessor.
- If a timeout, interval, or promise holds old values, call the accessor inside the callback.
- If loader or resource data shows previous data during refetch, check loading state first. That can be expected behavior.
