# Codex app-server (local)

Decision

- UI lists Codex + HPC models via `GET /api/models` (combined)
- DB only stores selected Codex model (for `projects.modelId` FK)
- Judging uses `codex app-server` JSON-RPC (no SDK, no `codex exec`)

Prereqs

- OpenAI Codex CLI installed (must support `codex app-server`)
- optional: `CODEX_BIN` env var to point at the right `codex`
- user runs `codex login`

Plan

1. app-server client (server)

- spawn `codex app-server` (stdio JSONL)
- `initialize` once; set `optOutNotificationMethods` to drop deltas
- always force a safe turn config: `cwd` empty dir, `sandboxPolicy.type="workspaceWrite"` (writableRoots only that dir), `networkAccess:false`, `approvalPolicy:"unlessTrusted"`
- handle server->client JSON-RPC _requests_ for approvals; always `decline`
- helper: `modelList()` => `model/list`
- helper: `runJsonTurn({model,input,outputSchema})` => `thread/start` + `turn/start`, collect final `agentMessage.text`

2. routes

- `GET /api/models`
  - returns DB HPC models + Codex models from app-server as virtual ids `codex:<modelName>`
  - includes DB Codex models (also as `codex:<modelName>`) as fallback if app-server is unavailable
- `POST /api/models/ensure`
  - input: `{provider:"codex", modelName: string, name: string}`
  - insert if missing (no real upsert): dedupe by `ownerId + provider + modelName`
  - must set `models.name` (notNull) + `ownerId` + `provider:"codex"` + `modelName` + `baseURL:null`

3. UI

- all model selects use one list from `GET /api/models` (no toggle)
- if selected model has `provider=="codex"`: call `POST /api/models/ensure` before submitting, then use returned UUID `modelId`

4. judging

- extend `ModelConfigInput` with `provider` + `codexModelId`
- `provider!="codex"`: keep current OpenAI-compatible baseURL path
- `provider=="codex"`: call app-server client `runJsonTurn` w/ `outputSchema` for `SinglePromptJudgmentResult`
- on app-server error / not logged in: throw `ConnectionError` (requeue)

5. jobs

- cron runs when `RUN_SERVER_JUDGING=true` (no SGLANG_MODEL gate)
- split running jobs: `provider=="codex"` vs non-codex
- non-codex path keeps current `env.SGLANG_MODEL` filtering + capacity
- codex path:
  - `getAndUpdateReadyPrompts` must carry `models.provider`; allow `models.baseURL` null; skip `workerLoadBalancer`
  - set placeholder `modelBaseUrl="codex://app-server"` for logging/circuit keys
  - enforce concurrency before marking prompts `sent`: `CODEX_MAX_INFLIGHT` (default 1) using count of `sent` prompts for codex jobs

Verify

- `codex login`
- create project (Codex model) + start judgments job
- confirm `judgments` rows insert; codex jobs dont touch `llm_status`
