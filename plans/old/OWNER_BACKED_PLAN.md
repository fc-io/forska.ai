# Owner-Backed Runtime Plan

## Goal

Keep `judge-worker` dispatch fully owner-backed so it never reads DuckDB while resolving non-Codex provider runtimes.

## Problem

`judge-worker` receives owner-backed running jobs and job runtime metadata, but `getReadyPromptRuntime()` still calls local provider runtime autodetect. That path reads `app.provider_connection` through DuckDB and fails with `Current server role judge-worker cannot own DuckDB`, before the worker logs `llm.requestsToSendByJob.*` or claims prompts.

## Approach

Resolve provider runtime on the DuckDB owner and return a `PromptRuntime`-shaped value through the owner-backed job runtime endpoint. The judge-worker must treat this owner-provided runtime as the only runtime source for owner-backed jobs.

## Implementation Steps

1. Extend owner-backed job runtime data

Add resolved runtime fields to `OwnerBackedJudgmentJobInfo` and the owner-backed `/api/judgmentsjobs/:id/runtime` response:

- `resolvedRuntime: {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]} | null`
- `runtimeMatchStatus: 'ambiguous' | 'manual-only' | 'matched' | 'unreachable'`
- `runtimeMatchReason: string`
- `runtimeResolutionMode: 'auto-detect' | 'manual'`

2. Compute resolved runtime on owner

In the owner route handler, use existing provider config and model fields to call the same runtime resolution logic used by provider connection diagnostics. Preserve existing behavior for Codex by returning `{modelBaseUrl: 'codex://app-server', modelProvider: 'codex', modelWorkerUrls: []}` without autodetect.

Do not resolve runtime per prompt. Resolve once per owner runtime request, and keep the detector's existing cache behavior intact so the hot dispatch loop does not repeatedly probe provider endpoints.

3. Use owner-provided runtime in judge-worker

Change owner-backed `getReadyPromptRuntime()` and `getOwnerBackedReadyRows()` to use `resolvedRuntime` from `getOwnerBackedJudgmentJobInfo()` instead of calling `resolveProviderConnectionRuntimeMatch()` locally.

The owner-backed branch must not fall back to local provider runtime autodetect, `getDetectedProviderRuntimeSummaries()`, `listProviderConnections()`, or any DuckDB-backed provider connection reads in the judge-worker process.

4. Keep local non-owner path unchanged

Only alter the owner-backed branch. The normal maintenance/dev-single path can keep using local SQLite job info and local runtime resolution.

5. Surface invalid owner runtime clearly

If the owner response has `resolvedRuntime: null` for a non-Codex job, return `null` from `getReadyPromptRuntime()` and log the owner-provided `runtimeMatchStatus`, `runtimeMatchReason`, and `runtimeResolutionMode`. Do not let `judge-worker` fall back to local DuckDB reads.

6. Add regression coverage

Add tests proving owner-backed non-Codex `getReadyPromptRuntime()` and `getAndUpdateReadyPrompts()` do not call provider runtime autodetect or DuckDB-backed provider connection listing, while still returning resolved SGLang runtime fields.

Add a route test proving `/api/judgmentsjobs/:id/runtime` returns `resolvedRuntime` and runtime match diagnostics for a non-Codex job.

## Quality Gates

- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun run lint`

## Touched Layers

- server: owner-backed judgment job runtime route, judge-worker prompt runtime resolution
- database: no schema changes
- client: no UI changes expected
- desktop/web: shared server flow only; no browser or desktop runtime asset changes expected
