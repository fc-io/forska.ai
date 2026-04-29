# Provider Inflight Limit Plan

## Goal

- Let each provider connection set its own API-server cap for `Prompts in Progress`.
- Keep this separate from SGLang runtime launch settings like `SGLANG_API_MAX_INFLIGHT_REQUESTS`.
- Apply the cap across all jobs using the same provider connection, not per job.
- Keep current behavior unchanged when the provider-level value is unset.

## Core Decision

- Store this as a nullable app-owned column on `app.provider_connection`.
- DB name: `max_inflight_requests`. API/UI name: `maxInflightRequests`.
- `NULL` means use the provider-family default.
- `>= 1` means set the API server's provider-level claim and request concurrency for that provider connection.
- Default when unset:
  - non-codex: current runtime/global-derived limit
  - codex: current `CODEX_MAX_INFLIGHT` limit
- Effective limit still respects stricter lower-level runtime constraints when they exist.

## Why A Column

- This is Forska scheduler state, not upstream provider metadata.
- It should survive runtime auto-detect, launcher changes, model sync, and provider config JSON cleanup.
- A dedicated column is easier to query when grouping running jobs by provider connection.

## Scope Now

- Add the provider connection column and thread it through server types and provider APIs.
- Show and edit the setting on the provider detail page, including Codex App.
- Respect it when claiming ready prompts and when acquiring request slots.
- Apply it to all provider connections, including the singleton Codex connection.

## Not Now

- Per-model overrides.
- Per-project or per-job overrides.
- Auto-tuning from runtime metrics.
- Separate burst tuning UI; first pass uses the same provider cap for `maxInflight` and `maxBurst` tightening.

## Implementation Order

1. Schema + server types.
   - Add DuckDB migration for `app.provider_connection.max_inflight_requests`.
   - Thread it through `ProviderConnectionRow`, `ProviderConnectionRecord`, repository queries, and route payloads.
   - Validate as nullable positive integer.
2. Provider API.
   - Extend `POST /api/provider-connections` and `PATCH /api/provider-connections/:id`.
   - Reject `0`, negative numbers, and non-integers.
   - Keep omitted or empty input as `NULL`.
3. UI.
   - Add a `Prompts in Progress limit` number input on `src/app/routes/+providers/+$id/+index.tsx`.
   - Explain that empty means `use provider default`.
   - For Codex, empty falls back to `CODEX_MAX_INFLIGHT`; for runtime-backed providers, empty falls back to current runtime/global capacity.
   - Keep it visible where provider connections are edited, including Codex, not per model.
4. Runtime accounting.
   - Extend running-job lookup to include `providerConnectionId`.
   - Group jobs by provider connection in `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`.
   - Tighten prompt claiming per provider group so one provider cannot over-claim above its configured cap.
5. Request-slot enforcement.
   - Pass provider-connection identity and effective provider cap into `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`.
   - Maintain provider-scoped in-flight accounting for fallback and worker-based requests.
   - Ensure the provider cap still composes with worker load balancing, codex scheduling, and circuit breaking.
6. Tests.
   - Repository/route tests for create, update, null/default, and validation.
   - Runtime tests that multiple jobs sharing one provider connection respect the same cap.
   - Runtime tests that two provider connections do not block each other beyond the global cap.

## Open Behavior Choices

- First pass should treat provider cap as a ceiling for both:
  - prompt claiming into `sent`
  - active request slots in the API server
- If the provider cap is higher than a stricter runtime or worker limit, that stricter lower-level limit still wins.
- If multiple jobs share one provider connection, they compete fairly inside that shared provider budget.
- Codex uses the same saved provider setting, but its empty/default path still comes from `CODEX_MAX_INFLIGHT`.

## Done Criteria

- A provider connection can save `maxInflightRequests` or leave it empty.
- `/api/provider-connections` returns the saved value.
- The Providers UI shows and edits the value successfully for both Codex and non-Codex connections.
- Jobs using one provider connection never exceed that provider's configured in-flight cap, even when multiple jobs run at once.
- Leaving the field empty preserves current behavior.

## Quality Gates

- `bun run db:mig`
- `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts`
- `bun run lint`
- Browser verify in `/providers/:id`: save a provider cap, leave it empty for default, confirm the saved value survives reload, verify a capped provider does not let `Prompts in Progress` exceed the configured value, and verify Codex uses the same field with its own default fallback.
