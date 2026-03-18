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

## Runtime Architecture

- Replace scattered provider branches like `provider === 'codex'` with one provider registry.
- Provider adapter contract:
  - `testConnection`
  - `listModels`
  - `addManualModel`
  - `invoke`
  - `health`
- Shared OpenAI-compatible adapter where possible: `openai`, `openrouter`, `ollama`, `llmstudio`, `sglang`, `vllm`.
- Dedicated adapters for `codex`, `anthropic`, `google`.
- Use Effect: `https://effect.website/`
  - `Layer` / `Context` for registry, connection store, secret store, client factory
  - `Effect.gen` for connect / test / sync flows
  - `Schedule` for retries, polling, health checks
  - `Scope` / `acquireRelease` if a provider needs managed client lifetime

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
