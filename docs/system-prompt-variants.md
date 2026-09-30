# System prompt variants

The judge system prompt for scientific articles is selected per project through `app.project.system_prompt_variant`.

## Variants

| Variant        | Source                                                    | Used by                                                            |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `legacy`       | `src/agent/judge/judgeSinglePromptSystemPrompt.ts`        | Every project that existed before the column, and new manual ones. |
| `screening_v1` | `src/agent/judge/judgeSinglePromptSystemPromptScreeningV1.ts` | Covidence projects created after the column was added.         |

`NULL` in the column means `legacy`. The list of variants and the defaults live in `src/agent/judge/systemPromptVariant.ts`. Selection happens in `getSinglePromptSystemPromptForArticle` (`src/agent/judge/judgePromptSelection.ts`). FHIR patient records and structured file imports keep their own system prompts whatever the variant. The chunked evidence system prompt does not vary.

`screening_v1` frames the task as screening a record against one section of the eligibility criteria, asks for a structured explanation that ends with `Missing: <fact>` on a `maybe`, restricts quotes to the part of the record the section is about, uses the title as part of the record, and shows examples with `'yes' | 'no' | 'maybe'`. The reasoning behind it is in `CRITERIA_PROMPT_REFINEMENTS_FABLE.md`, section 5.2.

## How the variant reaches the model

- Judgment jobs copy it into the per-job SQLite `job_info` table at initialization (`system_prompt_variant`), so a running job keeps the variant it started with. Older job databases get the column on open and read as `legacy`.
- Owner-backed judge workers receive it in `OwnerBackedJudgmentJobInfo` from `GET /api/judgmentsjobs/:id/runtime`.
- `PromptToProcess.systemPromptVariant` carries it to `judgeSinglePrompt`.
- The prompt preview (`GET /api/projects/:id/prompts/:promptId/preview`) uses the project's variant.

## Switching a project

There is no UI switch. Use the API:

```http
PATCH /api/projects/:id/edit
{"systemPromptVariant": "screening_v1"}
```

`POST /api/projects` accepts the same optional field. The variant is protected like the content settings: once a judgment job exists for the project the edit route answers 409. Clone copies the source project's variant. Project transfer exports the variant in the project settings when it is not `legacy`, and import stores it.

## Known limitation

The variant is not part of the judgment identity `(article, prompt, model, use_title, use_abstract, use_fulltext, use_fulltext_no_images)`. Two projects with the same model, content settings and prompt text share judgments regardless of variant. To compare the two system prompts on the same criteria, use different prompt text or a different model record, or extend the judgment identity.
