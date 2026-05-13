# Refusal Management Plan

## Goal

Build a durable refusal-management workflow for Anthropic safety refusals so the app can:

1. Stop retrying the same `article + prompt + model + content settings` combination after repeated safety refusals.
2. Persist refusal state in first-class app tables rather than JSON-only diagnostics.
3. Let admins list, inspect, and triage refusal-prone article + prompt combinations.
4. Preserve exact prompt payloads and provider diagnostics for audit and review.
5. Support manual reset, unblock, replay, and prompt experimentation in later phases.

The runtime goal is to prevent wasteful repeated LLM calls.
The product goal is to turn refusal debugging into an operational workflow instead of one-off log reading.

## Current State

### What Exists

1. `app.token_use.failed_requests_details` already stores rich failure snapshots for many failed request rows.
2. The admin UI already has `/admin/failed_requests` and `/admin/failed_requests/$id`.
3. The job detail page can show refusal metrics.

Useful fields already available in failure snapshots include:

- `articleId`
- `promptIds`
- `error`
- `failureType`
- `systemPrompt`
- `userPrompt`
- `lastResponse`
- provider diagnostics in some cases

### What Is Missing

1. No canonical refusal state keyed by the same dimensions as a judgment configuration.
2. No cheap hot-path lookup to decide whether to skip a repeated refusal before sending a provider request.
3. No first-class refusal event history for audit and review.
4. No admin page focused specifically on Anthropic safety refusals.
5. No durable system prompt version identity or last-updated metadata.
6. No replay or prompt experimentation workflow for exact failing requests.
7. No reset or unblock mechanism for refusal-blocked combinations.

## Design Principles

1. Use first-class relational tables for runtime control.
2. Keep `app.token_use` as an audit and analytics source, not the canonical refusal counter.
3. Keep successful judgments in `app.judgment`; do not create placeholder judgment rows for refusals.
4. Split current state from historical events.
5. Key refusal state by the same dimensions that define a unique judgment configuration.
6. Preserve exact prompt snapshots even after prompt versions change.
7. Keep replay explicit, manual, and auditable.

## Canonical Data Model

### Primary Runtime Table

Add:

- `app.judgment_refusal_state`

Purpose:

- hold latest refusal state and counter for one logical judgment key
- support pre-send skip/block logic
- support manual reset and unblock later

Recommended columns:

- `id VARCHAR PRIMARY KEY`
- `article_id VARCHAR NOT NULL REFERENCES app.article(id)`
- `prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id)`
- `model_id VARCHAR NOT NULL REFERENCES app.model(id)`
- `project_id VARCHAR REFERENCES app.project(id)`
- `system_prompt_version_id VARCHAR` nullable for phase 1
- `system_prompt_hash VARCHAR` nullable for phase 1 and legacy matching
- `use_title BOOLEAN NOT NULL`
- `use_abstract BOOLEAN NOT NULL`
- `use_fulltext BOOLEAN NOT NULL`
- `use_fulltext_no_images BOOLEAN NOT NULL`
- `refusal_count INTEGER NOT NULL DEFAULT 0`
- `first_refused_at TIMESTAMPTZ`
- `last_refused_at TIMESTAMPTZ`
- `last_failure_code VARCHAR`
- `last_error VARCHAR`
- `last_provider_diagnostics JSON`
- `last_judgment_job_id VARCHAR REFERENCES app.judgment_job(id)` nullable
- `last_token_use_id VARCHAR REFERENCES app.token_use(id)` nullable
- `blocked_at TIMESTAMPTZ`
- `unblocked_at TIMESTAMPTZ`
- `block_reason VARCHAR`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`

Recommended phase 1 uniqueness:

- `article_id`
- `prompt_id`
- `model_id`
- `use_title`
- `use_abstract`
- `use_fulltext`
- `use_fulltext_no_images`

When prompt versioning is available, extend uniqueness with:

- `COALESCE(system_prompt_version_id, '')`

Without prompt-version awareness, a bad old prompt can permanently poison an article + prompt pair even after the system prompt changes.

### Historical Event Table

Add:

- `app.judgment_refusal_event`

Purpose:

- persist each refusal occurrence as an auditable event
- power refusal review UI pages
- support prompt-version comparisons and replay history later

Recommended columns:

- `id VARCHAR PRIMARY KEY`
- `article_id VARCHAR NOT NULL REFERENCES app.article(id)`
- `prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id)`
- `model_id VARCHAR NOT NULL REFERENCES app.model(id)`
- `project_id VARCHAR REFERENCES app.project(id)`
- `judgment_job_id VARCHAR REFERENCES app.judgment_job(id)` nullable
- `token_use_id VARCHAR REFERENCES app.token_use(id)` nullable
- `system_prompt_version_id VARCHAR` nullable
- `system_prompt_hash VARCHAR` nullable
- `system_prompt_text VARCHAR`
- `user_prompt_text VARCHAR`
- `failure_code VARCHAR NOT NULL`
- `error VARCHAR NOT NULL`
- `provider_diagnostics JSON`
- `failure_type VARCHAR`
- `attempts INTEGER`
- `failed_attempts INTEGER`
- `use_title BOOLEAN NOT NULL`
- `use_abstract BOOLEAN NOT NULL`
- `use_fulltext BOOLEAN NOT NULL`
- `use_fulltext_no_images BOOLEAN NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`

Recommended indexes:

- `(article_id, prompt_id, model_id, created_at DESC)`
- `(failure_code, created_at DESC)`
- `(judgment_job_id, created_at DESC)`

### Prompt Version Table

Add in a later phase:

- `app.system_prompt_version`

Recommended columns:

- `id`
- `created_at`
- `updated_at`
- `scope` such as `article_judge` or `article_evidence`
- `provider` such as `anthropic` or `all`
- `name`
- `description`
- `prompt_text`
- `is_active`
- `supersedes_id`
- `created_by`
- `notes`

Versioning rules:

1. Prompt versions are append-only by default.
2. Use one active version per `(scope, provider)` unless the product explicitly supports multiple strategies.
3. Stored refusal events still keep raw `system_prompt_text` for historical accuracy.
4. New judgment runs should store `system_prompt_version_id` when known.
5. Legacy rows can show `legacy snapshot` plus a stable prompt hash.

### Replay Run Table

Add when replay ships:

- `app.refusal_replay_run`

Recommended columns:

- `id`
- `created_at`
- `article_id`
- `prompt_id`
- `judgment_job_id`
- `model_id`
- `provider_connection_id`
- `system_prompt_version_id` nullable if using an ad hoc draft
- `system_prompt_text`
- `user_prompt_text`
- `response_text`
- `parsed_response_json`
- `error`
- `provider_diagnostics_json`
- `stop_reason`
- `status` such as `success`, `refusal`, `parse_error`, or `transport_error`
- `operator_note`

## Refusal Classification

Add one shared classifier on the server.

Phase 1 rule:

- provider is Anthropic
- failure code is `anthropic_refusal_empty_response`
- legacy-compatible `anthropic_empty_response` also counts when diagnostics include stop reason `refusal`

Keep classification logic centralized so the following all agree on refusal semantics:

- runtime skip logic
- refusal state/event persistence
- job metrics
- failed request pages
- refusal admin pages
- replay results

## Runtime Behavior

### Threshold

Recommended initial block threshold:

- `refusal_count >= 3`

### Pre-Send Gate

Before sending a prompt to the provider:

1. Run the existing judgment-exists check.
2. Look up `app.judgment_refusal_state` for the exact execution key.
3. Continue normally when `refusal_count < 3` or the row is absent.
4. Do not send the provider request when `refusal_count >= 3` and the state is not unblocked.
5. Mark the queue row skipped with `skip_reason='refusal_limit'`.

The `refusal_limit` skip reason should be distinct from:

- `no_fulltext`
- `conversion_failed`
- `fulltext_too_large`

### Incrementing Refusal State

On a classified Anthropic refusal:

1. Append a `judgment_refusal_event` row.
2. Upsert the matching `judgment_refusal_state` row.
3. Increment `refusal_count`.
4. Set `first_refused_at` if empty.
5. Update `last_refused_at`.
6. Store latest error, diagnostics, job id, and token use id.
7. Set `blocked_at` and `block_reason` once the threshold is crossed.

Do not increment refusal state for:

1. non-refusal provider failures
2. connection errors
3. parse or quote validation failures after a non-refusal model response
4. skipped prompts

### Worker Touch Points

Primary file:

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`

Suggested flow:

1. `checkJudgmentExistsInDatabase`
2. `checkJudgmentRefusalState`
3. skip with `refusal_limit` if blocked
4. otherwise continue with provider request

Persistence should happen from the worker or judge path using data already available from:

- `RecoverableJudgeError.failureCode`
- `RecoverableJudgeError.providerDiagnostics`
- `JudgeTokenUsageEntry`
- persisted `failed_requests_details`

Do not rely on later JSON parsing of `token_use` for the canonical refusal counter.

## Reset And Override Behavior

Design for these actions even if only shipped after the runtime MVP:

1. Reset refusal count.
2. Unblock once.
3. Reset automatically for a new system prompt version.

Recommended behavior:

1. Keep lifetime refusal history in `judgment_refusal_event`.
2. Gate runtime using current prompt-version-specific `judgment_refusal_state` when prompt versions exist.
3. Do not erase historical refusal events on reset.

## Admin Workflow

### Information Architecture

Add admin pages:

- `/admin/safety-refusals`
- `/admin/safety-refusals/$refusalKey`

Optional later page:

- `/admin/safety-refusals/prompts`

Recommended menu label:

- `Safety Refusals`

### List Page

Purpose:

- top-level refusal triage
- filtering and sorting
- fast identification of refusal-prone article + prompt combinations

Rows should show:

- article title
- article id
- prompt heading
- prompt id
- refusal count
- first refusal timestamp
- latest refusal timestamp
- model name
- model provider
- thinking or version label
- system prompt version or prompt hash
- latest refusal status/result
- latest job link
- quick link to failed request detail

Useful filters:

- provider
- model
- project
- job id
- prompt id
- article id
- article title search
- date range
- system prompt version
- only with repeated refusals
- only without successful replay

Helpful badges:

- `Repeated refusal`
- `Other failures too`
- `Prompt changed since first refusal`
- `No replay yet`
- `Resolved after replay`
- `Blocked by refusal limit`

### Detail Page

The detail page should show:

- article metadata
- prompt metadata
- latest system prompt used
- latest user prompt used
- refusal history for the exact execution key
- links to other refusal rows for the same article
- links to all other failures for the same article + prompt pair
- current refusal state and block status
- reset and unblock actions when available

Recommended sections:

1. Summary.
2. Article preview.
3. Prompt metadata.
4. Latest exact prompt payload.
5. Refusal history table.
6. Other errors for this article + prompt.
7. Replay workbench when shipped.
8. Notes or operator observations when shipped.

## API Plan

Recommended routes:

- `GET /api/refusals`
- `GET /api/refusals/:refusalKey`
- `POST /api/refusals/:refusalKey/reset`
- `POST /api/refusals/:refusalKey/unblock`
- `GET /api/system-prompt-versions`
- `POST /api/system-prompt-versions`
- `PATCH /api/system-prompt-versions/:id`
- `POST /api/refusals/:refusalKey/replay`
- `POST /api/refusals/:refusalKey/compare-system-prompts` later

`GET /api/refusals` should support filters for:

- `provider`
- `projectId`
- `jobId`
- `promptId`
- `articleId`
- `startDate`
- `endDate`
- `onlyActivePromptVersion`
- `limit`
- `offset`
- `sort`

Group list results by:

- `articleId + promptId + modelId + content settings + systemPromptVersionId or prompt hash`

## Replay Workbench

Replay should be manual only and should not mutate production prompt behavior automatically.

Required behavior:

1. Use the exact stored `userPrompt` from the selected refusal.
2. Allow selecting an active system prompt version.
3. Allow editing a custom draft system prompt inline.
4. Send one manual test request only on explicit click.
5. Store the result as a replay run for later comparison.

Result panel should show:

- request model, provider, and version
- system prompt version or custom draft
- raw response text
- parsed JSON if valid
- stop reason
- provider diagnostics
- token usage
- refusal classification
- quote validation outcome if running through the judge pipeline

Support two modes eventually:

1. `Provider raw replay`
2. `Judge pipeline replay`

Phase 1 of replay can ship with `Provider raw replay` only.

## Database Migration Plan

Add a DuckDB migration under:

- `src/db/duckdbMigrations/`

Migration should:

1. Create `app.judgment_refusal_state`.
2. Create uniqueness constraint and lookup indexes.
3. Create `app.judgment_refusal_event`.
4. Create event indexes for common lookups.
5. Optionally backfill from recent `token_use.failed_requests_details` later.

Recommended phase 1:

- no historical backfill
- collect new refusal state and events forward only

Reasons:

- backfilling from `token_use` JSON adds complexity
- classification may change during development
- forward collection is easier to validate first

Update:

- `src/db/schemaTypes.ts`

Add:

- `JudgmentRefusalStateRecord`
- `JudgmentRefusalEventRecord`
- `JudgmentsJobsPromptsSkipReason` value `refusal_limit`

## Mart Impact

No mart changes are required for runtime gating.

The following marts can remain unchanged in the first phase:

- `mart.judgment_fact`
- `mart.prompt_answer_fact`
- `mart.review_article_rollup`
- `mart.review_article_serving`
- `mart.review_article_serving_detail`
- related filter and member tables

Reason:

- these marts are built from successful `app.judgment` rows
- refusals do not create `app.judgment` rows today
- blocking future refusals at runtime does not change judgment mart semantics

Optional later additions:

- `mart.refusal_fact`
- refusal summary fields in `mart.review_article_rollup`

Possible rollup fields:

- `anthropic_refusal_count`
- `anthropic_refusal_prompt_ids`
- `has_blocked_refusals`
- `latest_refusal_at`

## Logging

Use the shared runtime logger instead of direct `console.*` calls.

Runtime logging:

- Emit pre-send refusal-limit skips as structured `file-only` runtime events because they are routine hot-path control decisions.
- Emit refusal-state upserts, threshold crossings, and `blocked_at` transitions as `both` so operators get terminal-visible refusal-block signals and matching JSONL records.

Replay logging:

- Emit replay request and result summaries as structured `file-only` events with `refusalKey`, `systemPromptVersionId`, `modelId`, and replay mode attrs.
- Emit replay refusals, provider failures, and replay-run persistence failures as `both`.
- Include durable identifiers such as `refusalKey`, `tokenUseId`, and `systemPromptVersionId`.

## Implementation Phases

### Phase 1: Runtime Control And Review MVP

Ship:

1. `app.judgment_refusal_state`.
2. `app.judgment_refusal_event`.
3. Shared refusal classifier.
4. Worker-side event insert and state upsert on classified refusal.
5. Worker-side pre-send skip when `refusal_count >= 3`.
6. New skip reason `refusal_limit`.
7. Admin menu link for `Safety Refusals`.
8. Refusal list page.
9. Refusal detail page.
10. Refusal history and latest stored prompt snapshots.
11. Links back to failed request rows.

Do not ship yet:

- prompt editing
- replay
- prompt version DB tables unless already needed during implementation
- mart changes
- historical backfill

### Phase 2: Prompt Versioning And Overrides

Ship:

1. `app.system_prompt_version`.
2. Active version selection for Anthropic article prompts.
3. Version labels in refusal list/detail pages.
4. Last-updated, author, and note metadata.
5. Reset refusal count.
6. Unblock once.
7. Prompt-version-aware refusal state keys.

### Phase 3: Replay Workbench

Ship:

1. Refusal replay route.
2. Custom prompt draft editor.
3. Saved replay runs.
4. Inline result viewer.
5. Provider raw replay first.
6. Judge pipeline replay later if needed.

### Phase 4: Comparison And Analytics

Ship only if needed:

1. Compare multiple prompt versions on one refusal.
2. Derived analytics by version, prompt, provider, and model.
3. `mart.refusal_fact`.
4. Optional refusal summary fields in review rollups.
5. `Resolved after prompt version X` indicators.

## Risks

1. Replay requests can generate real provider spend.
2. Prompt experiments can accidentally drift from production behavior.
3. Historical refusal rows may not map cleanly to prompt versions.
4. Large prompt/user prompt blobs can make list pages slow without pagination.
5. Narrow classification may miss relevant refusal rows.
6. Broad classification may make refusal pages noisy.
7. A state key without prompt-version awareness can keep a combination blocked after a prompt fix.

## Open Questions

1. Should the threshold be exactly `3`, or configurable per provider/model?
2. Should the block key include `system_prompt_version_id` immediately, or add it later?
3. Should a successful manual replay clear block state automatically?
4. Should `refusal_limit` count as a skipped prompt or a blocked prompt in job stats?
5. Should refusal state be backfilled from historical `token_use` rows later?
6. Should replay always use the original model id, or allow switching model/version?
7. Should custom prompt drafts be persisted separately, or only saved as replay runs?

Recommended phase 1 answers:

1. Use fixed threshold `3`.
2. Do not backfill historical state.
3. Do not automatically unblock on replay success yet.
4. Store as skipped with `skip_reason='refusal_limit'`.
5. Add prompt-version awareness in phase 2 unless it is already available while implementing phase 1.
6. Replay should default to the original model id, with model override later if useful.
7. Persist custom drafts only as replay runs at first.

## Quality Gates

Phase 1 gates:

1. `bun run db:mig`
2. targeted `bun test` for refusal classifier helper
3. targeted `bun test` for refusal state/event persistence
4. targeted `bun test` for worker skip after threshold
5. targeted `bun test` for skip reason propagation
6. targeted tests for refusal routes and UI pages
7. `bun run build`
8. `bun run desktop:build` because admin UI is shared by browser and desktop flows
9. manual browser verification for admin menu link, refusal list, refusal detail drilldown, and failed-request links
10. manual verification that the fourth run of the same exact key does not send a provider request and marks the queue row `refusal_limit`
11. manual verification that non-refusal failures do not increment refusal count

Phase 2 gates:

1. targeted tests for prompt version routes/services
2. `bun run db:mig`
3. `bun run build`
4. `bun run desktop:build`

Phase 3 gates:

1. targeted tests for replay route classification
2. targeted tests that replay uses exact stored `userPrompt`
3. targeted tests for replay run persistence
4. `bun run build`
5. `bun run desktop:build`
