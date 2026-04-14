# Combined Inclusion/Exclusion Prompt Plan

## Goal

Add a Covidence import option that lets the user choose between:

- `per_field`: create one prompt per non-empty include or exclude field.
- `per_section`: create one prompt per eligibility section that contains both inclusion and exclusion criteria.
- `single_prompt`: create one large prompt that contains all populated sections, with both inclusion and exclusion criteria in one prompt.

## Current State

- `src/app/routes/+admin/+datasources/+covidence-import.tsx` always flattens each non-empty include/exclude field into its own prompt.
- `src/server/routes/DataSourcesImportRoutes.ts` has no request field for prompt grouping.
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts` assumes a 1:1 mapping between eligibility fields and prompt definitions.
- `src/server/services/covidenceImportService.ts` only builds prompt definitions with a single disposition: `include` or `exclude`.
- Summary-mode project logic only understands prompt metadata with `criteriaDisposition = 'include' | 'exclude'`.
- The older single combined prompt path using `inclusionCriteria` and `exclusionCriteria` is conceptually similar to `single_prompt`, but it does not carry summary-safe criteria metadata today and is not wired to the structured section UI.

## Desired Outcome

- The import page exposes a clear prompt grouping control.
- `per_field` keeps the current behavior unchanged.
- `per_section` creates at most one prompt per section, ordered by the existing section list.
- `single_prompt` creates at most one prompt total, with populated sections rendered in the existing section order.
- `per_section` and `single_prompt` instructions clearly define answer meaning:
  - `yes`: inclusion criteria are satisfied and exclusion criteria are not triggered.
  - `no`: an exclusion applies or an inclusion requirement is not met.
  - `maybe`: the report does not provide enough information.
- Project summary derivation, review APIs, and OLAP all agree on `per_section` and `single_prompt` semantics.

## Proposed UI Changes

- Add a `Prompt grouping` control to `src/app/routes/+admin/+datasources/+covidence-import.tsx` with values:
  - `One prompt per include/exclude field`
  - `One prompt per section`
  - `One prompt for all sections`
- Update helper copy so it reflects the selected mode instead of always saying each field becomes its own prompt.
- Keep the existing eligibility section inputs and clipboard import flow unchanged.
- Submit `promptGrouping` with the create request.
- Show a small derived count preview so the user can see how many prompts will be created before import.
- Update preview copy to explain that `single_prompt` may create one large prompt that is harder to review but cuts prompt count to one.

## Proposed API Changes

- Extend `POST /api/datasources/import/covidence-create` to accept:

```ts
type CovidencePromptGrouping = 'per_field' | 'per_section' | 'single_prompt'
```

- Thread `promptGrouping` through:
  - `src/server/routes/DataSourcesImportRoutes.ts`
  - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
  - `src/app/routes/+admin/+datasources/+covidence-import.tsx`
- Normalize eligibility fields once in the create route, then branch prompt generation by grouping mode instead of relying on index-based 1:1 prompt backfilling.
- Clean up the stale client response type in `src/app/routes/+admin/+datasources/+covidence-import.tsx` so it matches the server's `covidencePrompts` array response.

## Prompt And Summary Semantics Changes

- Add prompt builders in `src/server/services/covidenceImportService.ts` for:
  - `per_field`
  - `per_section`
  - `single_prompt`
- Keep the current per-disposition builder for `per_field` mode.
- For `per_section` mode, generate prompt text with both blocks in one prompt, for example:
  - question line for the selected screening mode
  - allowed answers
  - explicit combined answer rules
  - `Inclusion criteria:` block
  - `Exclusion criteria:` block
- Use a distinct heading for section-combined prompts, for example `Matches Population Eligibility`.
- For `single_prompt`, generate one prompt that renders each populated section in order, for example:
  - `Population inclusion criteria:`
  - `Population exclusion criteria:`
  - `Intervention / Exposure inclusion criteria:`
  - `Intervention / Exposure exclusion criteria:`
  - and so on for populated sections only
- Use a distinct heading for the all-in-one prompt, for example `Matches Full Eligibility`.
- Route the legacy `inclusionCriteria` / `exclusionCriteria` path through the same all-in-one combined semantics so old callers also get consistent metadata.

## Project Prompt Metadata And Summary Logic

- Recommended: extend the existing prompt criteria metadata to support a third value, `combined`, instead of inventing a Covidence-only side channel.
- Add a DuckDB migration that updates `project_prompt_criteria_disposition` to allow `combined`.
- Update `src/db/schemaTypes.ts` and server types to reflect `include | exclude | combined`.
- Use `combined` for both `per_section` and `single_prompt`; the grouping mode changes prompt generation shape, but the summary rule at prompt-evaluation time is the same.
- Update summary derivation in `src/server/utils/judgmentAnswers.ts` so:
  - `include`: `no` is a hard fail
  - `exclude`: `yes` is a hard fail
  - `combined`: `no` is a hard fail
  - any missing answer keeps the summary `null`
  - any surviving `maybe` yields summary `maybe`
  - otherwise summary is `yes`
- Thread the new metadata through all consumers that read or copy project prompts, especially:
  - `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
  - `src/services/olap/duckdbOlap.ts`
  - `src/server/routes/ProjectsRoutes.ts`
  - `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`

## Files Likely Touched

- `src/app/routes/+admin/+datasources/+covidence-import.tsx`
- `src/server/routes/DataSourcesImportRoutes.ts`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
- `src/server/services/covidenceImportService.ts`
- `src/server/utils/judgmentAnswers.ts`
- `src/services/olap/duckdbOlap.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
- `src/server/routes/ProjectsRoutes.ts`
- `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`
- `src/db/schemaTypes.ts`
- `src/db/duckdbMigrations/<new migration>.sql`
- Covidence route/service/unit/e2e tests covering prompt creation and summary behavior

## Implementation Steps

1. Add `promptGrouping` to the import UI state, form submission, and route schema.
2. Refactor Covidence create-route normalization so prompt generation is driven by grouped section data, not by 1:1 eligibility-field indexing.
3. Add service helpers for:
   - per-field prompt definitions
   - per-section prompt definitions
   - single-prompt definitions covering all populated sections
   - legacy combined criteria normalization
4. Add DB and type support for `criteriaDisposition = 'combined'`.
5. Update project prompt sync, clone, and archived-project rebuild paths to preserve the new metadata.
6. Update strict summary derivation and all summary readers so `per_section` and `single_prompt` compute consistent overall answers.
7. Update UI copy, smoke tests, and e2e coverage for all three grouping modes.

## Test Plan

- Service tests:
  - `per_field` still creates one prompt per non-empty field
  - `per_section` creates one prompt per populated section
  - `single_prompt` creates one prompt total when any criteria exist
  - section-combined and all-in-one prompt text/headings match the new rules
  - legacy `inclusionCriteria` / `exclusionCriteria` path produces all-in-one combined metadata
- Route tests:
  - `promptGrouping='per_field'` persists per-field prompt links
  - `promptGrouping='per_section'` persists combined prompt links in stable section order
  - `promptGrouping='single_prompt'` persists exactly one combined prompt link when criteria exist
- Summary logic tests:
  - combined prompt `no` becomes a hard fail
  - combined prompt `maybe` yields overall `maybe` when no hard fail exists
  - mixed projects with per-field and combined prompts still derive expected answers
- UI/e2e tests:
  - import flow succeeds in `per_field` mode
  - import flow succeeds in `per_section` mode
  - import flow succeeds in `single_prompt` mode
  - project edit renders the expected prompt headings/count for each mode

## Quality Gates

- `bun run lint`
- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- `bun test src/server/utils/judgmentAnswers.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
- `bun test src/services/olap/duckdbOlap.test.ts`
- `bun run build`
- Browser verification: import one Covidence package in `per_field`, `per_section`, and `single_prompt` modes; confirm prompt count, headings, and project edit load correctly.

## Touched Layers

- Client
- Server
- Database
- Tests
