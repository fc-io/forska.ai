# Local Batch Size Plan

## Goal

- Let user set per-model `max concurrent requests` from provider detail page.
- Expose it in `Add Model` and `Models` on `src/app/routes/+providers/+$id/+index.tsx`.
- First pass: show for local/runtime-backed providers; store generically so later non-local providers can use same field.
- Keep current scheduling unchanged when unset.

## Core Decision

- Store this as a nullable app-owned column on `app.model`, not provider config or model metadata.
- DB name: `max_inflight_requests`. API/UI name: `maxInflightRequests`.
- `NULL` means use current runtime/provider defaults. `>= 1` means extra per-model ceiling.
- Effective send cap = existing global/provider cap, tightened by model cap.
- Cap is per model across all jobs using that model, not per job.

## Scope Now

- Create manual models with this value.
- Edit existing saved/discovered models with this value.
- Respect it in judgment send/runtime paths for normal and chunked requests.
- Keep UI visibility local-first; keep server/data generic.

## Not Now

- Provider-level/global batch-size UI.
- Auto-tuning from provider metrics.
- Per-project/per-job overrides.
- Full remote-provider UI rollout.

## Implementation Order

1. Schema + types.
   - Add DuckDB migration for `app.model.max_inflight_requests`.
   - Thread through `ProviderModelRow`, `ProviderModelRecord`, provider connection payloads, and any job snapshot data that needs it.
2. API.
   - Extend `POST /api/provider-connections/:id/models` and `PATCH /api/models/:id`.
   - Validate positive integer or empty/null; reject `0`, negative, non-integer.
   - Omitted field keeps old behavior.
3. Sync + persistence rules.
   - New manual/discovered rows default to `NULL`.
   - Provider model sync must preserve an existing user-set value on upsert.
   - Duplicate manual-add flow should not silently overwrite an existing model's value; edit remains in `Models`.
4. UI.
   - Add `Max concurrent requests` number input to `Add Model`.
   - Add same editable field to each row/card in `Models`.
   - Extract a small provider-kind helper for local-first visibility so later non-local rollout is one place.
   - Copy should explain: empty = default scheduler limit.
5. Runtime.
   - Pass `modelId` + `maxInflightRequests` into request scheduling.
   - Add model-scoped in-flight accounting in `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`.
   - Tighten prompt claiming in `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts` so capped models are not over-claimed across jobs.
   - Ensure chunked judging also respects the same model cap.
6. Tests.
   - Route/repository tests for create, update, validation, null/default, and sync preservation.
   - Runtime tests for model-shared cap across multiple jobs and chunked requests.
   - UI/browser verification for add/edit/save states and empty/default copy.

## Quality Gates

- `bun test src/server/routes/ProviderModelsRoutes.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun run lint`
- `bun run build`
- Browser verify in `/providers/:id`: add manual model with cap, edit existing model cap, leave empty for default, confirm saved value survives reload and sync.
