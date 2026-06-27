# Tests

Run tests through `bun run ...` from the repo root.

| Command | What It Checks | Notes |
| --- | --- | --- |
| `bun run test:bun` | Server, scripts, utilities, and core TypeScript tests | Uses `scripts/runBunTests.ts`; best default for backend changes. |
| `bun run test:vitest` | App/component tests that use Vitest | Use for client-side unit tests. |
| `bun run test:playwright` | Browser smoke and e2e tests | Starts the app/server through Playwright config. |
| `bun run test:network-smoke` | Current primary DB route/network smoke | Read-only/mutation-limited current DB audit. Catches broken pages, API failures, API-role DuckDB ownership, fatal DuckDB restarts, worker loop failures, and forbidden server runtime logs. |
| `bun run test:network-smoke:current-db` | Same as `test:network-smoke` | Explicit current-DB alias. |
| `bun run test:network-smoke:synthetic` | Synthetic DB route/network smoke | Safer isolated smoke when current DB data is not needed. Also checks forbidden server runtime logs. |
| `bun run test:dev-server:current-db` | Real `dev:server` startup against the primary DB | Captures server output and fails on API-role DuckDB ownership, fatal DuckDB restarts, owner heartbeat errors, and worker loop failures. Stops the dev server when done. |
| `bun test src/db/migrateDuckdb.test.ts src/server/reviewServing/reviewServingSchema.test.ts` | DuckDB migration and review-serving V4 schema drift checks | Catches already-applied current-DB V4 mart drift such as missing `payload_kind` before worker chunks hit binder errors. |

Target a single Bun test file with `bun test path/to/file.test.ts`.

Quality gates: run the narrow test for your change first, then `bun run lint` or `bun run build` when the changed layer needs it.
