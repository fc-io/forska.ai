# Provider Auto Detect Plan

## Goal

- Keep manual provider/model rows as source of truth.
- Auto-detect live runtimes local or remote, then bind them to the matching saved provider connection.
- Auto-adopt only when saved provider settings match one live runtime.
- Move normal provider resolution away from one global implicit runtime per provider kind.

## Current Problem

- `scripts/getForskaRuntimeEnv.ts` + `src/server/utils/getInferenceRuntimeConfig.ts` produce one global runtime snapshot.
- `src/server/providers/providerRuntimeState.ts` applies that snapshot by `providerKind`, so one active SGLang tunnel can affect every `sglang` connection in runtime mode.
- `bun run dev:server` vs `bun run alvis:dev:server` is operational knowledge, not provider state.

## Core Decision

- Saved connection settings like `baseURL`, `manualWorkerUrls`, and saved model ids become match keys, not second-class fallback.
- Live runtime detection becomes an ephemeral per-connection overlay; do not silently rewrite saved DB URLs.
- Auto-adopt only on one strong match. `0` matches => stay manual and show reason. `>1` matches => ambiguous and do not auto-switch.
- First pass targets local/runtime-backed providers: `sglang`, `vllm`, `ollama`, `llmstudio`, `llamacpp`.
- Detection should be low-frequency and budgeted; do not keep pinging healthy runtimes aggressively, especially while a model is actively serving work.

## Scope Now

- Detect live local endpoints from saved manual URLs.
- Detect remote runtimes from launcher metadata written by `alvis:launch*` / `mn5:launch` plus local tunnel endpoints.
- Probe detected endpoints for served models via `/v1/models` or provider-native discovery.
- Attach detection state to provider connections and saved models in `/providers`.
- Use matched runtime for connection test, model sync, runtime guard, and judgments.

## Probe Policy

- Prefer launcher metadata and saved manual settings before live probes.
- Cache healthy detection results with a longer TTL; cache failures with backoff.
- Do not poll active runtimes on a tight loop.
- Revalidate eagerly only on explicit user actions like `Test`, `Sync Models`, opening `/providers`, or when the last match is stale.
- Reuse successful real request traffic as freshness evidence when possible.

## Not Now

- Auto-create provider rows from arbitrary open ports.
- SSH into schedulers on every API request.
- Multi-user runtime ownership policy.
- Hosted API providers like OpenAI/Anthropic; those already have explicit connection state.

## Data Shape

- Add a runtime-only `provider runtime candidate` shape:
  - `providerKind`, `source`, `status`
  - `localBaseURL`, `remoteBaseURL`
  - `localWorkerUrls`, `remoteWorkerUrls`
  - `modelNames`
  - small source metadata like `jobId`, `cluster`, `sshJumpHost`
- Add a per-connection `runtime match` payload:
  - `status`: `matched` | `manual-only` | `ambiguous` | `unreachable`
  - `candidateId`
  - `reasons`
  - `effectiveBaseURL`
  - `effectiveWorkerUrls`
  - `detectedModelNames`
- Replace or phase out `workerUrlMode: "runtime"` with connection-level `resolutionMode: "manual" | "auto-detect"`; short term, map old `runtime` to `auto-detect`.

## Matching Rules

- Hard gate: same `providerKind`.
- Strong match when saved manual settings overlap detected runtime:
  - saved `baseURL` equals detected local or remote base URL
  - saved `manualWorkerUrls` intersect detected local or remote worker URLs
- Boost match when saved model ids intersect detected served models.
- Add optional source hints later if needed, e.g. `alvis`, `mn5`, `sshJumpHost`.
- Never auto-adopt on provider kind alone.

## Implementation Order

1. Detection source layer.
   - Add a server-side detector service with TTL + backoff, not aggressive polling.
   - Local detector probes saved provider endpoints.
   - Launcher detector reads local runtime metadata files from `alvis:launch*` / `mn5:launch` instead of relying on global env.
   - Treat active judgments/runtime usage as freshness; avoid extra probe traffic while the runtime is clearly alive.
2. Launcher metadata.
   - Make launch scripts write a small local runtime record on start, refresh, and stop.
   - Record provider kind, model, local tunnel URLs, remote URLs, job id, and source cluster.
3. Matching + overlay.
   - Add connection-to-candidate matching.
   - Resolve effective base URL and worker URLs from the matched candidate, else fall back to saved manual settings.
   - Move `providerRuntimeState` from global-by-kind behavior to per-connection overlay behavior.
4. API + UI.
   - Extend `/api/provider-connections` payload with detection and match state.
   - Show states like `matched local`, `matched Alvis`, `ambiguous`, `manual only`.
   - Show detected served models and why a connection did or did not match.
5. Model/runtime use sites.
   - Make connection test, model sync, runtime guard, and judgments use matched effective runtime.
   - Mark saved models as `available now` when detected runtime serves them.
6. Migration + cleanup.
   - Keep current global `FORSKA_RUNTIME_*` flow only as a compatibility bridge.
   - Remove `alvis:dev:server` / `mn5:dev:server` specialness once ordinary `dev:server` uses provider-aware detection.

## Done Criteria

- A manual local SGLang provider auto-matches a live local endpoint.
- A manual Alvis or MN5 provider auto-matches the running tunneled job without `*:dev:server`.
- Ambiguous matches stay visible and unadopted.
- Judgment job creation uses the matched runtime, not the old global fallback.
- Provider page shows which saved models are currently served.

## Quality Gates

- `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun test src/server/providers/providerRuntimeModelGuard.test.ts`
- `bun test src/server/providers/providerRuntimeState.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.test.ts`
- `bun run lint`
- `bun run build`
- Browser verify:
  - local manual provider matches a live local runtime
  - manual Alvis or MN5 provider matches a live tunneled runtime
  - ambiguous match stays non-adopted and visible
  - creating a judgment job succeeds through the matched runtime
