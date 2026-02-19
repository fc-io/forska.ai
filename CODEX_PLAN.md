# Codex Local Provider

## Options

- B (Recommend): Codex models listed via API (not from DB); DB only stores chosen model on demand
- C: runner impl: `@openai/codex-sdk` vs spawn `codex exec` vs `codex app-server` (JSON-RPC)

## Plan (B + runner=C; start w/ SDK)

### 1) Dependencies / prereqs

- Add deps: `@openai/codex-sdk` (+ `@openai/codex` if not pulled in)
- User prereq: run `codex login` once (ChatGPT OAuth / device auth)

### 2) Model catalog (no sync)

- Add server-side static catalog: codex model ids + labels
- Add `GET /api/codex/models`: return catalog (UI dropdown)
- Add `POST /api/codex/models/ensure`: upsert ONE selected codex model into `models` table, return `{modelId}`
- Add `GET /api/codex/status`: “Codex usable?” (CLI present + logged in)

Files

- `src/server/routes/CodexRoutes.ts` (new)
- `src/server/index.ts` register route

### 3) UI: show Codex models like other models

- Keep `GET /api/models` for HPC models
- Add provider toggle: `HPC` vs `Codex`
- If `Codex`: load `GET /api/codex/models`, store selected codex model id (string)
- On submit: if `Codex`, call `POST /api/codex/models/ensure` then call existing `POST /api/projects` with returned `modelId`

Files

- `src/app/routes/+projects/+create.tsx`
- `src/app/routes/+projects/+create-subproject.tsx`
- `src/app/routes/+projects/+$id/+edit.tsx`

### 4) Job runner: allow Codex jobs to run

- `src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts`
  - include `models.provider=="codex"` jobs regardless of `env.SGLANG_MODEL`
  - keep current `env.SGLANG_MODEL` gating for non-codex models
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts`
  - carry `models.provider`
  - allow `models.baseURL` null when provider=`codex` and set placeholder `modelBaseUrl="codex://local"`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
  - pass provider through to judging
- `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`
  - ignore provider=`codex` (no SGLang metrics)

### 5) Judging: branch provider => Codex runner vs HPC baseURL

- Extend `ModelConfigInput` to include `provider`
- In `src/agent/judge.ts`:
  - non-codex: keep current `/v1/chat/completions`
  - codex: call runner
    - `read-only` sandbox, approvals off, web search off
    - `outputSchema` => strict JSON (`SinglePromptJudgmentResult`)
    - if not logged in: throw `ConnectionError` (requeue)

### 6) Verify

- Manual: `codex login` -> sync models -> create project selecting codex -> start judgments job -> confirm `judgments` rows insert
- Regression: ensure non-codex models still run via existing HPC baseURL flow

## Notes

- Runner details: see Option C (SDK persists `~/.codex/sessions`; `--ephemeral` avoids it; app-server is long-lived JSON-RPC but more work/experimental)
