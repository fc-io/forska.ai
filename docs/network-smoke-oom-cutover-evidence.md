# Network Smoke OOM Cutover Evidence

## 2026-06-25 Implementation Note

Scope: browser network smoke gate for Phase 5C DuckDB OOM cutover. Desktop evidence remains separate through `bun run desktop:build`, owner-handoff tests, and Phase 6 physical interruption checks.

Implemented gates:

- Current/real DB smoke remains no-seed through `FORSKA_NETWORK_SMOKE_DB_MODE=current` and `FORSKA_NETWORK_SMOKE_SEED_MODE=existing`.
- Synthetic smoke writes deterministic fixtures only into the Playwright temporary DuckDB path.
- Current-DB warning probes call `POST /api/projectsreviewswarnings` for discovered project IDs.
- Smoke fails on `Large rebuild failed` in warning probe responses, page HTML, document/fetch/XHR response bodies, console/page errors, and captured runtime logs.
- Skipped route inventory requires explicit `missing-data`, `admin-debug-only`, or `unsafe-pending-phase-5c-rewiring` classification.
- Route inventory fails if a normal browser route is skipped only because it queues legacy V3 repair, dirty refresh, or large-rebuild work on load.

Current explicit skipped routes:

| Route | Classification | Reason |
|---|---|---|
| `/admin/failed_requests/$id` | `missing-data` | Needs a real failed token-usage request row; generic smoke seeding should not manufacture failed provider traffic. |
| `/admin/jobs/$id` | `missing-data` | Creating a real judgment job requires runtime/model admission and local SQLite preflight state. |
| `/admin/jobs/$id/unassessed_articles` | `missing-data` | Depends on the same safely-created judgment job fixture as the job detail route. |
| `/compare-judgments/$id` | `unsafe-pending-phase-5c-rewiring` | Current-DB read-only mode skips pages that can queue comparison-serving rebuild work on load. |
| `/compare-judgments/$id/edit` | `unsafe-pending-phase-5c-rewiring` | Current-DB read-only mode skips comparison-project dynamic pages as one route family. |
| `/compare-judgments/$id/export` | `unsafe-pending-phase-5c-rewiring` | Current-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route. |
| `/compare-judgments/$id/import-resolutions` | `unsafe-pending-phase-5c-rewiring` | Current-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route. |
| `/projects/$id/humanAssessment` | `unsafe-pending-phase-5c-rewiring` | Current-DB read-only mode skips `POST /api/humanassessment/init` because it can create pending human judgments. |

Commands run during implementation:

- `bunx playwright test tests/e2e/networkSmoke.spec.ts -g "network smoke route inventory stays explicit"`

Commands intentionally not run:

- `bun run test:network-smoke`: left for the coordinator smoke run as requested.
- `bun run test:network-smoke:synthetic`: left for the coordinator smoke run as requested.
- `bun run desktop:build`: not required for this browser smoke/test-doc change; desktop evidence remains separate.
