# Summary Judgment Plan

## Goal

- Stop representing imported Covidence human screening decisions as duplicated prompt-level rows.
- Introduce a first-class overall human summary judgment per `(project, article)` for future Covidence screening imports.
- Keep AI judgments granular per eligibility section, but derive one deterministic overall AI summary answer.
- Use overall-vs-overall comparison in the review UI while preserving prompt-by-prompt AI drilldown.

## Current State

- Covidence structured import creates one prompt per eligibility field.
- Covidence human seeding currently writes the same human answer into every enabled project prompt for the article.
- Review detail, review tables, OLAP, and mart rollups interpret human completion as "answered for every prompt".
- That makes imported human data look falsely granular even though the human decision was made once across all criteria.

## Core Decision

- Implement the clean model now, not a phased compatibility model for new writes.
- Add an explicit project-level summary mode switch so summary behavior is configured, not inferred.
- Model that switch as `app.project.human_judgment_mode` with values `'prompt' | 'summary'` rather than a bare boolean.
- Gate all summary storage, rollup, query, and UI behavior off that project setting.
- Persist Covidence criteria metadata on `app.project_prompt`, not `app.prompt`, so summary behavior stays project-local.
- Persist imported human screening decisions in a dedicated summary table, not in `app.judgment_human`.
- Keep `app.judgment_human` for ordinary prompt-by-prompt human assessments only.
- Keep `app.judgment` for ordinary AI prompt-level judgments only.
- Derive the AI summary answer from existing prompt judgments. Do not create a synthetic summary prompt and do not make an LLM call.

## Strict Summary Rule

- Normalize answers through shared judgment-answer helpers into `yes | no | maybe | null`.
- Return `null` until every enabled summary-eligible prompt has one normalized answer.
- Treat unexpected non-empty values conservatively as `maybe` during normalization.
- Return `no` if any exclusion prompt answer is `yes`.
- Return `no` if any inclusion prompt answer is `no`.
- If no hard-`no` condition applies and any prompt answer is `maybe`, return `maybe`.
- Return `yes` if all inclusion prompts are `yes` and all exclusion prompts are `no`.
- Zero inclusion prompts plus all exclusion prompts `no` still returns `yes`.
- Zero exclusion prompts plus all inclusion prompts `yes` still returns `yes`.

## Data Model Changes

- Add `app.project.human_judgment_mode VARCHAR NOT NULL DEFAULT 'prompt' CHECK (human_judgment_mode IN ('prompt', 'summary'))`.
- This is the explicit project-level summary enable state.
- Use `'summary'` for future structured Covidence screening imports that should compare one imported human decision against derived AI summary output.
- Use `'prompt'` for existing prompt-by-prompt human review workflows.
- Add nullable metadata columns on `app.project_prompt`:
  - `criteria_disposition` with `CHECK (criteria_disposition IN ('include', 'exclude') OR criteria_disposition IS NULL)`
  - `criteria_section_key`
  - `criteria_section_label`
- Add `app.judgment_human_summary` with:
  - `id`
  - `project_id`
  - `article_id`
  - `is_answered`
  - `answer` with `CHECK (answer IN ('yes', 'no', 'maybe') OR answer IS NULL)`
  - `comment`
  - `origin` with `CHECK (origin IN ('covidence_import', 'manual_override'))`
  - `created_at`
  - `updated_at`
  - `UNIQUE(project_id, article_id)`
- Storage split:
  - `app.judgment_human_summary` stores one overall human screening answer per `(project_id, article_id)` when the project is in summary mode.
  - `app.judgment_human` stores prompt-level human answers only for prompt-mode projects and manual prompt-based review flows.
  - `app.judgment` continues to store AI prompt-level judgments only.
- No manual summary-override UI is in scope for this first pass, but the summary table schema should already support a later `origin = 'manual_override'` write path.

## Future Imports Only

- No backfill for existing projects.
- No heuristic migration that guesses which old projects should become summary mode.
- Only newly created structured Covidence screening projects set `app.project.human_judgment_mode = 'summary'` and seed `app.judgment_human_summary`.
- Existing pre-change projects remain prompt mode in this first pass.

## Summary-Mode API Contract

- Return an explicit `humanJudgmentMode` field from review-serving APIs that branch on summary behavior. Do not make the client infer summary mode from missing prompt-level fields.
- For summary-mode `articlesreviewsboth` rows, return `humanSummaryAnswer` and `llmSummaryAnswer` and omit prompt-derived `humanAnswersByPrompt`.
- For summary-mode article review detail, return `humanJudgmentMode`, `humanSummaryAnswer`, `llmSummaryAnswer`, and prompt criteria metadata used to label the AI section list.
- For summary-mode `articlesreviewshuman`, return article hydration plus one overall human summary answer per row. Do not require or fabricate prompt-level human judgment arrays.
- For summary-mode `articlesreviewshumanfilters`, return one overall summary-answer filter definition instead of prompt-by-prompt filter values.

## Scope Now

- Database.
- Server.
- Client.
- Tests.

## Files Likely Touched

- `src/db/duckdbMigrations/*.sql`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
- `src/server/services/covidenceImportService.ts`
- `src/server/services/covidenceImportService.test.ts`
- `src/server/utils/judgmentAnswers.ts` or a nearby shared summary helper
- `src/server/services/getAppQueryService.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/services/getDuckdbMartRefreshService.test.ts`
- `src/server/services/projectMartLargeRebuildExecutor.ts`
- `src/services/olap/duckdbOlap.ts`
- `src/services/olap/duckdbOlap.test.ts`
- `src/services/olap/olapTypes.ts`
- `src/server/routes/HumanAssessmentRoutes.ts`
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts`
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`
- `src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- `src/components/main/projects/reviews/review/reviewJudgments.tsx`
- `src/components/main/projects/reviews/review/reviewHumanAssessments.tsx`
- `src/components/main/projects/reviews/review/reviewHumanJudgmentItem.tsx`
- `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.tsx`

## Implementation Order

1. Add the schema needed for summary-mode projects.
   - Create a DuckDB migration for `project.human_judgment_mode` with the allowed-value check.
   - Create a DuckDB migration for `project_prompt` criteria metadata columns and the `criteria_disposition` check.
   - Create `app.judgment_human_summary` with allowed-value checks on `answer` and `origin` plus indexes aligned to project/article lookups.
   - Ensure all new summary logic keys off `project.human_judgment_mode = 'summary'` instead of guessing from import source or row shape.
   - Thread `human_judgment_mode` through shared project config and OLAP scope helpers so routes and serving code branch on one explicit source of truth.

2. Centralize summary-answer derivation.
   - Add one shared helper that accepts project-prompt metadata plus normalized answers and returns `yes | no | maybe | null`.
   - Reuse the existing answer-normalization helpers so LLM and human summary paths do not fork their parsing rules.
   - Lock the edge cases in one place: missing answers return `null`, exclusion `yes` returns `no`, inclusion `no` returns `no`, any remaining `maybe` returns `maybe`, and fully satisfied inclusion/exclusion rules return `yes`.
   - Support zero-inclusion and zero-exclusion projects without special-case UI logic.
   - If a summary-mode project has an enabled prompt without criteria metadata, return `null` and log a clear warning instead of guessing.

3. Change Covidence import to write clean summary-mode data.
   - Update `dataSourcesImportRoutesPostCovidenceCreate` and related Covidence project sync helpers to pass criteria metadata, not only prompt IDs.
   - Set `project.human_judgment_mode = 'summary'` for new structured Covidence screening projects.
   - Persist `criteria_disposition`, `criteria_section_key`, and `criteria_section_label` when linking prompts to the project.
   - Stop seeding duplicated prompt rows into `app.judgment_human` for these projects.
   - Seed one row per article into `app.judgment_human_summary` using the existing Covidence stage-based answer and `origin = 'covidence_import'`.
   - Keep `app.judgment_human` untouched for true prompt-level manual human workflows only.

4. Update mart and OLAP rollups.
   - Extend rollup/serving refresh logic to read `app.judgment_human_summary` for summary-mode projects.
   - Keep existing prompt-level human completeness semantics for prompt-mode projects.
   - Add derived `human_summary_answer` and `llm_summary_answer` fields to the review-serving path so list views do not need to recompute the rule repeatedly.
   - Make summary-mode human completeness depend on the presence of a human summary answer, not prompt-row count.
   - Derive AI summary only from enabled summary-eligible prompts.
   - Keep shared serving column names stable, but define `has_all_human_answers` as summary-row presence in summary mode and prompt-count completeness in prompt mode.

5. Update OLAP types, review routes, and payload contracts.
   - Extend shared scope/config/result types with `humanJudgmentMode`, `humanSummaryAnswer`, `llmSummaryAnswer`, and the prompt criteria metadata needed for summary-mode rendering.
   - Return `humanJudgmentMode`, `humanSummaryAnswer`, and `llmSummaryAnswer` from article review detail.
   - Return `humanJudgmentMode`, `humanSummaryAnswer`, and `llmSummaryAnswer` from `articlesreviewsboth` rows for summary-mode projects.
   - Return project prompt criteria metadata needed to label the AI sections cleanly.
   - For summary-mode projects, stop returning fake per-prompt `humanAnswersByPrompt` data derived from duplicated rows.
   - Switch summary-mode human article queries to `app.judgment_human_summary` and return one overall human decision per article instead of prompt-level human judgment arrays.
   - Switch summary-mode human filter queries to one overall summary-answer filter contract rather than prompt-by-prompt answer filters.
   - Make every client branch depend on the explicit mode field, not on nullable prompt-level fields.

6. Update the review UI.
   - Add an overall decision card near the top of the review sidebar showing human and AI summary answers together.
   - Keep the AI section list below it so reviewers can still inspect inclusion and exclusion prompts individually.
   - In summary mode, stop rendering imported human answers as if they belong to each prompt.
   - In summary mode, the `reviews both` comparison label on the right should compare only `llmSummaryAnswer` against `humanSummaryAnswer`.
   - Keep the current compact `Y`, `N`, `M` label style and the same green/yellow/red agreement coloring, but drive it from summary-vs-summary comparison instead of prompt-level human rows.
   - Prompt chips remain visible as AI detail only in summary mode.
   - Do not append per-prompt human comparison letters in summary mode.
   - In summary-mode human review screens, show overall-answer filters and row labels that match the new summary API contract.

7. Guard prompt-based human assessment routes.
   - Summary-mode projects do not use prompt-based human assessment routes in this first pass.
   - Reject both `HumanAssessmentRoutes` init and submit flows for summary-mode projects with a clear `409` or `400` before any prompt-level pending rows are created.
   - Keep prompt-mode projects unchanged.
   - Do not expose the prompt-based human assessment UI flow for summary-mode projects.

8. Keep the manual summary override path open.
   - No manual summary-override UI is in scope for this first pass.
   - The schema and server helpers should already be able to persist a later override in `app.judgment_human_summary` with `origin = 'manual_override'`.
   - If a later override flow is added, document precedence between the stored human summary row and any derived AI summary separately from this change.

9. Add tests.
   - Covidence import test: structured import seeds `judgment_human_summary` and does not seed duplicated `judgment_human` rows.
   - Covidence import test: project prompt links retain section/disposition metadata in stable order.
   - Summary helper tests: strict rule covers exclusion hits, inclusion failures, maybe cases, missing-answer `null`, and zero-inclusion or zero-exclusion edge cases.
   - Mart refresh test: summary-mode projects compute human completeness from the summary table and expose summary answers in serving rows.
   - OLAP test: summary-mode projects expose `humanSummaryAnswer` and `llmSummaryAnswer` correctly.
   - Review detail route test: summary-mode payload includes overall answers and no fake prompt-level human answer map.
   - Route parity test: summary-mode `articlesreviewsboth` rows match the new overall-answer contract.
   - Human route test: summary-mode `articlesreviewshuman` and `articlesreviewshumanfilters` return the summary contract rather than prompt-level prompt maps.
   - Human assessment route tests: summary-mode init and submit are rejected cleanly.
   - Review table/UI tests: summary-mode comparison uses overall answers while prompt-level AI detail still renders.

## Behavior Notes

- This change is for future Covidence summary-style screening imports.
- Prompt-mode projects keep the existing `app.judgment_human` workflow.
- A derived AI summary should only consider enabled prompts with non-null criteria metadata.
- If a summary-mode project is misconfigured and has enabled prompts without criteria metadata, the summary answer should stay `null` and log a clear server-side warning instead of guessing.
- Summary-mode `articlesreviewshuman` and `articlesreviewshumanfilters` become overall-answer APIs, not prompt-level human judgment APIs.
- Summary-mode human completeness is based on the presence of a human summary answer, not on prompt-row counts.
- Existing pre-change projects remain in prompt mode in this first pass.
- No manual summary-override UI ships in this first pass, but the storage model should already support it.

## Not Now

- No synthetic summary prompt stored in `app.prompt`.
- No extra LLM request for overall judgment.
- No attempt to collapse arbitrary non-Covidence projects into summary mode.
- No backfill or automatic upgrade of existing projects in this first pass.
- No unrelated review-table redesign beyond swapping in the overall summary comparison where the current fake prompt-level human comparison is misleading.
- No summary-aware queue prioritization change in `judgmentsJobsAddToQueue` in this first pass. Comparison correctness must not depend on human-first prompt prioritization.

## Done Criteria

- Future structured Covidence imports create summary-mode projects.
- Imported human screening decisions are stored once per article, not once per prompt.
- AI overall decision is derived from prompt judgments with the strict inclusion/exclusion rule.
- Review detail shows one overall human answer and one overall AI answer.
- AI prompt-level sections remain visible for inspection.
- Summary-mode `reviews both` rows compare only overall human vs overall AI summaries in the right-side comparison label, with the existing `Y/N/M` label style and agreement colors preserved.
- Summary-mode prompt-based human assessment flows are hidden or rejected cleanly.
- Existing pre-change projects remain prompt mode.
- Prompt-mode projects keep their existing behavior.

## Quality Gates

- `bun run db:mig`
- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
- `bun test src/services/olap/duckdbOlap.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- `bun test src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts`
- `bun test src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts`
- `bun run build`

## Touched Layers

- Database
- Server
- Client
- Tests
- Docs

## Commands Reviewed

- No shell commands were run for this plan update.
- Repo inspection used code search and file reads only because this task was planning, not implementation.
