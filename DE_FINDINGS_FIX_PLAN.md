# Findings Fix Plan For Covidence De-duplication Plan

## Goal

- Update `DE_DUPLICATE_COV_PLAN.md` so it explicitly addresses the review findings from the whole-plan pass.
- Make the main plan safer for implementation by tightening identity contracts, broad import scope, mart coverage, snapshot compatibility, concurrency, and quality gates.

Touched layers: docs

## Findings To Address

| # | Finding | Required Update To `DE_DUPLICATE_COV_PLAN.md` |
|---|---|---|
| 1 | `app.article.article_id` migration is underspecified | Add an explicit API and display identity contract covering canonical internal ids, project-scoped external ids, source URLs, and the compatibility-only lifecycle of `app.article.article_id`. |
| 2 | Broad-source harvesters are not explicitly in scope | Add `src/agent/*WorkflowStoreEntries.ts`, harvest route handlers, and related importer tests to the file and system scope. |
| 3 | Comparison project marts and routes are missing | Add comparison project serving builders, routes, migrations, and tests to mart, query, and quality-gate sections. |
| 4 | Judgment execution snapshots need a compatibility policy | Add snapshot and queued-job compatibility requirements before removing article-level import fields. |
| 5 | Multi-identifier conflict handling is not explicit | Add strong-identifier conflict and quarantine rules for cases where DOI, PMID, arXiv, bioRxiv, or medRxiv matches disagree. |
| 6 | Concurrent import behavior is undefined | Add import-run leases, transaction boundaries, `ON CONFLICT` retry behavior, and single-writer or idempotent writer rules. |
| 7 | Source record history versus current import membership is unclear | Add policy for `source_record_key`, `source_record_hash`, import runs, repeated harvests, and multiple source rows resolving to one canonical article. |
| 8 | Identifier normalization needs exact rules and tests | Add a normalization contract and test coverage for DOI, PMID, arXiv, bioRxiv, medRxiv, PMCID if used, and URL-derived identifiers. |
| 9 | Additional read and helper surfaces are not named | Add `fullTextConversionJobs.ts`, `appQueryHelpers.ts`, `dataSourceQueryService.ts`, `AdminInvestigateRoutes.ts`, review warning and health routes, and maintenance lease services to the affected systems list. |
| 10 | Performance gates lack concrete budgets | Add pass/fail targets for chunk size, wall-clock budget, memory ceiling, query shape, and mart refresh scope. |

## Planned Edits

### 1. Add An Identity Contract Section

Add a new section after `Short Answer On Identifiers` or after `Make external identity explicit` named `Identity And Display Contract`.

Required content:

| Identity | Owner | Purpose | Migration Rule |
|---|---|---|---|
| `app.article.id` | Canonical article row | Internal joins and foreign keys | Keep as the only durable join key. |
| `app.article_identifier.normalized_value` | Canonical identifier table | Cross-import matching | Use for DOI, PMID, arXiv, bioRxiv, and medRxiv matching. |
| `app.article_import_route.external_article_id` | Import-scoped article record | Source-facing display, exports, seeding, source URLs | Derive project-scoped display ids from the selected import record. |
| `app.article.article_id` | Legacy compatibility field | Temporary reads during migration | Do not assign new route-scoped meaning; remove or replace after callers migrate. |
| Source URL | Canonical article or import-scoped source record | Browser links and exports | Prefer explicit URL fields or identifier-derived URL helpers over prefix parsing of `article_id`. |

Also update `Target Data Model`, `Project-Scoped Serving Metadata`, `Client Review Surfaces`, and `Phase 8` to say URL and display helpers must stop parsing source prefixes from `app.article.article_id`.

### 2. Expand Import And Write Scope

Update `Main Files And Systems To Change` with broad-source harvesters and route handlers.

Add these files or file groups:

| Area | Files |
|---|---|
| PubMed and Europe PMC harvesters | `src/agent/pubmedWorkflowStoreEntries.ts`, `src/agent/pubmedHarvest.ts`, `src/agent/europePmcPprWorkflowStoreEntries.ts`, `src/agent/europePmcPprHarvest.ts` |
| Preprint harvesters | `src/agent/biorxivWorkflowStoreEntries.ts`, `src/agent/medrxivWorkflowStoreEntries.ts`, `src/agent/arxivWorkflow/arxivWorkflowStoreEntires.ts` |
| Import routes | `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts`, `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.ts`, `src/server/routes/DataSourcesImportRoutes.ts` |
| Import tests | `src/agent/importerStoreEntries.test.ts` and route tests for source imports when present |

Update `Phase 3` to say these harvesters must pass normalized candidates, source identifiers, source record keys, and import-run references to the central matching/write path instead of treating source `article_id` as canonical identity.

### 3. Add Comparison Project Coverage

Update `Main Files And Systems To Change`, `Phase 5`, `Phase 6`, `Quality Gates`, and `Commands To Run`.

Add these systems:

| Area | Files |
|---|---|
| Comparison serving builders | `src/server/services/comparisonProjectServingRollupBuilder.ts`, `src/server/services/comparisonProjectServingCellBuilder.ts`, `src/server/services/comparisonProjectServingInvalidationService.ts` |
| Comparison routes | `src/server/routes/ComparisonProjectsRoutes.ts`, `src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts` |
| Comparison migrations | `src/db/duckdbMigrations/0072_comparisonProjectServingSchema.sql`, `src/db/duckdbMigrations/0075_rebuildComparisonServingMarts.sql` |
| Comparison tests | comparison project serving and judgment-row tests |

Required behavior:

1. Comparison article serving must derive `article_external_id` from the comparison-project source scope or selected import record, not from `app.article.article_id`.
2. Comparison serving metadata must combine canonical metadata with scoped import metadata, not copy `app.article.source_metadata` wholesale.
3. Comparison judgment row lookup must be explicit about whether the client passes canonical ids or external display ids.

### 4. Add Judgment Snapshot Compatibility

Update `Current Repo State`, `Main Files And Systems To Change`, `Phase 3`, `Phase 5`, `Phase 8`, and `Risks`.

Add these files:

| Area | Files |
|---|---|
| Snapshot payloads | `src/server/services/judgmentExecutionSnapshotService.ts` |
| Judgment queue and outbox | `src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts`, `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`, judgment completion journal files where relevant |
| LLM prompt payloads | `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts` |

Required behavior:

1. Existing queued jobs and snapshots must remain reproducible during the migration.
2. Snapshot payloads should expose canonical article fields plus the correct project-scoped external id and import metadata.
3. Legacy `importRoute` and `originalData` fields in snapshot payloads need a compatibility adapter until downstream consumers are migrated.
4. Phase 8 cannot remove article-level fields until queued jobs, snapshot readers, and outbox import paths no longer depend on them.

### 5. Add Strong Identifier Conflict Rules

Update `Matching Policy`, `Unresolved Cases`, `Risks`, and `Quality Gates`.

Add explicit rules:

1. If an incoming row has multiple strong identifiers and all existing matches point to the same canonical article, reuse that article.
2. If DOI matches article A and PMID or another strong identifier matches article B, quarantine the row as a strong-identifier conflict.
3. If a source row claims a strong identifier already linked to another canonical article but canonical fields materially conflict, quarantine instead of overwriting.
4. If a batch contains two source rows with the same strong identifier but materially different article fields, collapse only exact duplicates and quarantine conflicts.
5. Quarantine records must include source kind, import run id, source record key, conflicting identifier kinds, conflicting canonical article ids, and enough payload metadata for operator review.

### 6. Add Concurrency And Transaction Policy

Update `Performance And Scale Requirements`, `Bulk Import Staging And Checkpointing`, `Phase 2`, `Phase 3`, `Migration Notes`, and `Risks`.

Required policy:

1. Use an import-run lease or equivalent single-writer guard per source/import route when needed.
2. Keep canonical article creation, identifier insertion, and import-record insertion in bounded transactions.
3. Treat `UNIQUE(kind, normalized_value)` on `app.article_identifier` as the final arbiter for concurrent writers.
4. On identifier insert conflict, re-read the winning identifier row and continue only if it maps to the same intended canonical article.
5. If the winning identifier row maps elsewhere, quarantine the row as a concurrent strong-identifier conflict.
6. Make retries idempotent by `source_kind`, `import_run_id`, `source_record_key`, and `source_record_hash`.

### 7. Add Source Record History Policy

Update `Import-Scoped Article Record`, `Bulk Import Staging And Checkpointing`, `Phase 3`, and `Open Decisions During Build`.

Required policy:

1. `app.article_import_route` represents current article membership for a route and the latest compact import-scoped payload.
2. `import_run_id`, `source_record_key`, and `source_record_hash` record the provenance of the latest write.
3. Repeated harvests for the same source record should update the import-scoped record only when the hash changes.
4. Multiple source rows in one import route that resolve to the same canonical article must either merge import metadata deterministically or be stored in a child row table.
5. If source-row history is needed for audit, use `app.article_import_route_row` or a dedicated import-run row table instead of overloading the current membership row.

### 8. Add Identifier Normalization Contract

Update `Matching Policy`, `Article Identifier Table`, `Phase 0`, and `Quality Gates`.

Add rules for:

| Identifier | Normalization Rule |
|---|---|
| DOI | trim, lowercase, strip `https://doi.org/`, `http://doi.org/`, `doi:`, and surrounding punctuation where safe |
| PMID | trim, keep numeric string without source prefix |
| PMCID | decide whether to support as strong identifier or store as source metadata; if supported, normalize `PMC` prefix consistently |
| arXiv | strip URL or `arXiv:` prefix, normalize version policy explicitly, and decide whether `v1` and `v2` match the same canonical article |
| bioRxiv | normalize DOI or server path form to one identifier shape |
| medRxiv | normalize DOI or server path form to one identifier shape |
| URL-derived identifiers | extract only from trusted URL patterns and store the extracted identifier with its source |

Add required tests for exact boundary cases, malformed values, duplicate values in one batch, and conflicting values across identifier kinds.

### 9. Expand Read And Helper Surface List

Update `Main Files And Systems To Change` and `Quality Gates`.

Add these likely affected files:

| Area | Files |
|---|---|
| Full-text conversion | `src/server/cron/fullTextConversionJobs.ts` |
| Shared query helpers | `src/server/services/appQueryHelpers.ts`, `src/server/services/dataSourceQueryService.ts` |
| Admin and investigation | `src/server/routes/AdminInvestigateRoutes.ts`, `src/server/routes/ArticleAdminRoutes.ts` |
| Review warnings and health | `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`, `src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts` |
| Maintenance and leases | `src/server/services/maintenanceWorkLeaseService.ts`, `src/server/workers/projectMartRefreshWorker.ts` |
| Client URL helpers | `src/app/utils/getArticleUrl.ts` |

### 10. Make Performance Gates Concrete

Update `Performance And Scale Requirements`, `Quality Gates`, and `Commands To Run`.

Add pass/fail budgets:

| Scenario | Pass Criteria |
|---|---|
| 50,000-record Covidence import | Completes in bounded chunks, no per-row canonical lookup, no duplicate canonical rows, memory remains below the configured DuckDB/process budget. |
| One million identifier-bearing broad-source rows | Stages and matches in bounded chunks, links rows matching Covidence-created canonical articles, and can resume after interruption. |
| Identifier matching query shape | Uses indexed joins or chunked `IN` lookups against normalized identifier tables, not JSON scans or full `app.article` scans. |
| Mart refresh impact | Broad-source imports with no project-linked changes do not mark unrelated project marts dirty. |
| Retry behavior | Re-running an interrupted import does not create additional canonical articles or duplicate import-scoped records. |

Also add an open decision for exact local thresholds: wall-clock budget, default chunk size, checkpoint interval, and memory ceiling under the shared DuckDB runtime.

## Update Order

1. Add identity and display contract sections first because many later edits depend on that terminology.
2. Expand file and system scope so implementation readers know all affected surfaces.
3. Add matching conflict, normalization, source history, and concurrency policies.
4. Add comparison project and judgment snapshot compatibility requirements.
5. Tighten phased implementation steps to include the new policies.
6. Add tests, benchmarks, and quality gates for the newly covered surfaces.
7. Update risks and open decisions after the plan body is consistent.

## Acceptance Criteria

1. `DE_DUPLICATE_COV_PLAN.md` includes all ten findings as explicit plan content, not only as risks.
2. The main plan states which id each API, mart, export, snapshot, and UI surface should expose.
3. The main plan lists broad-source harvesters, comparison projects, and judgment snapshot systems as affected systems.
4. The main plan defines strong-identifier conflicts, concurrent import conflict behavior, and source-record history behavior.
5. The main plan includes identifier normalization rules and targeted tests.
6. The main plan includes concrete performance pass/fail checks for 50,000-record Covidence imports and million-row broad-source imports.
7. The main plan keeps browser and desktop verification requirements for shared UI and runtime-path changes.

## Quality Gates

Pass/fail checks for this documentation update:

1. Read `DE_DUPLICATE_COV_PLAN.md` after editing and confirm every item in `Findings To Address` is represented.
2. Read `DE_FINDINGS_FIX_PLAN.md` after creation and confirm it has no contradictions with `DE_DUPLICATE_COV_PLAN.md`.
3. No code tests are required for creating this plan file.

Quality gates to add to the main implementation plan:

1. `bun test src/utils/articleSourceMetadata.test.ts`
2. `bun test src/agent/importerStoreEntries.test.ts`
3. `bun test src/server/services/judgmentExecutionSnapshotService.test.ts` if present, or add targeted snapshot coverage before migration.
4. `bun test` for comparison project serving builders and judgment-row routes touched by the migration.
5. 50,000-record Covidence import benchmark or integration fixture.
6. One-million-row broad-source staged matching benchmark or integration fixture.
7. `bun run db:mig`
8. `bun run lint`
9. `bun run build`
10. `bun run desktop:build` when shared UI, runtime paths, or client URL helpers change.

## Commands To Run

For this docs-only plan creation:

1. No test command is required.

For the follow-up update to `DE_DUPLICATE_COV_PLAN.md`:

1. Re-read both plan files after editing.
2. Run no code tests unless code or test files are changed.
