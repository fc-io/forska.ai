# Network Smoke

The browser network smoke gate is the supported route-audit pass for local
Forska. It runs Playwright against a local API/server stack and the app server,
then fails on app/API-origin request errors, HTTP 4xx/5xx responses, page
errors, console errors, failed review-warning states, and forbidden
review-serving failure strings.

## Commands

```bash
bun run test:network-smoke
bun run test:network-smoke:current-db
bun run test:network-smoke:current-db:readonly
bun run test:network-smoke:synthetic
```

`test:network-smoke` currently points at the current-DB gate. Stop any manually
running server stack that owns the same DuckDB file before running it directly.

Use synthetic mode only when deterministic fixture rows are needed. Synthetic
mode writes only to the Playwright temporary DuckDB path.

## Current-DB Mode

Current-DB mode:

- uses existing data only
- discovers route IDs through read endpoints
- skips dynamic routes without representative current data
- does not seed rows into the primary database
- probes `POST /api/projectsreviewswarnings` for discovered projects
- rejects `Large rebuild failed` and failed warning states in page, API,
  warning-probe, console, and server-log output

Skipped routes must carry an explicit classification:

| Classification                     | Meaning                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `missing-data`                     | The current DB lacks a representative ID or row and the real pass must not synthesize it.                                               |
| `admin-debug-only`                 | The route is intentionally outside normal product flow coverage.                                                                        |
| `unsafe-pending-phase-5c-rewiring` | The route can write or queue work on load and must be audited, V4-rewired, or retained with a bounded reason before the skip can close. |

No normal browser route should remain skipped only because it queues legacy V3
repair, dirty refresh, or large-rebuild work on load.

## Historical Cutover Evidence

The June 2026 OOM cutover added the current/real DB no-seed path, synthetic
temporary DB mode, warning probes, forbidden large-rebuild failure checks, and
explicit skipped-route classifications.

Implementation verification at the time:

```bash
bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"
bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts
bun run lint
bun run test:network-smoke
bun run test:network-smoke:synthetic
```

The browser smoke gate is not desktop evidence. Desktop release checks remain
separate through desktop build/runtime tests and any current review-serving
progress gate required by `TESTS.md`.
