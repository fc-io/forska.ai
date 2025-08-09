# forska.ai

Elysia (Bun) API server + Solid (Vite) client, using Drizzle ORM (Postgres) and Better Auth.

## Prerequisites
- Bun 1.1+
- Postgres 14+

## Install
```bash
bun install
```

## Environment
Create a `.env.local` (or export these in your shell) with:
```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/forska

# Auth
BETTER_AUTH_SECRET=dev-super-secret-change-me
# Public base URL of the auth server (your API origin)
BETTER_AUTH_URL=http://localhost:3000

# Vite dev server port
VITE_PORT=5173
```
Note: The tooling reads environment variables during config time. If you keep them in `.env.local`, run commands with `bun --env-file=.env.local ...`, or move them to `.env` to have Bun load them automatically.

## Database
Apply migrations (required before running):
```bash
bun run d:push
```
Optional utilities:
```bash
# Explore DB with Drizzle Studio
bun run d:studio

# Generate new migrations from schema changes
bun run d:gen

# Run pending migrations
bun run d:migrate

# Seed local data (optional)
bun run db:seed

# Create/refresh updated_at triggers (optional)
bun run db:triggers
```

## Run (development)
Use two terminals (or panes):

Terminal A — API server (Elysia on 3000):
```bash
bun --env-file=.env.local run dev:server
```

Terminal B — Web client (Vite on VITE_PORT):
```bash
bun --env-file=.env.local run dev:app
```

Open the client at:
```
http://localhost:5173
```
The API is available at:
```
http://localhost:3000
```
Auth endpoints are served under `/api/auth/*`.

## Lint & Tests
```bash
bun run lint
bun run test
```

## Build (client)
If you need a production build/preview for the client without adding scripts:
```bash
bunx --bun vite build
bunx --bun vite preview
```

## Project structure
- `src/server` — Elysia API (`/api/auth/*`), listens on port 3000
- `src/app` — Solid + Vite client (port from `VITE_PORT`)
- `src/db` — Drizzle schema, migrations, and helpers
- `auth-schema.ts` — Better Auth schema additions