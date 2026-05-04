# New Job Page UI Plan

## Goal

Make the job detail page more compact and easier to debug by ordering visible information as a pipeline, while keeping all debug data visible and removing only duplicate presentations.

## Debug Flow

1. Job Header
   - Show project link, full job ID, job status, storage state, created/updated timestamps, project ID, and primary lifecycle actions in one compact header.
   - Keep runtime warnings near the header so start blockers are immediately visible.

2. Work Definition
   - Show provider connection, current request-level LLM call limit, model/runtime notice, unassessed article count, and token totals.
   - Purpose: clarify what this job is trying to process before showing execution state.

3. Pipeline Summary
   - Show prompt counts in order: Ready, Claimed, Running, Judged, Skipped.
   - Show request indicators nearby: Live request calls, Attempts, Failed attempts, Anthropic refusals.

4. Request And Capacity Debug
   - Group worker slots, queued prompts, provider prefetch fill, request-slot waiters, lifecycle counters, and request-work backlog.
   - Purpose: explain whether the job is executing, waiting locally, or blocked by capacity.

5. Provider Capacity Telemetry
   - Keep all telemetry visible, but make cards denser.
   - Order sections as: Lease Authority, Local Worker Diagnostics, Observed Aggregate Telemetry, Bottleneck Metadata, Allocation/Convergence, Endpoint Diagnostics.

6. Storage And Import Flow
   - Order storage fields by recovery path: storage policy, SQLite/WAL size, outbox/claimed/retained/pending ACK, recent transfer flow, oldest unexported/ACK age, projected drain, import success/failure details.
   - Move lease host, PID, lease ID, server job, port, and heartbeat under a compact Runtime Lease subsection.

7. Recovery And Danger Actions
   - Keep repair actions adjacent to storage diagnostics.
   - Keep delete separated as a danger action.

8. Errors And Timeline
   - Show errors near the top when present.
   - Keep token timeline visible lower on the page, after live/debug state.

## Compactness Changes

- Use wider page layout instead of `max-w-4xl`.
- Reduce most card padding from `p-6` to `p-3` or `p-4`.
- Prefer dense metric grids and label/value rows over large standalone cards.
- Shorten explanatory copy without removing fields.
- Keep all sections visible; no accordions or expandable sections.

## Removed Stats Or Indicators

No underlying stats or indicators will be removed from the page. Only duplicate placements will be removed:

- Remove the duplicate Storage State metric card because storage state remains in the header and storage section badge.
- Remove Live request LLM calls from Job Queue because it remains in Request Activity and Provider Capacity Telemetry.
- Remove Worker prompt slots from Job Queue because it remains in Request Activity and lifecycle counters.
- Remove Worker queued prompts from Job Queue because it remains in Request Activity and lifecycle counters.
- Remove duplicate standalone Project ID display if it is already shown in the compact header metadata.
- Remove duplicate standalone Created and Last Updated cards if they are already shown in the compact header metadata.
- Keep token totals in one place only, under Work Definition.

## Quality Gates

- `bun run lint`
- `bun run build`
- `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- Browser check `/admin/jobs/:id` on desktop and mobile widths.
- Browser check `/admin/jobs` to ensure the list remains compact and usable.
