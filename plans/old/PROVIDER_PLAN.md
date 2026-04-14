# Provider Plan

## Goal

- Add first-class provider support like OpenCode / OpenClaw / Hermes Agent.
- First pass providers: `openai`, `codex`, `docling`, `anthropic`, `google`, `openrouter`, `ollama`, `llmstudio`, `sglang`, `vllm`.
- Use provider-first connect / enable / add flows on `src/app/routes/+providers/+index.tsx` and `src/app/routes/+providers/+add-provider.tsx`.
- Long term: no backwards-compat layer. Short term: keep the legacy Codex `/api/models/*` bridge until remaining clients move.

## Core Decision

- Do not store provider settings on `app.user_config` / old `user`.
- Do not store provider settings on `app.model`.
- Add a dedicated provider layer.
- Why: one provider connection can serve many models; one provider kind can have many connections; auth/health/secrets are connection concerns, not model concerns; future multi-user still works.

## Long-Term Data Shape

- Keep provider definitions in code, not DB. DB stores configured connections only.
- Add `app.provider_connection`:
  - `id`, `provider_kind`, `label`, `enabled`
  - `auth_mode`
  - `base_url`
  - `config_json` for non-secret provider-specific config
  - `secret_ref`
  - `last_checked_at`, `last_error`
  - `created_at`, `updated_at`
- Reshape `app.model` into the selectable model table:
  - `id`, `provider_connection_id`
  - `remote_model_id`, `display_name`, `variant`
  - `source` (`discovered` | `manual`)
  - `enabled`
  - `metadata_json`
  - `created_at`, `updated_at`
- Move `worker_urls` off `app.model`; keep it in `app.provider_connection.config_json` for `sglang` / `vllm` if still needed.
- Keep `app.project.model_id`. Good foreign key. Good history.

## Lean Duck Alignment

- Follow the same hot-DB rule as `LEAN_DUCK_PLAN.md`: keep ids, toggles, labels, small capability facts, and normalized config; do not keep large duplicated provider payloads in hot DuckDB without a proven need.
- `app.provider_connection.config_json` should stay lean:
  - keep only saved app config such as manual base URLs, manual worker URLs, and small provider-specific toggles
  - do not persist runtime-discovered worker state, launcher metadata, auth device payloads, or large health/debug payloads
- `app.model.metadata_json` should stay lean:
  - keep only normalized capability metadata the UI/runtime genuinely needs when discovery is missing or expensive to repeat
  - do not store full raw `/models` responses, Codex model payloads, or other provider catalog blobs by default
- Prefer recomputing/discovering remote provider state on demand over persisting bulky response payloads in DuckDB.
- If we later need cold debug/audit payload storage, keep it out of the hot live DuckDB path.

## Concrete Checklist

### Schema

- [x] Add `app.provider_connection`.
- [x] Add groundwork columns on `app.model`: `provider_connection_id`, `remote_model_id`, `display_name`, `variant`, `source`, `enabled`, `metadata_json`.
- [x] Backfill existing `app.model` rows into one seeded `app.provider_connection` row per existing model row.
- [x] Seed new model inserts with matching `provider_connection_id`.
- [x] Stop syncing env worker URLs into `app.model.worker_urls`.
- [x] Move runtime reads from model transport columns to provider connections.
- [x] Slim persisted provider/model metadata so `config_json` and `metadata_json` only hold normalized hot-path data, not raw provider payloads.
- [x] Add `NOT NULL` + FK on `app.model.provider_connection_id` after runtime switch.
- [x] Drop old model-level transport/auth columns after phase 2.

### API

- [x] `GET /api/provider-connections` list connections + status snapshot.
- [x] `POST /api/provider-connections` create connection.
- [x] `PATCH /api/provider-connections/:id` edit label, enabled, base URL, config.
- [x] `POST /api/provider-connections/:id/test` test auth + reachability.
- [x] `POST /api/provider-connections/:id/sync-models` discover remote catalog.
- [x] `POST /api/provider-connections/:id/models` add manual model.
- [x] `PATCH /api/models/:id` edit display name, enabled, variant metadata.
- [x] Keep provider-specific auth routes only when transport needs it, e.g. Codex login/status.
- [x] Add generic provider auth lifecycle routes for onboarding.

## Secrets

- [x] Add a `ProviderSecretStore` abstraction.
- Best long term: secrets live in OS keychain / credential store; DuckDB stores only `secret_ref` + non-secret metadata.
- If keychain support is missing on some platform, add encrypted-DB fallback behind the same interface.
- Never keep provider API keys on `app.user_config` or duplicated per `app.model` row.

## Provider Inputs - First Pass

- `openai`: API key, optional base URL, model discovery + manual add.
- `codex`: CLI/app-server auth, status, device login, model discovery incl reasoning variants.
- `docling`: base URL, no secret by default, manual connection for PDF conversion.
- `anthropic`: API key, model discovery + manual add.
- `google`: API key, model discovery + manual add.
- `openrouter`: API key, default OpenRouter base URL, model discovery + manual add.
- `ollama`: base URL, no secret by default, model discovery + manual add fallback.
- `llmstudio`: base URL, no secret by default, model discovery if available, manual add fallback.
- `sglang`: base URL, optional worker/runtime config, model discovery + manual add.
- `vllm`: base URL, optional worker/runtime config, model discovery + manual add.

## GitHub Reference Patterns

- Reviewed `https://github.com/anomalyco/opencode` and `https://github.com/openclaw/openclaw` as the main reference implementations.
- `anomalyco/opencode` pattern:
  - credentials are added through a connect flow and stored separately from provider config
  - provider config is code/config-driven, not mixed into model rows
  - generic provider support comes from transport families plus provider metadata
  - OpenAI-compatible providers are mostly defined by `provider id + baseURL + headers + model catalog`
  - OpenAI-style `/v1/responses` and `/v1/chat/completions` are treated as distinct compatibility modes
- `openclaw/openclaw` pattern:
  - provider plugins own onboarding, auth formatting, auth refresh, dynamic model resolution, request wrapping, and usage/quota fetching
  - auth profiles are separate from model selection and can rotate/fail over independently
  - direct providers (`openai`, `openai-codex`, `anthropic`, `google`) are split from OpenAI-compatible local/proxy providers
  - local providers like `ollama`, `sglang`, and `vllm` are first-class, not hidden behind one generic "other" bucket

## Interaction Families

- Long term, implement provider behavior as `provider policy + transport family`, not one-off route code per provider.
- Transport families to support:
  - `codex-app`: Codex app/CLI auth + Codex app-server execution
  - `openai-responses`: direct OpenAI Responses API
  - `openai-chat`: OpenAI-compatible `/v1/chat/completions`
  - `anthropic-messages`: Anthropic `/v1/messages`
  - `gemini-generate-content`: Google Gemini `models/*:generateContent`
  - `ollama-native-discovery`: Ollama-native model discovery helper
- Provider policy owns:
  - auth onboarding method
  - runtime credential resolution
  - model discovery and normalization
  - request-body quirks and headers
  - usage parsing
  - provider-specific health checks and error hints

## Provider Interaction Details

### `openai`

- Follow the OpenClaw split between direct `openai` and Codex-style auth.
- Auth:
  - primary: API key
  - optional later: subscription/OAuth if OpenAI keeps supporting it for external tools
- Discovery:
  - `GET /v1/models`
  - enrich with our own capability metadata instead of trusting raw discovery for everything
- Invoke:
  - prefer direct OpenAI Responses API for real OpenAI connections
  - keep a compatibility fallback path only where a model/feature still requires it
- Notes:
  - keep `base_url` override support for proxies/gateways
  - keep model params for service tier, reasoning, and future transport toggles

### `codex`

- Follow the OpenClaw `openai-codex` idea and keep it separate from direct OpenAI API auth.
- Auth:
  - ChatGPT/Codex OAuth or installed Codex app/CLI session
  - store a session/token reference, not an API key in the model row
- Discovery:
  - query the Codex app-server / model list endpoint
  - synthesize reasoning-effort variants into separate selectable model rows when needed
- Invoke:
  - use Codex app-server transport, not generic OpenAI-compatible transport
- Notes:
  - Models page must expose login state, device login, and “already connected” handling
  - Codex connection UX should behave more like “connect account/app” than “paste API key”

### `anthropic`

- Follow OpenCode/OpenClaw direct-provider handling, not OpenAI compatibility shims.
- Auth:
  - primary: API key
  - optional later: Claude setup-token / subscription flow only if we explicitly accept the policy risk
- Discovery:
  - `GET /v1/models`
- Invoke:
  - `POST /v1/messages`
  - map our generic prompt/tooling format into Anthropic message blocks
- Notes:
  - keep room for prompt-cache TTL and service-tier options
  - normalize provider-specific tool-use and usage fields in the adapter, not in callers

### `google`

- Follow OpenClaw’s direct `google` provider approach for Gemini API key auth.
- Auth:
  - primary: `GEMINI_API_KEY`
  - later extensions can add separate provider kinds for Vertex or Gemini CLI OAuth if we want them
- Discovery:
  - `GET /v1beta/models`
  - normalize legacy/preview naming so stored model ids stay stable
- Invoke:
  - `POST /v1beta/models/{model}:generateContent`
  - add streaming later with `streamGenerateContent` once the generic runtime is ready
- Notes:
  - adapter owns `systemInstruction`, tool declarations, and Google-specific usage parsing

### `openrouter`

- Follow OpenCode’s preloaded-model + config-override pattern.
- Auth:
  - API key
- Discovery:
  - `GET /api/v1/models`
  - allow provider-specific model metadata overrides in config/db
- Invoke:
  - OpenAI-compatible transport against `https://openrouter.ai/api/v1`
- Notes:
  - keep room for per-model routing options like provider order / fallback control
  - store those routing hints on the model/connection metadata, not as hard-coded route params

### `ollama`

- Combine the two reference patterns:
  - OpenCode proves simple OpenAI-compatible config works well
  - OpenClaw shows Ollama deserves first-class local-provider treatment
- Auth:
  - none by default
- Discovery:
  - prefer native Ollama discovery (`/api/tags`) when available
  - also accept `/v1/models` when the OpenAI bridge is enabled
- Invoke:
  - default to OpenAI-compatible `/v1/chat/completions` for maximum code reuse
  - keep the adapter open to native `/api/chat` later if we need richer Ollama-only features
- Notes:
  - local-provider health check should verify the daemon is reachable, not just model auth

### `llmstudio`

- Follow the OpenCode custom-provider / local-proxy pattern.
- Auth:
  - none by default
- Discovery:
  - `GET /v1/models` if exposed
  - manual model add remains important because local servers are often incomplete here
- Invoke:
  - OpenAI-compatible `/v1/chat/completions`
- Notes:
  - treat this as a first-class local provider in UI, even if runtime shares the generic adapter

### `sglang`

- Follow the OpenClaw local provider plugin pattern.
- Auth:
  - optional API key / bearer token, depending on deployment
- Discovery:
  - `GET /v1/models`
- Invoke:
  - OpenAI-compatible `/v1/chat/completions`
- Notes:
  - connection config should hold worker URLs / load-balancer settings
  - health should check both base endpoint and worker pool state when worker URLs are configured

### `vllm`

- Follow the OpenClaw local provider plugin pattern.
- Auth:
  - optional API key / bearer token, depending on deployment
- Discovery:
  - `GET /v1/models`
- Invoke:
  - OpenAI-compatible `/v1/chat/completions`
- Notes:
  - same worker/runtime config shape as `sglang`
  - keep adapter-level compatibility shims for non-standard OpenAI behavior out of the rest of the runtime

## Long-Term Auth Extension

- The current `provider_connection + secret_ref` direction is still the right base.
- If we later want OpenClaw-style auth rotation/failover, add a separate `app.provider_auth_profile` layer rather than overloading `app.provider_connection`.
- That future table would own:
  - `provider_connection_id`
  - `auth_type` (`api_key`, `oauth`, `setup_token`, etc.)
  - `secret_ref`
  - `email` / account label
  - `cooldown_until`, `disabled_until`, `last_used_at`
- Keep `app.provider_connection` as the stable user-facing connection object; keep auth profiles as an internal execution concern.

## Runtime Architecture

- Replace scattered provider branches like `provider === 'codex'` with one provider registry.
- Provider adapter contract:
  - `beginAuth`
  - `finishAuth`
  - `resolveRuntimeCredentials`
  - `testConnection`
  - `listModels`
  - `addManualModel`
  - `invoke`
  - `parseUsage`
  - `health`
- Shared OpenAI-compatible adapter where possible: `openrouter`, `llmstudio`, `sglang`, `vllm`.
- Dedicated adapters for `openai`, `codex`, `anthropic`, `google`, plus an Ollama-native discovery shim.
- Use Effect: `https://effect.website/`
  - `Layer` / `Context` for registry, connection store, secret store, client factory
  - `Effect.gen` for connect / test / sync flows
  - `Schedule` for retries, polling, health checks
  - `Scope` / `acquireRelease` if a provider needs managed client lifetime

## Current Status

- Done now:
  - provider connections and model linkage schema
  - lean provider/model metadata persistence and cleanup script
  - final `app.model` rebuild to provider-connection-only schema
  - provider registry, repositories, services, and transports
  - explicit adapters for all first-pass providers
  - generic auth lifecycle support with Codex-specific pending login behavior
  - split provider routes (`ProviderConnectionsRoutes`, `ProviderModelsRoutes`)
  - separate add-provider and manage-models UI
  - provider-specific onboarding form extraction
  - route/adaptor/auth focused test coverage
  - end-to-end provider -> model -> project test coverage
- Still left:
  - add fuller rendered UI tests for add-provider/manage-models flows
  - optional future `app.provider_auth_profile` work for rotation/failover

## Adapter / Module Checklist

### Core modules

- [x] `src/server/providers/providerRegistry.ts`
  - register provider policies by `provider_kind`
  - expose one typed lookup point for auth, discovery, invoke, health, and usage
- [x] `src/server/providers/providerTypes.ts`
  - canonical provider contracts and transport-family types
  - normalized request/response/usage/model metadata shapes
- [x] `src/server/providers/providerConnectionRepository.ts`
  - load/save `app.provider_connection`
  - keep DB access separate from adapter logic
- [x] `src/server/providers/providerModelRepository.ts`
  - load/save/sync `app.model`
  - own discovered-vs-manual model upsert rules
- [x] `src/server/providers/providerSecretStore.ts`
  - OS keychain first
  - encrypted fallback later behind same interface
- [x] `src/server/providers/providerAuthService.ts`
  - shared begin/finish auth orchestration
  - provider-specific auth handoff hooks
- [x] `src/server/providers/providerSyncService.ts`
  - run discovery, normalize catalog rows, persist models
  - central place for sync-models jobs and retries
- [x] `src/server/providers/providerInvocationService.ts`
  - resolve provider connection + model + runtime credentials
  - delegate to registry adapter and normalize failures
- [x] `src/server/providers/providerHealthService.ts`
  - standard health/test flow
  - persist `last_checked_at` / `last_error`
- [x] `src/server/providers/providerUsageService.ts`
  - parse provider usage into one internal shape
  - leave provider-specific usage fetching/parsing in adapters when needed

### Shared transport modules

- [x] `src/server/providers/transports/openaiResponsesTransport.ts`
  - direct OpenAI Responses API execution
  - own OpenAI-specific request body, streaming, and usage parsing
- [x] `src/server/providers/transports/openaiChatTransport.ts`
  - shared `/v1/chat/completions` execution for OpenAI-compatible providers
  - support base URL override, headers, and optional auth
- [x] `src/server/providers/transports/anthropicMessagesTransport.ts`
  - shared `POST /v1/messages` execution
  - own Anthropic message-block formatting and usage parsing
- [x] `src/server/providers/transports/geminiGenerateContentTransport.ts`
  - shared Gemini `generateContent` execution
  - own `systemInstruction`, tools, and Gemini-specific usage parsing
- [x] `src/server/providers/transports/codexAppTransport.ts`
  - Codex app/CLI login-state checks
  - Codex app-server invocation and model listing

### Adapter modules

- [x] `src/server/providers/adapters/openaiAdapter.ts`
  - auth: API key first
  - discovery: `GET /v1/models`
  - invoke: `openaiResponsesTransport`
  - health: direct OpenAI auth + endpoint reachability
- [x] `src/server/providers/adapters/codexAdapter.ts`
  - auth: OAuth / Codex app session
  - discovery: Codex app-server model list + reasoning variants
  - invoke: `codexAppTransport`
  - health: CLI installed, logged in, app-server ready
- [x] `src/server/providers/adapters/anthropicAdapter.ts`
  - auth: API key
  - discovery: `GET /v1/models`
  - invoke: `anthropicMessagesTransport`
  - health: auth + endpoint reachability
- [x] `src/server/providers/adapters/googleAdapter.ts`
  - auth: `GEMINI_API_KEY`
  - discovery: `GET /v1beta/models`
  - invoke: `geminiGenerateContentTransport`
  - health: auth + endpoint reachability
- [x] `src/server/providers/adapters/openrouterAdapter.ts`
  - auth: API key
  - discovery: `GET /api/v1/models`
  - invoke: `openaiChatTransport`
  - own OpenRouter routing metadata normalization
- [x] `src/server/providers/adapters/ollamaAdapter.ts`
  - auth: none by default
  - discovery: prefer `/api/tags`, fallback `/v1/models`
  - invoke: `openaiChatTransport`
  - health: daemon reachability + local model availability
- [x] `src/server/providers/adapters/llmstudioAdapter.ts`
  - auth: none by default
  - discovery: `/v1/models` when available
  - invoke: `openaiChatTransport`
  - manual-model path stays first-class
- [x] `src/server/providers/adapters/sglangAdapter.ts`
  - auth: optional bearer/API key
  - discovery: `/v1/models`
  - invoke: `openaiChatTransport`
  - health: endpoint + worker/runtime config checks
- [x] `src/server/providers/adapters/vllmAdapter.ts`
  - auth: optional bearer/API key
  - discovery: `/v1/models`
  - invoke: `openaiChatTransport`
  - health: endpoint + worker/runtime config checks

### Provider interaction checklist by provider

- [x] `openai`
  - add direct API-key connect flow
  - use direct OpenAI discovery
  - use Responses transport, not generic OpenAI-compatible by default
- [x] `codex`
  - add login-status + device-login + create-connection flow
  - split account/app connection from model add/sync
  - synthesize reasoning variants during discovery
- [x] `anthropic`
  - add API-key connect flow
  - support direct model discovery and messages execution
- [x] `google`
  - add Gemini API-key connect flow
  - normalize preview model names so stored ids stay stable
- [x] `openrouter`
  - add API-key connect flow
  - support model discovery plus per-model routing metadata
- [x] `ollama`
  - add local-daemon connect flow
  - prefer native discovery over generic `/v1/models`
- [x] `llmstudio`
  - add local-endpoint connect flow
  - support discovery when exposed, manual add when not
- [x] `sglang`
  - add endpoint + worker/runtime config flow
  - keep worker config on provider connection, never on model rows
- [x] `vllm`
  - add endpoint + worker/runtime config flow
  - keep worker config on provider connection, never on model rows

### API / route modules

- [x] `src/server/routes/ProviderConnectionsRoutes.ts`
  - list/create/edit/test/remove connections
- [x] `src/server/routes/ProviderModelsRoutes.ts`
  - sync discovered models
  - add manual model rows
  - edit enable/display metadata
- [x] keep provider-specific routes only for auth flows that genuinely need them
  - Codex login/status is the first example

### UI modules

- [x] `src/app/routes/+providers/+index.tsx`
  - provider management list
- [x] `src/app/routes/+providers/+add-provider.tsx`
  - provider onboarding only
- [x] `src/app/routes/+providers/+$id/+index.tsx`
  - provider detail + model management
- [x] `src/app/routes/+admin/+models/providerConnectionsClient.ts`
  - shared client-side provider API helpers and catalog labels
- [x] provider-specific UI fragments under `src/app/routes/+admin/+models/`
  - `openaiProviderForm.tsx`
  - `codexProviderForm.tsx`
  - `anthropicProviderForm.tsx`
  - `googleProviderForm.tsx`
  - `openAICompatibleProviderForm.tsx`

### Tests

- [x] `src/server/providers/*.test.ts`
  - transport-level success/error normalization
- [x] adapter tests per direct provider
  - `openaiAdapter.test.ts`
  - `codexAdapter.test.ts`
  - `anthropicAdapter.test.ts`
  - `googleAdapter.test.ts`
- [x] shared compatibility tests for local/proxy providers
  - `openrouterAdapter.test.ts`
  - `ollamaAdapter.test.ts`
  - `llmstudioAdapter.test.ts`
  - `sglangAdapter.test.ts`
  - `vllmAdapter.test.ts`
- [x] route tests for connect / sync / manual add / disable / remove
- [ ] UI tests for:
  - add-provider flow
  - Codex already-connected state
  - separate provider-vs-model actions

## Recommended Implementation Order

### 0. Lock the contracts first

- Build first:
  - `providerTypes.ts`
  - `providerRegistry.ts`
  - repository interfaces
  - normalized request/model/usage shapes
- Why first:
  - every adapter, route, and UI call depends on the same stable provider contract
- Dependency:
  - phase-1 schema groundwork must already exist

### 1. Build the shared provider infrastructure

- Build next:
  - `providerConnectionRepository.ts`
  - `providerModelRepository.ts`
  - `providerSecretStore.ts`
  - `providerAuthService.ts`
  - `providerHealthService.ts`
  - `providerSyncService.ts`
  - `providerInvocationService.ts`
  - `providerUsageService.ts`
- Why next:
  - adapters should plug into stable orchestration services, not each own DB and secret logic
- Dependency:
  - step 0

### 2. Build the shared transports

- Build next:
  - `openaiChatTransport.ts`
  - `openaiResponsesTransport.ts`
  - `anthropicMessagesTransport.ts`
  - `geminiGenerateContentTransport.ts`
  - `codexAppTransport.ts`
- Why next:
  - this isolates protocol quirks before provider-specific adapters are added
- Dependency:
  - steps 0-1

### 3. Build the direct-provider adapters first

- Build in this order:
  1. `codexAdapter.ts`
  2. `openaiAdapter.ts`
  3. `anthropicAdapter.ts`
  4. `googleAdapter.ts`
- Why this order:
  - `codex` is the least like the others and forces the auth/runtime split early
  - `openai` establishes the direct OpenAI path distinct from generic OpenAI-compatible providers
  - `anthropic` and `google` validate the non-OpenAI transports
- Dependency:
  - steps 0-2

### 4. Build the OpenAI-compatible adapter family

- Build in this order:
  1. `openrouterAdapter.ts`
  2. `ollamaAdapter.ts`
  3. `llmstudioAdapter.ts`
  4. `sglangAdapter.ts`
  5. `vllmAdapter.ts`
- Why this order:
  - `openrouter` proves remote OpenAI-compatible behavior
  - `ollama` proves first-class local-provider treatment with native discovery
  - `llmstudio` proves local manual/discovery hybrid behavior
  - `sglang` and `vllm` extend the same transport with runtime/worker config
- Dependency:
  - steps 0-2
  - step 3 is strongly recommended before this, but not strictly required for all providers

### 5. Cut server routes over to the new provider layer

- Build next:
  - `ProviderConnectionsRoutes.ts`
  - `ProviderModelsRoutes.ts`
  - thin Codex auth/status routes where still needed
- Route order:
  1. list/create/edit/test provider connections
  2. sync discovered models
  3. add manual models
  4. enable/disable/edit/remove
- Why next:
  - this gives the UI one clean API surface while runtime cutover is still in progress
- Dependency:
  - steps 0-4

### 6. Build UI in two separate tracks

- Track A: provider onboarding
  - `+add-provider.tsx`
  - provider-specific onboarding forms
  - Codex login/account-state UX
- Track B: provider/model management
  - `+index.tsx`
  - existing connection editing
  - model sync/manual add/toggle/edit
- Why split it:
  - adding providers and adding models are separate user actions and should stay separate in code too
- Dependency:
  - step 5

### 7. Cut runtime execution fully to provider services

- Move all execution paths to:
  - `providerInvocationService.ts`
  - provider registry lookup
  - runtime credential resolution via provider connection
- Include:
  - judgment execution
  - provider-specific health/usage reads
  - remaining non-runtime model display queries
- Why here:
  - by this point adapters and route surfaces exist, so runtime can safely stop depending on legacy model-level transport fields
- Dependency:
  - steps 0-5

### 8. Remove legacy assumptions

- Remove only after step 7 is complete:
  - old settings-page Codex UI
  - old raw-table assumptions
  - scattered `provider === 'codex'` branches
  - model-level transport/auth columns that are no longer read
- DB cleanup order:
  1. verify all reads use `provider_connection`
  2. add FK / `NOT NULL` on `provider_connection_id`
  3. drop legacy columns
- Dependency:
  - step 7

### 9. Lock the behavior with tests

- Test order:
  1. transport tests
  2. direct-provider adapter tests
  3. OpenAI-compatible adapter tests
  4. route tests
  5. UI tests
  6. end-to-end provider -> model -> project flow
- Why last:
  - some tests can be written earlier, but the most stable and least wasteful point is after route/runtime shapes stop moving
- Dependency:
  - steps 0-8

## Parallel Work Guidance

- Can be done in parallel after step 0:
  - repository/service scaffolding
  - shared transports
- Can be done in parallel after step 2:
  - `anthropicAdapter.ts`
  - `googleAdapter.ts`
  - `openrouterAdapter.ts`
- Should stay mostly sequential:
  - `codexAdapter.ts` before final Codex UI polish
  - runtime cutover before destructive schema cleanup
  - provider routes before the final admin UI split is considered done

## Phase 2 Execution Checklist

### Ticket 1 - Lock provider contracts

- [x] Add `providerTypes.ts`
- [x] Add `providerRegistry.ts`
- [x] Freeze normalized connection/model/invoke/usage shapes

### Ticket 2 - Extract provider infrastructure

- [x] Add provider connection/model repositories
- [x] Add secret/auth/health/sync/invocation/usage services
- [x] Route current provider DB access through these services

### Ticket 3 - Build shared transports

- [x] Add `openaiResponsesTransport.ts`
- [x] Add `openaiChatTransport.ts`
- [x] Add `anthropicMessagesTransport.ts`
- [x] Add `geminiGenerateContentTransport.ts`
- [x] Add `codexAppTransport.ts`

### Ticket 4 - Finish direct-provider adapters

- [x] Implement `codexAdapter.ts`
- [x] Implement `openaiAdapter.ts`
- [x] Implement `anthropicAdapter.ts`
- [x] Implement `googleAdapter.ts`

### Ticket 5 - Finish OpenAI-compatible adapters

- [x] Implement `openrouterAdapter.ts`
- [x] Implement `ollamaAdapter.ts`
- [x] Implement `llmstudioAdapter.ts`
- [x] Implement `sglangAdapter.ts`
- [x] Implement `vllmAdapter.ts`

### Ticket 6 - Cut API routes to provider services

- [x] Add/finish provider connection routes
- [x] Add/finish provider model routes
- [x] Keep only truly provider-specific auth routes outside the generic surface

### Ticket 7 - Cut runtime to provider registry

- [x] Route judgment execution through `providerInvocationService.ts`
- [x] Resolve runtime credentials from provider connection, not model row
- [x] Route health/usage reads through provider services everywhere for the current runtime path.

### Ticket 8 - Finish provider UI split

- [x] Keep add-provider onboarding separate from model management
- [x] Add provider-specific form fragments
- [ ] Move remaining provider/model actions off the legacy `/api/models/*` bridge

### Ticket 9 - Remove legacy assumptions

- [x] Remove remaining legacy model-level transport/auth reads
- [x] Replace raw provider/model metadata persistence with lean normalized fields only
- [x] Add FK / `NOT NULL` on `provider_connection_id`
- [x] Drop obsolete model-level transport/auth columns

### Ticket 10 - Lock with tests

- [x] Transport tests
- [x] Adapter tests
- [x] Route tests
- [ ] UI tests
- [x] End-to-end provider -> model -> project test

### Definition of done for Phase 2

- [x] Every supported provider resolves through the registry
- [x] Runtime no longer depends on legacy model transport/auth fields.
- [x] Provider persistence follows the lean hot-DB rule: no raw provider catalog payloads or runtime-discovery blobs stored by default.
- [x] Provider connect/test/sync/manual-add all run through shared services
- [x] Add-provider and model-management flows remain separate in UI and API

## Providers Page UX

- `src/app/routes/+providers/+index.tsx` is the provider-first management page.
- Provider onboarding now lives on `src/app/routes/+providers/+add-provider.tsx`.
- `src/app/routes/+providers/+$id/+index.tsx` is the detail page for one connection and its models.
- Connected providers section:
  - label
  - provider kind
  - enabled state
  - connection status
  - base URL
  - last check
  - actions: edit, test, sync models, disable, remove
- Provider detail panel:
  - provider-specific form
  - secret entry / update
  - test connection
  - sync discovery
  - manual model add
- Models section:
  - group by provider connection
  - show discovered vs manual
  - enable / disable per model
  - show remote model id + variant
- Codex connect UX now lives on provider pages, not settings.
- Keep raw debug data, if needed, as a secondary admin panel. Not the primary UI.

## API Surface

- `GET /api/provider-connections`
- `POST /api/provider-connections`
- `PATCH /api/provider-connections/:id`
- `POST /api/provider-connections/:id/test`
- `POST /api/provider-connections/:id/sync-models`
- `POST /api/provider-connections/:id/models` for manual add
- `PATCH /api/models/:id`
- Keep provider-specific routes only where transport needs it, e.g. Codex login/status.
- Legacy bridge still exists for now: `/api/models/codex/*`, `/api/models/ensure`.

## Phases

### 1. Schema reset

- Add `app.provider_connection`.
- Reshape `app.model` around `provider_connection_id`.
- Seed one provider-connection row per existing model row first.
- Stop env-to-model sync paths.
- Defer destructive column drops until runtime reads no longer depend on old fields.

### 2. Server/runtime

- Add provider registry + adapters.
- Add secret-store abstraction.
- Add connect/test/sync/manual-add server flows.
- Migrate judgment execution to resolve a model through its provider connection.

### 3. UI

- Rebuild provider UI around `src/app/routes/+providers/+index.tsx` and `src/app/routes/+providers/+$id/+index.tsx`.
- Move Codex login there.
- Add provider forms, status, sync, manual add, model toggles.

### 4. Cleanup

- Delete old raw-table assumptions.
- Delete old settings-page Codex section.
- Remove scattered provider special-casing where registry handles it.

### 5. Tests

- Add coverage for connect, edit, test, sync, manual model add, enable/disable.
- Add provider adapter tests for OpenAI-compatible, Codex, Anthropic, Google.
- Add end-to-end test: connect provider -> sync/add model -> create project with model.

## Done When

- A user can add any supported provider from the add-provider flow and then manage it from the Providers page.
- One provider connection can expose many models without duplicated auth/config.
- Projects still pick one `app.model` row.
- Provider auth/config is not stored on user config or repeated on models.
- Provider logic is centralized behind provider adapters/services.
