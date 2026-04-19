# Covidence De-duplication Plan

## Goal

- Prevent duplicate canonical articles and duplicate prompt definitions across Covidence imports and other import sources.
- Keep import-specific Covidence metadata like stage membership, study keys, notes, source rows, and seeded human answers without forcing one article row per import.
- Preserve existing review, judgment, and mart behavior while moving to a cleaner long-term data model.

Touched layers: server, database, client

## Short Answer On Identifiers

1. We do not need a random identifier for deduplication.
2. We still need random UUIDs as internal primary keys for rows.
3. The current unique ids in our app are not enough for cross-import dedupe:
   - `app.article.id` is only an internal row id.
   - Covidence currently writes `app.article.article_id` as `covidence:<datasourceId>:<articleKey>`, which is route-scoped and guarantees duplicates across imports.
4. We can live with articles that have no DOI and no PMID.
5. For those articles, dedupe must fall back to weaker fingerprints and ambiguity handling. A random id does not help match the same article across two imports.

## Current Repo State

1. Prompt bodies are already mostly shared globally by `content_hash` in `app.prompt`.
2. Covidence prompt creation already hashes and reuses matching prompt bodies, but its archived-prompt behavior should be aligned with the shared immutable prompt path.
3. Article dedupe fails across Covidence imports because Covidence article ids are intentionally namespaced by import route.
4. `app.article` is currently mixing canonical article fields with import-specific payloads:
   - `import_route`
   - `original_data`
   - `source_metadata`
5. `app.article_import_route` already models many-to-many article and route membership, but it does not currently hold the import-scoped metadata that actually belongs there.
6. Several read paths, marts, and UI surfaces still assume one article has one `import_route` and one `source_metadata` blob.

## Desired Behavior

1. One canonical article row should be reused across overlapping imports.
2. One canonical prompt row should be reused across matching prompt content.
3. Import-specific Covidence metadata must stay per import, not per canonical article.
4. Projects should still scope articles by import route and curated project links.
5. Review screens should show the metadata relevant to the target project's import routes, not a random article-global payload from the last writer.
6. Browser and desktop flows must keep the same functional behavior.

## Key Decisions

### 1. Keep prompts global and immutable

1. Keep `app.prompt` as the canonical prompt-definition table.
2. Keep prompt identity based on content hash, not on project, import route, or Covidence package.
3. Keep Covidence section and criteria metadata on `app.project_prompt`, not on `app.prompt`.
4. Align Covidence prompt creation with the shared immutable prompt helper behavior so archived canonical rows are reused safely.

### 2. Make articles truly canonical

1. Treat `app.article` as the canonical article record only.
2. Stop treating `app.article.article_id` as a route-scoped import identity.
3. Stop storing import-specific Covidence payloads directly on `app.article`.

### 3. Move import-specific article data into import-scoped records

1. Promote `app.article_import_route` into the real article-import record, or add a sibling table with the same role.
2. Store per-import payloads there:
   - raw source data
   - source metadata
   - Covidence stage membership
   - study and record keys
   - Covidence ids and reference ids
   - notes, tags, file provenance
   - seeded human answers and duplicate flags
3. Keep `UNIQUE(article_id, import_route_id)` so one canonical article can have one record per route.

### 4. Use identifier-based matching instead of route-prefixed article ids

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

### 5. No random ids for matching

1. Random ids are fine for table primary keys.
2. Random ids are not useful for deciding whether two imported records describe the same article.
3. For missing DOI and PMID, the plan is to rely on deterministic fingerprints plus ambiguity handling, not synthetic random matching ids.

## Target Data Model

### Canonical Article

Keep `app.article` for canonical fields only:

1. title
2. abstract
3. authors
4. canonical identifiers
5. canonical URL
6. full text fields
7. publication status
8. canonical derived metadata like journal title and preprint source

Fields to stop relying on at the article level:

1. `import_route`
2. import-scoped `original_data`
3. import-scoped `source_metadata`

### Article Identifier Table

Add `app.article_identifier` with fields like:

1. `id`
2. `article_id` referencing `app.article(id)`
3. `kind`
4. `normalized_value`
5. `source`
6. `is_primary`
7. timestamps

Expected unique constraint:

1. `UNIQUE(kind, normalized_value)`

This table becomes the canonical matching surface for new imports and for historical backfill.

### Import-Scoped Article Record

Preferred direction: expand `app.article_import_route` instead of inventing a second overlapping table.

Add fields like:

1. `external_article_id`
2. `source_kind`
3. `original_data`
4. `source_metadata`
5. `match_strategy`
6. `match_confidence`
7. timestamps

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

### Project-Scoped Serving Metadata

1. `mart.review_article_serving.source_metadata` should stop being copied from `app.article.source_metadata`.
2. Serving metadata should be derived from the import-scoped records relevant to the target project's import routes.
3. Covidence badges and related-record views should be driven by project-scoped import records, not article-global metadata.

## Matching Policy

### Auto-Merge Rules

Automatically reuse an existing canonical article when there is a single unambiguous match on:

1. DOI
2. PMID
3. arXiv id
4. bioRxiv id
5. medRxiv id

### Weak-Match Rules

When strong identifiers are missing:

1. compute a normalized title-year-first-author fingerprint
2. only auto-merge if that fingerprint resolves to exactly one candidate and there is no conflicting strong identifier on either side
3. otherwise treat it as ambiguous

### Ambiguous Cases

Preferred direction:

1. do not silently merge ambiguous weak matches
2. create a manual review queue or blocked-import state for those cases
3. allow explicit operator resolution

This is the safest long-term behavior if we want to avoid poisoning canonical article identity.

## Prompt Plan

1. Keep prompt dedupe global by content hash.
2. Replace Covidence prompt creation behavior with the same reuse semantics used by `immutablePromptService`.
3. Keep Covidence criteria metadata on `app.project_prompt`.
4. If two logical Covidence criteria happen to produce the same prompt body, model them as separate project prompt slots if the product still needs both visible. Do not solve that by duplicating `app.prompt` rows.

## Main Files And Systems To Change

### Database

1. `src/db/duckdbMigrations/0000_nativeDuckdbSchema.sql`
2. follow-up DuckDB migrations for the new identifier and import-scoped article model
3. mart schema migrations where serving metadata assumptions change

### Import And Write Paths

1. `src/server/services/articleImportStoreService.ts`
2. `src/server/services/covidenceImportService.ts`
3. `src/server/services/structuredFileImportService.ts`
4. `src/server/routes/ArticlesRoutes.ts`

### Query And Serving Paths

1. `src/server/services/getAppQueryService.ts`
2. `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
3. `src/server/routes/ArticlesRoutes.ts`
4. `src/server/routes/ProjectExportRoutes.ts`
5. `src/services/olap/duckdbOlap.ts`

### Mart Refresh And Rebuild

1. `src/server/services/getDuckdbMartRefreshService.ts`
2. `src/server/services/projectMartLargeRebuildExecutor.ts`
3. related refresh state and worker paths

### Types And Metadata Utilities

1. `src/db/schemaTypes.ts`
2. `src/utils/articleSourceMetadata.ts`
3. `src/services/olap/olapTypes.ts`

### Client Review Surfaces

1. Covidence badges and related-record displays
2. any route that reads one article-global Covidence metadata blob today

## Phased Implementation Plan

### Phase 0. Regression coverage first

Add tests that capture the current duplicate behavior before changing the schema and write paths.

Required scenarios:

1. two Covidence imports with overlapping articles currently create duplicate canonical article rows
2. overlapping Covidence and non-Covidence imports currently create duplicate canonical article rows
3. prompt reuse still works across repeated Covidence prompt definitions
4. archived prompt rows do not create hash conflicts once aligned with immutable prompt behavior

### Phase 1. Add the new schema foundation

1. add `app.article_identifier`
2. expand `app.article_import_route` to hold import-scoped payloads
3. add any optional raw-row child table if needed
4. add indexes needed for identifier lookup and project-scoped import record lookup
5. keep the old article columns temporarily for compatibility during migration

### Phase 2. Build a canonical article matching service

1. centralize matching logic in one service used by all import flows
2. support strong identifiers first
3. support weak deterministic fingerprints second
4. produce explicit match outcomes:
   - reuse canonical article
   - create new canonical article
   - ambiguous and requires manual resolution

### Phase 3. Rewrite article write paths

1. refactor `articleImportStoreService` so it:
   - resolves canonical article ids
   - writes canonical article data to `app.article`
   - writes import-scoped payloads to `app.article_import_route`
2. refactor Covidence import so it no longer uses route-prefixed article ids as canonical identity
3. refactor structured-file import to follow the same canonical model
4. stop overwriting `app.article.import_route` and `app.article.source_metadata` in `ArticlesRoutes`

### Phase 4. Backfill and merge historical duplicates

1. backfill `app.article_identifier` from existing article rows
2. backfill import-scoped payloads from current article-level fields
3. detect duplicate canonical articles that should collapse into one
4. rewrite all referencing foreign keys from duplicate article ids to the chosen survivor
5. preserve article-import-route records for each original import route
6. keep migration scripts idempotent and restart-safe

Main FK tables to rewrite during historical merges:

1. `app.article_import_route`
2. `app.project_article`
3. `app.judgment_job_prompt`
4. `app.judgment`
5. `app.judgment_human`
6. `app.judgment_human_summary`
7. `app.review`
8. refresh and quarantine state tables

### Phase 5. Rewrite read and query paths

1. update `getAppQueryService` so article reads expose canonical article fields and scoped import data separately
2. update review-detail Covidence related-record lookups to read import-scoped records
3. update OLAP readers and filters that currently query `source_metadata.covidence` off `app.article`
4. update exports and any batch article endpoints that still assume article-global import metadata

### Phase 6. Rewrite mart refresh and rebuild logic

1. keep project scope driven by `project_import_route` plus `project_article`
2. derive serving metadata from the relevant import-scoped records for each project
3. stop denormalizing article-global Covidence metadata into the marts
4. keep incremental refresh and large rebuild behavior aligned

### Phase 7. Client and UI alignment

1. update review pages to read project-scoped Covidence metadata
2. update duplicate-study and study-conflict filters to use the new serving shape
3. verify the browser app flow and the desktop app flow both still render Covidence review details correctly

### Phase 8. Remove legacy article-level import fields

After all reads and writes have moved:

1. stop reading `app.article.import_route`
2. stop reading `app.article.original_data`
3. stop reading `app.article.source_metadata`
4. remove or fully deprecate those columns in a later cleanup migration

## Risks

1. weak matching can incorrectly merge unrelated articles if ambiguity handling is too permissive
2. historical article-level metadata may already reflect last-writer-wins corruption from prior imports
3. mart refresh logic has a large blast radius and can drift from raw read paths if not updated together
4. review filters and Covidence UI can show incorrect project-scoped metadata if they keep reading article-global fields during the transition
5. duplicate historical rows may already have judgments, human judgments, or reviews attached, so survivor selection must be careful and deterministic

## Migration Notes

1. this is a long-running refactor, not a small patch
2. prompts do not need a broad redesign; the main work is article identity and import-scoped metadata
3. the safest path is a staged migration with compatibility reads during the middle phases
4. after each historical merge batch, rebuild the affected marts before trusting review UI behavior

## Quality Gates

Pass/fail checks for this change:

1. `bun run db:mig`
2. `bun test src/server/services/articleImportStoreService.test.ts`
3. `bun test src/server/services/covidenceImportService.test.ts`
4. `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
5. `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.test.ts`
6. `bun test src/server/routes/ArticlesRoutes.test.ts`
7. `bun test src/server/routes/ProjectsRoutes.test.ts`
8. `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
9. `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
10. `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
11. `bun run lint`
12. `bun run build`
13. `bun run desktop:build`
14. Browser verify:
    - create a Covidence import
    - re-import the same package
    - import an overlapping package from another source
    - confirm one canonical article is reused and Covidence metadata still renders correctly per project
15. Desktop verify the same Covidence create and review flow

## Commands To Run

1. add the new regression tests before behavior changes
2. run the targeted `bun test` commands before implementation and after each major phase
3. run `bun run db:mig` after each schema phase
4. run `bun run build` for shared app changes
5. run `bun run desktop:build` when runtime paths or shared UI are touched
6. run `bun run lint` before merge

## Open Decisions During Build

1. whether ambiguous weak matches should block import entirely or enter an explicit manual-resolution queue
2. whether to expand `app.article_import_route` directly or introduce a sibling import-record table and migrate consumers later
3. whether raw Covidence source rows should live in one JSON payload or in a child table for queryability and size control
