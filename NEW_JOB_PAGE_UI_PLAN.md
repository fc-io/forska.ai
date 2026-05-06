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
   - Show request indicators nearby: Live Request LLM Calls, Attempts, Failed Attempts, Anthropic Refusals.

4. Request And Capacity Debug
   - Group Worker Prompt Slots, Worker Queued Prompts, Prompt Prefetch Fill, and Request Slot Waiters.
   - Make Request Slot Waiters canonical here; do not also keep it in Provider Capacity Telemetry.
   - Do not repeat local prompt backlog, request-work backlog, or lifecycle counters here; those remain canonical in Provider Capacity Telemetry.
   - Purpose: explain whether the job is executing, waiting locally, or blocked by capacity.

5. Provider Capacity Telemetry
   - Keep all telemetry visible, but make cards denser.
   - Order sections as: Admission Lease Snapshot, Local Worker Diagnostics, Observed Aggregate Telemetry, Allocation State And Convergence, Bottleneck Source Metadata, Endpoint Diagnostics.
   - Preserve endpoint diagnostics, provider coverage, lease/observed mismatch warning, allocation versions, convergence preconditions, bottleneck/subreason/source metadata, and lifecycle counters.
   - Keep Local Worker Diagnostics as the canonical location for local prompt backlog and request-work backlog.

6. Storage And Import Flow
   - Order storage fields by recovery path: storage policy, SQLite/WAL size, outbox/claimed/retained/pending ACK, orphaned local queue, recent transfer flow, oldest unexported/ACK age, projected drain, import success/failure details, and quarantine reason.
   - Move lease host, PID, lease ID, server job, port, and heartbeat under a compact Runtime Lease subsection.

7. Recovery Actions
   - Keep repair actions adjacent to storage diagnostics; do not insert unrelated sections between storage diagnostics and repair controls.

8. Errors
   - Move job errors near the top when present, below immediate start/runtime blockers and above detailed debug sections.
   - Do not change the token timeline component, data, content, or page placement.

9. Danger Actions
   - Keep delete separated as a final danger action below recovery actions.

## Final Page Order

1. Back link.
2. Compact job header with status, storage state, metadata, primary lifecycle actions, action errors/notices, resume-blocked guidance, runtime model notice, and judging-runtime warning.
3. Job errors, only when present.
4. Work Definition.
5. Pipeline Summary.
6. Request And Capacity Debug.
7. Existing token timeline, unchanged.
8. Provider Capacity Telemetry.
9. Storage And Import Flow, including Runtime Lease.
10. Recovery Actions.
11. Danger Actions.

## Implementation Checklist

- [ ] Widen the job detail page container from `max-w-4xl` to `max-w-7xl` and verify mobile-safe wrapping with no horizontal page overflow.
- [ ] Rebuild the job header as a compact block containing the project link, full job ID, job status, storage state, project ID, timestamps, lifecycle actions, action errors/notices, resume-blocked guidance, `RuntimeModelNotice`, and judging-runtime warning.
- [ ] Move job errors directly below the header/blocker area and above detailed debug sections when errors are present.
- [ ] Create the Work Definition section with provider connection, current request-level LLM call limit, unassessed article count, and token totals.
- [ ] Create the Pipeline Summary section with Ready, Claimed, Running, Judged, Skipped, Live Request LLM Calls, Attempts, Failed Attempts, and Anthropic Refusals.
- [ ] Create the Request And Capacity Debug section with Worker Prompt Slots, Worker Queued Prompts, Prompt Prefetch Fill, and Request Slot Waiters as the canonical waiter placement.
- [ ] Split the current Job Queue and Request Activity cards into Pipeline Summary and Request And Capacity Debug, removing duplicate metric placements listed in Removed Stats Or Indicators without removing the underlying API data.
- [ ] Keep the existing token timeline component, data, content, and page placement unchanged.
- [ ] Densify Provider Capacity Telemetry while preserving the required section order and canonical local prompt backlog, request-work backlog, and lifecycle counter fields.
- [ ] Reorder Storage And Import Flow by recovery path and group lease host, PID, lease ID, server job, port, and heartbeat under Runtime Lease.
- [ ] Keep recovery repair actions adjacent to storage diagnostics, then move delete into a final separated Danger Actions section.
- [ ] Add wrapping or break classes for long job IDs, project IDs, lease IDs, endpoint URLs, provider keys, error messages, quarantine reasons, and import failure details.
- [ ] Update unit/e2e tests for new headings, header-adjacent blockers/actions, compactness, and no-overflow behavior.
- [ ] Run the Quality Gates and record any skipped gate with the reason.

## Compactness Changes

- Use a wider bounded page layout, replacing `max-w-4xl` with `max-w-7xl` and preserving mobile-safe wrapping with no horizontal page overflow.
- Reduce most card padding from `p-6` to `p-3` or `p-4`.
- Prefer dense metric grids and label/value rows over large standalone cards.
- Ensure long text never overflows its container, including job IDs, project IDs, lease IDs, endpoint URLs, provider keys, error messages, quarantine reasons, and import failure details.
- Shorten explanatory copy without removing fields.
- Keep all sections visible; no accordions or expandable sections.

## Removed Stats Or Indicators

No underlying stats or indicators will be removed from the page. Only duplicate placements will be removed:

- Remove the duplicate Storage State metric card because storage state remains in the header and storage section badge.
- Remove Live Request LLM Calls from Job Queue because it remains in Pipeline Summary and Provider Capacity Telemetry lifecycle counters.
- Remove Worker Prompt Slots from Job Queue because it remains in Request And Capacity Debug and Provider Capacity Telemetry lifecycle counters.
- Remove Worker Queued Prompts from Job Queue because it remains in Request And Capacity Debug and Provider Capacity Telemetry lifecycle counters.
- Keep Request Slot Waiters only in Request And Capacity Debug; remove the Provider Capacity Telemetry placement if it would otherwise duplicate.
- Keep local prompt backlog and request-work backlog only in Provider Capacity Telemetry.
- Keep lifecycle counters only in Provider Capacity Telemetry.
- Consolidate Project ID, Created, and Last Updated into compact header metadata instead of repeating them in separate large metadata blocks.
- Keep token totals in one place only, under Work Definition.

## Test Updates

- Update telemetry e2e assertions to match the final section headings, especially `Admission Lease Snapshot` versus the older `Lease Authority` label.
- Add an e2e assertion that lifecycle actions, action errors/notices, resume-blocked guidance, `RuntimeModelNotice`, and judging-runtime warnings render near the header before detailed debug sections.
- Keep list-page behavior unchanged except for any compactness checks needed by this plan.
- For shared app UI changes, verify the browser/web path and ensure the desktop build still compiles.

## Quality Gates

- `bun run lint`
- `bun run build`
- `bun run desktop:build`
- `bun test src/app/routes/+admin/+jobs/jobsPageShared.test.ts`
- `bunx playwright test tests/e2e/adminJudgmentJobTelemetry.spec.ts tests/e2e/adminJudgmentJobTelemetryWebFlow.spec.ts`
- Browser check `/admin/jobs/:id` on desktop and mobile widths.
- Browser check `/admin/jobs/:id` with long IDs, endpoint URLs, provider keys, and error text to verify no text or page-level horizontal overflow.
- Browser check `/admin/jobs` to ensure the list remains compact and usable.
