# Lean Duck Plan

## Goal

- [x] Cut live DuckDB size hard, without breaking review/judgment UX.
- [x] Keep hot DB for active work; push cold/duplicated data out.
- [x] Rebuild/compact only after real deletions, not via `VACUUM`.

## Baseline

- [x] Original baseline before cleanup was ~`390.5 GiB`, with only ~`1.7 GiB` free blocks.
- [x] Original biggest buckets were `mart` (~`169 GiB`) and `app.article` (~`89 GiB`).
- [x] Original major waste buckets were:
  - `app.article.original_data` ~`69.5 GiB`
  - duplicated article metadata in marts ~`85.6 GiB`
  - duplicated judgment payload in marts ~`31.2 GiB`
  - archived-project mart rows ~`68 GiB`
- [x] Current live DB after purge + compact is ~`146.8 GiB`.

## Phase 1 - Archived Out Of Marts

- [x] Adopt one archived-project product rule: archived projects are cold storage, not live working surfaces.
- [x] Archived projects should only support unarchive; no edit, no review, no detail views, no normal project actions.
- [x] Keep archived-project UI minimal: name, status, maybe counts, unarchive action.
- [x] Remove archived-project links/buttons for review, settings, prompts, exports, and detail screens.
- [x] Add route/page guards so archived project URLs redirect back to list or archived placeholder.
- [x] Add server/API guards so archived projects reject edit/review mutations even if UI is bypassed.
- [x] Audit every mart table keyed by `project_id`; decide if archived projects need live mart rows at all.
- [x] Change full rebuild SQL in `src/server/services/getDuckdbMartService.ts` to skip archived projects.
- [x] Change scoped refresh SQL in `src/server/services/getDuckdbMartRefreshService.ts` to delete mart rows when a project becomes archived.
- [x] Decide archived fallback: no mart-backed archived review/detail UI.
- [x] Add one cleanup script to purge existing archived-project rows from all mart tables.
- [x] Add UI/server tests that archived projects can be unarchived but not otherwise used.
- [x] After purge, run `CHECKPOINT`, then compact by copying into a fresh DB.

## Phase 2 - `mart.review_article_judgment_payload`

- [x] Confirm runtime read-path usage; code search says it is rebuilt but not queried.
- [x] If unused, stop writing it in `src/server/services/getDuckdbMartService.ts` and `src/server/services/getDuckdbMartRefreshService.ts`.
- [x] Drop the table from DuckDB schema/migrations if unused.
- [x] Add regression test so payload rows are not silently reintroduced.
- [x] Compact DB after removal.

## Phase 3 - `app.article.original_data`

- [x] Audit every caller of `original_data`; split into must-keep vs nice-to-have.
- [x] List exact subfields actually used by UI, exports, imports, and cron paths.
- [x] Treat current runtime uses as four buckets: DOI lookup, full-text link fallback, journal title fallback, and preprint/source display.
- [x] Verify `app.article.doi` matches `original_data.doi` everywhere it exists.
- [x] Backfill `app.article.doi` from `original_data.doi` anywhere missing.
- [x] Add one normalization step so DOI values have one canonical format before comparing/backfilling.
- [x] Change Unpaywall/PDF fetch paths to read DOI from `app.article.doi`, not `original_data`.
- [x] Confirm import routes populate `doi` directly on write, especially PubMed.
- [x] Verify every data source import path still writes the right `doi`, `original_data`, and normalized source metadata after the import/update changes.
- [x] Add/import one normalized hot source metadata field for current UX needs: `journalTitle`, `preprintSource`, `isPreprint`, and `fullTextLinks`.
- [x] Decide storage shape for normalized source metadata: one JSON field (`app.article.source_metadata`).
- [x] Backfill normalized source metadata from legacy `original_data` for existing rows.
- [x] Change review APIs to return normalized source metadata instead of raw `originalData`.
- [x] Change admin PDF tooling to use normalized `fullTextLinks` instead of raw `originalData`.
- [x] Change export paths to use normalized `journalTitle` instead of raw `originalData`.
- [x] Stop client review tables from depending on raw `originalData`; use normalized source fields only.
- [x] Treat `original_data` as disposable; do not build a cold-store path.
- [x] Remove `original_data` from hot storage once replacement fields are fully verified.
- [x] Backfill any hot typed fields we still need into normal columns before removal.
- [x] Stop writing large raw payloads into hot `app.article` for new imports.
- [x] Keep writing the normalized hot source metadata when new articles import.
- [x] Add one migration/script to purge historical `original_data`.
- [x] Only purge `original_data` after review/admin/export/PDF fetch paths no longer read it.
- [x] Compact DB after removal/move.

## Phase 4 - Stop Storing Duplicated Article Metadata In Marts

- [x] Adopt one mart rule: marts keep ids, filters, sort keys, counts, booleans; not repeated display text unless proven needed.
- [x] Remove repeated article metadata from `mart.project_scope_article`.
- [x] Remove repeated article metadata from `mart.prompt_answer_fact`.
- [x] Remove repeated article metadata from `mart.review_article_rollup`.
- [x] Remove repeated article metadata from `mart.review_article_page`.
- [x] Remove repeated article metadata from `mart.review_article_display`.
- [x] Remove repeated article metadata from `mart.review_article_candidate`.
- [x] Remove repeated article metadata from `mart.review_article_judgment_detail`.
- [x] Update OLAP/read queries to join `app.article` for titles, route/status, URLs, full-text display fields.
- [x] Keep only article columns that are truly needed for order/filter paths.

## Phase 5 - Design Slimmer Mart Shapes

- [x] Write target column set for each large mart before changing SQL.
- [x] Make `mart.project_scope_article` a scope table only: ids, scope flags, matched routes, freshness marker.
- [x] Make `mart.prompt_answer_fact` an answer fact only: ids, answer value, minimal time/order fields.
- [x] Make `mart.review_article_rollup` a rollup only: ids, counts, booleans, latest timestamps, route-match ids.
- [x] Check if `mart.review_article_page` can be derived from `mart.review_article_rollup` + `app.article` instead of stored separately.
- [x] Check if `mart.review_article_display` can be dropped and replaced by join-time projection.
- [x] Check if `mart.review_article_candidate` should keep only ids, sequence, and judging completeness fields.
- [x] Check if `mart.review_article_judgment_detail` should keep only ids/order plus small answer fields, with payload joined later.
- [x] Check if some marts can disappear fully because they are cached projections of another mart.
- [x] Benchmark key pages after each mart-slimming step.

## Phase 6 - Review Wide Mart Indexes After Slimming

- [x] Inventory current mart indexes and map each one to a real query predicate/order path.
- [x] Drop indexes that only support removed duplicated columns.
- [x] Re-check if multi-column wide indexes are still needed once marts hold fewer text columns.
- [x] Keep narrow indexes first: `project_id`, join ids, order timestamps, small boolean/order combos.
- [x] Re-run slow page/query checks after each index drop.
- [ ] Compact DB after index cleanup.

## Execution Order

- [x] First: archived out of marts.
- [x] Second: remove `mart.review_article_judgment_payload` if unused.
- [x] Third: slim duplicated article metadata across marts.
- [x] Fourth: decide fate of `original_data`.
- [x] Fifth: review/rebuild indexes on the slimmer schema.
- [x] After each major delete wave: backup, `CHECKPOINT`, fresh-copy compact, verify counts.

## Done When

- [x] Archived projects no longer consume live mart space.
- [x] Archived projects are unarchive-only in UI/API.
- [x] Unused payload mart is gone.
- [x] `original_data` is removed from hot storage or moved cold.
- [x] Large marts store keys/facts, not repeated article text.
- [x] Mart indexes are only the ones real query paths need.
- [x] Live DuckDB is materially smaller after compact copy.
