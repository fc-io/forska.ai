# Lean Duck Plan

## Goal

- [ ] Cut live DuckDB size hard, without breaking review/judgment UX.
- [ ] Keep hot DB for active work; push cold/duplicated data out.
- [ ] Rebuild/compact only after real deletions, not via `VACUUM`.

## Baseline

- [ ] Treat current DB as ~`390.5 GiB`; free blocks only ~`1.7 GiB`.
- [ ] Treat `mart` as main target: ~`169 GiB`.
- [ ] Treat `app.article` as next target: ~`89 GiB`.
- [ ] Treat biggest known buckets as:
  - `app.article.original_data` ~`69.5 GiB`
  - duplicated article metadata in marts ~`85.6 GiB`
  - duplicated judgment payload in marts ~`31.2 GiB`
  - archived-project mart rows ~`68 GiB`

## Phase 1 - Archived Out Of Marts

- [ ] Adopt one archived-project product rule: archived projects are cold storage, not live working surfaces.
- [ ] Archived projects should only support unarchive; no edit, no review, no detail views, no normal project actions.
- [ ] Keep archived-project UI minimal: name, status, maybe counts, unarchive action.
- [ ] Remove archived-project links/buttons for review, settings, prompts, exports, and detail screens.
- [ ] Add route/page guards so archived project URLs redirect back to list or archived placeholder.
- [ ] Add server/API guards so archived projects reject edit/review mutations even if UI is bypassed.
- [ ] Audit every mart table keyed by `project_id`; decide if archived projects need live mart rows at all.
- [ ] Change full rebuild SQL in `src/server/services/getDuckdbMartService.ts` to skip archived projects.
- [ ] Change scoped refresh SQL in `src/server/services/getDuckdbMartRefreshService.ts` to delete mart rows when a project becomes archived.
- [ ] Add one explicit path to rebuild marts for one archived project on demand if we still need archived review views.
- [ ] Decide archived fallback: direct base-table queries vs temporary rebuild vs no mart-backed archived review UI.
- [ ] Add one cleanup script to purge existing archived-project rows from all mart tables.
- [ ] Add UI/server tests that archived projects can be unarchived but not otherwise used.
- [ ] After purge, run `CHECKPOINT`, then compact by copying into a fresh DB.

## Phase 2 - `mart.review_article_judgment_payload`

- [ ] Confirm runtime read-path usage; code search says it is rebuilt but not queried.
- [ ] If unused, stop writing it in `src/server/services/getDuckdbMartService.ts` and `src/server/services/getDuckdbMartRefreshService.ts`.
- [ ] Drop the table from DuckDB schema/migrations if unused.
- [ ] If needed in one narrow screen only, replace full mart materialization with detail-time join to `mart.judgment_fact` or `app.judgment`.
- [ ] Add regression test so payload rows are not silently reintroduced.
- [ ] Compact DB after removal.

## Phase 3 - `app.article.original_data`

- [ ] Audit every caller of `original_data`; split into must-keep vs nice-to-have.
- [ ] List exact subfields actually used by UI, exports, imports, and cron paths.
- [ ] Treat current runtime uses as four buckets: DOI lookup, full-text link fallback, journal title fallback, and preprint/source display.
- [ ] Verify `app.article.doi` matches `original_data.doi` everywhere it exists.
- [ ] Backfill `app.article.doi` from `original_data.doi` anywhere missing.
- [ ] Add one normalization step so DOI values have one canonical format before comparing/backfilling.
- [ ] Change Unpaywall/PDF fetch paths to read DOI from `app.article.doi`, not `original_data`.
- [ ] Confirm import routes populate `doi` directly on write, especially PubMed.
- [ ] Verify every data source import path still writes the right `doi`, `original_data`, and normalized source metadata after the import/update changes.
- [ ] Add/import one normalized hot source metadata field for current UX needs: `journalTitle`, `preprintSource`, `isPreprint`, and `fullTextLinks`.
- [ ] Decide storage shape for normalized source metadata: one JSON field vs a few typed columns plus one JSON field for links.
- [ ] Backfill normalized source metadata from legacy `original_data` for existing rows.
- [ ] Change review APIs to return normalized source metadata instead of raw `originalData`.
- [ ] Change admin PDF tooling to use normalized `fullTextLinks` instead of raw `originalData`.
- [ ] Change export paths to use normalized `journalTitle` instead of raw `originalData`.
- [ ] Stop client review tables from depending on raw `originalData`; use normalized source fields only.
- [ ] Treat `original_data` as disposable; do not build a cold-store path.
- [ ] Remove `original_data` from hot storage once replacement fields are fully verified.
- [ ] Backfill any hot typed fields we still need into normal columns before removal.
- [ ] Stop writing large raw payloads into hot `app.article` for new imports.
- [ ] Keep writing the normalized hot source metadata when new articles import.
- [ ] Add one migration/script to purge historical `original_data`.
- [ ] Only purge `original_data` after review/admin/export/PDF fetch paths no longer read it.
- [ ] Compact DB after removal/move.

## Phase 4 - Stop Storing Duplicated Article Metadata In Marts

- [ ] Adopt one mart rule: marts keep ids, filters, sort keys, counts, booleans; not repeated display text unless proven needed.
- [ ] Remove repeated article metadata from `mart.project_scope_article`.
- [ ] Remove repeated article metadata from `mart.prompt_answer_fact`.
- [ ] Remove repeated article metadata from `mart.review_article_rollup`.
- [ ] Remove repeated article metadata from `mart.review_article_page`.
- [ ] Remove repeated article metadata from `mart.review_article_display`.
- [ ] Remove repeated article metadata from `mart.review_article_candidate`.
- [ ] Remove repeated article metadata from `mart.review_article_judgment_detail`.
- [ ] Update OLAP/read queries to join `app.article` for titles, route/status, URLs, full-text display fields.
- [ ] Keep only article columns that are truly needed for order/filter paths.

## Phase 5 - Design Slimmer Mart Shapes

- [ ] Write target column set for each large mart before changing SQL.
- [ ] Make `mart.project_scope_article` a scope table only: ids, scope flags, matched routes, freshness marker.
- [ ] Make `mart.prompt_answer_fact` an answer fact only: ids, answer value, minimal time/order fields.
- [ ] Make `mart.review_article_rollup` a rollup only: ids, counts, booleans, latest timestamps, route-match ids.
- [ ] Check if `mart.review_article_page` can be derived from `mart.review_article_rollup` + `app.article` instead of stored separately.
- [ ] Check if `mart.review_article_display` can be dropped and replaced by join-time projection.
- [ ] Check if `mart.review_article_candidate` should keep only ids, sequence, and judging completeness fields.
- [ ] Check if `mart.review_article_judgment_detail` should keep only ids/order plus small answer fields, with payload joined later.
- [ ] Check if some marts can disappear fully because they are cached projections of another mart.
- [ ] Benchmark key pages after each mart-slimming step.

## Phase 6 - Review Wide Mart Indexes After Slimming

- [ ] Inventory current mart indexes and map each one to a real query predicate/order path.
- [ ] Drop indexes that only support removed duplicated columns.
- [ ] Re-check if multi-column wide indexes are still needed once marts hold fewer text columns.
- [ ] Keep narrow indexes first: `project_id`, join ids, order timestamps, small boolean/order combos.
- [ ] Re-run slow page/query checks after each index drop.
- [ ] Compact DB after index cleanup.

## Execution Order

- [ ] First: archived out of marts.
- [ ] Second: remove `mart.review_article_judgment_payload` if unused.
- [ ] Third: slim duplicated article metadata across marts.
- [ ] Fourth: decide fate of `original_data`.
- [ ] Fifth: review/rebuild indexes on the slimmer schema.
- [ ] After each major delete wave: backup, `CHECKPOINT`, fresh-copy compact, verify counts.

## Done When

- [ ] Archived projects no longer consume live mart space.
- [ ] Archived projects are unarchive-only in UI/API.
- [ ] Unused payload mart is gone.
- [ ] `original_data` is removed from hot storage or moved cold.
- [ ] Large marts store keys/facts, not repeated article text.
- [ ] Mart indexes are only the ones real query paths need.
- [ ] Live DuckDB is materially smaller after compact copy.
