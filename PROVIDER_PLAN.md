# Provider Plan

## Goal

- Add first-class provider support like OpenCode / OpenClaw / Hermes Agent.
- First pass providers: `openai`, `codex`, `anthropic`, `google`, `openrouter`, `ollama`, `llmstudio`, `sglang`, `vllm`.
- Replace the raw table view on `src/app/routes/+admin/+models/+index.tsx` with real connect / enable / add flows.
- Do a clean break. No backwards-compat layer.

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

## Concrete Checklist

### Schema

- [x] Add `app.provider_connection`.
- [x] Add groundwork columns on `app.model`: `provider_connection_id`, `remote_model_id`, `display_name`, `variant`, `source`, `enabled`, `metadata_json`.
- [x] Backfill existing `app.model` rows into one seeded `app.provider_connection` row per existing model row.
- [x] Seed new model inserts with matching `provider_connection_id`.
- [x] Stop syncing env worker URLs into `app.model.worker_urls`.
- [ ] Move runtime reads from model transport columns to provider connections.
- [ ] Add `NOT NULL` + FK on `app.model.provider_connection_id` after runtime switch.
- [ ] Drop old model-level transport/auth columns after phase 2.

### API

- [ ] `GET /api/provider-connections` list connections + status snapshot.
- [ ] `POST /api/provider-connections` create connection.
- [ ] `PATCH /api/provider-connections/:id` edit label, enabled, base URL, config.
- [ ] `POST /api/provider-connections/:id/test` test auth + reachability.
- [ ] `POST /api/provider-connections/:id/sync-models` discover remote catalog.
- [ ] `POST /api/provider-connections/:id/models` add manual model.
- [ ] `PATCH /api/models/:id` edit display name, enabled, variant metadata.
- [ ] Keep provider-specific auth routes only when transport needs it, e.g. Codex login/status.

## Secrets

- Add a `ProviderSecretStore` abstraction.
- Best long term: secrets live in OS keychain / credential store; DuckDB stores only `secret_ref` + non-secret metadata.
- If keychain support is missing on some platform, add encrypted-DB fallback behind the same interface.
- Never keep provider API keys on `app.user_config` or duplicated per `app.model` row.

## Provider Inputs - First Pass

- `openai`: API key, optional base URL, model discovery + manual add.
- `codex`: CLI/app-server auth, status, device login, model discovery incl reasoning variants.
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

## Adapter / Module Checklist

### Core modules

- [ ] `src/server/providers/providerRegistry.ts`
  - register provider policies by `provider_kind`
  - expose one typed lookup point for auth, discovery, invoke, health, and usage
- [ ] `src/server/providers/providerTypes.ts`
  - canonical provider contracts and transport-family types
  - normalized request/response/usage/model metadata shapes
- [ ] `src/server/providers/providerConnectionRepository.ts`
  - load/save `app.provider_connection`
  - keep DB access separate from adapter logic
- [ ] `src/server/providers/providerModelRepository.ts`
  - load/save/sync `app.model`
  - own discovered-vs-manual model upsert rules
- [ ] `src/server/providers/providerSecretStore.ts`
  - OS keychain first
  - encrypted fallback later behind same interface
- [ ] `src/server/providers/providerAuthService.ts`
  - shared begin/finish auth orchestration
  - provider-specific auth handoff hooks
- [ ] `src/server/providers/providerSyncService.ts`
  - run discovery, normalize catalog rows, persist models
  - central place for sync-models jobs and retries
- [ ] `src/server/providers/providerInvocationService.ts`
  - resolve provider connection + model + runtime credentials
  - delegate to registry adapter and normalize failures
- [ ] `src/server/providers/providerHealthService.ts`
  - standard health/test flow
  - persist `last_checked_at` / `last_error`
- [ ] `src/server/providers/providerUsageService.ts`
  - parse provider usage into one internal shape
  - leave provider-specific usage fetching/parsing in adapters when needed

### Shared transport modules

- [ ] `src/server/providers/transports/openaiResponsesTransport.ts`
  - direct OpenAI Responses API execution
  - own OpenAI-specific request body, streaming, and usage parsing
- [ ] `src/server/providers/transports/openaiChatTransport.ts`
  - shared `/v1/chat/completions` execution for OpenAI-compatible providers
  - support base URL override, headers, and optional auth
- [ ] `src/server/providers/transports/anthropicMessagesTransport.ts`
  - shared `POST /v1/messages` execution
  - own Anthropic message-block formatting and usage parsing
- [ ] `src/server/providers/transports/geminiGenerateContentTransport.ts`
  - shared Gemini `generateContent` execution
  - own `systemInstruction`, tools, and Gemini-specific usage parsing
- [ ] `src/server/providers/transports/codexAppTransport.ts`
  - Codex app/CLI login-state checks
  - Codex app-server invocation and model listing

### Adapter modules

- [ ] `src/server/providers/adapters/openaiAdapter.ts`
  - auth: API key first
  - discovery: `GET /v1/models`
  - invoke: `openaiResponsesTransport`
  - health: direct OpenAI auth + endpoint reachability
- [ ] `src/server/providers/adapters/codexAdapter.ts`
  - auth: OAuth / Codex app session
  - discovery: Codex app-server model list + reasoning variants
  - invoke: `codexAppTransport`
  - health: CLI installed, logged in, app-server ready
- [ ] `src/server/providers/adapters/anthropicAdapter.ts`
  - auth: API key
  - discovery: `GET /v1/models`
  - invoke: `anthropicMessagesTransport`
  - health: auth + endpoint reachability
- [ ] `src/server/providers/adapters/googleAdapter.ts`
  - auth: `GEMINI_API_KEY`
  - discovery: `GET /v1beta/models`
  - invoke: `geminiGenerateContentTransport`
  - health: auth + endpoint reachability
- [ ] `src/server/providers/adapters/openrouterAdapter.ts`
  - auth: API key
  - discovery: `GET /api/v1/models`
  - invoke: `openaiChatTransport`
  - own OpenRouter routing metadata normalization
- [ ] `src/server/providers/adapters/ollamaAdapter.ts`
  - auth: none by default
  - discovery: prefer `/api/tags`, fallback `/v1/models`
  - invoke: `openaiChatTransport`
  - health: daemon reachability + local model availability
- [ ] `src/server/providers/adapters/llmstudioAdapter.ts`
  - auth: none by default
  - discovery: `/v1/models` when available
  - invoke: `openaiChatTransport`
  - manual-model path stays first-class
- [ ] `src/server/providers/adapters/sglangAdapter.ts`
  - auth: optional bearer/API key
  - discovery: `/v1/models`
  - invoke: `openaiChatTransport`
  - health: endpoint + worker/runtime config checks
- [ ] `src/server/providers/adapters/vllmAdapter.ts`
  - auth: optional bearer/API key
  - discovery: `/v1/models`
  - invoke: `openaiChatTransport`
  - health: endpoint + worker/runtime config checks

### Provider interaction checklist by provider

- [ ] `openai`
  - add direct API-key connect flow
  - use direct OpenAI discovery
  - use Responses transport, not generic OpenAI-compatible by default
- [ ] `codex`
  - add login-status + device-login + create-connection flow
  - split account/app connection from model add/sync
  - synthesize reasoning variants during discovery
- [ ] `anthropic`
  - add API-key connect flow
  - support direct model discovery and messages execution
- [ ] `google`
  - add Gemini API-key connect flow
  - normalize preview model names so stored ids stay stable
- [ ] `openrouter`
  - add API-key connect flow
  - support model discovery plus per-model routing metadata
- [ ] `ollama`
  - add local-daemon connect flow
  - prefer native discovery over generic `/v1/models`
- [ ] `llmstudio`
  - add local-endpoint connect flow
  - support discovery when exposed, manual add when not
- [ ] `sglang`
  - add endpoint + worker/runtime config flow
  - keep worker config on provider connection, never on model rows
- [ ] `vllm`
  - add endpoint + worker/runtime config flow
  - keep worker config on provider connection, never on model rows

### API / route modules

- [ ] `src/server/routes/ProviderConnectionsRoutes.ts`
  - list/create/edit/test/remove connections
- [ ] `src/server/routes/ProviderModelsRoutes.ts`
  - sync discovered models
  - add manual model rows
  - edit enable/display metadata
- [ ] keep provider-specific routes only for auth flows that genuinely need them
  - Codex login/status is the first example

### UI modules

- [ ] `src/app/routes/+admin/+models/+index.tsx`
  - provider management + model management for existing connections
- [ ] `src/app/routes/+admin/+models/+add-provider.tsx`
  - provider onboarding only
- [ ] `src/app/routes/+admin/+models/providerConnectionsClient.ts`
  - shared client-side provider API helpers and catalog labels
- [ ] provider-specific UI fragments under `src/app/routes/+admin/+models/`
  - `openaiProviderForm.tsx`
  - `codexProviderForm.tsx`
  - `anthropicProviderForm.tsx`
  - `googleProviderForm.tsx`
  - `openAICompatibleProviderForm.tsx`

### Tests

- [ ] `src/server/providers/*.test.ts`
  - transport-level success/error normalization
- [ ] adapter tests per direct provider
  - `openaiAdapter.test.ts`
  - `codexAdapter.test.ts`
  - `anthropicAdapter.test.ts`
  - `googleAdapter.test.ts`
- [ ] shared compatibility tests for local/proxy providers
  - `openrouterAdapter.test.ts`
  - `ollamaAdapter.test.ts`
  - `llmstudioAdapter.test.ts`
  - `sglangAdapter.test.ts`
  - `vllmAdapter.test.ts`
- [ ] route tests for connect / sync / manual add / disable / remove
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

- [ ] Add `providerTypes.ts`
- [ ] Add `providerRegistry.ts`
- [ ] Freeze normalized connection/model/invoke/usage shapes

### Ticket 2 - Extract provider infrastructure

- [ ] Add provider connection/model repositories
- [ ] Add secret/auth/health/sync/invocation/usage services
- [ ] Route current provider DB access through these services

### Ticket 3 - Build shared transports

- [ ] Add `openaiResponsesTransport.ts`
- [ ] Add `openaiChatTransport.ts`
- [ ] Add `anthropicMessagesTransport.ts`
- [ ] Add `geminiGenerateContentTransport.ts`
- [ ] Add `codexAppTransport.ts`

### Ticket 4 - Finish direct-provider adapters

- [ ] Implement `codexAdapter.ts`
- [ ] Implement `openaiAdapter.ts`
- [ ] Implement `anthropicAdapter.ts`
- [ ] Implement `googleAdapter.ts`

### Ticket 5 - Finish OpenAI-compatible adapters

- [ ] Implement `openrouterAdapter.ts`
- [ ] Implement `ollamaAdapter.ts`
- [ ] Implement `llmstudioAdapter.ts`
- [ ] Implement `sglangAdapter.ts`
- [ ] Implement `vllmAdapter.ts`

### Ticket 6 - Cut API routes to provider services

- [ ] Add/finish provider connection routes
- [ ] Add/finish provider model routes
- [ ] Keep only truly provider-specific auth routes outside the generic surface

### Ticket 7 - Cut runtime to provider registry

- [ ] Route judgment execution through `providerInvocationService.ts`
- [ ] Resolve runtime credentials from provider connection, not model row
- [ ] Route health/usage reads through provider services

### Ticket 8 - Finish admin UI split

- [ ] Keep add-provider onboarding separate from model management
- [ ] Add provider-specific form fragments
- [ ] Make all existing provider/model actions use the new route surface only

### Ticket 9 - Remove legacy assumptions

- [ ] Remove remaining legacy model-level transport/auth reads
- [ ] Add FK / `NOT NULL` on `provider_connection_id`
- [ ] Drop obsolete model-level transport/auth columns

### Ticket 10 - Lock with tests

- [ ] Transport tests
- [ ] Adapter tests
- [ ] Route tests
- [ ] UI tests
- [ ] End-to-end provider -> model -> project test

### Definition of done for Phase 2

- [ ] Every supported provider resolves through the registry
- [ ] Runtime no longer depends on legacy model transport/auth fields
- [ ] Provider connect/test/sync/manual-add all run through shared services
- [ ] Add-provider and model-management flows remain separate in UI and API

## Models Page UX

- Repurpose `src/app/routes/+admin/+models/+index.tsx` into a provider-first page.
- Top section: provider catalog cards with `Connect` / `Add` actions.
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
- Move the existing Codex connect UI from `src/app/routes/+settings/+index.tsx` into this page.
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

- Rebuild `src/app/routes/+admin/+models/+index.tsx` around provider management.
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

- A user can add any supported provider from the Models page.
- One provider connection can expose many models without duplicated auth/config.
- Projects still pick one `app.model` row.
- Provider auth/config is not stored on user config or repeated on models.
- Provider logic is centralized behind Effect-powered adapters.
