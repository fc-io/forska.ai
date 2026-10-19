# System prompt variants

The judge system prompt for scientific articles is selected per project through `app.project.system_prompt_variant`.

## Variants

| Variant        | Source                                                        | Used by                                                                                              |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `legacy`       | `src/agent/judge/judgeSinglePromptSystemPrompt.ts`            | Every project that existed before the column, and new manual ones.                                   |
| `screening_v1` | `src/agent/judge/judgeSinglePromptSystemPromptScreeningV1.ts` | Covidence projects created after the column was added and before 2026-10-19.                         |
| `screening_v2` | `src/agent/judge/judgeSinglePromptSystemPromptScreeningV2.ts` | Covidence projects created after 2026-10-19; v1 plus the model may quote the article_metadata block. |

`NULL` in the column means `legacy`. The list of variants and the defaults live in `src/agent/judge/systemPromptVariant.ts`. Selection happens in `getSinglePromptSystemPromptForArticle` (`src/agent/judge/judgePromptSelection.ts`). FHIR patient records and structured file imports keep their own system prompts whatever the variant. The chunked evidence system prompt does not vary.

`screening_v1` frames the task as screening a record against one section of the eligibility criteria, applies exclusion lines first, treats any one inclusion line as enough unless the criteria text says otherwise, asks for a structured explanation that ends with `Missing: <fact>` on a `maybe`, restricts quotes to the part of the record the section is about, counts the title as part of the record, and shows yes, no and maybe examples with `'yes' | 'no' | 'maybe'`. The text is the one specified in `forska-plans/2026-09-30-judge-system-prompt-variants.md`; the reasoning behind it is in `CRITERIA_PROMPT_REFINEMENTS_FABLE.md`, section 5.2. `src/agent/judge/judgePromptConstants.test.ts` pins its rules.

`screening_v2` is `screening_v1` with exactly two changes: "You will receive" item 4 no longer says `, do not quote it`, and the quote rule reads `Quotes may come only from article_title, article_summary, article_metadata, or article_fulltext.` `src/agent/judge/judgeSinglePromptSystemPromptScreeningV2.test.ts` pins that it is v1 with exactly those two replacements. Existing projects keep their stored variant; nothing is backfilled. A variant's frozen text is never edited, so a prompt change becomes a new variant.

## How the variant reaches the model

- Judgment jobs copy it into the per-job SQLite `job_info` table at initialization (`system_prompt_variant`), so a running job keeps the variant it started with. Older job databases get the column on open and read as `legacy`. The fifth content flag `use_metadata` is frozen the same way (`job_info.use_metadata INTEGER NOT NULL DEFAULT 0`, older job databases read `0`).
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

The variant is part of the judgment identity: `(article, prompt, model, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata, system_prompt_variant)`. `app.judgment.system_prompt_variant` is `VARCHAR NOT NULL DEFAULT 'legacy'` and is included in the table's UNIQUE constraint and in `idx_app_judgment_lookup`. Migration `0255_judgmentUseMetadata.sql` rebuilt both again to add the content flag `use_metadata BOOLEAN NOT NULL DEFAULT FALSE` (existing judgments `FALSE`); a project matches it with `COALESCE(project.use_metadata, FALSE)`. A project only sees and reuses judgments whose variant equals its own `COALESCE(system_prompt_variant, 'legacy')` (`getProjectVisibleJudgmentNaturalKeySql` in `src/server/services/projectVisibleJudgmentRule.ts`). Two projects with the same model, content settings and prompt text but different variants therefore judge separately.

Since migration `0267_judgmentFullTextStrategy.sql` the full UNIQUE on `app.judgment` is `(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata, system_prompt_variant, full_text_strategy_id, delete_generation)`.

`use_fulltext_no_images` is a frozen legacy identity dimension, like `delete_generation`. Full text is chosen with `use_fulltext` plus a full-text strategy (figure mode `none` replaces "no images"), so nothing writes `TRUE` into new rows. The column stays in the UNIQUE because other installations can hold legacy judgments that differ only in this flag; dropping it from the key would turn them into duplicates. The rules:

- No API input accepts it. Project create, `PATCH /api/projects/:id`, `PATCH /api/projects/:id/edit`, clone, `POST /api/subprojects` and the comparison-project create, create-from-project and edit bodies answer 400 when the field is present, whatever its value (`rejectLegacyFullTextNoImagesBody`). Elysia drops unknown body keys without an error, so the check runs as a `transform` hook before validation. The judge-worker completion body (`POST /api/judgmentsjobs/:id/completions`) still carries the flag, because it is part of the claim identity.
- A project or comparison that already has it set keeps it. Its legacy judgments (`fts-legacy-v0`) stay visible through it. Clone, create-subproject and comparison create-from-project copy the stored value. Comparison edit keeps the stored value.
- An edit that gives a legacy no-images project a full-text strategy (only possible before its first job) clears the flag together with the strategy change. The project then stops seeing its legacy judgments, as any strategy change does.
- Identity code keeps reading and writing the column: the judgment store, outbox import, project transfer, review-change deltas, execution snapshots, comparison content variants and keys, and judgment-context derivation. Behaviour code does not branch on it. Whether a project uses full text comes from `use_fulltext` or a stored `fts-legacy-v0` strategy.
- UI shows legacy rows as "full text (legacy, no images)" and has no control for the flag.

Migration `0251_judgmentSystemPromptVariant.sql` rebuilds `app.judgment` together with `app.judgment_assessment`. DuckDB cannot alter a UNIQUE constraint, and `judgment_assessment` has a foreign key to `app.judgment`. The migration copies every existing judgment as `legacy`, because every judgment stored before it was produced with the legacy prompt. On a full clone of the live database (1.04M judgments) the rebuild took about 23 s.

How the variant gets onto a stored judgment:

- `recordJudgmentSuccess` writes it into the per-job SQLite `judgment_outbox.system_prompt_variant` from the job's frozen `job_info` value. The optional `systemPromptVariant` in the completion payload (`JudgeWorkerCompletionPayload`, `POST /api/judgmentsjobs/:id/completions`) is used only when the job has no `job_info` row. Older job databases get the outbox column on open, and their rows without a value take the job's `job_info` variant when imported. `judgment_outbox.use_metadata` is stamped from `job_info` the same way; the optional `useMetadata` in the completion payload is also part of the claim identity, so a completion whose flag contradicts the job is rejected with `snapshot claim identity mismatch for useMetadata`, and a payload without it (journal entries written before the flag existed) is treated as `false`.
- The outbox import (`judgmentsJobsMarkDirtyWork.ts`) inserts the variant into `app.judgment` and uses it in the `ON CONFLICT` target.
- The already-judged checks in `processPromptWithLLM` and `storeSinglePromptJudgment` include the variant, so a `screening_v1` job does not skip an article because a `legacy` judgment exists.
