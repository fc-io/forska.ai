# Covidence De-duplication Plan

## Goal

- Prevent duplicate canonical articles and duplicate prompt definitions across Covidence imports and other import sources.
- Separate canonical article identity from import-scoped external and source identity.
- Keep import-specific Covidence metadata like stage membership, study keys, notes, source rows, and seeded human answers without forcing one article row per import.
- Preserve existing review, judgment, mart, browser, and desktop behavior while moving to a cleaner long-term data model.

Touched layers: server, database, client

## Short Answer On Identifiers

1. We do not need a random identifier for deduplication.
2. We still need random UUIDs as internal primary keys for rows.
3. The current unique ids in our app are not enough for cross-import dedupe:
   - `app.article.id` is only an internal row id.
   - Covidence currently writes `app.article.article_id` as `covidence:<datasourceId>:<articleKey>`, which is route-scoped and guarantees duplicates across imports.
4. We can live with articles that have no DOI and no PMID.
5. For those articles, dedupe must fall back to weaker fingerprints and ambiguity handling. A random id does not help match the same article across two imports.
6. Source-facing article ids still matter, but they belong on the import-scoped article record, not as the canonical article identity.

## Identity And Display Contract

| Identity Or Field | Owner | Purpose | Migration Rule |
|---|---|---|---|
| `app.article.id` | Canonical article row | Internal joins, foreign keys, and durable canonical article identity | Keep as the only durable app join key. Do not expose it as a source-facing article id unless an API explicitly asks for canonical ids. |
| `app.article_identifier.normalized_value` | Canonical identifier table | Cross-import matching for DOI, PMID, arXiv id, bioRxiv id, and medRxiv id | Use normalized strong identifiers for matching and backfill. Do not use display labels or route-prefixed ids as matching keys. |
| `app.article_import_route.external_article_id` | Import-scoped article record | Project-scoped source-facing display id, Covidence seeding, exports, and source-specific references | Derive displayed article ids from the selected project-scoped import record. This is where Covidence-local ids and broad-source external ids belong. |
| `app.article.article_id` | Legacy compatibility field on the canonical article row | Temporary compatibility reads during migration | Do not assign new route-scoped meaning. Do not parse source prefixes from it. Replace callers with canonical ids, normalized identifiers, or import-scoped external ids, then remove or fully deprecate it. |
| Source URL | Canonical article URL or import-scoped source URL record | Browser links, exports, full-text routing hints, and source landing pages | Store canonical landing URLs on canonical article fields when they are article-level truth. Store source-specific URLs on the import-scoped record or explicit source metadata fields. URL helpers must use explicit URL fields or identifier-derived URL builders instead of parsing `app.article.article_id` prefixes. |

## Current Repo State

1. Prompt bodies are already mostly shared globally by `content_hash` in `app.prompt`.
2. Covidence prompt creation already hashes and reuses matching prompt bodies, but its archived-prompt behavior should be aligned with the shared immutable prompt path.
3. Article dedupe fails across Covidence imports because Covidence article ids are intentionally namespaced by import route.
4. `app.article` is currently mixing canonical article fields with import-specific payloads:
   - `import_route`
   - `original_data`
   - `source_metadata`
5. `app.article_import_route` already models many-to-many article and route membership, but it does not currently hold the import-scoped metadata that actually belongs there.
6. Several read paths, marts, exports, and admin or full-text flows still assume one article has one `import_route` and one `source_metadata` blob.
7. `app.article.source_metadata` is mixing three different ownership types today:
   - canonical derived metadata like journal title and preprint hints
   - full-text link hints used by fetch and admin paths
   - import-scoped Covidence or source payload that should not be article-global

## Desired Behavior

1. One canonical article row should be reused across overlapping imports.
2. One canonical prompt row should be reused across matching prompt content.
3. Import-specific Covidence metadata must stay per import, not per canonical article.
4. Projects should still scope articles by import route and curated project links.
5. Review screens should show the metadata relevant to the target project's import routes, not a random article-global payload from the last writer.
6. Browser and desktop flows must keep the same functional behavior.

## Performance And Scale Requirements

1. Treat 50,000-article Covidence packages as normal production input, not as an edge case.
2. Treat Europe PMC, `src:med`, `src:PPR`, and similar corpus imports as bulk corpus ingestion that can include millions of candidate articles in one run.
3. Do not perform per-article full-table lookups, JSON scans, or one-transaction-per-row writes during import.
4. Matching must be batch-oriented and set-based:
   - normalize identifiers for a batch first
   - deduplicate identifiers inside the batch before touching canonical tables
   - join or lookup the batch against indexed canonical identifiers in bounded chunks
   - write canonical articles, identifiers, and import records in bounded transactions
5. Bulk imports must be resumable and idempotent by import run, source, and source record key. Restarting an interrupted import must not duplicate canonical articles or duplicate import-scoped records.
6. A Covidence-first then Europe PMC scenario must work:
   - if Covidence created the canonical article first, a later Europe PMC or `src:med`/`src:PPR` import with the same DOI, PMID, arXiv id, bioRxiv id, or medRxiv id must reuse that existing canonical article
   - the later bulk source should add or update its own import-scoped record and add missing canonical identifiers
   - canonical article field updates must go through the deterministic resolver, not overwrite Covidence-derived or user-visible data by last writer wins
7. Weak fingerprint matching must not require comparing each new article against the full article corpus. For large corpus imports, weak matching is allowed only when backed by an indexed non-unique lookup surface or deferred to a separate candidate-resolution job.
8. Large corpus imports should not trigger global mart rebuilds for every project. Refresh only affected import routes and projects, or enqueue scoped rebuild work.
9. Import processing must avoid loading complete source packages, complete staging tables, or complete JSON payloads into process memory at once.
10. Long-running imports must emit progress and checkpoint logs so operators can see throughput, current batch, matched counts, created counts, unresolved counts, and elapsed time.

## Key Decisions

### 1. Keep prompts global and immutable

1. Keep `app.prompt` as the canonical prompt-definition table.
2. Keep prompt identity based on content hash, not on project, import route, or Covidence package.
3. Keep Covidence section and criteria metadata on `app.project_prompt`, not on `app.prompt`.
4. Align Covidence prompt creation with `immutablePromptService` so archived canonical rows are reused safely.

### 2. Make articles truly canonical

1. Treat `app.article` as the canonical article record only.
2. Stop treating `app.article.article_id` as a route-scoped import identity.
3. Stop storing raw import-specific Covidence payloads directly on `app.article`.
4. All canonical article field writes must go through one resolver instead of route-specific ad hoc upserts.

### 3. Split article metadata by ownership

1. Replace the legacy mixed `app.article.source_metadata` contract.
2. Keep canonical derived metadata on `app.article` or a small canonical metadata structure:
   - journal title
   - preprint source and host label
   - aggregated full-text link hints
3. Keep raw source payloads and Covidence-only metadata on `app.article_import_route`.
4. Do not move full-text link hints into a per-import-only location without a canonical replacement. Full-text fetch and admin flows still need article-level access.

### 4. Move import-specific article data into import-scoped records

1. Expand `app.article_import_route` into the real article-import record instead of inventing a second overlapping table first.
2. Store per-import payloads there:
   - raw source data
   - import-scoped metadata
   - Covidence stage membership
   - study and record keys
   - Covidence ids and reference ids
   - notes, tags, file provenance
   - seeded human answers and duplicate flags
3. Keep `UNIQUE(article_id, import_route_id)` so one canonical article can have one record per route.
4. Prefer a new authoritative blob name like `import_metadata` or `import_source_metadata` so it is not confused with the legacy article-level `source_metadata` field.

### 5. Use identifier-based matching instead of route-prefixed article ids

1. Strong identifiers should drive canonical matching:
   - DOI
   - PMID
   - arXiv id
   - bioRxiv id
   - medRxiv id
2. Weak fingerprints are allowed when strong identifiers are missing:
   - normalized title + publication year + first author
3. Covidence-local ids like `covidence_id` and `reference_id` should stay import-scoped and not become the canonical global identity by default.
4. If weak matching is ambiguous, the system should not silently merge.
5. Weak fingerprints are for candidate discovery, not global uniqueness.

### 6. Make external identity explicit

1. `app.article.id` remains the only join key.
2. `app.article_import_route.external_article_id` becomes the source and import-scoped external id used in Covidence seeding, exports, and project-scoped display.
3. `mart.review_article_serving.article_external_id` should be derived from the project-scoped import record, not copied blindly from `app.article.article_id`.
4. Treat `app.article.article_id` as a compatibility field during migration only. Do not give it a new overloaded meaning mid-refactor.

### 7. No random ids for matching

1. Random ids are fine for table primary keys.
2. Random ids are not useful for deciding whether two imported records describe the same article.
3. For missing DOI and PMID, the plan is to rely on deterministic fingerprints plus ambiguity handling, not synthetic random matching ids.

## Target Data Model

Display and URL helpers in the target model must stop parsing source prefixes from `app.article.article_id`. They should read canonical URL fields, identifier-derived URL builders, or project-scoped import records with explicit `external_article_id` and source URL fields.

### Canonical Article

Keep `app.article` for canonical fields only:

1. title
2. abstract
3. authors
4. canonical identifiers
5. canonical URL
6. full text fields
7. publication status
8. canonical derived metadata like journal title, preprint source, preprint host label, and aggregated full-text link hints
9. optional compatibility-only `article_id` until callers are migrated

Fields to stop relying on at the article level:

1. `import_route`
2. raw `original_data`
3. the mixed legacy `source_metadata` blob
4. route-scoped meaning of `article_id`

### Canonical Field Update Policy

1. Identifiers and normalized full-text links are additive and merged by union.
2. Scalar fields like title, abstract, URL, and publication status use a deterministic resolver based on source trust, completeness, and existing non-empty values.
3. Historical merge jobs and live imports must use the same resolver.
4. No write path should keep doing last-writer-wins updates directly against canonical article columns.

### Article Identifier Table

Add `app.article_identifier` with fields like:

1. `id`
2. `article_id` referencing `app.article(id)`
3. `kind`
4. `normalized_value`
5. `source`
6. `is_primary`
7. timestamps

Scope:

1. Store only strong canonical identifiers here:
    - DOI
    - PMID
    - arXiv id
    - bioRxiv id
    - medRxiv id
2. Use `UNIQUE(kind, normalized_value)` for these strong identifiers.
3. Use this table as the canonical matching surface for new imports and for historical backfill.
4. Add an index that supports batch joins by `(kind, normalized_value)` without scanning `app.article`.
5. Bulk imports must stage normalized identifier rows first, then join staging rows to this table in chunks.
6. Duplicate identifiers inside one source batch must be collapsed before canonical article creation to avoid intra-batch races and uniqueness conflicts.

### Weak Match Fingerprint

1. Do not put weak fingerprints into `app.article_identifier`.
2. Preferred default: compute normalized title-year-first-author fingerprints in the matching service.
3. If fingerprint materialization is needed for speed or operator tooling, add a separate table such as `app.article_match_fingerprint` with a non-unique indexed lookup surface.
4. Ambiguous weak fingerprints must remain representable as many articles sharing one fingerprint.
5. For million-row corpus imports, do not run weak matching by scanning canonical article text fields. Either use the materialized non-unique fingerprint lookup or mark weak-only rows for deferred resolution.

### Import-Scoped Article Record

Preferred direction: expand `app.article_import_route` instead of inventing a second overlapping table.

Add fields like:

1. `external_article_id`
2. `source_kind`
3. `original_data`
4. `import_metadata` or `import_source_metadata`
5. `match_strategy`
6. `match_confidence`
7. `import_run_id` or equivalent batch/checkpoint reference
8. `source_record_key`
9. `source_record_hash`
10. timestamps

For Covidence specifically, this record should carry:

1. `studyKey`
2. `studyKeySource`
3. `recordKey`
4. `recordKeySource`
5. `articleKey`
6. `articleKeySource`
7. `stageMembership`
8. `covidenceIds`
9. `referenceIds`
10. `notes`
11. `tags`
12. duplicate-study flags
13. study-decision-conflict flags
14. seeded human answer metadata
15. package file provenance

### Optional Raw Row Child Table

If the Covidence raw source rows are too large or too query-heavy for a single JSON blob, add `app.article_import_route_row`:

1. `id`
2. `article_import_route_id`
3. `row_number`
4. `file_role`
5. `source_file_name`
6. `citation`
7. `note`
8. `exclusion_reason`
9. `tags`

### Bulk Import Staging And Checkpointing

For high-volume sources, add staging and checkpoint state rather than writing directly from parser output to canonical tables.

Minimum staging responsibilities:

1. record the import run, source kind, source file or cursor, batch number, and source record key
2. store normalized strong identifiers in a compact relational shape separate from raw JSON payloads
3. store weak fingerprint inputs only if needed for candidate discovery
4. mark each staged row as matched, created, unresolved, skipped duplicate, or failed
5. preserve enough source information to retry a failed batch without reparsing the whole source when practical

Implementation options:

1. use temporary or persistent staging tables for million-row imports
2. keep persistent checkpoint state for resumability and operator visibility
3. periodically compact or delete completed staging rows once canonical writes and import-scoped records are durable
4. avoid keeping large raw JSON blobs in staging if source rows can be re-read cheaply from a file or cursor

### Project-Scoped Serving Metadata

1. `mart.review_article_serving.source_metadata` should stop being copied wholesale from `app.article.source_metadata`.
2. Serving rows should combine canonical article metadata with import-scoped metadata filtered to the target project's import routes.
3. `mart.review_article_serving.article_external_id` should come from the selected project-scoped import record.
4. Covidence badges and related-record views should be driven by project-scoped import records, not article-global metadata.
5. Display and URL helpers that consume serving rows must use `article_external_id`, explicit source URL fields, canonical URL fields, or identifier-derived URL helpers, not source prefixes parsed from `app.article.article_id`.

## Matching Policy

### Auto-Merge Rules

Automatically reuse an existing canonical article when there is a single unambiguous match on:

1. DOI
2. PMID
3. arXiv id
4. bioRxiv id
5. medRxiv id

For large imports, auto-merge must be implemented as batched joins against `app.article_identifier`, not as one query per source article.

### Weak-Match Rules

When strong identifiers are missing:

1. compute a normalized title-year-first-author fingerprint
2. only auto-merge if that fingerprint resolves to exactly one candidate and there is no conflicting strong identifier on either side
3. otherwise mark the record unresolved instead of merged
4. for million-row corpus imports, run weak matching only against a materialized indexed fingerprint table or defer it to a separate bounded job
5. allow source-specific policy to disable weak auto-merge for broad corpus imports when precision matters more than recall

### Unresolved Cases

Preferred direction:

1. do not silently merge ambiguous weak matches
2. preserve the raw import record in an unresolved-import or manual-review state
3. allow explicit operator resolution to either link an existing canonical article or create a new canonical article
4. keep unresolved records out of normal project review scope until resolved
5. for high-volume corpus imports, unresolved rows should be stored compactly and queryable by source, batch, identifier presence, and fingerprint rather than as large raw blobs only

This is the safest long-term behavior if we want to avoid poisoning canonical article identity.

## Prompt Plan

1. Keep prompt dedupe global by content hash.
2. Replace Covidence prompt creation behavior with the same reuse semantics used by `immutablePromptService`.
3. Keep Covidence criteria metadata on `app.project_prompt`.
4. Keep the current invariant of one `app.project_prompt` row per `(project_id, prompt_id)` for this refactor.
5. If the product later needs two visible slots with identical prompt bodies, add explicit slot identity to `app.project_prompt` or a sibling slot table as a follow-up. Do not solve that by duplicating `app.prompt` rows.

## Main Files And Systems To Change

### Database

1. `src/db/duckdbMigrations/0000_nativeDuckdbSchema.sql`
2. follow-up DuckDB migrations for `app.article_identifier`, the expanded import-scoped article model, and any unresolved or fingerprint tables if needed
3. mart schema migrations where serving metadata and `article_external_id` assumptions change
4. Comparison serving migrations:
   - `src/db/duckdbMigrations/0072_comparisonProjectServingSchema.sql`
   - `src/db/duckdbMigrations/0075_rebuildComparisonServingMarts.sql`

### Import And Write Paths

1. `src/server/services/articleImportStoreService.ts`
2. `src/server/services/covidenceImportService.ts`
3. `src/server/services/structuredFileImportService.ts`
4. `src/server/services/immutablePromptService.ts`
5. `src/server/routes/ArticlesRoutes.ts`
6. PubMed and Europe PMC harvesters:
   - `src/agent/pubmedWorkflowStoreEntries.ts`
   - `src/agent/pubmedHarvest.ts`
   - `src/agent/europePmcPprWorkflowStoreEntries.ts`
   - `src/agent/europePmcPprHarvest.ts`
7. Preprint harvesters:
   - `src/agent/biorxivWorkflowStoreEntries.ts`
   - `src/agent/medrxivWorkflowStoreEntries.ts`
   - `src/agent/arxivWorkflow/arxivWorkflowStoreEntires.ts`
8. Broad-source import routes:
   - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts`
   - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.ts`
   - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostBiorxiv.ts`
   - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostMedrxiv.ts`
   - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts`
   - `src/server/routes/DataSourcesImportRoutes.ts`
9. Import tests:
   - `src/agent/importerStoreEntries.test.ts`
   - source import route tests when present

### Query And Serving Paths

1. `src/server/services/getAppQueryService.ts`
2. `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
3. `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviews.ts`
4. `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts`
5. `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`
6. `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`
7. `src/server/routes/ArticlesRoutes.ts`
8. `src/server/routes/ProjectExportRoutes.ts`
9. `src/server/routes/ArticleAdminRoutes.ts`
10. `src/server/cron/fullTextJobs.ts`
11. `src/services/olap/duckdbOlap.ts`
12. Comparison routes:
   - `src/server/routes/ComparisonProjectsRoutes.ts`
   - `src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts`
13. any caller that still reads `app.article.article_id`, `import_route`, or the legacy mixed `source_metadata` blob directly

### Mart Refresh And Rebuild

1. `src/server/services/getDuckdbMartRefreshService.ts`
2. `src/server/services/projectMartLargeRebuildExecutor.ts`
3. Comparison serving builders:
   - `src/server/services/comparisonProjectServingRollupBuilder.ts`
   - `src/server/services/comparisonProjectServingCellBuilder.ts`
   - `src/server/services/comparisonProjectServingInvalidationService.ts`
4. related refresh state and worker paths

### Types And Metadata Utilities

1. `src/db/schemaTypes.ts`
2. `src/utils/articleSourceMetadata.ts`
3. `src/services/olap/olapTypes.ts`

### Client Review Surfaces

1. Covidence badges and related-record displays
2. filters and review tables that currently assume one article-global Covidence metadata blob
3. exports or detail screens that show source-specific article ids
4. display and URL helpers must stop parsing source prefixes from `app.article.article_id` and instead use project-scoped external ids plus explicit URL fields from the serving payload

### Tests

1. Comparison project serving tests:
   - `src/server/services/comparisonProjectServingRollupBuilder.test.ts`
   - `src/server/services/comparisonProjectServingCellBuilder.test.ts`
   - `src/server/services/comparisonProjectServingInvalidationService.test.ts`
2. Comparison judgment-row tests:
   - `src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.test.ts`

## Phased Implementation Plan

### Phase 0. Regression coverage first

Add tests that capture the current duplicate behavior and the current query-surface expectations before changing the schema and write paths.

Required scenarios:

1. two Covidence imports with overlapping articles currently create duplicate canonical article rows
2. overlapping Covidence and non-Covidence imports currently create duplicate canonical article rows
3. prompt reuse still works across repeated Covidence prompt definitions
4. archived prompt rows do not create hash conflicts once aligned with immutable prompt behavior
5. read and query paths that currently depend on article-level metadata are covered before the split:
   - review hydration
   - related-record lookup
   - human-review filters
   - export
   - full-text fetch selection

### Phase 1. Add the new schema foundation

1. add `app.article_identifier` for strong identifiers only
2. expand `app.article_import_route` to hold import-scoped payloads and source external ids
3. split the legacy mixed article metadata contract into canonical replacements plus import-scoped replacements
4. add any optional raw-row child table, unresolved queue table, or non-unique weak-fingerprint table if needed
5. add indexes needed for identifier lookup, unresolved review lookup, and project-scoped import record lookup
6. add staging and checkpoint tables or an equivalent import-run mechanism for high-volume sources
7. add indexes that support batch joins from staging rows to `app.article_identifier` and `app.article_import_route`
8. keep the old article columns temporarily for compatibility during migration

### Phase 2. Build a canonical article matching and merge service

1. centralize matching logic in one service used by all import flows
2. support strong identifiers first
3. support weak deterministic fingerprints second without unique constraints
4. centralize the canonical field resolver so write paths stop doing last-writer-wins article updates
5. produce explicit match outcomes:
    - reuse canonical article
    - create new canonical article
    - unresolved and requires manual resolution
6. expose a batch API that accepts staged rows or normalized article candidates and returns match outcomes in bounded chunks
7. make the batch API deduplicate source rows and source identifiers before canonical writes
8. make matching idempotent across retries by source kind, import run, source record key, and normalized identifiers
9. keep all large-source matching paths free of full scans over `app.article.original_data`, `app.article.source_metadata`, or import-scoped JSON blobs

### Phase 3. Rewrite article write paths

1. refactor `articleImportStoreService` so it:
    - resolves canonical article ids
    - applies the canonical field resolver
    - writes canonical article data to `app.article`
    - writes strong identifiers to `app.article_identifier`
    - writes import-scoped payloads and external ids to `app.article_import_route`
2. refactor Covidence import so it no longer uses route-prefixed article ids as canonical identity
3. refactor Covidence project-scope and seeded-human-answer lookups so they resolve via import records or an explicit compatibility lookup, not via `app.article.article_id`
4. refactor structured-file import to follow the same canonical model
5. align Covidence prompt creation with `immutablePromptService`
6. stop overwriting `app.article.import_route` and the legacy mixed `source_metadata` blob in `ArticlesRoutes`
7. make Covidence import process records in batches large enough for set-based lookup but small enough to stay within DuckDB memory limits
8. make Europe PMC, `src:med`, `src:PPR`, and similar source imports use staging, checkpointing, and batch matching before canonical writes
9. make PubMed, Europe PMC/PPR, arXiv, bioRxiv, and medRxiv harvesters pass normalized candidates, normalized source identifiers, source record keys, and import-run references to the central matching/write path instead of writing directly to canonical article identity
10. store source `article_id` values from broad-source harvesters only as source-facing or import-scoped identifiers; they must not become canonical article identity or redefine `app.article.article_id`
11. ensure a later broad-source import can enrich a Covidence-created canonical article without changing its project-scoped Covidence metadata

### Phase 4. Backfill and merge historical duplicates

1. backfill `app.article_identifier` from existing article rows
2. backfill import-scoped payloads from current article-level fields
3. backfill canonical derived metadata and full-text link hints from existing article rows
4. detect duplicate canonical articles that should collapse into one
5. choose the survivor deterministically using:
   - strongest identifier coverage
   - most import-route links
   - richest canonical field completeness
   - oldest `created_at`
   - stable id tie-breaker
6. rewrite all referencing foreign keys with explicit table-level conflict handling
7. preserve article-import-route records for each original import route
8. keep migration scripts idempotent and restart-safe
9. process historical duplicate detection in bounded batches by identifier kind and normalized value
10. avoid global weak-fingerprint scans unless a materialized indexed fingerprint table exists

Main FK tables to rewrite during historical merges:

1. `app.article_import_route`
2. `app.project_article`
3. `app.judgment_job_prompt`
4. `app.judgment`
5. `app.judgment_human`
6. `app.judgment_human_summary`
7. `app.review`
8. refresh and quarantine state tables

Conflict rules when FK rewrites hit unique constraints:

1. `app.article_import_route`: if the survivor already has the same route link, merge payloads into one import record instead of creating duplicates
2. `app.project_article`: on conflict keep one row, preserve `imported_from_project_id` when present, and prefer the earliest created link
3. `app.judgment_job_prompt`: on conflict keep the furthest-progress row using `judged > sent > ready > skipped`, preferring non-null timestamps and `server_id`
4. `app.judgment`: on post-merge uniqueness conflict keep one row only if the payloads are materially equivalent; otherwise quarantine for manual resolution instead of silently dropping data
5. `app.judgment_human`: collapse exact duplicates; if answer or comment differ, quarantine for manual review
6. `app.judgment_human_summary`: prefer `manual_override` over seeded Covidence origin, then the latest `updated_at`
7. `app.review`: merge section-complete booleans with logical OR and merge distinct non-empty comments deterministically
8. refresh, quarantine, and mart state: prefer recompute or rebuild from source tables over hand-merging stale derived state

### Phase 5. Rewrite read and query paths

1. update `getAppQueryService` so article reads expose canonical article fields, canonical metadata, and optionally scoped import data separately
2. update review-detail Covidence related-record lookups to read import-scoped records
3. update review list, human list, and human-filter routes that currently query `a.source_metadata` or `a.import_route` off `app.article`
4. update `fullTextJobs` and `ArticleAdminRoutes` so PDF fetch flows still use canonical full-text link hints after the metadata split
5. update OLAP readers and filters that currently query `source_metadata.covidence` off `app.article`
6. update exports and any batch article endpoints that still assume article-global import metadata or article-global external ids
7. update comparison project read paths, including `ComparisonProjectsRoutes` and `comparisonProjectJudgmentRows`, so judgment row lookups explicitly distinguish canonical article ids from external display ids and never infer identity from `app.article.article_id`

### Phase 6. Rewrite mart refresh and rebuild logic

1. keep project scope driven by `project_import_route` plus `project_article`
2. derive serving metadata from canonical article metadata plus the relevant import-scoped records for each project
3. derive `article_external_id` from the chosen project-scoped import record
4. stop denormalizing article-global Covidence metadata into the marts
5. keep incremental refresh and large rebuild behavior aligned
6. when broad corpus imports add millions of canonical articles that are not linked to a project, do not rebuild project review marts for unaffected projects
7. when broad corpus imports enrich articles already linked to Covidence projects, enqueue scoped refreshes only for those affected project and article ids
8. update comparison project serving marts so comparison `article_external_id` comes from the comparison-project source scope or selected import record, not from `app.article.article_id`
9. make comparison serving metadata combine canonical article metadata with scoped import metadata instead of copying `app.article.source_metadata` wholesale

### Phase 7. Client and UI alignment

1. update review pages to read project-scoped Covidence metadata and source-specific external ids
2. update duplicate-study and study-conflict filters to use the new serving shape
3. verify the browser app flow and the desktop app flow both still render Covidence review details correctly

### Phase 8. Remove legacy article-level import fields

After all reads and writes have moved:

1. stop reading `app.article.import_route`
2. stop reading `app.article.original_data`
3. stop reading the mixed legacy `app.article.source_metadata` blob
4. stop reading `app.article.article_id` as an import-scoped external id
5. remove display and URL helper fallbacks that parse source prefixes from `app.article.article_id`
6. remove or fully deprecate those columns in a later cleanup migration; if a canonical public id is still needed, add an explicitly named field instead of reusing `article_id`

## Risks

1. weak matching can incorrectly merge unrelated articles if ambiguity handling is too permissive
2. historical article-level metadata may already reflect last-writer-wins corruption from prior imports
3. mart refresh logic has a large blast radius and can drift from raw read paths if not updated together
4. review filters and Covidence UI can show incorrect project-scoped metadata if they keep reading article-global fields during the transition
5. duplicate historical rows may already have judgments, human judgments, or reviews attached, so survivor selection must be careful and deterministic
6. full-text fetch, export, and admin flows can regress if the metadata split drops canonical full-text links or source-specific external ids
7. prompt-slot expectations can leak into this refactor if the product still assumes duplicate visible prompts with identical bodies
8. million-row source imports can exhaust DuckDB or process memory if staging, matching, or JSON payload handling is not chunked
9. per-row matching queries can make a 50,000-article Covidence import or million-row corpus import unacceptably slow even if correctness is fixed
10. bulk corpus imports can create excessive mart refresh work unless project-impact detection is explicit
11. source batches can contain internal duplicates or conflicting identifiers, so staging must collapse or quarantine conflicts before canonical writes

## Migration Notes

1. this is a long-running refactor, not a small patch
2. prompts do not need a broad redesign; keep prompt dedupe separate from any future prompt-slot work
3. the safest path is a staged migration with compatibility reads during the middle phases
4. after each historical merge batch, rebuild the affected marts before trusting review UI behavior
5. do not blindly rewrite tables with uniqueness constraints; run explicit conflict rules and quarantine unresolved collisions
6. record old-to-new article id mappings and merge decisions for auditability and restart safety
7. for large imports, prefer checkpointed batch cutovers over one monolithic migration transaction
8. broad corpus imports should be safe to pause, resume, and rerun without changing match decisions for already-processed rows

## Logging

- Emit long-running migration and backfill progress as structured `file-only` runtime events with identifiers such as surviving article id, batch size, merge counts, and elapsed time.
- Emit unresolved-match, quarantine, and conflict-resolution warnings as `both` so operators see them in the terminal and the runtime JSONL.
- Make the centralized matching service emit stable structured attrs such as `articleId`, `identifierKind`, `matchStrategy`, and `matchConfidence` instead of ad-hoc text logs.
- For high-volume imports, emit batch-level throughput attrs such as `importRunId`, `sourceKind`, `batchNumber`, `sourceRows`, `matchedRows`, `createdRows`, `unresolvedRows`, `duplicateSourceRows`, `failedRows`, `elapsedMs`, and `rowsPerSecond`.

## Quality Gates

Pass/fail checks for this change:

1. `bun run db:mig`
2. `bun test src/server/services/articleImportStoreService.test.ts`
3. `bun test src/server/services/covidenceImportService.test.ts`
4. `bun test src/server/services/getAppQueryService.test.ts`
5. `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
6. `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
7. `bun test src/server/routes/ArticlesRoutes.test.ts`
8. `bun test src/server/routes/ProjectsRoutes.test.ts`
9. `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
10. `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.test.ts`
11. `bun test src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.test.ts`
12. `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
13. `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
14. `bun test src/services/olap/duckdbOlap.test.ts`
15. `bun test src/server/services/comparisonProjectServingRollupBuilder.test.ts`
16. `bun test src/server/services/comparisonProjectServingCellBuilder.test.ts`
17. `bun test src/server/services/comparisonProjectServingInvalidationService.test.ts`
18. `bun test src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.test.ts`
19. `bun run lint`
20. `bun run build`
21. `bun run desktop:build`
22. Browser verify:

- create a Covidence import
- re-import the same package
- import an overlapping package from another source
- confirm one canonical article is reused
- confirm project-scoped Covidence metadata, related-record views, filters, and displayed external article ids still render correctly
- confirm a PDF fetch flow still works for an article that only has imported full-text links

23. Desktop verify the same Covidence create and review flow
24. Performance verify a synthetic or fixture-backed 50,000-record Covidence import completes without per-row matching queries, duplicate canonical articles, or unbounded memory growth
25. Performance verify a staged broad-source import path can process at least one million identifier-bearing rows in bounded chunks and correctly links rows that match articles previously created by Covidence
26. Verify broad-source imports that do not affect a project do not trigger rebuilds for unrelated project review marts

## Commands To Run

1. add the new regression tests before behavior changes
2. run the targeted `bun test` commands before implementation and after each major phase, including `getAppQueryService`, human-review routes, and OLAP coverage when those layers change
3. run comparison project serving and judgment-row tests when comparison routes, read paths, or serving marts change
4. run `bun run db:mig` after each schema phase
5. run `bun run build` for shared app changes
6. run `bun run desktop:build` when runtime paths or shared UI are touched
7. run `bun run lint` before merge
8. add or run a repo-native import benchmark or integration test for 50,000 Covidence records before accepting the write-path rewrite
9. add or run a repo-native staged-import benchmark or integration test for million-row Europe PMC or `src:med`/`src:PPR` identifier matching before accepting the broad-source path

## Open Decisions During Build

1. whether weak fingerprints stay computed on demand or get materialized in a separate non-unique table
2. whether the expanded import-scoped blob should be named `import_metadata` or `import_source_metadata`
3. whether raw Covidence source rows should live in one JSON payload or in a child table for queryability and size control
4. whether canonical derived metadata that does not justify dedicated columns should live in a small canonical JSON field or explicit columns only
5. whether high-volume staging should be persistent by default for resumability or temporary for smaller interactive imports
6. what batch sizes and checkpoint intervals are safe defaults for 50,000-record Covidence imports and million-row corpus imports under the shared DuckDB memory limit
7. whether broad-source imports should disable weak auto-merge by default unless a fingerprint table is present
