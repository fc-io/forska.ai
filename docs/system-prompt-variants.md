# System prompt variants

The judge system prompt for scientific articles is selected per project through `app.project.system_prompt_variant`.

## Variants

| Variant        | Source                                                    | Used by                                                            |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `legacy`       | `src/agent/judge/judgeSinglePromptSystemPrompt.ts`        | Every project that existed before the column, and new manual ones. |
| `screening_v1` | `src/agent/judge/judgeSinglePromptSystemPromptScreeningV1.ts` | Covidence projects created after the column was added.         |

`NULL` in the column means `legacy`. The list of variants and the defaults live in `src/agent/judge/systemPromptVariant.ts`. Selection happens in `getSinglePromptSystemPromptForArticle` (`src/agent/judge/judgePromptSelection.ts`). FHIR patient records and structured file imports keep their own system prompts whatever the variant. The chunked evidence system prompt does not vary.

`screening_v1` frames the task as screening a record against one section of the eligibility criteria, applies exclusion lines first, treats any one inclusion line as enough unless the criteria text says otherwise, asks for a structured explanation that ends with `Missing: <fact>` on a `maybe`, restricts quotes to the part of the record the section is about, counts the title as part of the record, and shows yes, no and maybe examples with `'yes' | 'no' | 'maybe'`. The text is the one specified in `forska-plans/2026-09-30-judge-system-prompt-variants.md`; the reasoning behind it is in `CRITERIA_PROMPT_REFINEMENTS_FABLE.md`, section 5.2. `src/agent/judge/judgePromptConstants.test.ts` pins its rules.

## How the variant reaches the model

- Judgment jobs copy it into the per-job SQLite `job_info` table at initialization (`system_prompt_variant`), so a running job keeps the variant it started with. Older job databases get the column on open and read as `legacy`.
- Owner-backed judge workers receive it in `OwnerBackedJudgmentJobInfo` from `GET /api/judgmentsjobs/:id/runtime`. That route reads the job's `job_info` copy and only falls back to the live `app.project` value when the job has no SQLite store yet.
- `PromptToProcess.systemPromptVariant` carries it to `judgeSinglePrompt`.
- The prompt preview (`GET /api/projects/:id/prompts/:promptId/preview`, the "Preview Prompt" button on the Project Details page) uses the project's variant and reports it as `systemPromptVariant`. When no served article is available yet (no ready review-serving snapshot, no articles, or no full text), the response is still `unavailable` for the user prompt, but it carries the current `systemPrompt` built for a plain scientific article with the project's provider, so the page always shows the system prompt in use.

## Switching a project

There is no UI switch. Use the API:

```http
PATCH /api/projects/:id/edit
{"systemPromptVariant": "screening_v1"}
```

`POST /api/projects` accepts the same optional field. The variant is protected like the content settings: once a judgment job exists for the project the edit route answers 409, so a project's judgments all come from one system prompt. Existing projects therefore keep `legacy` unless they are switched before their first job. Clone copies the source project's variant. Project transfer exports the variant in the project settings when it is not `legacy`, import validates and stores it, and the judgment input signature (`systemPromptFamily: getSinglePromptSystemPromptForArticle:v2`) digests the system prompt of the exporting project's variant and names it in `request.systemPromptVariant`.

## Judgment identity

The variant is part of the judgment identity: `(article, prompt, model, use_title, use_abstract, use_fulltext, use_fulltext_no_images, system_prompt_variant)`. `app.judgment.system_prompt_variant` is `VARCHAR NOT NULL DEFAULT 'legacy'` and is included in the table's UNIQUE constraint and in `idx_app_judgment_lookup`. A project only sees and reuses judgments whose variant equals its own `COALESCE(system_prompt_variant, 'legacy')` (`getProjectVisibleJudgmentNaturalKeySql` in `src/server/services/projectVisibleJudgmentRule.ts`). Two projects with the same model, content settings and prompt text but different variants therefore judge separately.

Migration `0251_judgmentSystemPromptVariant.sql` rebuilds `app.judgment` together with `app.judgment_assessment`. DuckDB cannot alter a UNIQUE constraint, and `judgment_assessment` has a foreign key to `app.judgment`. The migration copies every existing judgment as `legacy`, because every judgment stored before it was produced with the legacy prompt. On a full clone of the live database (1.04M judgments) the rebuild took about 23 s.

How the variant gets onto a stored judgment:

- `recordJudgmentSuccess` writes it into the per-job SQLite `judgment_outbox.system_prompt_variant` from the job's frozen `job_info` value. The optional `systemPromptVariant` in the completion payload (`JudgeWorkerCompletionPayload`, `POST /api/judgmentsjobs/:id/completions`) is used only when the job has no `job_info` row. Older job databases get the outbox column on open, and their rows without a value take the job's `job_info` variant when imported.
- The outbox import (`judgmentsJobsMarkDirtyWork.ts`) inserts the variant into `app.judgment` and uses it in the `ON CONFLICT` target.
- The already-judged checks in `processPromptWithLLM` and `storeSinglePromptJudgment` include the variant, so a `screening_v1` job does not skip an article because a `legacy` judgment exists.
