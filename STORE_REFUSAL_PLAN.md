# Store Refusal Plan

## Goal

Persist refusal state in first-class app tables so the runtime can stop retrying the same `article + prompt + model + content settings` combination after repeated Anthropic safety refusals.

This plan follows:

1. Option 1: add a dedicated refusal state table.
2. Strongly recommended addition: also add a refusal event table for audit/history.

The state table is the runtime control surface.
The event table is the observability and review surface.

## Why This Plan

Current refusals are primarily persisted inside `app.token_use.failed_requests_details`.

That is useful for diagnostics, but not a good runtime control source because:

1. it is JSON detail data, not first-class relational state
2. it is expensive and awkward to query in hot scheduling paths
3. it does not give us a simple reset / unblock / override mechanism
4. it is not a durable canonical place for refusal counters

Also, `app.judgment` currently represents successful judged outputs. Refusals do not create `app.judgment` rows today, so putting refusal counters directly on `app.judgment` would blur the meaning of the table and create unnecessary mart fallout.

## Recommended Design

### Primary table

Add:

- `app.judgment_refusal_state`

Purpose:

- hold the latest refusal state and counter for one logical judgment key
- support runtime skip/block logic
- support manual reset/unblock later

### Strongly recommended table

Add:

- `app.judgment_refusal_event`

Purpose:

- persist each refusal occurrence as an auditable event
- support the refusal review UI
- support prompt-version comparisons and replay history later

## Keying Rules

Refusal state must be keyed by the same dimensions that define a unique judgment configuration.

Recommended logical key:

- `article_id`
- `prompt_id`
- `model_id`
- `use_title`
- `use_abstract`
- `use_fulltext`
- `use_fulltext_no_images`

Recommended extension once prompt versioning exists:

- `system_prompt_version_id` nullable for legacy rows
- or `system_prompt_hash` until versioning is fully in place

Without prompt-version awareness, a bad old prompt can permanently poison an article+prompt pair even after the system prompt changes.

## Proposed Schema

### `app.judgment_refusal_state`

Recommended columns:

- `id VARCHAR PRIMARY KEY`
- `article_id VARCHAR NOT NULL REFERENCES app.article(id)`
- `prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id)`
- `model_id VARCHAR NOT NULL REFERENCES app.model(id)`
- `project_id VARCHAR REFERENCES app.project(id)`
- `system_prompt_version_id VARCHAR` nullable for phase 1
- `system_prompt_hash VARCHAR` nullable for phase 1 / legacy matching
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

Recommended uniqueness:

- unique on
  - `article_id`
  - `prompt_id`
  - `model_id`
  - `use_title`
  - `use_abstract`
  - `use_fulltext`
  - `use_fulltext_no_images`
  - `COALESCE(system_prompt_version_id, '')`

If prompt versioning is not available in phase 1, use the same unique key without `system_prompt_version_id` first.

### `app.judgment_refusal_event`

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

## Refusal Classification

Add one shared classifier on the server.

Phase 1 rule:

- provider is Anthropic
- failure code is one of:
  - `anthropic_refusal_empty_response`
  - legacy-compatible `anthropic_empty_response` when diagnostics stop reason is `refusal`

Keep classification logic centralized so it is reused by:

- runtime skip logic
- refusal list pages
- refusal metrics on job pages
- replay tooling later

## Runtime Behavior

### Threshold

Recommended initial block threshold:

- `refusal_count >= 3`

### What should happen at runtime

Before sending a prompt to the provider:

1. look up `app.judgment_refusal_state` for the exact execution key
2. if `refusal_count < 3`, continue normally
3. if `refusal_count >= 3`, do not send the request
4. mark the queue row skipped using a new skip reason

Recommended new skip reason:

- `refusal_limit`

That skip reason should show up in queue/admin surfaces distinctly from:

- `no_fulltext`
- `conversion_failed`
- `fulltext_too_large`

### When to increment refusal state

On a classified Anthropic refusal:

1. append a `judgment_refusal_event`
2. upsert `judgment_refusal_state`
3. increment `refusal_count`
4. set `first_refused_at` if empty
5. update `last_refused_at`
6. store latest error / diagnostics / job / token use references
7. set `blocked_at` and `block_reason` once threshold is crossed

### When not to increment

Do not increment refusal state for:

1. non-refusal provider failures
2. connection errors
3. parse/quote validation failures after a non-refusal model response
4. skipped prompts

## Recommended Reset / Override Behavior

Even if not shipped in phase 1, design the schema for these later actions:

1. `reset refusal count`
2. `unblock once`
3. `reset on system prompt version change`

Recommended product behavior:

1. Keep lifetime refusal history in `judgment_refusal_event`
2. Gate runtime using the current prompt-version-specific refusal state

That means a new prompt version can start from a fresh refusal counter without erasing history.

## Worker Changes

### Pre-send gate

Touch:

- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`

Add a refusal-state existence check near the existing `checkJudgmentExistsInDatabase` path.

Suggested flow:

1. `checkJudgmentExistsInDatabase`
2. `checkJudgmentRefusalState`
3. if blocked, mark queue row skipped with `refusal_limit`
4. otherwise continue

### Persistence on refusal

Current refusal information is available from:

- `RecoverableJudgeError.failureCode`
- `RecoverableJudgeError.providerDiagnostics`
- `JudgeTokenUsageEntry`
- persisted `failed_requests_details`

Recommended implementation path:

1. classify refusal as early as possible in the judge/worker path
2. persist refusal state/event directly from the worker path
3. do not rely on later JSON parsing of `token_use` for the canonical refusal counter

`token_use` remains an audit/analytics source, not the runtime state source.

### Logging

- Emit pre-send refusal-limit skips as structured `file-only` runtime events because they are routine hot-path control decisions.
- Emit refusal-state upserts, threshold crossings, and `blocked_at` transitions as `both` so operators get terminal-visible refusal-block signals and matching JSONL records.
- Keep the refusal classifier and worker path on the shared runtime logger instead of direct `console.*` calls.

## API / Admin Surface Plan

Phase 1 should at least support internal admin review and manual reset later.

Recommended future routes:

- `GET /api/refusals`
- `GET /api/refusals/:refusalKey`
- `POST /api/refusals/:refusalKey/reset`
- `POST /api/refusals/:refusalKey/unblock`

These are aligned with `REFUSAL_MANAGMENT_PLAN.md`.

## Database Migration Plan

Add a new DuckDB migration under:

- `src/db/duckdbMigrations/`

Migration should:

1. create `app.judgment_refusal_state`
2. create indexes and uniqueness constraint
3. create `app.judgment_refusal_event`
4. create indexes for common lookups
5. optionally backfill from recent `token_use.failed_requests_details` if desired

Recommended phase 1:

- no backfill yet
- only start collecting new refusal state/events after deployment

Reason:

- backfilling from `token_use` JSON adds complexity
- classification may change during development
- easier to validate forward-collection first

## Schema Type Updates

Update:

- `src/db/schemaTypes.ts`

Add:

- `JudgmentRefusalStateRecord`
- `JudgmentRefusalEventRecord`
- update `JudgmentsJobsPromptsSkipReason` with `refusal_limit`

## Mart Impact

### Phase 1 recommendation

No mart changes required for runtime gating.

This is the main benefit of keeping refusal state outside `app.judgment`.

The following marts can remain unchanged in phase 1:

- `mart.judgment_fact`
- `mart.prompt_answer_fact`
- `mart.review_article_rollup`
- `mart.review_article_serving`
- `mart.review_article_serving_detail`
- related filter/member tables

### Why no mart changes are required initially

Those marts are built from successful `app.judgment` rows.
Refusals do not create `app.judgment` rows today.
Blocking future refusals at runtime does not change the semantic meaning of judgment marts.

### Optional phase 2 mart work

If refusal visibility is needed in review dashboards, add refusal-specific marts or summary joins later.

Recommended future additions:

1. `mart.refusal_fact`
2. optional refusal summary fields in `mart.review_article_rollup`

Possible rollup fields:

- `anthropic_refusal_count`
- `anthropic_refusal_prompt_ids`
- `has_blocked_refusals`
- `latest_refusal_at`

That should be a separate phase, not required for phase 1 runtime gating.

## Option Comparison Summary

### Why not put this directly on `app.judgment`

Because:

1. refusals are not judgments today
2. that would require placeholder judgment rows
3. it would force wider mart changes
4. it would blur the meaning of `app.judgment`

### Why the state+event split is best

Because it gives:

1. cheap runtime gating
2. clean data semantics
3. full historical traceability
4. easy alignment with the refusal-management UI plan

## Suggested Implementation Phases

### Phase 1: runtime control MVP

Ship:

1. `app.judgment_refusal_state`
2. `app.judgment_refusal_event`
3. refusal classifier helper
4. worker-side increment/upsert on refusal
5. worker-side skip when `refusal_count >= 3`
6. new skip reason `refusal_limit`

No mart changes.

### Phase 2: admin visibility

Ship:

1. refusal list/detail pages using new tables first
2. manual reset/unblock actions
3. richer grouping and filtering

### Phase 3: prompt-version-aware state

Ship:

1. link refusal state/event to system prompt versions
2. reset counters per prompt version automatically
3. replay tooling integration

### Phase 4: optional marts

Ship only if needed:

1. `mart.refusal_fact`
2. refusal summary in review rollups

## Open Questions

1. Should the threshold be exactly 3, or configurable per provider/model?
2. Should the block key include `system_prompt_version_id` immediately, or add that later?
3. Should a successful manual replay clear block state automatically?
4. Should `refusal_limit` count as a skipped prompt or a blocked prompt in job stats?
5. Should we backfill refusal state from historical `token_use` rows later?

## Recommended Answers For Phase 1

1. threshold fixed at `3`
2. no historical backfill
3. no automatic unblock on replay success yet
4. store as skipped with `skip_reason='refusal_limit'`
5. add prompt-version awareness in phase 3 unless it is already available while implementing phase 1

## Quality Gates

Because this includes schema work, runtime gating, and likely admin-facing reporting, the concrete gates should be:

1. `bun run db:mig`
2. targeted `bun test` for:
   - refusal classifier helper
   - refusal state/event persistence
   - worker skip after threshold
   - skip reason propagation
3. `bun run build` if any admin UI is added in the same change
4. `bun run desktop:build` if shared admin UI is changed
5. manual verification:
   - refusal count increments on a classified refusal
   - fourth run of the same exact key does not send a provider request
   - queue row is marked `refusal_limit`
   - normal non-refusal failures do not increment refusal count
