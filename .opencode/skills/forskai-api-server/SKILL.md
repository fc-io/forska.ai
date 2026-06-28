---
name: forskai-api-server
description: Use ONLY when touching server routes, Elysia, Eden/RPC, API paths, request bodies, t.File upload routes, ArkType validation, errors, environment variables, or server runtime wiring.
---

# Forska API And Server

## API And Routes

- Route files use `src/server/routes/[resource]Routes.ts`.
- Routes use `/api/` plus the plural resource name.
- Prefer flat routes and request bodies over nested URL params.
- Use Eden/RPC on the client.
- Avoid `fetch` unless streaming, upload, or download requires it.
- Keep fetch logic local to the `useQuery` or mutation file.
- Do not create services files for ordinary client fetch logic.
- For `t.File()` routes, Elysia `derive` does not propagate auth context. Read the session from `request.headers` inside the handler.

## Validation And Errors

- Avoid `try`, `catch`, `finally`, and `throw` unless necessary.
- Use ArkType for runtime validation at API boundaries.
- Validate incoming request data before processing.
- Prefer graceful error handling when easily possible.

## Environment

- Do not rely on `.env` files for normal dev.
- Use `process.env`, not Bun's env.
- Keep secrets and values that must change outside the app in shell env or secret files.
- Keep shell env use limited to runtime wiring, machine-local paths, and secrets.
- If you start a local server or process for debugging, stop it before finishing or replying.

## Web And Desktop Awareness

- Server, API wiring, runtime-path, import, and local file storage changes may affect both browser and desktop app flows.
- Keep `bun run dev:server` and `bun run dev:app` working unless the task explicitly says otherwise.
- Check `bun run desktop:build` or `bun run desktop:dev` when the shared runtime path or desktop integration is relevant.
