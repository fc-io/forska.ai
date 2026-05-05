# New Job Page UI Plan

## Goal

Make the job detail page more compact and easier to debug by ordering visible information as a pipeline, while keeping all debug data visible and removing only duplicate presentations.

## Debug Flow

1. Job Header
   - Show project link, full job ID, job status, storage state, created/updated timestamps, project ID, and primary lifecycle actions in one compact header.
   - Keep `RuntimeModelNotice`, judging-runtime warnings, action errors/notices, and resume-blocked guidance near the header so start blockers are immediately visible.

2. Work Definition
   - Show provider connection, current request-level LLM call limit, unassessed article count, and token totals.
   - Purpose: clarify what this job is trying to process before showing execution state.

3. Pipeline Summary
   - Show prompt counts in order: Ready, Claimed, Running, Judged, Skipped.
   - Show request indicators nearby: Live request calls, Attempts, Failed attempts, Anthropic refusals.

4. Request And Capacity Debug
   - Group worker prompt slots, worker queued prompts, prompt prefetch fill, request-slot waiters, lifecycle counters, local prompt backlog, and request-work backlog.
   - Purpose: explain whether the job is executing, waiting locally, or blocked by capacity.

5. Provider Capacity Telemetry
   - Keep all telemetry visible, but make cards denser.
   - Order sections as: Admission Lease Snapshot, Local Worker Diagnostics, Observed Aggregate Telemetry, Allocation State And Convergence, Bottleneck Source Metadata, Endpoint Diagnostics.
   - Preserve endpoint diagnostics, provider coverage, lease/observed mismatch warning, allocation versions, convergence preconditions, bottleneck/subreason/source metadata, and lifecycle counters.

6. Storage And Import Flow
   - Order storage fields by recovery path: storage policy, SQLite/WAL size, outbox/claimed/retained/pending ACK, orphaned local queue, recent transfer flow, oldest unexported/ACK age, projected drain, import success/failure details, and quarantine reason.
   - Move lease host, PID, lease ID, server job, port, and heartbeat under a compact Runtime Lease subsection.

7. Recovery And Danger Actions
   - Keep repair actions adjacent to storage diagnostics.
   - Keep delete separated as a danger action.

8. Errors And Timeline
   - Move job errors near the top when present, below immediate start/runtime blockers and above detailed debug sections.
   - Move token timeline lower on the page, after live/debug state and before danger actions.

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
- Consolidate Project ID, Created, and Last Updated into compact header metadata instead of repeating them in separate large metadata blocks.
- Keep token totals in one place only, under Work Definition.

## Test Updates

- Update telemetry e2e assertions to match the final section headings, especially `Admission Lease Snapshot` versus the older `Lease Authority` label.
- Keep list-page behavior unchanged except for any compactness checks needed by this plan.
- For shared app UI changes, verify the browser/web path and ensure the desktop build still compiles.

## Quality Gates

- `bun run lint`
- `bun run build`
- `bun run desktop:build`
- `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- `bunx playwright test tests/e2e/adminJudgmentJobTelemetry.spec.ts tests/e2e/adminJudgmentJobTelemetryWebFlow.spec.ts`
- Browser check `/admin/jobs/:id` on desktop and mobile widths.
- Browser check `/admin/jobs` to ensure the list remains compact and usable.
