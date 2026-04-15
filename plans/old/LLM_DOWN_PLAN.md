# LLM Down / Misconfigured Endpoint Handling Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** When the configured inference endpoint is down or misconfigured, Forska should emit a clear operator message, stop claiming and sending additional prompts for that provider connection, and resume only after a successful health probe.

**Architecture:** Reuse provider adapter `testConnection` and `health` hooks as the single source of truth for endpoint usability. Replace the current boolean `isConnectionError` gating with structured endpoint-availability handling keyed by provider connection plus effective base URL, and wire that state into both the request runtime and the pre-claim send scheduler. Keep queue semantics retry-safe: unavailable endpoints requeue prompts; prompt/content errors remain per-prompt failures.

**Tech Stack:** Bun, TypeScript, judgment-job SQLite queues, provider registry/adapters, OpenAI-compatible transports.

---

## Current gap

- `src/server/cron/judgmentsJobs/connectionHealth.ts` only opens the circuit for `408`, `429`, `5xx`, or network-like messages.
- `src/agent/judge.ts` wraps provider invocation failures in `ConnectionError`, but an OpenAI-compatible `404 NOT_FOUND` from `/v1/chat/completions` is not classified as endpoint-unavailable.
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts` claims batches before it knows the endpoint is unusable and fans them out with `Promise.allSettled(...)`, so a bad endpoint can still generate noisy retries and aborts inside one tick.
- `src/server/providers/providerHealthService.ts` and adapter `testConnection` hooks already exist, but they are not used to gate dispatch.

## Desired behavior

- First send attempt for a provider connection performs or reuses a health decision.
- `404`/`405`/`501` from required inference endpoints are treated as endpoint unavailable or misconfigured, not as opaque prompt aborts.
- While a connection is unavailable, the scheduler does not claim or send new prompts for it.
- Recovery happens only after a successful health probe.
- Logs and persisted errors clearly say which endpoint failed and why Forska is pausing dispatch.

## Task 1: Introduce structured inference endpoint failure classification

**Objective:** Replace the current boolean connection-error heuristic with a typed classification that can distinguish network failure, endpoint unavailable, endpoint misconfigured, circuit open, rate limit, and generic request/content errors.

**Files:**

- Modify: `src/server/cron/judgmentsJobs/connectionHealth.ts`
- Modify: `src/agent/judge.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- Optional helper: `src/server/providers/adapters/providerAdapterUtils.ts`

**Plan:**

- Add a structured error type or classifier result, for example:
  - `network_unavailable`
  - `endpoint_unavailable`
  - `endpoint_misconfigured`
  - `rate_limited`
  - `circuit_open`
  - `other`
- For OpenAI-compatible providers, classify `404`, `405`, and `501` from required endpoints (`/v1/models`, `/v1/chat/completions`, `/v1/responses`) as endpoint unavailable or misconfigured.
- Make the propagated error message explicit:
  - include provider kind, base URL, endpoint path, status code, and likely cause
  - example: `Inference endpoint unavailable: llama.cpp Server at http://127.0.0.1:8080 returned 404 NOT_FOUND for POST /v1/chat/completions. Likely wrong server/port or OpenAI-compatible API offline.`
- Keep `400`/`422`-style prompt/content errors out of the outage path.

## Task 2: Replace failure-count-only gating with endpoint availability state

**Objective:** Track whether a provider connection is healthy, unavailable, misconfigured, cooling down, or probing, keyed by provider connection and effective base URL.

**Files:**

- Create: `src/server/cron/judgmentsJobs/judgmentEndpointAvailability.ts`
- Modify: `src/server/cron/judgmentsJobs/connectionHealth.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.ts`

**Plan:**

- Introduce connection-scoped availability state keyed by:
  - `providerConnectionId`
  - resolved/effective base URL
- Track:
  - `status: 'healthy' | 'cooldown' | 'probing' | 'misconfigured'`
  - last failure kind/message
  - cooldown expiry
  - in-flight probe promise
- Behavior:
  - explicit endpoint-misconfigured or unavailable failures open the gate immediately
  - ambiguous transient failures may still use limited thresholding if needed, but the send gate must stop once the connection is marked unavailable
  - only one half-open probe at a time
  - success clears the gate and resets failure history
- Keep `judgmentsRequestRuntime.ts` as the concurrency/slot layer, but make it consult the richer availability state instead of only `isCircuitOpen(baseURL)`.

## Task 3: Reuse provider adapter health probes for resume logic

**Objective:** Use the existing provider registry health path as the authoritative `can this endpoint serve model traffic?` probe.

**Files:**

- Modify: `src/server/providers/providerHealthService.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentEndpointAvailability.ts`
- Modify: `src/server/providers/adapters/createOpenAICompatibleAdapter.ts` only if returned messages need tightening

**Plan:**

- Reuse `testProviderConnectionHealth(...)` and adapter `testConnection(...)` for probe execution.
- For OpenAI-compatible providers, the probe should remain `models.list()`-based unless a transport-specific endpoint check is more reliable.
- Normalize probe failures into the new endpoint-availability message shape.
- Persist the latest probe failure into `app.provider_connection.last_error` / `last_checked_at` via the existing health service path so operators see the same reason the scheduler is using.

## Task 4: Stop claiming and sending new prompts while the endpoint is down

**Objective:** Prevent unnecessary claim/send/abort churn at the scheduler level.

**Files:**

- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts` if claim flow needs an early availability check
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`

**Plan:**

- Before calling `getAndUpdateReadyPrompts(...)` for a provider connection, consult availability state:
  - `healthy` → proceed
  - `cooldown` / `misconfigured` → skip claim
  - cooldown expired → run one probe; only proceed if probe succeeds
- Log a clear scheduler-level skip message once per window, not once per prompt.
- Preserve retry semantics:
  - prompts already claimed for an unavailable endpoint go back to `ready`
  - they are not marked `judged`
- Refactor connection-scoped prompt execution so one detected endpoint-unavailable failure stops launching more prompts for that connection in the same tick.
  - Current `Promise.allSettled(prompts.map(...))` starts the whole claimed batch immediately; that defeats graceful stop.
  - Replace it with a connection-scoped dispatcher that can short-circuit remaining not-yet-started prompts once availability flips to unavailable.

## Task 5: Make operator-facing messages explicit and actionable

**Objective:** Replace opaque `Aborting: 404 NOT_FOUND` lines with messages that explain the failure mode and pause behavior.

**Files:**

- Modify: `src/agent/judge.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- Modify: diagnostics/status payloads that already expose provider/job error state, if needed

**Plan:**

- Replace generic messages like:
  - `Aborting: 404 NOT_FOUND`
  - `Connection error - marking prompts for retry (...)`
- With endpoint-aware text that includes:
  - what failed
  - which base URL
  - which endpoint/path
  - whether Forska is pausing dispatch
  - when the next probe will happen
- Example log:
  - `Inference endpoint unavailable for provider connection 5304d063-28f0-49b4-b904-f88aae0eec0f: http://127.0.0.1:8080 returned 404 NOT_FOUND for POST /v1/chat/completions. Pausing new prompt dispatch for 30s and waiting for a successful health probe.`
- Example per-prompt log:
  - `Prompt requeued because provider endpoint is unavailable; no further prompts will be sent for this connection until health check passes.`

## Task 6: Add regression coverage for the exact misroute scenario

**Objective:** Lock in the behavior for `wrong server on the configured LLM port`.

**Files:**

- Create: `src/server/cron/judgmentsJobs/connectionHealth.test.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- Modify: `src/server/providers/adapters/createOpenAICompatibleAdapter.test.ts`

**Required test cases:**

- `404 NOT_FOUND` from OpenAI-compatible `/v1/chat/completions` is classified as endpoint unavailable or misconfigured.
- Once classified unavailable, dispatch skips new claims for that provider connection.
- Only one health probe runs after cooldown expiry.
- Successful health probe closes the gate and dispatch resumes.
- Prompt/content errors that are not endpoint-availability problems do not pause the whole connection.
- Already-claimed prompts are requeued safely when availability flips to unavailable.

## Task 7: Surface the paused state in diagnostics

**Objective:** Make it easy to see from job/provider diagnostics why dispatch is paused and when it will retry.

**Files:**

- Modify: existing judgments job diagnostics/status route(s) that already expose request stats and provider state
- Modify: provider admin/status payloads that already include `last_error` / runtime state

**Plan:**

- Expose:
  - availability status
  - last failure kind
  - last failure message
  - cooldown remaining
  - probe in progress yes/no
- This should be read-only diagnostics, not a second independent source of truth.

---

## Quality Gates

Pass/fail only.

- `bun test src/server/cron/judgmentsJobs/connectionHealth.test.ts`
  - Pass: new `404`/misconfigured classification and gate transitions are covered
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
  - Pass: request runtime blocks dispatch while unavailable and reopens only after probe success
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
  - Pass: scheduler skips claims while unavailable and requeues safely
- `bun test src/server/providers/adapters/createOpenAICompatibleAdapter.test.ts`
  - Pass: OpenAI-compatible health probe / `404` behavior is covered
- `bun run lint`
  - Pass: no new lint/type issues in touched files

## Commands to run during implementation

- `bun test src/server/cron/judgmentsJobs/connectionHealth.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM.test.ts`
- `bun test src/server/providers/adapters/createOpenAICompatibleAdapter.test.ts`
- `bun run lint`

## Notes

- Prefer reusing the existing provider adapter `testConnection` flow over adding a second bespoke health-check protocol.
- Do not treat all `4xx` responses as outage signals; only transport/endpoint-shape failures should pause the connection.
- Key the paused state by provider connection plus effective base URL so one bad endpoint does not stall unrelated providers.
- Preserve current retry-safe queue semantics: unavailable endpoints requeue prompts; they do not silently mark them completed.
