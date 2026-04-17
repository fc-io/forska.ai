# Compare 2 Plan

## Goal

Add a toggle to `Compare Project` and `Create New Comparison` so comparison projects can use the Covevidence-style human and LLM summary flow in addition to the existing prompt-by-prompt human comparison flow.

## Desired Behavior

- Prompt mode keeps the current behavior: one human column per prompt.
- Summary mode shows overall human and LLM screening decisions instead of prompt-level human columns.
- `Compare Project` can inherit summary mode from a summary-capable source project.
- `Create New Comparison` can opt into summary mode by selecting a summary-capable source project to provide the human summary rows and criteria metadata.
- Edit should allow switching the saved comparison project between prompt mode and summary mode when the required source metadata is available.

## Touched Layers

- Server: `src/server/routes/ComparisonProjectsRoutes.ts`
- Client: `src/app/routes/+compare-judgments/+create.tsx`
- Client: `src/app/routes/+compare-judgments/+create-from-project.tsx`
- Client: `src/app/routes/+compare-judgments/+$id/+edit.tsx`
- Client: `src/app/routes/+compare-judgments/+$id/+index.tsx`
- Client: `src/components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.tsx`
- Client/service types: `src/services/comparisonProjectsService.ts`
- Database: comparison project schema and migration files under `src/db/duckdbMigrations/`

## Proposed Design

### 1. Extend comparison project persistence

Add comparison-specific fields so summary mode is explicit and durable.

- Add `human_judgment_mode` to `app.comparison_project` with values `prompt | summary`.
- Add `summary_source_project_id` to `app.comparison_project` referencing `app.project`.
- Add criteria metadata to `app.comparison_project_prompt`:
  - `criteria_disposition`
  - `criteria_section_key`
  - `criteria_section_label`

Rationale:

- `judgment_human_summary` rows are project-scoped, so the comparison flow needs an explicit source project instead of inferring one from routes/prompts/dates.
- Summary derivation depends on prompt criteria metadata, so comparison projects need their own copied snapshot of that metadata.

### 2. Extend API and client types

Update comparison create, create-from-project, fetch, and edit payloads to include:

- `humanJudgmentMode`
- `summarySourceProjectId`

Update return types so comparison metadata and edit form data expose:

- `humanJudgmentMode`
- `summarySourceProjectId`
- enough prompt metadata to know whether summary mode is valid

### 3. Define source project rules

#### Compare Project

- If the selected source project has `humanJudgmentMode = 'summary'`, allow enabling the new summary toggle.
- When enabled, save:
  - `humanJudgmentMode = 'summary'`
  - `summarySourceProjectId = sourceProject.id`
- Copy criteria metadata from the source project's enabled prompt links into `comparison_project_prompt`.

#### Create New Comparison

- Add a summary toggle next to the existing human comparison toggle.
- If summary mode is enabled, require selecting a summary-capable source project.
- Use that source project only for:
  - human summary rows
  - prompt criteria metadata
- Keep the comparison's own dates, models, content settings, selected prompts, and import routes configurable.

Recommended constraint:

- In manual mode, only allow prompt selections that exist on the selected summary source project and have summary criteria metadata.

This keeps the implementation aligned with Covevidence and avoids building new UI for editing include/exclude prompt criteria manually.

### 4. Update edit flow

On the edit page:

- Show the saved human comparison mode.
- If prompt mode, preserve current behavior.
- If summary mode, show the selected summary source project.
- Allow switching modes only when the form can supply valid summary dependencies.
- Re-copy or revalidate comparison prompt criteria metadata if selected prompts change in summary mode.

### 5. Implement summary-aware comparison scope building

In `src/server/routes/ComparisonProjectsRoutes.ts`:

- Extend `ComparisonProjectScope` with:
  - `humanJudgmentMode`
  - `summarySourceProjectId`
  - prompt criteria metadata per selected prompt
- Keep the current prompt-mode scope behavior unchanged.
- In summary mode, build synthetic summary columns instead of prompt-level human columns.

Recommended column model:

- LLM columns: one `summary` column per model/content variant.
- Human columns: one overall human summary column.

Use a synthetic prompt id such as `summary` for ordering and filtering compatibility.

### 6. Reuse existing summary derivation helpers

Reuse the existing shared helpers in `src/server/utils/judgmentAnswers.ts`:

- `getNormalizedSummaryAnswer`
- `deriveStrictSummaryAnswer`

LLM summary derivation in summary mode should:

- gather the latest LLM judgment answer per selected prompt
- normalize prompt answers to `yes | no | maybe`
- derive one strict overall summary answer using copied criteria metadata

Human summary loading in summary mode should:

- read from `app.judgment_human_summary`
- filter by `summarySourceProjectId`
- use the latest non-empty overall answer per article

### 7. Update comparison result rendering

In the comparison results page and table:

- Prompt mode: keep the existing prompt-level display.
- Summary mode:
  - show overall-decision columns only
  - label clearly, for example `Overall decision` or `Include this study?`
  - continue row highlighting based on agreement vs disagreement across shown values

Update metadata cards to show:

- human comparison mode
- summary source project when present

### 8. Filtering and pagination behavior

Keep existing pagination behavior.

Adjust filters so they still make sense in summary mode:

- `Hide rows with under 2 answered prompts` should become effectively "under 2 answered shown columns" in summary mode.
- `Show only rows where all shown columns are answered` should work against synthetic summary columns.
- `Show only rows with LLM differences` should compare summary answers across models in summary mode.

## Implementation Steps

1. Add a DuckDB migration for comparison-project summary mode fields.
2. Update comparison-project schema typing.
3. Extend comparison-project create, fetch, and update route contracts.
4. Update comparison-project creation helpers to copy prompt criteria metadata in summary mode.
5. Add summary-source project lookup and validation.
6. Add summary-mode scope construction and summary cell generation.
7. Update create/edit forms with the new toggle and source-project selection UI.
8. Update the comparison results page and table for summary-mode rendering.
9. Add targeted tests for prompt mode and summary mode behavior.

## Validation Rules

- A comparison project must always have at least one content option.
- Summary mode requires `compareWithHumans = true`.
- Summary mode requires a valid `summarySourceProjectId`.
- Summary mode prompt selections must all exist on the summary source project.
- Summary mode prompt selections must have criteria metadata required by `deriveStrictSummaryAnswer`.
- Prompt mode must continue to work unchanged for all existing comparison projects.

## Risks

- The current comparison flow infers a source project, but summary rows are project-scoped and cannot safely use inference alone.
- Selected prompts can drift from source-project prompts unless we validate or constrain them.
- Summary mode and prompt mode share the same table UI, so the column abstraction needs to stay simple.

## Recommended Scope Decision

Recommended implementation:

- summary mode in manual comparison requires selecting a summary-capable source project
- summary mode only supports prompts that come from that source project

Not recommended for this pass:

- custom manual editing of include/exclude criteria metadata for arbitrary prompt sets

The recommended path is much smaller, matches Covevidence storage, and avoids introducing a new prompt-criteria authoring UX.

## Quality Gates

- `bun run db:mig`
- `bun test src/server/utils/judgmentAnswers.test.ts`
- targeted `bun test` for comparison-project route and helper coverage
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
- Browser verify web flow for:
  - creating a summary comparison from a Covevidence project
  - creating a manual summary comparison from a summary-capable source project
  - editing a summary comparison
  - confirming prompt mode remains unchanged

## Commands To Run During Implementation

- `bun run db:mig`
- `bun test src/server/utils/judgmentAnswers.test.ts`
- `bun test <targeted comparison test files>`
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
