# JUDGE_V2 (model + article-content-used aware)

- [ ] Define canonical `contentKey` (or 4 bool cols): `useTitle/useAbstract/useFulltext/useFulltextNoImages` (fulltext vs noImages mutually-exclusive)
- [ ] Decide legacy/backfill rule for existing `judgments` (NULL/unknown => force rejudge? vs assume title+abstract)

## Postgres / Drizzle
- [ ] `src/db/schema.ts`: add `contentKey` (or 4 bool cols) on `judgments`; add index `(article_id,prompt_id,model_id,contentKey)` (+ optional unique)
- [ ] Drizzle mig: `bun run db:gen` + `bun run db:mig` (no hand SQL)

## Prompt build + store (LLM)
- [ ] `src/agent/judge/judgeGetPrompt.ts`: extend `ContentSettings` to include fulltext flags; include fulltext only when flagged; (no-flag => strip/ignore `article.fullText`)
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`: pass full content settings; ensure fulltext only for `useFulltext||useFulltextNoImages`; strip images when `useFulltextNoImages`
- [ ] `src/agent/judge.ts`: propagate `contentSettings` through to storage
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: store `contentKey`; existing-check must match `(articleId,promptId,modelId,contentKey)`

## Queue selection (rejudge rules)
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`: NOT EXISTS match on `(articleId,promptId,project.modelId,contentKey,isAnswered=true)`

## API (review + unassessed)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`: fetch project modelId+content flags; filter “LLM assessment” by `(modelId,contentKey)`; placeholders based on same (fix: other-model judgments must not block)
- [ ] `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`: join/filter judgments by `(modelId,contentKey,isAnswered=true)`
- [ ] `src/server/routes/ArticlesRoutes.ts`: include new fields in `/api/articles/:id` judgments payload (for UI labeling)

## ClickHouse / Parquet analytics (must filter by contentKey too)
- [ ] `src/services/parquet/types.ts` + `src/services/parquet/parquetWriter.ts`: add content fields
- [ ] `src/agent/judge/storeSinglePromptJudgment.ts`: write parquet record incl content fields
- [ ] `scripts/clickhouse-setup.sql`: add columns to `forska.judgments` + `judgments_queue` + MV
- [ ] `scripts/backfillPostgresToParquet.ts`: emit new cols (per legacy/backfill rule)
- [ ] ClickHouse queries: add `(modelId + contentKey)` filters
  - [ ] `src/services/clickhouse/articlesReviewsClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsBothClickHouse.ts`
  - [ ] `src/services/clickhouse/articlesReviewsFiltersClickHouse.ts`
  - [ ] `src/services/clickhouse/selectArticleIdsClickHouse.ts` (used by `src/server/routes/ProjectsAddArticlesRoutes.ts`)

## Client UI (show “Article Content Used” per judgment)
- [ ] `src/components/main/projects/reviews/review/reviewJudgmentItem.tsx`: render content label next to model
- [ ] `src/components/main/projects/reviews/review/reviewJudgments.tsx` + `src/components/main/projects/reviews/review/reviewAvailableJudgments.tsx`: plumb new fields/types

## Checks
- [ ] `bun run lint`
- [ ] `bun test` (unit: `contentKey` + `judgeGetSinglePrompt` respects flags)
