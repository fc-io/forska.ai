# Network Smoke Audit Plan

The browser network smoke audit is a reproducible Playwright pass over the local application. It runs against the same unauthenticated local development shape as the normal app: an API server plus the app server. It does not require a saved browser session, test user, or auth fixture.

## Runtime

- Start from a clean test database.
- Start the API/server stack with the Playwright `webServer` config.
- Start the app server with the Playwright `webServer` config.
- Point the browser bundle at the direct local API origin for the test ports.
- Expose the local operator API surface in the test runtime so admin/operator pages can be audited without auth.
- Visit app routes through the app origin and observe requests to both the app and API origins.

Run it with:

```bash
bun run test:network-smoke
```

To run against the primary runtime database without creating synthetic seed rows:

```bash
bun run test:network-smoke:current-db
```

Current-DB mode uses existing IDs discovered through read endpoints. It requires at least one active project with a linked prompt and article, one provider connection, and one active data source. It skips routes that are known to write or queue work on load, including human assessment init and comparison-project dynamic pages. Stop other servers using the same DuckDB file before using direct current-DB mode, or run against a copied database for full dynamic-route coverage.

## Audit Loop

1. Build a concrete route inventory from the generated TanStack route tree.
2. Seed only local data needed to give dynamic routes real IDs.
3. Navigate each audited route directly.
4. Record app/API-origin request failures, HTTP 4xx/5xx responses, page errors, and console errors.
5. Fail with a grouped report containing the page, request URL, method, status, and a short response snippet.

The audit keeps a second explicit list for routes that are not yet safe to visit in the generic smoke pass. That list must include a reason, so new coverage gaps stay visible in review.

## Triage And Fix Guidance

- Treat app/API-origin failures as bugs unless the route inventory explicitly documents why they are expected.
- Reproduce backend failures with direct API calls before patching where possible.
- Prefer fixing the responsible contract or page state over adding allowlist entries.
- Use allowlist entries only for stable, known-benign browser noise such as missing browser-managed assets.
- After a fix, rerun `bun run test:network-smoke` and the focused unit or integration tests for the touched code.
