# EFFECT_PLAN_FOR_JUDGING

- Goal: durable, inspectable judging. One business run. One append-only step log. One final judgment.
- Flow: `queue row -> snapshots -> judgingRun -> buildPrompt -> fitsContext ? singleRequest : chunkPlan -> chunkEvidence[] -> finalSynthesis -> parseJudgment -> persistJudgment -> finishRun`
- Rule: write `started` before work. Write `succeeded` / `failed` / `interrupted` after work. Crashes stay visible.

## Core model

- `judging_runs`: one logical execution for `articleId + promptId + modelId + contentSettings`. Rerun = new row.
- `judging_steps`: one execution of one named step. Retries reuse `stepKey` and increment `attemptNumber`.
- `judgments`: final output. Add `judgmentRunId`.

## Keep / drop

- Keep request kinds: `singleRequest`, `chunkEvidence`, `finalSynthesis`.
- Keep Effect if wanted.
- Drop `judging_stages`.
- Drop `judging_attempts`.
- Drop `judging_artifacts`.
- Treat token summaries, failed-request pages, metrics, traces, admin views as projections from `judging_runs` + `judging_steps`.

## Step kinds

- `prepareRun`
- `buildPrompt`
- `chunkPlan`
- `singleRequest`
- `chunkEvidence`
- `finalSynthesis`
- `parseJudgment`
- `persistJudgment`

## judging_runs

- One row per logical execution.
- Cols:
  - `jobId`, `jobPromptId`
  - `articleId`, `promptId`, `projectId`, `modelId`
  - `useTitle`, `useAbstract`, `useFulltext`, `useFulltextNoImages`
  - `status`, `chunkingStrategy`, `chunkCount`
  - `articleSnapshotJson`, `promptSnapshotJson`
  - `startedAt`, `finishedAt`
  - `finalJudgmentId`, `winningStepId`
  - `errorStep`, `errorTag`, `errorMessage`, `errorJson`
- Indexes:
  - `(jobId, articleId, promptId)`
  - `(status, startedAt)`
  - `(articleId, promptId, modelId, useTitle, useAbstract, useFulltext, useFulltextNoImages)`

## judging_steps

- One row per executed step.
- Same logical step retried = same `stepKey`, higher `attemptNumber`.
- `stepKey` examples: `singleRequest`, `chunkEvidence:0`, `chunkEvidence:1`, `finalSynthesis`, `parseJudgment`.
- Cols:
  - `runId`
  - `kind`, `stepKey`, `attemptNumber`
  - `chunkIndex`, `chunkCount`
  - `provider`, `baseURL`, `modelName`, `modelVersion`
  - `status`, `startedAt`, `finishedAt`
  - `promptTokens`, `completionTokens`, `totalTokens`, `usageJson`
  - `requestJson`, `responseJson`
  - `errorTag`, `errorMessage`, `errorJson`, `causeJson`
- Notes:
  - LLM calls live here.
  - Parse / quote validation / persist failures also live here.
  - Prompt / response / evidence payloads live here first. External blob storage only if size later forces it.
- Indexes:
  - `(runId, kind, chunkIndex, attemptNumber)`
  - `(runId, stepKey, attemptNumber)`
  - `(status, startedAt)`
  - `(baseURL, startedAt)`

## judgments

- Add `judgmentRunId` FK.
- Keep content-settings + model provenance on `judgments`.
- Final row points back to the run that produced it.

## Effect shape

- Use `Effect` for the workflow.
- Keep only a small service surface:
  - `JudgingWorkflow`
  - `JudgingRepo`
  - `ModelGateway`
- Keep prompt building, chunk planning, parsing, quote validation as pure functions.
- Use typed domain errors.
- Persist `errorTag`, `errorMessage`, `errorJson` as the main error model.
- Keep serialized `Cause` only as optional debug payload.

## Execution rules

- Create `judging_run` before any LLM work.
- Persist selected article snapshot and prompt snapshot on the run.
- Persist `judging_step started` before each step executes.
- Single path: `buildPrompt -> singleRequest -> parseJudgment -> persistJudgment`.
- Chunked path: `buildPrompt -> chunkPlan -> chunkEvidence[n] -> finalSynthesis -> parseJudgment -> persistJudgment`.
- Shared concurrency limit across `singleRequest`, `chunkEvidence`, `finalSynthesis`, retries.
- Retry only typed transient errors.
- Parse, quote, schema, and persist failures stay first-class step failures.
- Connection failures stay visible as failed steps.

## Derived views

- `requests` = all LLM step rows: `singleRequest`, `chunkEvidence`, `finalSynthesis`.
- `failedRequests` = runs that finish failed without `finalJudgmentId`.
- `failedSubrequests` = failed LLM step rows.
- Token totals derive from `judging_steps`; cache rows are optional.
- Failed-request UI reads from `judging_runs` + `judging_steps`, not legacy blobs.

## Migration

- Add `judging_runs`.
- Add `judging_steps`.
- Add `judgments.judgmentRunId`.
- Dual-write from current judge flow.
- Switch failed-request and debug reads to new tables.
- Keep `token_use` only as summary / cache during migration.
- Delete legacy-only failure aggregation last, if ever.

## Verify

- Direct success.
- Chunked success.
- Retry then success.
- Parse failure.
- Quote validation failure.
- Connection failure.
- Crash after send.
- Final synthesis failure.
- Rerun creates a new run and keeps old step history.
- Any run answers: what was sent, what came back, what failed, what it cost.
