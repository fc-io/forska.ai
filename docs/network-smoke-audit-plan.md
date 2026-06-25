# Network Smoke Audit Plan

The browser network smoke audit is a reproducible Playwright pass over the local application. It runs against the same unauthenticated local development shape as the normal app: an API server plus the app server. It does not require a saved browser session, test user, or auth fixture.

## Runtime

- Default to the current primary runtime database.
- Do not create synthetic seed rows in the default run.
- Discover existing project, article, prompt, provider, and data source IDs through read endpoints.
- Visit only routes that have the existing IDs they need.
- Skip routes that are known to write or queue work on load when running against the current DB.
- Start the API/server stack with the Playwright `webServer` config.
- Start the app server with the Playwright `webServer` config.
- Point the browser bundle at the direct local API origin for the test ports.
- Expose the local operator API surface in the test runtime so admin/operator pages can be audited without auth.
- Visit app routes through the app origin and observe requests to both the app and API origins.

Run it with:

```bash
bun run test:network-smoke
```

This is the real-data, no-seed-write path. It starts Playwright-controlled app/API servers against the primary DuckDB path, unless `DUCKDB_PATH` or `FORSKA_NETWORK_SMOKE_DUCKDB_PATH` points elsewhere. Stop other servers using the same DuckDB file before running it directly.

To run the older clean synthetic fixture instead:

```bash
bun run test:network-smoke:synthetic
```

Synthetic mode starts from a clean test database and writes local fixture rows only into that temporary database. Use it when you need deterministic coverage for routes that do not currently have representative data in the real DB.

## Audit Loop

1. Build a concrete route inventory from the generated TanStack route tree.
2. Resolve dynamic route IDs from existing data without writing to the current database.
3. Skip dynamic routes whose IDs do not exist in the current database.
4. Navigate each audited route directly.
5. Record app/API-origin request failures, HTTP 4xx/5xx responses, page errors, and console errors.
6. Fail with a grouped report containing the page, request URL, method, status, and a short response snippet.

The audit keeps a second explicit list for routes that are not yet safe to visit in the generic smoke pass. That list must include a reason, so new coverage gaps stay visible in review.

Skipped routes must also carry one of these classifications:

- `missing-data`: the current DB lacks a representative ID or row, and the real pass must not synthesize it.
- `admin-debug-only`: the route is intentionally excluded from normal product flow coverage.
- `unsafe-pending-phase-5c-rewiring`: the route can write or queue work on load in the current DB pass and must be audited, V4-rewired, or retained only with an explicit bounded reason before Phase 5C closes.

No normal browser route may remain skipped only because it queues legacy V3 repair, dirty refresh, or large-rebuild work on load.

The current-DB pass also probes `POST /api/projectsreviewswarnings` for discovered project IDs and fails if page HTML, API/document/fetch/XHR responses, console/page errors, warning probe responses, or captured server logs contain `Large rebuild failed`.

The synthetic pass may create deterministic fixtures only in its temporary DuckDB database.

## Triage And Fix Guidance

- Treat app/API-origin failures as bugs unless the route inventory explicitly documents why they are expected.
- Reproduce backend failures with direct API calls before patching where possible.
- Prefer fixing the responsible contract or page state over adding allowlist entries.
- Use allowlist entries only for stable, known-benign browser noise such as missing browser-managed assets.
- After a fix, rerun `bun run test:network-smoke` and the focused unit or integration tests for the touched code.
