# DUCKDB_WRITE_CONCURRENCY_PLAN

## Scope reviewed

- `src/server/utils/duckdbService.ts`
- `src/server/utils/duckdbOwnerLease.ts`
- `src/server/utils/serverRuntimeRole.ts`
- `src/server/services/getDuckdbMartRefreshService.ts`
- `src/server/routes/ProjectsRoutes.ts`
- `src/server/routes/ComparisonProjectsRoutes.ts`
- `src/server/routes/PromptsRoutes.ts`
- `src/agent/judge/judgeStoreJudgment.ts`

## Current read of the system

- Cross-process write races are already handled reasonably well by the DuckDB writer lease.
- In-process write races are mostly avoided by the serialized control queue.
- Background mart writes are separated onto their own connection/queue.
- Append-only judgment inserts are separated onto append lanes.

So the main remaining risk is not “too much concurrency” in general.
It is unsafe multi-step mutation patterns that temporarily break relationships and then repair them.

## Main race / conflict risks in current code

### 1. Multi-step canonical edits that leave temporary invalid states

`ProjectsRoutes.ts` currently has project-model-change logic that detaches referencing rows, updates the parent row, then restores the references.

That is a practical workaround for DuckDB FK limitations, but it creates a concurrency-sensitive pattern:

- backup
- delete references
- mutate parent
- restore references

Even when wrapped carefully, this is much easier to break than a true single-shape write.

### 2. Multi-transaction edit flows with temp-table handoffs

`ComparisonProjectsRoutes.ts` has a model-id-change path that:

- copies related rows into a temp table
- deletes link rows in one transaction
- updates the parent in another transaction
- restores links in another transaction

That is not ideal for concurrency safety or crash safety.

### 3. Read-then-write judgment storage

`judgeStoreJudgment.ts` does per-prompt read-then-update/insert logic.

That pattern is vulnerable to:

- duplicate concurrent work
- stale reads
- unnecessary control-lane time

The unique constraints help, but the write shape is still weaker than an atomic upsert/append path.

### 4. Post-commit mart queue gap

A repeated pattern in the repo today is:

- commit canonical app-table writes first
- queue mart refresh work afterwards

If the writer dies in that gap, canonical state can be correct while marts stay stale.
That is a correctness issue, not just an operability issue.

### 5. Lost-update risk on normal edit endpoints

Most edit routes rely on “last write wins”.
That is simple, but it means two open clients can overwrite each other without noticing.

### 6. Route-specific race windows already visible in the code

Examples worth planning around directly:

- human assessment init can race when two requests allocate the same next article
- prompt merge can collide with existing natural-key rows when redirecting `prompt_id`
- `insertArticlesIntoProject` currently spans several autocommit statements instead of one atomic mutation

## Plan

### 1. Define three write classes and enforce them

### Class A — canonical app-state writes

Examples:

- project edits
- prompt merges
- comparison project edits
- import-route changes

Rules:

- run only on the control connection
- one transaction per logical mutation when possible
- no background lane
- no append lane

### Class B — append-only idempotent ingest

Examples:

- `app.judgment` append flow
- telemetry/event rows

Rules:

- may use append lanes
- must be idempotent via unique keys / conflict handling
- must not mutate existing canonical relationship graphs as part of the same operation

### Class C — derived-state maintenance

Examples:

- mart refresh queue processing
- serving-table generation swaps

Rules:

- may use the background lane
- should only mutate mart/maintenance tables plus explicit queue/metadata tables
- should not rewrite canonical app tables except for narrowly defined metadata like queue/generation rows

## 2. Remove temp invalid states from user-facing edits

Best medium-term direction:

- stop treating `project.model_id` and similar high-fanout config as an in-place mutable parent field
- introduce an immutable config/revision layer for high-fanout entities

For example:

- `project` keeps identity and stable metadata
- `project_revision` holds model/content-mode settings
- child/derived work points to a revision or snapshots the needed config
- changing model creates a new revision instead of mutating a referenced parent row in place

That avoids:

- detach/restore hacks
- FK conflict workarounds
- race-prone multi-phase edits

The same idea likely helps comparison-project model changes too.

## 3. If a revision model is too big, standardize a staging-then-swap pattern

If the repo is not ready for immutable revisions yet, then at minimum:

- no multi-transaction temp-table choreography for canonical writes
- no delete-and-restore flow without a single recovery wrapper
- prefer staging tables plus one control-lane transaction that computes and applies the final state

## 4. Queue mart refresh work inside the same transaction as canonical writes

For any write that changes canonical app state and requires mart maintenance:

- insert/update the `app.mart_refresh_queue` row inside the same control-lane transaction
- commit both or neither
- let the background worker drain later

That closes the current “commit succeeded but refresh was never queued” race.

## 5. Add optimistic concurrency to edit APIs

Add an `expectedUpdatedAt` or `version` field to write endpoints for:

- projects
- prompts
- comparison projects
- data sources

Behavior:

- client sends the version it loaded
- server rejects if the stored row changed since then
- UI shows “record changed, reload before saving” instead of silently overwriting

This is the cleanest way to prevent lost updates without introducing lock-heavy behavior.

## 6. Fix route-level claim/merge races directly

Concrete changes the plan should cover:

- `humanAssessmentRoutesPostInit.ts`
  - allocate the pending article in one transaction
  - use a claim row or `INSERT ... SELECT ... WHERE NOT EXISTS` shape
- `PromptsRoutes.ts`
  - merge via staging + dedupe, not blind `UPDATE prompt_id = keepPromptId`
  - preserve natural-key uniqueness in `app.judgment` and `app.judgment_human`
- `insertArticlesIntoProject.ts`
  - make the whole link/import/prompt-auto-link flow one transaction
  - compute prompt order from current max, not implicit zero-based resets

## 7. Move legacy judgment writes onto one atomic path

Target:

- `judgeStoreJudgment.ts` should stop doing per-prompt read-then-write logic
- use either the append-lane path or one atomic `INSERT ... ON CONFLICT ...` path

That will reduce:

- race exposure
- control-lane time
- duplicate work under retries/concurrency

## 6. Add explicit idempotency for retryable external write flows

Today, follower proxying intentionally avoids retries for many write methods.
That is reasonable.

If safe retries are ever needed for POST/PATCH flows, add:

- request id / idempotency key
- durable dedupe record keyed by route + actor + idempotency key

Do not add generic write retries before that.

## 7. Add conflict policy for background work

Mart refresh is already deduped via queue keys.
Build on that with explicit rules:

- one active project refresh per project at a time
- article refresh may run concurrently only if it cannot invalidate the project-level generation step
- project config changes always queue after commit, never mid-transaction
- background retries only for idempotent refresh units

## 8. Add focused concurrency tests

Add tests for:

- concurrent project edit requests with stale versions
- project model change racing a mart refresh enqueue/flush
- prompt merge racing judgment append/import
- duplicate proxied request with idempotency key
- comparison-project model change under concurrent reads

## Guardrails

- Avoid “more threads” as a concurrency fix.
- Favor immutability or optimistic concurrency over lock-heavy designs.
- Keep all canonical writes on the control lane.
- Keep background work derived-only.
- Keep retry behavior restricted to idempotent operations.

## Suggested rollout order

1. Write-class rules
2. Optimistic concurrency for edit endpoints
3. Move legacy read-then-write judgment path to atomic writes
4. Replace multi-phase parent-mutation flows with revision or staging/swap model
5. Add idempotency keys only where safe retries are truly needed

## Acceptance checks

- no silent overwrite on concurrent edits
- no canonical write flow that depends on temporary FK-invalid intermediate state
- fewer conflict-driven failures during project/comparison-project edits
- no duplicate judgment rows under concurrent import/store pressure
