# JUDGE_V2 (model + article-content-used aware)

- [x] Use 4 bool cols on `judgments`: `useTitle/useAbstract/useFulltext/useFulltextNoImages` (title+abstract both ok; enforce fulltext vs noImages exclusive)
- [x] ~~Decide legacy/backfill rule for existing `judgments`~~ → **Assume title+abstract** (`useTitle=true,useAbstract=true,useFulltext=false,useFulltextNoImages=false`)

## Postgres / Drizzle
- [ ] `src/db/schema.ts`: add 4 bool cols on `judgments`; add index `(article_id,prompt_id,model_id,useTitle,useAbstract,useFulltext,useFulltextNoImages)` (+ optional unique)
- [ ] Drizzle mig: `bun run db:gen` + `bun run db:mig` (no hand SQL)

## Prompt build + store (LLM)
- [ ] `src/agent/judge/judgeGetPrompt.ts`: extend `ContentSettings` to include fulltext flags; include fulltext only when flagged; (no-flag => strip/ignore `article.fullText`)
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`: pass full content settings; ensure fulltext only for `useFulltext||useFulltextNoImages`; strip images when `useFulltextNoImages`
- [ ] `src/agent/judge.ts`: propagate `contentSettings` through to storage
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: store 4 bool cols; existing-check must match `(articleId,promptId,modelId,useTitle,useAbstract,useFulltext,useFulltextNoImages)`

## Queue selection (rejudge rules)
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`: NOT EXISTS match on `(articleId,promptId,project.modelId,useTitle,useAbstract,useFulltext,useFulltextNoImages,isAnswered=true)`

## API (review + unassessed)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`: fetch project modelId+content flags; filter “LLM assessment” by `(modelId + 4 bool cols)`; placeholders based on same (fix: other-model/content judgments must not block)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`: join/filter judgments by `(modelId + 4 bool cols + isAnswered=true)`
- [ ] `src/server/routes/ArticlesRoutes.ts`: include new fields in `/api/articles/:id` judgments payload (for UI labeling)

## ClickHouse / Parquet analytics (must filter by content cols too)
- [ ] `src/services/parquet/types.ts` + `src/services/parquet/parquetWriter.ts`: add 4 bool cols
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: write parquet record incl content fields
- [ ] `scripts/clickhouse-setup.sql`: add columns to `forska.judgments` + `judgments_queue` + MV
- [ ] `scripts/backfillPostgresToParquet.ts`: emit new cols (per legacy/backfill rule)
- [ ] ClickHouse queries: add `(modelId + 4 bool cols)` filters
  - [ ] `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsBothClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`
  - [ ] `src/services/clickhouse/selectArticleIdsClickHouse.ts` (used by `src/server/routes/ProjectsAddArticlesRoutes.ts`)

## Client UI (show “Article Content Used” per judgment)
- [ ] `src/components/main/projects/reviews/review/reviewJudgmentItem.tsx`: render content label next to model
- [ ] `src/components/main/projects/reviews/review/reviewJudgments.tsx` + `src/components/main/projects/reviews/review/reviewAvailableJudgments.tsx`: plumb new fields/types

## Checks
- [ ] `bun run lint`
- [ ] `bun test` (unit: `judgeGetSinglePrompt` respects flags)
