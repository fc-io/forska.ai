# Covidence Eligibility Criteria Plan

## Goal

Update the Covidence import UI and API so structured eligibility criteria can be entered as separate sections and each non-empty section becomes its own prompt on the created Covidence project.

## Current State

- UI only has two free-text fields: `Inclusion criteria` and `Exclusion criteria`.
- API create flow accepts only those two strings.
- Import create path builds at most one Covidence prompt and attaches that single prompt to the created project.

## Desired Outcome

- The Covidence import page shows structured eligibility sections instead of only two large textareas.
- Sections are grouped in a way that matches the review workflow, for example:
  - Population: Include / Exclude
  - Intervention / Exposure: Include / Exclude
  - Comparator / Context: Include / Exclude
  - Outcome: Include / Exclude
  - Study Characteristics: Include / Exclude
  - Other: Include / Exclude
- Each non-empty section becomes its own project prompt.
- Empty strings and whitespace-only strings do not create prompts.

## Proposed UI Changes

- Replace the current single `Inclusion criteria` and `Exclusion criteria` inputs with a structured `Eligibility criteria` section.
- Render one textarea per section/subsection.
- Keep the layout simple and explicit rather than hiding fields behind accordions first.
- Label each textarea with both the section and disposition, for example:
  - `Population - Include`
  - `Population - Exclude`
  - `Outcome - Include`
- Keep the existing answer set and model selection flow unchanged.
- Add short helper text explaining that each filled field becomes a separate project prompt.
- Preserve the existing ability to leave sections blank.

## Proposed API Changes

- Extend the Covidence create payload to accept structured eligibility criteria instead of only two strings.
- Recommended payload shape:

```ts
type CovidenceEligibilityField = {
  sectionKey: string
  sectionLabel: string
  disposition: 'include' | 'exclude'
  text: string
}
```

- Pass an ordered array of these fields from UI to server.
- Server trims each field and drops blank entries before prompt creation.
- If no non-empty fields remain, create the project without prompts just as today allows when prompt input is absent.

## Prompt Creation Changes

- Replace singular prompt creation with plural prompt creation for Covidence imports.
- Add a service helper that builds one prompt definition per non-empty eligibility field.
- Prompt heading should identify the section clearly, for example:
  - `Covidence title/abstract - Population include`
  - `Covidence title/abstract - Outcome exclude`
- Prompt text should include:
  - the existing mode-specific screening question
  - allowed answers from the selected answer set
  - the section label and whether it is include or exclude guidance
  - the field text itself
- Create all prompts, then attach them all to the new project in a stable order matching the UI.

## Project Wiring Changes

- Update project creation flow so a Covidence project can be created with multiple prompt IDs instead of a single prompt ID.
- Reuse existing project/prompt linking tables rather than inventing a new Covidence-only storage model.
- Return created/reused prompts in the create response as a list, not a single `covidencePrompt` object.

## Compatibility Notes

- Keep the old two-field values readable during implementation if there are existing tests or callers, but converge the main UI and route contract on the structured field list.
- Prefer a minimal migration path in code:
  - UI sends structured fields
  - route normalizes fields
  - service creates prompt definitions from normalized fields

## Files Likely Touched

- `src/app/routes/+admin/+datasources/+covidence-import.tsx`
- `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts`
- `src/server/services/covidenceImportService.ts`
- Covidence route/service tests under:
  - `src/server/services/covidenceImportService.test.ts`
  - `src/server/routes/DataSourcesImportRoutes/*.test.ts`

## Implementation Steps

1. Add a shared structured eligibility field definition in the UI route and create payload.
2. Replace the two large criteria textareas with the structured sectioned form.
3. Normalize and trim fields in the create handler.
4. Add plural prompt-definition helpers in `covidenceImportService`.
5. Create and attach one prompt per non-empty field in stable UI order.
6. Update create response typing and any client success handling that assumes one prompt.
7. Update tests for:
   - blank fields skipped
   - multiple prompts created in order
   - prompt headings/text reflect section + include/exclude
   - project links all created prompts

## Open Decisions

- Whether to expose optional keyword/helper fields mentioned in Covidence guidance now, or keep scope limited to the explicit eligibility section prompts.
- Whether prompt headings should be short labels only or include mode prefixes for easier debugging.

## Quality Gates

- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceAnalyze.test.ts`
- `bun run build`

## Touched Layers

- Client
- Server
- Tests
