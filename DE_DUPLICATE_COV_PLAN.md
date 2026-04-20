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

### Weak Match Fingerprint

1. Do not put weak fingerprints into `app.article_identifier`.
2. Preferred default: compute normalized title-year-first-author fingerprints in the matching service.
3. If fingerprint materialization is needed for speed or operator tooling, add a separate table such as `app.article_match_fingerprint` with a non-unique indexed lookup surface.
4. Ambiguous weak fingerprints must remain representable as many articles sharing one fingerprint.

### Import-Scoped Article Record

Preferred direction: expand `app.article_import_route` instead of inventing a second overlapping table.

Add fields like:

1. `external_article_id`
2. `source_kind`
3. `original_data`
4. `import_metadata` or `import_source_metadata`
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

1. `mart.review_article_serving.source_metadata` should stop being copied wholesale from `app.article.source_metadata`.
2. Serving rows should combine canonical article metadata with import-scoped metadata filtered to the target project's import routes.
3. `mart.review_article_serving.article_external_id` should come from the selected project-scoped import record.
4. Covidence badges and related-record views should be driven by project-scoped import records, not article-global metadata.

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
3. otherwise mark the record unresolved instead of merged

### Unresolved Cases

Preferred direction:

1. do not silently merge ambiguous weak matches
2. preserve the raw import record in an unresolved-import or manual-review state
3. allow explicit operator resolution to either link an existing canonical article or create a new canonical article
4. keep unresolved records out of normal project review scope until resolved

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

### Import And Write Paths

1. `src/server/services/articleImportStoreService.ts`
2. `src/server/services/covidenceImportService.ts`
3. `src/server/services/structuredFileImportService.ts`
4. `src/server/services/immutablePromptService.ts`
5. `src/server/routes/ArticlesRoutes.ts`

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
12. any caller that still reads `app.article.article_id`, `import_route`, or the legacy mixed `source_metadata` blob directly

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
2. filters and review tables that currently assume one article-global Covidence metadata blob
3. exports or detail screens that show source-specific article ids

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
6. keep the old article columns temporarily for compatibility during migration

### Phase 2. Build a canonical article matching and merge service

1. centralize matching logic in one service used by all import flows
2. support strong identifiers first
3. support weak deterministic fingerprints second without unique constraints
4. centralize the canonical field resolver so write paths stop doing last-writer-wins article updates
5. produce explicit match outcomes:
   - reuse canonical article
   - create new canonical article
   - unresolved and requires manual resolution

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

### Phase 6. Rewrite mart refresh and rebuild logic

1. keep project scope driven by `project_import_route` plus `project_article`
2. derive serving metadata from canonical article metadata plus the relevant import-scoped records for each project
3. derive `article_external_id` from the chosen project-scoped import record
4. stop denormalizing article-global Covidence metadata into the marts
5. keep incremental refresh and large rebuild behavior aligned

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
5. remove or fully deprecate those columns in a later cleanup migration; if a canonical public id is still needed, add an explicitly named field instead of reusing `article_id`

## Risks

1. weak matching can incorrectly merge unrelated articles if ambiguity handling is too permissive
2. historical article-level metadata may already reflect last-writer-wins corruption from prior imports
3. mart refresh logic has a large blast radius and can drift from raw read paths if not updated together
4. review filters and Covidence UI can show incorrect project-scoped metadata if they keep reading article-global fields during the transition
5. duplicate historical rows may already have judgments, human judgments, or reviews attached, so survivor selection must be careful and deterministic
6. full-text fetch, export, and admin flows can regress if the metadata split drops canonical full-text links or source-specific external ids
7. prompt-slot expectations can leak into this refactor if the product still assumes duplicate visible prompts with identical bodies

## Migration Notes

1. this is a long-running refactor, not a small patch
2. prompts do not need a broad redesign; keep prompt dedupe separate from any future prompt-slot work
3. the safest path is a staged migration with compatibility reads during the middle phases
4. after each historical merge batch, rebuild the affected marts before trusting review UI behavior
5. do not blindly rewrite tables with uniqueness constraints; run explicit conflict rules and quarantine unresolved collisions
6. record old-to-new article id mappings and merge decisions for auditability and restart safety

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
15. `bun run lint`
16. `bun run build`
17. `bun run desktop:build`
18. Browser verify:

- create a Covidence import
- re-import the same package
- import an overlapping package from another source
- confirm one canonical article is reused
- confirm project-scoped Covidence metadata, related-record views, filters, and displayed external article ids still render correctly
- confirm a PDF fetch flow still works for an article that only has imported full-text links

19. Desktop verify the same Covidence create and review flow

## Commands To Run

1. add the new regression tests before behavior changes
2. run the targeted `bun test` commands before implementation and after each major phase, including `getAppQueryService`, human-review routes, and OLAP coverage when those layers change
3. run `bun run db:mig` after each schema phase
4. run `bun run build` for shared app changes
5. run `bun run desktop:build` when runtime paths or shared UI are touched
6. run `bun run lint` before merge

## Open Decisions During Build

1. whether weak fingerprints stay computed on demand or get materialized in a separate non-unique table
2. whether the expanded import-scoped blob should be named `import_metadata` or `import_source_metadata`
3. whether raw Covidence source rows should live in one JSON payload or in a child table for queryability and size control
4. whether canonical derived metadata that does not justify dedicated columns should live in a small canonical JSON field or explicit columns only
