# Review-Serving Early Readiness And Reuse Plan

## Goal

Show review rows and basic tab counts as soon as their required article/status
data is ready, while keeping heavier filter, search, detail, and derived summary
work exact and bounded in the background. Then reduce future rebuild cost by
reusing unchanged component generations across rebuilds.

The current failure mode is visible on large projects with no active
review-serving snapshot. The row/status components can be complete, but the UI
continues to show `0 / <total>` articles ready because snapshot promotion and
count routes still wait on broad `summary` and `posting` work.

## Live Evidence

Project `f326f203-c398-4da0-8458-aa2ac6f8bd05` had `544,684` scoped articles
and was actively progressing under the primary low-memory maintenance owner.
The warning route stayed responsive, the owner was not stuck, and there were no
failed, quarantined, expired-lease, or blocked rebuild chunks.

The important component breakdown from a read-only DuckDB snapshot:

- `projectScope`: complete.
- `display`: complete.
- `llmStatus`: complete.
- `humanStatus`: complete.
- `queue`: complete.
- `summary`: roughly `38,733` complete, `2,917` pending during diagnosis.
- `posting`, `payload`, and `search`: about `85` pending chunks each.

This means the basic row/status data was already available before the page could
be considered readable. The remaining first-visibility gate was mostly derived
summary/count/facet work.

## Implementation Order

Use component reuse as the architectural direction, but do not block early
visibility on the full reuse implementation.

1. Design the reuse and readiness model.
2. Split minimal row readiness from full enrichment readiness.
3. Tier summary/count projection so basic counts build before expensive facets.
4. Align posting priority with first-readiness needs.
5. Implement reusable unchanged component generations across rebuilds.

## Slice 1: Reuse And Readiness Design

Define the component invalidation contract before changing behavior:

- Document each component's input dependencies, output tables, and downstream
  read contracts.
- Define which source changes invalidate each component.
- Define how a snapshot manifest can safely compose freshly rebuilt components
  with reused compatible component generations.
- Define readiness tiers:
  - `rowsReady`: enough to list review rows for each tab.
  - `countsReady`: enough to show the tab's basic exact count.
  - `filtersReady`: enough for filter facets, posting intersections, and filter
    option lists.
  - `searchReady`: enough for token-prefix search.
  - `detailReady`: enough for payload/detail hydration.
  - `fullyEnriched`: all required and optional enrichment is complete.

Acceptance criteria:

- The component dependency matrix is explicit in code or docs.
- No route can accidentally treat a partial tier as a fully enriched snapshot.
- Manifest state exposes enough identity information to prove which tier is
  current.

## Slice 2: Minimal Row Readiness

Rows should be readable when their row contract inputs are complete, not when
all counts, facets, search, payload, and posting work is complete.

Target behavior:

- LLM rows can read after `projectScope`, `selectedImport`, `display`, and
  `llmStatus` are ready.
- Human rows can read after `projectScope`, `selectedImport`, `display`, and
  `humanStatus` are ready.
- Both rows can read after the LLM and human row inputs are ready.
- Unassessed rows can read after `projectScope`, `selectedImport`, `display`,
  `llmStatus`, and `queue` are ready.
- Search-enabled row reads require `searchReady`; otherwise non-search rows
  remain readable while search reports indexing.
- Detail routes continue to require `detailReady`.

Acceptance criteria:

- A large cold rebuild can promote or expose a snapshot for non-search row reads
  before `summary`, `posting`, `payload`, and `search` finish.
- Review warnings distinguish row readiness from filters/search/detail
  enrichment.
- UI loading text does not imply zero scoped articles when rows are available
  but enrichment is still running.

## Slice 3: Basic Count And Summary Tiers

Split summary work into basic counts and heavier derived summaries/facets.

Target behavior:

- Basic tab totals are built before prompt-answer facets and other high-fanout
  summary work.
- `review.list.total`, `review.queue.unassessedReady`, and the basic
  LLM/human/both tab counts have their own readiness identity.
- Filtered totals that need posting/search can stay indexing until their
  supporting artifacts are ready, or use an exact bounded fallback only when it
  satisfies the read budget.
- Prompt-answer facets, import-route facets, publication-year facets, and
  filter-option summaries remain exact but no longer block first rows.

Acceptance criteria:

- The LLM complete tab can show an exact basic count without waiting for every
  prompt-answer/facet summary chunk.
- Missing heavier summary tiers return explicit indexing/async state rather
  than silently returning zero.
- Existing count/facet correctness tests pass or are updated to the new tiered
  contract with exact assertions.

## Slice 4: Posting Priority

Align rebuild priority with the read contracts.

Target behavior:

- `posting` work that gates filter/posting reads is scheduled before optional
  `payload` and `search` work.
- `payload` and `search` remain secondary enrichment for detail/search reads.
- Scheduling stays bounded under the low-memory maintenance owner.

Acceptance criteria:

- Claim ordering tests prove posting is not starved behind optional payload or
  search when posting is required by a foreground/readiness tier.
- Search still yields after one range so foreground routes stay responsive.

## Slice 5: Reuse Unchanged Component Generations

Make rebuilds avoid redoing components whose input identity has not changed.

Target behavior:

- A new rebuild request can reuse a previous component generation when its input
  identity, source watermarks, projection identity, and selected-import identity
  are compatible.
- Reuse is recorded in the snapshot manifest and diagnostics.
- Reused components remain snapshot-protected until no active, retired,
  last-known-good, pinned, or in-flight manifest references them.
- Reuse never hides a stale component when project scope, selected import,
  display fields, model/thinking/content settings, prompt definitions, human
  judgments, LLM judgments, queue eligibility, or summary definitions change.

Acceptance criteria:

- Rebuilds after unrelated source changes skip unchanged components.
- Rebuilds after each component's invalidating source change rebuild that
  component and its dependents.
- Mixed reused/fresh snapshots read exactly the same rows/counts as a full
  rebuild.
- Diagnostics show reused versus rebuilt component counts.

## Verification Plan

Focused gates for the implementation slices:

```bash
bun test src/server/reviewServing/reviewServingReadContracts.test.ts
bun test src/server/reviewServing/reviewServingChunkManifestRepository.test.ts src/server/reviewServing/reviewServingRebuildRequestRepository.test.ts
bun test src/server/reviewServing/reviewServingV4RebuildRequestService.test.ts src/server/workers/reviewServingProjectorWorker.test.ts
bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts
bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts
bun test src/components/main/reviews/reviewsProjectWarnings.vitest.tsx src/components/main/reviews/getReviewIndexingInProgressTitle.test.ts
bun run bench:review-serving-release-gate
```

Full gates before PR completion:

```bash
bun run test:bun
bun run test:vitest
bun run lint
bun run build
git diff --check
bun run test:network-smoke:current-db
```

Because this changes review-serving maintenance, snapshot readiness, progress
reporting, and user-facing routes, the final PR must include a live current-DB
progress gate:

- API and maintenance/DuckDB-owner readiness.
- The primary DuckDB memory cap used during the check.
- Before/after progress counters for the affected project or another active
  current-DB review-serving workload.
- Confirmation that route latency remains bounded and no owner restart, OOM,
  fatal DuckDB error, quarantine, or expired-lease pattern appears.

If desktop/shared runtime behavior is touched, also run:

```bash
bun run desktop:build
```

Manual packaged desktop lifecycle smoke remains a separate manual gate unless a
packaged-app driver exists.

## Non-Goals

- Do not raise the primary DuckDB memory limit as the fix.
- Do not weaken count/filter correctness.
- Do not make search, payload, or prompt-answer facets appear ready before their
  supporting component tier is proven current.
- Do not leave permanent old/new competing snapshot-readiness paths.
