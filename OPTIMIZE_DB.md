# OPTIMIZE_DB

Rule: do NOT implement code changes; do NOT change schema/indexes (doc+measurement only).

Each check: run `EXPLAIN (ANALYZE, BUFFERS)` real params; fill `query plan:` (index used + rows est/act + ms + buffers + spill?).

## Snapshot (pg_stat_user_*; pg_stat_statements OFF)
- DUP huge: `judgments_prompt_article_answered_idx` == `judgments_prompt_article_covering_idx` (same def; one 0scan)
- DRIFT (DB≠schema): `articles_title_trgm_idx`; `articles_created_at_desc_id_idx`; `project_prompts_project_enabled_idx`
- 0SCAN (obs): `judgments_prompt_article_answered_idx`; `article_route_link_route_idx`; `project_prompts_project_order_idx`; `llm_status_model_ts_idx`; `articles_created_at_desc_id_idx`
- OK tiny: `project_route_link` seq_scan high, n_live=2
- token_use: `token_use_job_created_idx` used; failed-req likely seq; dead tuples high

## Checklist
### Infra
- [x] enable `pg_stat_statements`
  - impact: High (blocks query ranking)
  - check: `SHOW shared_preload_libraries`; `pg_extension`; `SELECT * FROM pg_stat_statements LIMIT 1`
  - result: preload=""; extension=0; view=0 (needs preload+restart+CREATE EXTENSION)
  - improvement impact: High (unblocks "top slow queries"; fastest win-finding)
  - potential improvement: set preload+restart; `CREATE EXTENSION pg_stat_statements`; record top queries per route
  - query plan: n/a

### ArticlesRoutes (`src/server/routes/ArticlesRoutes.ts`)
- [x] GET `/api/unassessed-count`
  - impact: Medium (count over big tables)
  - query: `articles` LEFT JOIN `judgments`; WHERE `judgments.id IS NULL`
  - index: `judgments_article_prompt_idx` | `judgments_article_prompt_model_idx`
  - result: ANALYZE timeout>120s; estimate shows SeqScan `articles`+`judgments` (slow)
  - improvement impact: High (>120s now; blocks UI/jobs)
  - potential improvement: cache count; rewrite to `NOT EXISTS` (anti-join) so `judgments.article_id` index can win; later precompute
  - query plan: estimate; top=Aggregate; joins=Hash Join(Left); seq=articles,judgments

- [x] GET `/api/articles/stats`
  - impact: Medium (stats page; joins + NOT EXISTS)
  - query: count; groupBy route via `article_route_link`; + NOT EXISTS link
  - index: `article_route_link_article_idx` (+ `article_route_link_route_idx` 0scan)
  - result: estimate: seq scans + hash joins (indexes not chosen)
  - improvement impact: Medium (stats UI + admin load)
  - potential improvement: compute byRoute from `article_route_link` only; cache; replace NOT EXISTS w/ derived counts
  - query plan (total): estimate; top=Aggregate; seq=articles
  - query plan (byRoute): estimate; top=Aggregate; joins=Hash Join(Inner); seq=article_route_link,articles,import_route
  - query plan (withoutLink): estimate; top=Aggregate; joins=Hash Join(Anti); seq=articles,article_route_link

- [x] GET `/api/articles/latest`
  - impact: Medium (sort + limit; user-facing list)
  - query: ORDER BY `COALESCE(articleCreatedAt, createdAt)` DESC LIMIT 200
  - index: maybe `articles_article_created_created_id_idx`; drift `articles_created_at_desc_id_idx` (0scan)
  - result: ANALYZE timeout 30s; estimate: Limit + SeqScan `articles` (sort on COALESCE likely)
  - improvement impact: Medium/High (feeds UI; likely full scan/timeout)
  - potential improvement: avoid `COALESCE` sort (split null/non-null); later expression index; consider keyset pagination
  - query plan: estimate; top=Limit; seq=articles

- [x] GET `/api/articles/search`
  - impact: High (interactive; OR + ILIKE)
  - query: `articleId = term OR title ILIKE '%term%'` (+ uuid path: `id = term`)
  - index: `articles_pkey` / `articles_article_id_key` / `articles_title_trgm_idx`
  - result: uses `articles_title_trgm_idx` + id indexes; OR forces extra work; 0.2–1.5s; high reads
  - improvement impact: High (0.2–1.5s now; user waits + high I/O)
  - potential improvement: 2-step search (exact id/articleId first, else trigram); remove OR; cap rows/cols/window
  - query plan (exact articleId): analyze; top=Limit; index=articles_article_id_unique,articles_title_trgm_idx; ms=470.3; buf=3686/5113; sort=quicksort
  - query plan (title token): analyze; top=Limit; index=articles_article_id_unique,articles_title_trgm_idx; ms=1461.3; buf=19766/15049; sort=top-N heapsort
  - query plan (uuid): analyze; top=Limit; index=articles_pkey,articles_article_id_unique,articles_title_trgm_idx; ms=218.7; buf=19796/15039; sort=top-N heapsort
- [x] GET `/api/articles/:id`
  - impact: Medium (detail view; fanout on judgments)
  - query: article by id; judgments by `articleId` JOIN prompts/models
  - index: `articles_pkey`; `judgments_article_prompt_*` (article_id prefix)
  - result: fast; article 0.4ms; judgments 2.8ms; uses `judgments_article_prompt_model_content_idx`; prompts seq scan
  - improvement impact: Low (<3ms now; not worth chasing)
  - potential improvement: none (already fast; prompts seq scan ok)
  - query plan (article): analyze; top=Limit; index=articles_pkey; ms=0.4; buf=4/6
  - query plan (judgments): analyze; top=Hash Join(Inner); index=judgments_article_prompt_model_content_idx; seq=prompts; ms=2.8; buf=6/20
- [x] GET `/api/articles/conversion-stats` + POST `/api/articles/conversion-reset`
  - impact: Low (admin/ops)
  - query: status='failed' count + last N; bulk update failed→null
  - index: `articles_full_text_conversion_status_idx`; `articles_updated_idx`
  - result: count uses status idx; last10 uses updated idx + filter; update uses status idx (estimate)
  - improvement impact: Low/Medium (ops UI; trim 0.2–0.5s waits)
  - potential improvement: later composite/partial index (`full_text_conversion_status`, `updated_at`); or filter recent window; maybe cache
  - query plan (count failed): analyze; top=Aggregate; index=articles_full_text_conversion_status_idx; ms=213.7; buf=6/1512
  - query plan (last10 failed): analyze; top=Limit; index=articles_updated_idx; ms=512.1; buf=512/2942
  - query plan (reset update): estimate; top=ModifyTable; index=articles_full_text_conversion_status_idx

### ProjectArticlesRoutes (`src/server/routes/ProjectArticlesRoutes.ts`)
- [x] GET `/api/projects/:id/articles`
  - impact: High (core project UI list)
  - index: `project_articles_unique` | `project_articles_project_idx`
  - result: unique hot (10M scans); project_idx used for count
  - query plan (count): analyze; top=Finalize Aggregate; index=project_articles_project_idx (Index Only Scan); ms=99; buf=4317/1; parallel workers=2
  - query plan (list): analyze; top=Nested Loop Left Join; index=articles_created_idx (wrong order!)+project_articles_unique; ms=14234.9; buf=2889399/858673; loops=883988 on unique idx
  - improvement impact: High (14.2s for paginated list; blocks project UI)
  - potential improvement: rewrite query to start from project_articles (filter first) then join articles; add composite index (project_id, article_id) with articles.created_at via subquery; consider keyset pagination
- [ ] DELETE `/api/projects/:id/articles/:articleId`
  - impact: Low (point delete)
  - index: `project_articles_unique`
  - result: unique hot
  - query plan:

### ProjectsRoutes core (`src/server/routes/ProjectsRoutes.ts`)
- [ ] GET `/api/projects/:id` (importablePrompts query)
  - impact: Medium (project page load)
  - index: `project_articles_project_idx`; `judgments_article_prompt_*`; `project_prompts_unique`
  - result: judgments indexes hot
  - query plan:

### projectsRoutes (reviews)
- [ ] POST `/api/articlesreviewsunassessed` (`src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts`)
  - impact: High (reviews UI)
  - index: `judgments_article_prompt_model_content_idx`; `project_prompts_project_enabled_idx` (drift); `article_route_link_route_idx` (0scan)
  - result: route index 0scan; project_prompts order index 0scan
  - query plan:
- [ ] POST `/api/articlesreviewshuman` (`src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`)
  - impact: High (reviews UI)
  - index: `judgments_human_project_idx`; `judgments_human_prompt_article_answer_idx`
  - result: TBD
  - query plan:
- [ ] GET `/api/articlesreviewshumanfilters` (`src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`)
  - impact: Medium (filters UX)
  - index: `judgments_human_prompt_article_answer_idx`
  - result: TBD
  - query plan:
- [ ] POST `/api/projectsreview` (`src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`)
  - impact: Medium (details; multi-query)
  - index: `judgments_article_prompt_*`; `project_prompts_project_order_idx` (0scan); `judgment_assessments(judgment_id)`? (check)
  - result: project_prompts order index 0scan
  - query plan:

### JudgmentsJobsRoutes (`src/server/routes/JudgmentsJobsRoutes.ts`)
- [ ] `getUnassessedArticlesCount|getUnassessedArticles`
  - impact: High (job UI + scheduling)
  - index: `judgments_article_prompt_model_content_idx`; `project_prompts_project_enabled_idx` (drift); `article_route_link_route_idx` (0scan)
  - result: route index 0scan; judgments indexes hot
  - query plan:
- [ ] GET `/api/judgmentsjobs/:id` (jjp stats + token_use sums)
  - impact: Medium (job UI)
  - index: `judgments_jobs_prompts_job_status_idx`; `token_use_job_created_idx`
  - result: token_use index used; dead tuples high
  - query plan:

### Cron: judgments jobs
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts`
  - impact: High (main LLM loop)
  - index: `judgments_jobs_prompts_article_prompt_job_idx`; `judgments_article_prompt_model_content_idx`
  - result: maybe partial later: `judgments(is_answered=true)`
  - query plan:
- [ ] `src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts`
  - impact: Medium (queue hygiene)
  - index: (updatedAt?) none in schema; check query plan
  - result: TBD
  - query plan:

### ProjectExportRoutes (`src/server/routes/ProjectExportRoutes.ts`)
- [ ] POST `/api/projects/:id/export`
  - impact: Medium (batch export; heavy but not constant)
  - index: `judgments_article_prompt_model_content_idx`; `article_route_link_route_idx` (0scan); dup judgments indexes huge
  - result: route index 0scan
  - query plan:

### Add articles / linking
- [ ] ProjectsAddArticlesRoutes (`src/server/routes/ProjectsAddArticlesRoutes.ts`) + insertArticlesIntoProject (`src/server/services/insertArticlesIntoProject.ts`)
  - impact: Medium (bulk ops)
  - index: `articles_pkey`; `project_articles_unique`; `judgments(article_id,...)`; `project_prompts_unique`
  - result: project_articles_unique hot
  - query plan:

### Tokens
- [ ] timeline (`src/server/routes/tokensRoutes/tokensRoutesGetTimeline.ts`)
  - impact: Medium (dashboards; big time ranges)
  - index: `token_use_job_created_idx`
  - result: index used, high I/O
  - query plan:
- [ ] failed requests list (`src/server/routes/tokensRoutes/tokensRoutesGetFailedRequests.ts`)
  - impact: Low/Medium (ops UI)
  - index: maybe partial later: (`has_failed_requests`, `created_at`)
  - result: seq_scans exist
  - query plan:

### Monitoring
- [ ] llmStatus (`src/server/routes/LlmStatusRoutes.ts`)
  - impact: Low (admin chart)
  - index: `llm_status_ts_idx`; `llm_status_model_ts_idx` (0scan)
  - result: ts index used
  - query plan:
- [ ] nvidiaSmi (`src/server/routes/NvidiaSmiRoutes.ts`)
  - impact: Low (admin chart)
  - index: `nvidia_smi_ts_idx`
  - result: ts index used
  - query plan:

### Full text
- [ ] fetch PDFs (`src/server/cron/fullTextJobs.ts`)
  - impact: Medium (supports fulltext judging)
  - index: `article_route_link_route_idx` (0scan)
  - result: route index 0scan
  - query plan:
- [ ] convert PDFs (`src/server/cron/fullTextConversionJobs.ts`)
  - impact: Medium (supports fulltext judging)
  - index: `articles_full_text_conversion_status_idx`; `article_route_link_route_idx` (0scan)
  - result: TBD
  - query plan:
