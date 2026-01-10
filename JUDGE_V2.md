# JUDGE_V2 (model + article-content-used aware)

- [x] Use 4 bool cols on `judgments`: `useTitle/useAbstract/useFulltext/useFulltextNoImages` (title+abstract both ok; enforce fulltext vs noImages exclusive)
- [x] ~~Decide legacy/backfill rule for existing `judgments`~~ → **Assume title+abstract** (`useTitle=true,useAbstract=true,useFulltext=false,useFulltextNoImages=false`)

## Fix now (bugs)
- [x] Prompt generation must gate fulltext by project flags (no settings => no fulltext)
- [ ] Any “is judged?” check must include `(modelId + 4 bools + isAnswered=true + deletedAt IS NULL)` (PG + CH + UI)
- [ ] CH tombstones unreliable with `ReplacingMergeTree(createdAt)` → don’t ship rejudge until versioning fixed
- [ ] Rejudge must handle in-flight jobs (prevent immediate re-write of “deleted” judgments)

## Postgres / Drizzle
- [x] `src/db/schema.ts`: add 4 bool cols on `judgments` (NOT NULL); defaults: `useTitle=true,useAbstract=true,useFulltext=false,useFulltextNoImages=false`
- [x] DB backfill: set legacy rows to same defaults (avoid old rows becoming all-false)
- [x] Add index `(article_id,prompt_id,model_id,useTitle,useAbstract,useFulltext,useFulltextNoImages)`; if unique, include soft-delete (`deletedAt`) or partial-unique on `deletedAt IS NULL` (so rejudge can insert)
- [x] Drizzle mig: `bun run db:gen` + `bun run db:mig` (no hand SQL)

## Prompt build + store (LLM)
- [x] `src/agent/judge/judgeGetPrompt.ts`: `ContentSettings` includes fulltext flags; fulltext only when flagged; (no-flag => ignore `article.fullText`)
- [x] `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`: pass full content settings; ensure fulltext only for `useFulltext||useFulltextNoImages`; strip images when `useFulltextNoImages`
- [x] `src/agent/judge.ts`: propagate `contentSettings` to prompt build
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: store 4 bool cols; existing-check must match `(articleId,promptId,modelId,useTitle,useAbstract,useFulltext,useFulltextNoImages,deletedAt IS NULL)`

## Queue selection (rejudge rules)
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`: NOT EXISTS match on `(articleId,promptId,project.modelId,4 bools,isAnswered=true,deletedAt IS NULL)`

## API (review + unassessed)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`: filter “LLM assessment” by `(modelId + 4 bools + isAnswered=true + deletedAt IS NULL)`; placeholders based on same (other-model/content must not block)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`: join/filter judgments by `(modelId + 4 bools + isAnswered=true + deletedAt IS NULL)`
- [ ] `src/server/routes/ArticlesRoutes.ts`: include new fields in judgments payload (UI labeling)

## ClickHouse / Parquet analytics (must filter by content cols too)
- [ ] `src/services/parquet/types.ts` + `src/services/parquet/parquetWriter.ts`: add 4 bool cols
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: write parquet record incl content fields
- [ ] `scripts/clickhouse-setup.sql`: add columns to `forska.judgments` + `judgments_queue` + MV (+ coalesce legacy NULLs → title+abstract defaults)
- [ ] Legacy Parquet rows: don’t rewrite; rely on CH MV (or query) `coalesce(useTitle,1)`, `coalesce(useAbstract,1)`, `coalesce(useFulltext,0)`, `coalesce(useFulltextNoImages,0)`
- [ ] Server fallback: if flags come back `null` from ClickHouse, treat as title+abstract for filtering + UI labels (safety net; primary defaulting is in CH)
- [ ] `scripts/backfillPostgresToParquet.ts`: emit new cols (per legacy/backfill rule)
- [ ] Tombstones: current CH `ReplacingMergeTree(createdAt)` won’t reliably let tombstones override (same `createdAt`); add a `versionAt/updatedAt` column (PG+Parquet+CH) or change CH versioning so tombstone wins
- [ ] ClickHouse queries: add `(modelId + 4 bool cols + deletedAt IS NULL)` filters; for legacy rows use coalesce in WHERE too
  - [ ] `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsBothClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`
  - [ ] `src/services/clickhouse/selectArticleIdsClickHouse.ts` (used by `src/server/routes/ProjectsAddArticlesRoutes.ts`)

## Client UI (show “Article Content Used” per judgment)
- [ ] `src/components/main/projects/reviews/review/reviewJudgmentItem.tsx`: render content label next to model
- [ ] `src/components/main/projects/reviews/review/reviewJudgments.tsx` + `src/components/main/projects/reviews/review/reviewAvailableJudgments.tsx`: plumb new fields/types

## Rejudge Project (force re-evaluation)
This feature allows forcing a project to be re-judged by cancelling all existing judgments for that project. This is useful when project settings (prompts, model, content flags) change and you want fresh judgments.

### UI
- [ ] `src/components/main/ProjectsGrid.tsx`: add "Rejudge" button per project (with confirmation dialog). Button should show loading state while processing.

### API
- [ ] `src/server/routes/projectsRoutes/projectsRoutesPostRejudge.ts`: new POST `/api/projects/:id/rejudge` endpoint
  - Auth: require project ownership
  - Steps:
    1. Fetch all judgment IDs for this project (via `judgments.projectId = projectId`)
    2. Soft-delete in PostgreSQL: `UPDATE judgments SET deletedAt = now() WHERE projectId = :projectId AND deletedAt IS NULL`
    3. Write tombstone records to Parquet for each affected judgment (batch operation)
    4. Return count of cancelled judgments

### PostgreSQL
- [ ] *No schema changes needed* — `judgments.deletedAt` already exists for soft delete support

### Parquet / ClickHouse (tombstone records)
- [ ] `src/services/parquet/parquetWriter.ts`: batch tombstone helper (note: `writeTombstone` already exists but needs a winning CH version column)
  - For each judgment ID, write a record with the same `id` but `deletedAt` set to current timestamp
  - This ensures ClickHouse `ReplacingMergeTree` will treat these as deleted during merges
- [ ] `src/services/parquet/types.ts`: possibly add helper type for tombstone creation (reuse `DenormalizedJudgmentAnalytics`)

### Service layer
- [ ] `src/server/routes/projectsRoutes/index.ts`: wire up the new rejudge route
- [ ] Consider adding `src/services/judgments/cancelJudgments.ts`: shared logic for soft-deleting judgments in both PG and Parquet

### Queue behavior
- After rejudge, the queue selection query (via `NOT EXISTS` on `isAnswered=true AND deletedAt IS NULL`) will automatically pick up these articles again for the next judgments job.

## Checks
- [ ] `bun run lint`
- [ ] `bun test` (unit: `judgeGetSinglePrompt` respects flags)
