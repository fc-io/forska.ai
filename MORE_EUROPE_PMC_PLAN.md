# More Europe PMC Sources Plan

## Goal

Add support for the remaining Europe PMC `SRC:` corpora as first-class importable data sources while preserving the existing browser and desktop flows.

Touched layers: server, client, database, tests

## Source Scope

| Source | Meaning | Initial Status | Import Priority |
| --- | --- | --- | --- |
| `SRC:PMC` | PubMed Central | New | High |
| `SRC:PPR` | Preprint records | Existing dedicated importer | Keep, then migrate to shared path |
| `SRC:PAT` | Biological patents | New | Medium |
| `SRC:AGR` | Agricola | New | Medium |
| `SRC:CBA` | Chinese Biological Abstracts | New | Medium |
| `SRC:CTX` | CiteXplore | New | Medium |
| `SRC:ETH` | EThOS theses | New | Low |
| `SRC:HIR` | NHS Evidence | New | Low |
| `SRC:NBK` | Europe PMC / NLM book metadata | New | Low |

`SRC:MED` is already exposed as `Europe PMC SRC:MED` through `/api/datasources/import/pubmed`. It is not in this expansion list, but the shared implementation should include it so MED, PPR, and the new sources use one Europe PMC search pipeline.

## Current Repo State

1. `src/agent/pubmedHarvest.ts` imports Europe PMC `SRC:MED` with cursor pagination, date bounds, retry handling, and `resultType=core`.
2. `src/agent/europePmcPprHarvest.ts` imports `SRC:PPR` with a nearly duplicate Europe PMC fetch and transform path.
3. `src/server/routes/DataSourcesImportRoutes.ts` exposes dedicated MED and PPR routes.
4. `src/app/routes/+admin/+datasources/dataSourceImportRouteOptions.ts` lists only arXiv, bioRxiv, medRxiv, Europe PMC PPR, and Europe PMC SRC:MED.
5. `src/app/routes/+admin/+datasources/+index.tsx` dispatches imports by hard-coded route names.
6. Existing storage uses `storeImportedArticles` through source-specific workflow store wrappers, so new sources should avoid another copy of the fetch, cursor, transform, and store logic.

## Desired Behavior

1. Users can create/import a data source for each supported Europe PMC source code from the admin data-sources UI.
2. Each source uses `SRC:<code> AND FIRST_PDATE:[from TO to]` by default and preserves the current cursor checkpoint behavior.
3. Existing `/api/datasources/import/pubmed` and `/api/datasources/import/europe-pmc-ppr` routes keep working.
4. New routes use stable route names, for example `/api/datasources/import/europe-pmc-pmc`, `/api/datasources/import/europe-pmc-pat`, and so on.
5. Imported articles keep source-specific external ids in deterministic `article_id` values until the broader canonical article de-duplication plan replaces route-scoped article identity.
6. Europe PMC raw records are stored in `original_data` so later metadata improvements can be recomputed without re-harvesting.
7. Import completion updates the data source count and clears the cursor just like MED and PPR.
8. Failed or interrupted imports leave the cursor checkpoint so retry resumes without starting from the first page.

## Implementation Plan

### 1. Create A Shared Europe PMC Import Module

1. Add a source configuration map, for example in `src/agent/europePmc/europePmcSources.ts`.
2. Model supported source codes as a literal union: `MED`, `PMC`, `PPR`, `PAT`, `AGR`, `CBA`, `CTX`, `ETH`, `HIR`, `NBK`.
3. Store per-source display labels, route suffixes, article id prefixes, and expected identifier strategy.
4. Move duplicated Europe PMC response ArkType schemas, date helpers, cursor fetch, retry handling, title extraction, author extraction, DOI normalization, URL extraction, and page harvesting into shared helpers.
5. Keep source-specific transforms as small functions only where data differs meaningfully.

### 2. Normalize Records Conservatively

1. Build a shared `EuropePmcDatabaseEntry` transform that accepts `{sourceCode, item, importRoute}`.
2. Use DOI when present and normalized.
3. Use PMID only for MED-like records that actually expose a PMID.
4. Use `pmcid` or Europe PMC `id` for PMC records when available.
5. Use source-prefixed article ids for non-MED records, such as `pmc:<id>`, `ppr:<id>`, `pat:<id>`, `agr:<id>`, `cba:<id>`, `ctx:<id>`, `eth:<id>`, `hir:<id>`, and `nbk:<id>`.
6. Keep blank or malformed records out of storage when no stable source id can be found.
7. Preserve source-specific fields in `original_data` rather than inventing parallel columns.
8. Set publication status only when it is clearly derivable from source metadata; keep unknown cases unset rather than guessing.

### 3. Replace Source-Specific Store Wrappers

1. Add one `europePmcWorkflowStoreEntries` wrapper around `storeImportedArticles`.
2. Keep the current batch size and short inter-batch delay unless profiling shows a need to change it.
3. Validate shared database entries with ArkType at the boundary.
4. Remove duplicate PPR and MED storage wrappers only after callers have migrated.

### 4. Add Server Routes

1. Add one route handler helper such as `dataSourcesImportRoutesPostEuropePmcSource.ts`.
2. Pass the source code into the helper from thin route exports.
3. Register routes in `src/server/routes/DataSourcesImportRoutes.ts` for each source.
4. Preserve existing route handlers for `/api/datasources/import/pubmed` and `/api/datasources/import/europe-pmc-ppr` as aliases to the shared helper.
5. Keep request bodies as `{id: string}`.
6. Keep default date behavior aligned with current MED and PPR routes: warn when date bounds are missing, cap future `dateTo` at now, and use the datasource cursor.

### 5. Add Client Options And Dispatch

1. Add built-in import route options for every Europe PMC source in `dataSourceImportRouteOptions.ts`.
2. Make labels explicit, for example `Europe PMC SRC:PMC`, `Europe PMC SRC:PAT`, and `Europe PMC SRC:NBK`.
3. Replace the hard-coded import dispatch chain in the admin data-source page with a route-to-request helper if Eden typing remains manageable.
4. Preserve custom import routes for sources that are not built into the app.
5. Confirm both browser and desktop app UI can create, import, refresh, and display the new source options.

### 6. Add Tests

1. Add unit tests for source-code config and route suffix generation.
2. Add transform tests for representative PMC, PPR, PAT, AGR, CBA, CTX, ETH, HIR, and NBK records.
3. Include edge cases with missing DOI, missing PMID, numeric ids, string ids, object-shaped titles, single-author and author-array responses, and absent abstracts.
4. Add route handler tests proving existing MED and PPR routes still call the shared helper with the same effective query and cursor behavior.
5. Add client option tests or service tests if the route dispatch is extracted into a helper.

## Source-Specific Notes

1. `PMC`: Prefer PMCID/source id for the import-scoped id and DOI/PMID for cross-source matching when present. Expect strong overlap with MED; do not assume PMC records are unique articles until canonical de-duplication is complete.
2. `PPR`: Keep current behavior compatible. The migration should not change existing article ids from `ppr:<id>`.
3. `PAT`: Treat as patent-like literature. DOI and PMID may be absent; source id is the primary import-scoped identity.
4. `AGR`, `CBA`, `CTX`, `HIR`: Treat as bibliographic records. Keep source id and raw metadata; avoid source-specific semantic fields until there is a UI need.
5. `ETH`: Treat as theses. Preserve institution, degree, and repository fields only in `original_data` for now.
6. `NBK`: Treat as book/book-chapter metadata. Prefer source id and title/year metadata; avoid forcing journal-specific display fields.

## De-Duplication Boundary

This work should not solve canonical article de-duplication by itself. It should prepare for it by preserving DOI, PMID, PMCID, and raw source ids consistently. The broader de-duplication plan should later move import-scoped source identity out of `app.article.article_id` and into import-route records.

Until that cutover lands, do not silently merge records across different Europe PMC sources only because titles look similar. Strong identifier matching should be handled by the canonical import path, not by per-source fetchers.

## Risks

1. Some Europe PMC sources may return sparse or source-specific shapes that the current MED/PPR schema rejects.
2. PMC and MED overlap can create duplicate canonical articles until the de-duplication model is implemented.
3. Low-volume sources may have unusual date behavior, so `FIRST_PDATE` should be verified per source with a small dry run.
4. Long-running imports can pressure DuckDB and mart refresh queues if every source is imported at broad date ranges.
5. Route proliferation can make the admin dispatch brittle unless the client route handling is simplified.

## Rollout

1. First PR: shared Europe PMC fetch/transform/store module with MED and PPR migrated, no new sources exposed.
2. Second PR: add PMC and one low-risk sparse source behind built-in options, with transform tests and route tests.
3. Third PR: add PAT, AGR, CBA, CTX, ETH, HIR, and NBK once sample responses are validated.
4. Final cleanup: remove duplicate old MED/PPR helper code after the shared path has passed tests and one real import per source.

## Quality Gates

1. `bun run lint` passes.
2. `bun test src/agent/importerStoreEntries.test.ts` passes or is replaced by targeted shared Europe PMC importer tests.
3. Targeted route tests for Europe PMC import routes pass.
4. For client changes, `bun run build` passes for the browser flow.
5. If shared route/client wiring affects desktop runtime paths or bundled client code, run `bun run desktop:build`.
6. Manual browser verification: create one data source for a new Europe PMC route, run a narrow date import, and confirm article count, cursor clearing, and visible imported rows.
7. Manual desktop verification when client/server route wiring changes: open the data-sources UI and confirm the new Europe PMC options render without breaking existing MED/PPR imports.

## Suggested Verification Samples

Use narrow date windows first and keep sample imports small. For each source, verify that Europe PMC returns records, records have stable ids, and the app stores at least title, date, import route, and raw original data.

| Source | Query Shape |
| --- | --- |
| `PMC` | `SRC:PMC AND FIRST_PDATE:[2024-01-01 TO 2024-01-07]` |
| `PPR` | `SRC:PPR AND FIRST_PDATE:[2024-01-01 TO 2024-01-07]` |
| `PAT` | `SRC:PAT AND FIRST_PDATE:[2024-01-01 TO 2024-01-31]` |
| `AGR` | `SRC:AGR AND FIRST_PDATE:[2024-01-01 TO 2024-01-31]` |
| `CBA` | `SRC:CBA AND FIRST_PDATE:[2024-01-01 TO 2024-01-31]` |
| `CTX` | `SRC:CTX AND FIRST_PDATE:[2024-01-01 TO 2024-01-31]` |
| `ETH` | `SRC:ETH AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]` |
| `HIR` | `SRC:HIR AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]` |
| `NBK` | `SRC:NBK AND FIRST_PDATE:[2024-01-01 TO 2024-12-31]` |

## Open Questions

1. Should new Europe PMC route names use one route with a source parameter, or separate built-in routes for Eden/client ergonomics?
2. Should PMC be shown separately from MED in the UI despite expected overlap, or kept as an advanced source to avoid duplicate-heavy imports?
3. Should patent, thesis, and book records be included in default review projects, or marked with source metadata so projects can filter them later?
4. Should broad Europe PMC source imports wait for canonical article de-duplication before being enabled by default?
