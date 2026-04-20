# Covidence Refresh Consolidation Plan

- Decision: move Covidence project refreshes onto `project_mart_refresh_state` + the worker path, and stop using old `app.mart_refresh_queue` project refreshes for Covidence create/reimport.
- Touched layers: server, tests, docs. No client changes. No DuckDB migration in this phase.

## Why This Shape

- `syncCovidenceProjectScopeFromConfig` already marks full-text scope changes dirty in `src/server/services/covidenceImportService.ts`.
- The missing piece is seeded human-judgment changes: a full-text or title/abstract reimport can change review marts even when scope does not change.
- Because of that, simply removing `queueImportedArticleRefreshes(...)` from the Covidence routes is not safe by itself.
- The safe consolidation path is: make Covidence writes mark dirty state completely, then remove the route-level queue call.

## Scope

- In scope:
  - `src/server/services/covidenceImportService.ts`
  - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts`
  - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
  - Covidence route/service tests
- Out of scope for this pass:
  - `app.mart_refresh_queue` redesign
  - generic structured-file or non-Covidence import flows
  - queue schema / lease migrations

## Implementation Steps

1. Add dirty-state coverage for seeded Covidence judgments.
   - In `src/server/services/covidenceImportService.ts`, make the Covidence judgment-seeding path mark the owning project dirty for the affected article ids.
   - Use `getProjectMartRefreshStateService().markProjectsDirtyAtomically(...)` inside the existing transaction.
   - Cover both modes:
     - `full_text`: mark articles touched by seeded full-text judgments.
     - `title_abstract`: mark articles touched by seeded title/abstract judgments, since this mode does not use `syncCovidenceProjectScopeFromConfig`.
   - Keep `syncCovidenceProjectScopeFromConfig(...)` as the owner for added/removed full-text scope articles.

2. Keep dirty-state writes minimal but safe.
   - First implementation can mark all seeded article ids dirty, even if some upserts are idempotent.
   - Do not add a new optimization layer until the consolidated path is stable.
   - If needed later, narrow dirty marking to rows that actually changed.

3. Remove the old queue trigger from Covidence routes.
   - Delete `queueImportedArticleRefreshes(...)` calls from:
     - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts`
     - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
   - Remove the now-unused import from those files.
   - Leave `src/server/services/articleImportStoreService.ts` unchanged for non-Covidence import flows.

4. Update regression coverage.
   - Service tests:
     - keep the existing full-text scope dirty-state coverage in `src/server/services/covidenceImportService.test.ts`
     - add/update coverage for reimports where judgments change without a scope change
     - add/update coverage for title/abstract imports marking dirty state without relying on the old queue
   - Route tests:
     - update `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
     - update `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
     - assert the routes no longer call `queueImportedArticleRefreshes(...)`

5. Validate no behavior regression in the worker-owned path.
   - Confirm the worker can fully rebuild from the new dirty-state marks without needing the old queue path.
   - Reuse existing refresh-state and mart tests; only add worker assertions if the service changes expose a gap.

## Done When

- Covidence create/reimport no longer enqueue project refreshes through `queueImportedArticleRefreshes(...)`.
- Full-text reimports still refresh when:
  - scope changes
  - judgments change but scope stays the same
- Title/abstract imports also refresh through dirty-state marks rather than the old queue.
- Existing non-Covidence import flows still use their current queue behavior.

## Risks And Mitigations

- Risk: removing the queue too early misses judgment-only refreshes.
  - Mitigation: add judgment-seed dirty marking before removing route queue calls.
- Risk: dirtying all seeded articles causes extra rebuild work.
  - Mitigation: accept the broader mark first; optimize later only if it becomes measurable.
- Risk: route tests still pass while worker behavior regresses.
  - Mitigation: keep service-level dirty-state assertions and run the mart refresh test suite.

## Quality Gates

- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
- `bunx eslint src/server/services/covidenceImportService.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts src/server/services/covidenceImportService.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`

## Follow-Up After This Lands

- Audit the rest of the codebase for project-refresh callers that still use the old queue directly.
- If more flows are migrated to dirty-state, plan a second pass to retire queue-based project refreshes entirely.
