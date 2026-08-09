# Review-Serving Payload Non-Blocking Plan

Date: 2026-08-09

## Goal

Make `payload` a secondary review-serving enrichment surface so a newly imported
project can become default-readable before the full judgment-detail mart has
finished.

The target user-visible behavior is:

- default LLM, Human, Both, and Unassessed review tabs open with exact rows,
  ordering, list membership, and tab/count state;
- LLM judgment scheduling still uses queue/status/input-content paths, not
  `payload`;
- detail panels, export, PDF, and any full judgment-detail view either hydrate
  from an available payload generation or clearly report that detail enrichment
  is still indexing;
- no route silently returns incomplete detail data as if `payload` were ready.

## Current Code Anchors

- Projection component list:
  `src/server/reviewServing/reviewServingContracts.ts`
  (`reviewServingProjectionComponents` includes `payload`).
- Default-readable timing already excludes `payload`:
  `src/server/reviewServing/reviewServingChunkManifestRepository.ts`
  (`defaultReadableReviewServingComponents`).
- Judgment-detail table:
  `mart.review_article_judgment_detail_serving_v4`, built by
  `src/server/reviewServing/reviewServingJudgmentPayloadProjector.ts`.
- Route/read contract split:
  `src/server/reviewServing/reviewServingReadContracts.ts`.
  `review.detail.judgments`, `review.detail.humanJudgments`,
  `review.export.selection`, and `review.pdf.selection` still require
  `payload`; list judgment contracts intentionally do not.
- Snapshot promotion:
  `src/server/reviewServing/reviewServingSnapshotPromotionService.ts` validates
  required component state, and
  `src/server/workers/reviewServingProjectorWorker.ts` refreshes candidate
  snapshots using the request's required/optional component split. If `payload`
  is in required components, promotion remains blocked.
- Rebuild request composition:
  `src/server/reviewServing/reviewServingV4RebuildRequestService.ts` prepares
  component requirements before composing the candidate snapshot. This is the
  likely anchor for the default/bootstrap policy.
- Filtered-count identity:
  `src/server/reviewServing/reviewServingFilteredCountService.ts` hashes the
  requested component identities. LLM/Human/Both route services currently pass
  `payload` into filtered-count identity inputs even though count SQL should not
  depend on payload.
- Default route tests already assert the intended direction:
  `reviewServingLlmReviewRouteService.test.ts` and
  `reviewServingHumanBothUnassessedRouteService.test.ts` have
  default-readable fixtures without `payload`.

## Non-Goals

- Do not remove `payload` or the judgment-detail mart.
- Do not change article membership, prompt enablement, judgment reuse, model, or
  content-setting semantics.
- Do not make filtered/detail/export/PDF routes approximate unless their
  response explicitly says the result is unavailable or async.
- Do not use a permanent old/new dual path for payload. If a schema or identity
  split is needed, make it a coherent cutover with cleanup.

## Implementation Plan

### 1. Make The Readiness Contract Explicit

Define three tiers in code and diagnostics:

- `defaultReadable`: `projectScope`, `selectedImport`, `display`, `llmStatus`,
  `humanStatus`, `queue`, `posting`, and `summary`.
- `detailReady`: `payload`.
- `fullyEnriched`: `defaultReadable` plus `detailReady` plus optional secondary
  surfaces such as `search` and lazy prompt/filter buckets.

Tasks:

- Introduce a named constant for default-readable components and use it anywhere
  rebuild timing, promotion diagnostics, or route-gate tests currently duplicate
  the list.
- Add a separate detail/payload readiness helper so code can ask "is payload
  available for this active snapshot?" without implying default readiness
  failure.
- Update diagnostics to show `defaultReadableAt`, `detailReadyAt`, and
  `fullyEnrichedAt` separately.

Acceptance criteria:

- A snapshot can be reported as default-readable while `payload` chunks are
  pending.
- Operator diagnostics show that payload is pending as enrichment, not as a
  blocker for the default review page.

### 2. Stop Request/Promotion Paths From Treating Payload As Initial Readiness

Tasks:

- Audit rebuild request creation for imports and missing-snapshot recovery so
  the initial activation/default-readable gate does not require `payload`.
- Keep `payload` requested as background enrichment unless the caller explicitly
  asks for a detail/export/PDF-ready rebuild.
- Move `payload` to optional component requirements for default/bootstrap
  rebuilds if the current request model needs it present in the same candidate
  manifest.
- Ensure active-snapshot selection can choose a default-readable snapshot for
  default list routes even when `payload` is absent from required component
  state.
- Keep retention/snapshot protection for pending or completed payload rows
  unchanged.

Acceptance criteria:

- Post-import review-serving rebuild can promote or become default-readable
  before `payload` completes.
- Payload work still appears in progress and eventually completes under the
  same snapshot identity.
- A candidate with `payload` missing but not required validates/promotes; a
  candidate with `payload` missing while required still fails validation.

### 3. Make Default List Hydration Payload-Aware Instead Of Payload-Blocking

The current default route tests exercise list routes without `payload`, but the
SQL still hydrates visible-page judgments from
`mart.review_article_judgment_detail_serving_v4`. Make the runtime behavior
explicit.

Tasks:

- For LLM/Human/Both default rows, keep page selection, ordering, count, and
  list-mode state independent of `payload`.
- If a payload identity is present, hydrate visible-page judgment detail from
  `mart.review_article_judgment_detail_serving_v4` as today.
- If no payload identity is present, return the row data with an explicit
  `detailReadiness: "indexing"` or equivalent response field, and avoid a
  misleading detail query against `$missingIdentity`.
- Prefer bounded post-selection fallback only if it can read exact judgment
  detail for the selected article IDs without scanning the whole project. If
  that fallback is not clearly bounded, do not add it in this slice.
- Teach the UI to render rows normally while marking judgment-detail chips or
  the detail panel as indexing.

Acceptance criteria:

- Default rows render without payload and do not issue wide raw-source fallback
  SQL.
- Users can still screen from the row/list state while detail chips hydrate or
  show an indexing state.
- When payload becomes ready, the same route returns full visible-page judgment
  detail without a reload-specific special case.

### 4. Keep Detail, Export, And PDF Strict

Tasks:

- Keep `review.detail.judgments`, `review.detail.humanJudgments`,
  `review.export.selection`, and `review.pdf.selection` behind `payload`
  readiness unless a bounded exact on-demand detail builder is implemented.
- Return a typed availability/error response for these workflows while payload
  is pending, instead of falling through to empty rows.
- In the frontend, show a concise "details still indexing" state for detail,
  export, and PDF actions.

Acceptance criteria:

- Detail/export/PDF cannot silently produce incomplete judgment payloads.
- The user can distinguish "no judgments" from "detail payload is still
  indexing".

### 5. Preserve LLM Dispatch Independence

Tasks:

- Add or strengthen tests proving judgment-job dispatch and prompt preview use
  queue/status/input-content readiness, not `payload`.
- Keep `review.prompt.preview` requiring `judgmentInputContent`,
  `projectScope`, and `selectedImport`, not `payload`.
- Keep queue article-rank reads independent of payload and prompt-pair payload
  expansion.

Acceptance criteria:

- LLM job creation/scheduling still works when `payload` is pending.
- No dispatch query joins `mart.review_article_judgment_detail_serving_v4` to
  decide which article/prompt pairs to send.

### 6. Measure The Win

Tasks:

- Run a current-DB post-import or forced rebuild and record:
  - commit completion to `defaultReadableAt`;
  - `defaultReadableAt` to `detailReadyAt`;
  - payload chunk count and wall time;
  - first default review page API latency while payload is pending;
  - owner RSS/temp spill behavior while payload continues in background.
- Add the result to `docs/review-serving-storage-performance.md` or the PR
  summary after implementation.

Acceptance criteria:

- The measured default-readiness time excludes payload wall time.
- Review-serving progress counters continue moving after default readiness.

### 7. Decouple Filtered Count Cache Keys From Payload

Filtered counts should not churn or miss just because the detail payload
generation changes. The count paths use posting/status/summary/search identity,
not judgment-detail payload rows.

Tasks:

- Remove `payload` from filtered-count component identity inputs in
  `reviewServingLlmReviewRouteService.ts` and
  `reviewServingHumanBothUnassessedRouteService.ts` unless a concrete count SQL
  dependency proves otherwise.
- Add tests that filtered count cache keys are stable across payload identity
  changes and still change when posting/status/summary/search identities change.
- Keep payload identity in detail/export/PDF paths only.

Acceptance criteria:

- Default and filtered count reads are not coupled to payload readiness or
  payload generation churn.
- No count SQL joins `mart.review_article_judgment_detail_serving_v4`.

## Quality Gates

- `bun test src/server/reviewServing/reviewServingReadContracts.test.ts`
- `bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts`
- `bun test src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts`
- `bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts`
- `bun test src/server/reviewServing/reviewServingSnapshotPromotionService.test.ts`
- `bun test src/server/reviewServing/reviewServingFilteredCountService.test.ts`
- Add the focused dispatch/queue test if the existing suite does not already
  prove payload independence for LLM scheduling.
- For UI changes, run the focused import/review route Vitest suite that covers
  the review page indexing/detail state.
- Live current-DB gate before PR/merge: API and maintenance owner ready, then
  verify review-serving progress counters move and the default review page opens
  before `payload` is complete.

## Risks

- If the list UI currently relies on hydrated judgment chips for ordinary
  screening, hiding those chips until payload is ready may be too much usability
  loss. In that case, implement only a bounded visible-page detail fallback, not
  a full eager payload rebuild.
- A missing payload identity must not be confused with an empty result set.
- Background payload work still shares DuckDB with foreground review traffic, so
  admission/backpressure must keep payload from starving default reads.
- Export/PDF users may perceive the project as "ready" while those actions are
  still indexing; the action state needs to be explicit.

## Recommended First Slice

Implement this as one PR-sized cut:

1. Centralize readiness tier constants and diagnostics.
2. Make default list routes skip payload hydration when no payload identity is
   present and return an explicit detail-readiness state.
3. Keep detail/export/PDF gated on payload with typed pending responses.
4. Add route/read-contract tests plus one live current-DB progress check.

This slice should reduce perceived mart creation time without changing source
truth or risking silent incomplete detail exports.
