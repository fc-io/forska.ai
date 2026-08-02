# Review Prompt Filter Options Plan

Date: 2026-08-02

## Goal

Restore prompt answer filters to the old mental model: every project prompt gets
its normal select/input visible immediately, without a separate expandable,
drawer, or "load filters" workflow.

Keep the rebuild and first-page-load gains by making only expensive answer-value
discovery lazy. The UI should derive prompt filter controls from project prompt
metadata first, then use review-serving facet/materialization data only when the
prompt type actually requires observed answer values.

## Core Decision

Use two different paths based on the prompt type.

## Concrete Project Check

Use project `9e25a18e-ad15-4d34-b999-608902e6d7a1` as the main real-data
smoke target while implementing this plan.

The active configured LLM prompt filters for that project are the standard
case: six scalar string-enum prompts with schema options `yes`, `no`, and
`maybe`.

Expected active prompt controls, in project order:

- Population Criteria
- Intervention / Exposure Criteria
- Comparator / Context Criteria
- Outcome Criteria
- Study Characteristics Criteria
- Other Criteria

The UI must render exactly those six active project prompt controls for LLM and
Both review-filter surfaces. It must not include importable-but-unlinked prompts
from the broader project prompt response.

Observed latest-configured LLM answer counts from the active snapshot:

- Population Criteria: `yes` 2,223, `no` 9,046, `maybe` 555
- Intervention / Exposure Criteria: `yes` 2,682, `no` 8,548, `maybe` 172
- Comparator / Context Criteria: `yes` 11,026, `no` 72, `maybe` 155
- Outcome Criteria: `yes` 2,935, `no` 8,041, `maybe` 177
- Study Characteristics Criteria: `yes` 3,139, `no` 7,726, `maybe` 184
- Other Criteria: `yes` 8,176, `no` 853, `maybe` 1,753

This project does not exercise the open-ended string or numeric branch. Add
synthetic fixtures for those paths.

## Stage 0. Repair Exact Prompt-Filtered Reads First

Do this before UI work.

The plan depends on a correct exact fallback when prompt-answer posting buckets
or option materializations are missing. That is not currently safe enough.

Known issue:

- A live `Population Criteria=yes` filtered request failed with HTTP 500.
- The lazy prompt-answer posting SQL emits `article_ids`, but the writer path
  references `source.article_id`.
- The delete/insert publication path needs an enclosing transaction or
  equivalent atomic replace semantics so a failed rebuild cannot destroy a
  previously working bucket.

Tasks:

- Add executable DuckDB coverage for the generated lazy prompt-answer posting
  SQL.
- Fix the column mismatch and prove the real project `Population Criteria=yes`
  request returns exactly 2,223 articles.
- Make first-read publication atomic: failed publication must preserve any
  existing bucket.
- Distinguish missing bucket, empty bucket, stale bucket, and ready bucket.
- Coalesce concurrent first requests for the same bucket identity.

Acceptance:

- Cold `Population Criteria=yes` returns 2,223 exact results.
- A second identical request uses a ready bucket or other fast path and avoids
  repeating canonical scans/writes.
- Empty enum buckets are distinguishable from missing/unavailable buckets.
- Concurrent first requests do not stampede the same rebuild.
- Failure during bucket publication leaves the previous usable bucket intact.

### 1. Schema-Known Enum Prompts

This is the standard and most common case.

Examples:

- `'yes' | 'no' | 'unsure'`
- `'include' | 'exclude'`
- boolean-style enums such as `true | false`, `boolean`, or project metadata
  that maps the answer to a fixed yes/no set
- arrays of fixed enum values, such as `('yes' | 'no')[]`

Behavior:

- Render the prompt filter select immediately from the project prompt list.
- Populate the select options immediately from the prompt `type`/schema.
- Default value is `All`.
- Selecting an option applies the filter immediately.
- The first selected use may still build or hydrate the lazy prompt-answer
  posting/facet/materialized bucket in the background.
- Once the lazy fast path is available, future filtered reads for the same
  project/prompt/answer/list-mode should use it instead of recomputing through
  the slow fallback.

User-visible result:

- Standard enum prompts look fully ready on first render.
- No loading state is needed just to show the select or its options.
- The slow path is invisible except for the first filtered read possibly taking
  longer than later reads.

### 2. Open-Ended String And Numeric Prompts

These are prompts where the project schema does not fully define the practical
filter options.

Examples:

- `string`
- `string[]`
- `string | 'not applicable'`
- `number`
- `integer`
- `string.integer`
- numeric types with special values such as `string.integer | 'unsure'`

Behavior:

- Render the prompt filter input/select immediately from the project prompt
  list.
- Default value is `All`.
- Do not fetch distinct observed values on first page load.
- When the user opens/focuses the input, show a loading state inside that
  specific control and request the slow distinct-value/facet path.
- Use the slow path result to populate options for this interaction.
- At the same time, queue or trigger lazy materialization of the fast option
  source for that prompt.
- Once the fast source is ready, future renders should populate the control from
  the fast source immediately when appropriate.

User-visible result:

- The control is present from first render, so the filter layout is stable.
- The loading state is local to the one control being opened.
- Later use is fast after the materialized option source exists.

## Why This Makes Sense

- Project prompt metadata is already fetched by review pages through
  `fetchProjectWithPrompts`.
- Existing server code already distinguishes enum, database/open-ended, and
  numeric prompt strategies through prompt type analysis.
- Enum prompts do not need observed answer scanning to know their valid option
  set.
- Open-ended strings and numeric distributions genuinely need observed project
  answers or materialized facets to produce useful options.
- The UI can stay stable and familiar while the expensive work remains lazy.

## Issues To Watch

### Authoritative Prompt Control Source

`fetchProjectWithPrompts` currently combines active linked project prompts with
importable prompt records. It must not be used directly as the filter-control
source.

Acceptance:

- The server or mapper returns only linked, enabled, non-archived prompts that
  participate in the current project/review surface.
- Controls are emitted in project order.
- The concrete project above produces exactly six LLM/Both prompt controls, not
  the 31 additional importable prompt records.

### Surface Semantics

Prompt filter behavior differs by review surface.

Acceptance:

- LLM review surfaces use active project prompt definitions.
- Both review surfaces use active project prompt definitions.
- Human prompt-mode review surfaces use active project prompt definitions.
- Human summary-mode surfaces expose the synthetic `summary` filter contract,
  not the six LLM project prompts.
- Unassessed surfaces either hide prompt-answer controls or define explicit
  behavior; they must not inherit a misleading prompt filter UI by accident.

### Boolean Type Parsing

Current enum parsing is oriented around quoted string unions. The implementation
must explicitly decide how to treat `boolean`, `true | false`, and any existing
boolean-like prompt types.

Acceptance:

- Boolean prompts render `true`/`false`, or the project's canonical yes/no labels
  if those are already defined in prompt metadata.
- Boolean enum detection is covered by tests.

### Selected URL Values Before Options Load

Bookmarked/shared URLs may contain prompt filters for open-ended prompts before
the option list has loaded.

Acceptance:

- Selected values render as selected chips/values immediately.
- The control can show selected values even when the full option list is still
  missing.
- Loading options must not clear or normalize the URL state unless a selected
  value is truly invalid for a schema-known enum prompt.

### Slow Path Must Not Reset Article Rows

Opening an open-ended prompt input will trigger the slow facet path. That must
not change the article query key unless a filter value is actually selected.

Acceptance:

- Opening/focusing a prompt control triggers only the filter-options request or
  background materialization request.
- The article list rows/count remain stable.
- No `/api/articlesreviews` list request is caused merely by opening a prompt
  option list.

### Fast Path Readiness

The UI needs a clear source preference:

1. prompt schema options for schema-known enum prompts
2. materialized fast option source when available for open-ended/numeric prompts
3. slow distinct-value/facet fallback while fast source is missing

Acceptance:

- Fast option availability is explicit in the API response or query state.
- The UI does not guess whether options are complete.
- A stale or missing fast source falls back without presenting incomplete data as
  complete.

### Separate Option Readiness From Article-Posting Readiness

The option text shown in a control and the article IDs returned by applying a
filter are related but separate caches/materializations.

Acceptance:

- Observed-option identity/readiness is tracked separately from prompt-answer
  posting-bucket identity/readiness.
- Schema-known enum options can render immediately even when posting buckets are
  missing.
- A ready option list does not imply that filtered article reads can skip the
  exact fallback.

### Cardinality

Some open-ended string prompts may have too many distinct values for a normal
dropdown.

Acceptance:

- Define a maximum option count for open-ended prompts.
- Above that count, use searchable server-backed options or a constrained
  "type to search values" mode instead of rendering thousands of items.
- The standard enum path is unaffected.

## Proposed Implementation

### Stage 1. Prompt Filter View Model

Create a small server-owned contract that turns current review-surface prompt
definitions into prompt filter controls before facet values are loaded.

Prefer returning this as authoritative `promptFilterDefinitions` from the
server, rather than having the frontend infer eligibility from the broad project
prompt response.

Each control should include:

- `promptId`
- `label`
- `kind`: `schemaEnum`, `openString`, or `numeric`
- immediate options for `schemaEnum`
- canonical option values and display labels
- selected values from URL/query state
- option source state: `schema`, `fast`, `slowLoading`, `slow`, `unavailable`
- surface/mode eligibility, such as LLM, Both, Human prompt-mode, or Human
  summary-mode

Acceptance:

- The review page renders every project prompt filter from this view model.
- Enum controls have complete options before any facet request.
- Open-ended/numeric controls render with `All` before any facet request.
- The active project produces exactly six ordered enum controls for LLM/Both.
- Importable-but-unlinked prompts never become controls.

### Stage 2. Enum Path

Use prompt `type` parsing to provide immediate options for schema-known enums.

Tasks:

- Extend or reuse prompt type analysis for frontend-facing prompt filter metadata.
- Include boolean and boolean-like fixed types.
- Define escaping, mixed unions, array enum handling, and canonical
  serialization.
- Reuse existing enum parsing where possible.
- Validate selected values against schema-known options without waiting for
  observed facet rows.

Acceptance:

- Standard enum prompt selects are visible and populated on first render.
- Selecting an enum option applies the filter.
- Applying the filter may use slow read-through once, then warms the fast path.

### Stage 3. Open-Ended And Numeric Option Loading

Keep controls visible, but load observed values only when the user interacts.

Tasks:

- Add per-control option loading state.
- Add a prompt-scoped canonical observed-options endpoint. The existing
  `/api/articlesreviewsfilters` response is not enough; it currently only reads
  materialized facets/options and can return empty/unavailable prompt filters.
- Endpoint response must include `source`, `readiness`, `complete`,
  pagination/search cursor, snapshot identity, and enough type metadata for
  stable labels.
- On open/focus, request observed options for only that prompt.
- For numeric prompts, return bins and special values with enough metadata for
  stable display labels.

Acceptance:

- Opening one open-ended/numeric control shows local loading in that control.
- Rows/counts do not disappear or refetch-reset.
- Loaded options are cached by query key.
- Large option lists are paginated or searchable instead of dumped into a huge
  dropdown.

### Stage 4. Fast Path Materialization

Make first slow use warm a reusable fast option source.

Tasks:

- Define the materialized option identity:
  - project id
  - review config/snapshot identity
  - mode: LLM/Human/Both as needed
  - prompt id
  - prompt type/strategy
  - filter context if options depend on date/search/duplicate/conflict filters
- On slow fallback, enqueue background materialization or publish the computed
  result when bounded and safe.
- Mark readiness explicitly.
- Prefer fast source on later UI renders when the identity matches.

Acceptance:

- First open/use can be slow.
- Later opens for the same prompt/context use the fast source.
- Fast source invalidates when prompt schema, project scope, judgments, or
  relevant review-serving snapshot changes.
- The implementation returns an actual cache-hit/readiness signal; it must not
  unconditionally delete and rebuild a requested bucket on every use.

### Stage 5. Article Filtering Read Path

Keep filtering exact while the fast posting path is warming.

Tasks:

- For enum selections, apply filters through the existing exact read path.
- If a prompt-answer posting bucket is missing, compute exact filtered article
  IDs from canonical eager judgment/status sources.
- Start lazy posting/materialization after that first read.
- Use the warmed posting bucket for subsequent reads.

Acceptance:

- First filtered result is exact even when fast buckets are missing.
- Subsequent filtered results are faster when the warmed path exists.
- Missing fast buckets never produce incomplete results that look exact.

### Stage 5B. Numeric Range Contract

Numeric filter display options and article filtering need an explicit shared
contract before numeric UI is shipped.

Tasks:

- Define whether numeric controls select exact values, ranges, or both.
- If bins are encoded as `bin:min:max`, implement matching range semantics in
  the read path instead of treating the bin string as an exact answer.
- Define inclusive/exclusive boundaries, null/missing behavior, special values,
  and canonical serialization.

Acceptance:

- Numeric bin selection matches numeric answers by range.
- Exact numeric selection remains available where appropriate.
- Tests cover numeric strings, numbers, integer-like strings, missing values,
  and special enum alternatives such as `unsure`.

### Stage 6. Tests And Regression Gates

Add tests at three levels.

Source/unit tests:

- enum prompt type parsing includes quoted strings, arrays, booleans, and
  boolean-like project metadata
- open-ended string and numeric prompt types are not treated as schema-known
  enums
- prompt filter view model includes all project prompts before facet data

Frontend regression tests:

- first render shows all prompt filter inputs/selects
- enum prompt selects have options immediately without calling the slow facet
  endpoint
- open-ended/numeric controls show `All` initially
- opening an open-ended/numeric control shows local loading only
- opening a control does not trigger article list refetch/reset
- URL-selected values render before option hydration

Backend/read-path tests:

- first enum-filtered read is exact with missing prompt-answer posting buckets
- first read warms/enqueues the fast path
- later read uses available fast buckets
- stale fast source falls back to exact slow path
- generated DuckDB posting SQL executes against a real test database
- failed publication preserves an existing bucket
- concurrent first requests coalesce

Live smoke:

- Load the current project review page.
- Confirm default rows/counts render.
- Confirm all prompt controls render immediately.
- For schema-known prompts, options are visible immediately.
- For arbitrary prompts, opening the control shows local loading and then
  options.
- Verify article rows remain visible and no unrelated article-list request fires
  on mere control open.
- On project `9e25a18e-ad15-4d34-b999-608902e6d7a1`, confirm
  `Population Criteria=yes` returns 2,223 exact results.

Quality gates:

- targeted executable DuckDB tests for prompt-answer postings
- focused frontend tests for query-key stability and first render
- focused Playwright desktop verification
- touched-file lint
- `bun run build`
- `bun run db:mig` if schema changes are introduced

## Recommended Order

1. Repair and test exact prompt-filtered reads.
2. Revert the prompt-filter shell UX to real prompt controls.
3. Return authoritative `promptFilterDefinitions` from the server.
4. Implement schema-known enum options from prompt type, including booleans.
5. Keep open-ended/numeric controls visible but lazy-hydrate options on open.
6. Add selected-URL-value rendering independent of option hydration.
7. Add the prompt-scoped canonical observed-options endpoint.
8. Wire first slow use to warm/materialize the fast path with real readiness and
   cache-hit behavior.
9. Define and implement numeric range filtering before shipping numeric bins.

## Non-Goals

- Do not rebuild all prompt-answer facets on first page load just to make the UI
  look complete.
- Do not hide prompt filters behind a generic load/toggle/drawer interaction.
- Do not treat open-ended strings as finite enums.
- Do not show incomplete option lists as complete.
- Do not let option loading block tab switching, paging, or default article
  list rendering.
