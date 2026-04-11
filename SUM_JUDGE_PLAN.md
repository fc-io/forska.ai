# Summary Judgment Plan

## Goal

- Stop representing imported Covidence human screening decisions as duplicated prompt-level rows.
- Introduce a first-class overall human summary judgment per `(project, article)` for Covidence screening projects.
- Keep AI judgments granular per eligibility section, but derive one deterministic overall AI summary answer.
- Use overall-vs-overall comparison in the review UI while preserving prompt-by-prompt AI drilldown.

## Current State

- Covidence structured import creates one prompt per eligibility field.
- Covidence human seeding currently writes the same human answer into every enabled project prompt for the article.
- Review detail, review tables, OLAP, and mart rollups interpret human completion as "answered for every prompt".
- That makes imported human data look falsely granular even though the human decision was made once across all criteria.

## Core Decision

- Implement the clean model now, not a phased compatibility model for new writes.
- Add a project-level human judgment granularity flag so summary-mode projects are explicit.
- Persist Covidence criteria metadata on `app.project_prompt`, not `app.prompt`, so summary behavior stays project-local.
- Persist imported human screening decisions in a dedicated summary table, not in `app.judgment_human`.
- Derive the AI summary answer from existing prompt judgments. Do not create a synthetic summary prompt and do not make an LLM call.

## Strict Summary Rule

- Normalize answers through shared judgment-answer helpers.
- Return `null` until every enabled summary-eligible prompt has one normalized answer.
- Return `no` if any exclusion prompt answer is `yes`.
- Return `no` if any inclusion prompt answer is `no`.
- Return `yes` if all inclusion prompts are `yes` and all exclusion prompts are `no`.
- Return `maybe` otherwise.
- Treat unexpected non-empty values conservatively as `maybe` after normalization.

## Data Model Changes

- Add `app.project.human_judgment_granularity VARCHAR NOT NULL DEFAULT 'prompt'`.
- Use `'summary'` for Covidence screening projects that should compare one imported human decision against derived AI summary output.
- Add nullable metadata columns on `app.project_prompt`:
  - `criteria_disposition`
  - `criteria_section_key`
  - `criteria_section_label`
- Add `app.judgment_human_summary` with:
  - `id`
  - `project_id`
  - `article_id`
  - `is_answered`
  - `answer`
  - `comment`
  - `origin`
  - `created_at`
  - `updated_at`
  - `UNIQUE(project_id, article_id)`

## Scope Now

- Database.
- Server.
- Client.
- Tests.

## Files Likely Touched

- `src/db/duckdbMigrations/*.sql`
- `src/server/services/covidenceImportService.ts`
- `src/server/services/covidenceImportService.test.ts`
- `src/server/utils/judgmentAnswers.ts` or a nearby shared summary helper
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/services/projectMartLargeRebuildExecutor.ts`
- `src/services/olap/duckdbOlap.ts`
- `src/services/olap/duckdbOlap.test.ts`
- `src/services/olap/olapTypes.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts`
- `src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts`
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`
- `src/components/main/projects/reviews/review/reviewJudgments.tsx`
- `src/components/main/projects/reviews/review/reviewHumanAssessments.tsx`
- `src/components/main/projects/reviews/review/reviewHumanJudgmentItem.tsx`
- `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.tsx`

## Implementation Order

1. Add the schema needed for summary-mode projects.
   - Create a DuckDB migration for `project.human_judgment_granularity`.
   - Create a DuckDB migration for `project_prompt` criteria metadata columns.
   - Create `app.judgment_human_summary` with indexes aligned to project/article lookups.

2. Centralize summary-answer derivation.
   - Add one shared helper that accepts project-prompt metadata plus normalized answers and returns `yes | no | maybe | null`.
   - Reuse the existing answer-normalization helpers so LLM and human summary paths do not fork their parsing rules.

3. Change Covidence import to write clean summary-mode data.
   - Set `project.human_judgment_granularity = 'summary'` for structured Covidence screening projects.
   - Persist `criteria_disposition`, `criteria_section_key`, and `criteria_section_label` when linking prompts to the project.
   - Stop seeding duplicated prompt rows into `app.judgment_human` for these projects.
   - Seed one row per article into `app.judgment_human_summary` using the existing Covidence stage-based answer.
   - Keep `app.judgment_human` for true prompt-level manual human workflows only.

4. Update mart and OLAP rollups.
   - Extend rollup/serving refresh logic to read `app.judgment_human_summary` for summary-mode projects.
   - Keep existing prompt-level human completeness semantics for prompt-mode projects.
   - Add derived `human_summary_answer` and `llm_summary_answer` fields to the review-serving path so list views do not need to recompute the rule repeatedly.
   - Make summary-mode human completeness depend on the presence of a human summary answer, not prompt-row count.

5. Update review routes and payloads.
   - Return `humanSummaryAnswer` and `llmSummaryAnswer` from article review detail.
   - Return project prompt criteria metadata needed to label the AI sections cleanly.
   - For summary-mode projects, stop returning fake per-prompt `humanAnswersByPrompt` data derived from duplicated rows.
   - Switch summary-mode human article queries and filter queries to `app.judgment_human_summary`.

6. Update the review UI.
   - Add an overall decision card near the top of the review sidebar showing human and AI summary answers together.
   - Keep the AI section list below it so reviewers can still inspect inclusion and exclusion prompts individually.
   - In summary mode, stop rendering imported human answers as if they belong to each prompt.
   - In summary mode, review tables should compare `llmSummaryAnswer` against `humanSummaryAnswer` instead of coloring prompt chips against duplicated human prompt answers.

7. Guard prompt-based human assessment routes.
   - Reject or explicitly disable `HumanAssessmentRoutes` for summary-mode projects in this first pass.
   - Keep prompt-mode projects unchanged.

8. Add tests.
   - Covidence import test: structured import seeds `judgment_human_summary` and does not seed duplicated `judgment_human` rows.
   - Covidence import test: project prompt links retain section/disposition metadata in stable order.
   - Summary helper tests: strict rule covers all inclusion, exclusion, partial, missing, and maybe cases.
   - OLAP test: summary-mode projects expose `humanSummaryAnswer` and `llmSummaryAnswer` correctly.
   - Review detail route test: summary-mode payload includes overall answers and no fake prompt-level human answer map.
   - Review table/UI tests: summary-mode comparison uses overall answers while prompt-level AI detail still renders.

## Behavior Notes

- This change is for Covidence summary-style screening projects.
- Prompt-mode projects keep the existing `app.judgment_human` workflow.
- A derived AI summary should only consider enabled prompts with non-null criteria metadata.
- If a summary-mode project is misconfigured and has enabled prompts without criteria metadata, the summary answer should stay `null` and log a clear server-side warning instead of guessing.

## Not Now

- No synthetic summary prompt stored in `app.prompt`.
- No extra LLM request for overall judgment.
- No attempt to collapse arbitrary non-Covidence projects into summary mode.
- No unrelated review-table redesign beyond swapping in the overall summary comparison where the current fake prompt-level human comparison is misleading.

## Done Criteria

- Structured Covidence imports create summary-mode projects.
- Imported human screening decisions are stored once per article, not once per prompt.
- AI overall decision is derived from prompt judgments with the strict inclusion/exclusion rule.
- Review detail shows one overall human answer and one overall AI answer.
- AI prompt-level sections remain visible for inspection.
- Summary-mode review tables no longer compare AI prompt answers against duplicated human prompt answers.
- Prompt-mode projects keep their existing behavior.

## Quality Gates

- `bun run db:mig`
- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/services/olap/duckdbOlap.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- `bun run build`

## Touched Layers

- Database
- Server
- Client
- Tests
- Docs

## Commands Reviewed

- No shell commands were run for this plan.
- Repo inspection used code search and file reads only because this task was planning, not implementation.
