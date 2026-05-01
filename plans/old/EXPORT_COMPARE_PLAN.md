# Compare Judgments Export Plan

## Goal

- Add a dedicated `Export data` flow for compare judgments that mirrors the existing project export UX, but exports compare-specific rows and columns.
- Keep the export aligned with the current Compare Project Judgments results view in both prompt mode and summary mode.
- Let users export all matching rows, not just the current paginated page.
- Replace the current overlapping row-state checkboxes with one select-based filter so the compare page and export page use a clearer mutually exclusive row-filter model.
- Reuse the existing compare filters for:
  - row answer coverage select
  - `Difference filter`

## Current State

- Project export already exists at `src/app/routes/+projects/+$id/+export.tsx` and streams CSV from `src/server/routes/ProjectExportRoutes.ts`.
- Compare judgments currently have:
  - metadata and column definitions from `fetchComparisonProjectJudgmentsMetadata`
  - paginated filtered rows from `fetchComparisonProjectJudgmentsPage`
  - filter state and labels in `src/app/routes/+compare-judgments/+$id/+index.tsx`
  - a second client-side row-filter pass on the compare page after the server response, which should be removed during this work so page counts and export rows stay aligned
  - no export route, no export button, and no server CSV endpoint
- Compare rows currently expose `articleTitle`, `articleCreatedAt`, and `cells`, but not article abstract/summary.

## Product Decisions

- Add a new route at `/compare-judgments/$id/export`.
- Add an `Export data` entry point for comparison projects.
  - Recommended: add it in `src/components/main/comparisonProjectsGrid.tsx` next to `Edit`.
  - Also add it on `src/app/routes/+compare-judgments/+$id/+index.tsx` so users can export from the results screen.
- Export should be available for archived comparison projects as well as active ones because archived comparison results are already viewable in read-only form.
- If the grid entry is added, show `Export data` on both active and archived comparison project cards; keep `Edit` active-only.
- Replace these two filters on the compare page:
  - `Show rows with more than 1 answer`
  - `Show only rows where all shown columns are answered`
    with one select, for example `Row filter`.
- Recommended row-filter select options:
  - `All rows`
  - `Rows with more than 1 answer`
  - `Rows where all shown columns are answered`
- Recommended default remains equivalent to current behavior:
  - `Rows with more than 1 answer`
- Export CSV should always include these article columns in v1:
  - `Title`
  - `Abstract/Summary`
  - `Date added`
- Answer columns should always mirror the compare page columns for the comparison project:
  - prompt mode: prompt-by-prompt human and LLM columns
  - summary mode: overall decision human and LLM columns
- Do not add project-export-only features in this pass unless implementation proves they are essentially free:
  - prompt re-selection
  - prompt header metadata toggles
  - explanation/quotes columns
  - prompt-answer filtering from the project export page
- Export should apply the compare filters across the full matching dataset, not just the visible page.

## Touched Layers

- Client route: new `src/app/routes/+compare-judgments/+$id/+export.tsx`
- Client route: `src/app/routes/+compare-judgments/+$id/+index.tsx`
- Client component: `src/components/main/comparisonProjectsGrid.tsx`
- Client service/types: `src/services/comparisonProjectsService.ts`
- Shared client/server utility: likely a new comparison-column ordering helper under `src/utils/`
- Server route/service:
  - either extend `src/server/routes/ComparisonProjectsRoutes.ts`
  - or, preferably, add a focused `src/server/routes/ComparisonProjectExportRoutes.ts`
- Server bootstrap: `src/server/serverMain.ts` if a new export route module is added
- Server shared comparison-row builder:
  - preferably extract reusable row/filter logic from `ComparisonProjectsRoutes.ts` into a small server helper/service

## Proposed Design

### 1. Add a dedicated compare export page

- Build `src/app/routes/+compare-judgments/+$id/+export.tsx` with the same general layout as the project `Export data` page:
  - back button to the comparison results page
  - page title `Export data`
  - comparison project info card
  - export filter controls
  - primary `Export to CSV` button
- Keep the page smaller than project export because the comparison project already defines the answer columns.
- Show the same filter labels and defaults as the comparison results page.

### 2. Use one shared filter contract for compare and export

- Replace the current two-checkbox row filtering model with one row-filter select shared by the compare page and export page.
- Once the new `rowFilter` contract is in place, remove the compare page's extra client-side row filtering and treat the server response as the single source of truth for row inclusion, counts, and export parity.
- Reuse the same default behavior currently used by `src/app/routes/+compare-judgments/+$id/+index.tsx` by making the default select option equivalent to the current sparse-row default.
- Keep `differenceFilter` defaulted to `all`.
- Preserve the summary-mode-specific wording for the sparse-answer option label.
  - prompt mode option: `Rows with more than 1 answered prompt`
  - summary mode option: `Rows with more than 1 answer`
- Reuse `getAvailableComparisonProjectDifferenceFilters`, `getComparisonProjectDifferenceFilterLabel`, and `getComparisonProjectHasDifferenceFilterMatch` behavior rather than creating export-only filter rules.
- Recommended: carry current filter search params from the results page into the export page so export starts from the user’s active compare view.

Recommended row-filter model:

- Replace:
  - `showOnlyRowsWithMultipleAnswers: boolean`
  - `showOnlyFullyAnsweredPrompts: boolean`
- With a single value, for example `rowFilter`, with options such as:
  - `multiple-answers`
  - `fully-answered`
  - `all`
- This makes the UI and URL state mutually exclusive and avoids the current ambiguous combined state.

Exact state contract:

- URL search param: `rowFilter`
- Allowed `rowFilter` values:
  - `multiple-answers`
  - `fully-answered`
  - `all`
- Default when missing or invalid: `multiple-answers`
- URL search param for disagreement remains: `differenceFilter`
- Export page should read and write the same search params as the compare page so the active compare state can flow directly into export.

Exact label mapping:

- `rowFilter=all`
  - label: `All rows`
- `rowFilter=multiple-answers`
  - prompt mode label: `Rows with more than 1 answered prompt`
  - summary mode label: `Rows with more than 1 answer`
- `rowFilter=fully-answered`
  - label: `Rows where all shown columns are answered`

Migration notes:

- Remove legacy compare-page search params tied to the checkbox model:
  - `showAllRows`
  - `showOnlyFullyAnsweredPrompts`
- For backwards-compatible compare-page URL parsing, map legacy params once on load with this precedence:
  - `showOnlyFullyAnsweredPrompts=1` -> `rowFilter=fully-answered`
  - else `showAllRows=1` -> `rowFilter=all`
  - else `rowFilter=multiple-answers`
- This is an intentional behavior change: the old combined checkbox intersection is no longer representable. When both legacy checkbox params were effectively active, normalize to the stricter `fully-answered` option.
- After parsing any legacy params, immediately replace the URL with the canonical `rowFilter` and `differenceFilter` search params.
- Do not carry those legacy params into the new export page.
- Update route state type names to reflect the single enum, for example:
  - `rowFilter: 'multiple-answers' | 'fully-answered' | 'all'`

### 3. Add article summary to comparison rows

- Extend `ComparisonProjectJudgmentsRow` in `src/services/comparisonProjectsService.ts` to include `articleSummary`.
- Update the server row-building logic to select `a.article_summary AS articleSummary` alongside title and created date.
- Keep the compare page table unchanged for now unless product decides abstract should also appear there.
- Use `articleCreatedAt` as the export `Date added` field.

Assumption:

- `Date added` maps to the same article-created timestamp currently shown as `Created` on the compare judgments page.

### 4. Extract shared comparison row/filter logic on the server

- Do not implement export by abusing the paginated judgments endpoint.
- Do not introduce a single helper that materializes the entire filtered dataset in memory just to make export reuse easy.
- Extract shared batch-friendly server helpers, for example:
  - stable scoped-article selection in compare-table order
  - batch cell assembly for a provided list of article IDs
  - pure row-filter evaluation for `rowFilter` and `differenceFilter`
- The judgments endpoint can build paged results on top of those helpers.
- The export endpoint should iterate scoped articles in stable batches, assemble cells for each batch, apply the shared row-filter evaluator, and enqueue CSV rows immediately.
- Shared row shape should include:
  - `id`
  - `articleTitle`
  - `articleSummary`
  - `articleCreatedAt`
  - `cells`
- Reuse the exact same filtering rules for both the page endpoint and the export endpoint so counts and rows stay consistent.
- During that extraction, replace the current two boolean row-filter inputs with the new single row-filter enum so both compare-page rendering and export use the same rule.

### 5. Add a compare export CSV endpoint

- Add a CSV export endpoint, for example `POST /api/comparison-projects/:id/export`.
- Request body should include only the compare-specific filters needed for export:
  - `rowFilter`
  - `differenceFilter`
- Exact request contract should mirror the page state:
  - `rowFilter: 'multiple-answers' | 'fully-answered' | 'all'`
  - `differenceFilter: 'all' | 'human-vs-llm' | 'llm-vs-llm' | 'any-disagreement'`
- Default server-side fallback when `rowFilter` is missing or invalid: `multiple-answers`.
- Response should stream CSV like project export rather than building the entire file in memory.
- The streaming implementation should batch over scoped articles and write matching rows incrementally, not build one full filtered row array before sending the response.
- Allow export for archived comparison projects; this endpoint is read-only and should not apply active-project-only guards.
- Filename pattern should follow current conventions, for example:
  - `<comparison_name>_compare_judgments_export_YYYY-MM-DD.csv`

### 6. Match comparison column ordering exactly

- Export column order must match the results table order, not raw DB order.
- Today that ordering lives only in `getOrderedJudgmentColumns` inside `src/app/routes/+compare-judgments/+$id/+index.tsx`.
- Extract that ordering rule into a shared utility under `src/utils/` so it can be reused by:
  - compare results page
  - compare export page
  - server CSV export generation if helpful
- Ordering rules should stay the same:
  - prompt order first
  - LLM before human when prompt order matches
  - stable fallback by original position

### 7. Define the CSV shape

- CSV headers should begin with:
  - `Title`
  - `Abstract/Summary`
  - `Date added`
- Follow with one header per shown comparison column.
- Header labels should be flattened, CSV-friendly versions of the table headers, for example:
  - `<prompt label> | <model label> | <content label>`
  - `Overall decision | Human`
- Cell values should export the same answers as the compare page.
- Recommended: flatten internal newline-delimited multi-answer cell values to `; ` in the CSV so one article still maps cleanly to one CSV row.
- Date formatting should be `yyyy-MM-dd` so the export matches the existing compare results table display for the same field, even though the project export route uses ISO timestamps elsewhere.

### 8. Client-side export wiring

- Add a client service method in `src/services/comparisonProjectsService.ts` to call the new export endpoint.
- Reuse the project export file-download behavior.
- Recommended: extract the small `downloadResponseAsCsv` helper from the project export page into a shared client util so both export pages use the same download code.

### 9. Tests and verification

- Add targeted server coverage for:
  - prompt-mode compare export
  - summary-mode compare export
  - filter application in export matching the judgments endpoint behavior
  - inclusion of `articleSummary` and `articleCreatedAt`
  - CSV header ordering and answer-cell formatting
- Add targeted coverage or manual verification for:
  - legacy compare URL params normalizing to canonical `rowFilter` search params
  - archived comparison projects remaining exportable
  - compare-page visible rows and counts matching the server-filtered response after the client-side post-filter is removed
- Extend existing comparison route tests where they already cover prompt vs summary behavior.
- Add a focused export route test file if a new route module is introduced.

## Implementation Steps

1. Introduce the canonical `rowFilter` search-param contract, including one-time legacy checkbox-param normalization to canonical URLs.
2. Replace the compare page row-filter checkboxes with a single select and remove the client-side post-filtering so rendered rows and counts come directly from the server-filtered response.
3. Extend comparison row types to include `articleSummary`.
4. Extract shared server row-assembly and row-filter helpers that work for both paged results and streamed export batches.
5. Add the compare export CSV endpoint using the new row-filter enum and batched streaming behavior.
6. Add compare export route entry points in the grid and comparison detail page, including archived/read-only entry points where appropriate.
7. Add the compare export client service and shared download helper.
8. Build `src/app/routes/+compare-judgments/+$id/+export.tsx`.
9. Wire the export page to metadata, canonical filters, and CSV download.
10. Register the new server route module in `src/server/serverMain.ts` if export routing is split out of `ComparisonProjectsRoutes.ts`.
11. Add targeted tests for prompt mode, summary mode, filter parity, archived export access, and legacy URL normalization as applicable.
12. Run lint, targeted tests, build, and desktop build.

## Risks

- `ComparisonProjectsRoutes.ts` is already large, so bolting export logic directly into it will make the file harder to maintain.
- The compare page currently filters on the server and again on the client; this work needs to remove that duplication without changing row semantics.
- Export must intentionally bypass pagination without changing row semantics.
- Summary mode and prompt mode share the same export endpoint but produce different effective columns, so header generation must stay mode-aware.
- Compare cells may contain multiple unique answers joined with newlines today; exporting them naively will create harder-to-use CSV rows.
- If users rely on the current ability to combine both checkbox filters, moving to a single select reduces filter expressiveness in exchange for clearer UX, and any bookmarked legacy URLs with both params require a lossy normalization.

Recommended decision:

- Prefer the clearer mutually exclusive select unless there is a strong product need to preserve the combined checkbox state.

## Quality Gates

- Targeted `bun test` for comparison route/export coverage
- `bun run lint`
- `bun run build`
- `bun run desktop:build`
- Browser verify web flow for:
  - opening compare export from the comparison grid
  - opening compare export from the comparison detail page with active filters
  - opening compare export for an archived comparison project
  - legacy compare URLs normalizing to `rowFilter`
  - compare-page counts staying aligned with server-filtered rows after the client-side post-filter is removed
  - exporting prompt-mode comparisons
  - exporting summary-mode comparisons
- Desktop verify the same export page loads and downloads correctly if shared route/import changes affect desktop packaging

## Commands To Run During Implementation

- `bun test src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`
- `bun test <new comparison export test file>`
- `bun run lint`
- `bun run build`
- `bun run desktop:build`

## Scope Notes

- No DuckDB migration is required for this feature as planned.
- No new database tables are required.
- This plan keeps the normal browser flow intact and treats desktop support as additive.
