# Long-Term Bun Mart Refresh Plan

> For Hermes: Use subagent-driven-development skill to implement this plan task-by-task.

Goal: Restore automatic, correct post-judgment updates for project review pages, LLM assessment pages, reviews-unassessed pages, unassessed counts, projectsreviewswarnings, and prompt queueing without relying on Bun/macOS crash-prone mart queue/drain paths.

Architecture: Replace the current row-per-refresh queue model with a durable coalesced dirty-project ledger plus a dedicated refresh worker that participates in the existing writer-role / DuckDB-ownership system. Writers only mark affected projects dirty; the worker resolves cross-project impact, rebuilds `mart.judgment_fact` for changed articles, refreshes project-serving marts, and advances a ledger token that represents freshness for all affected projects.

Tech Stack: Bun API server, DuckDB marts, SQLite judgment job storage, app DB, existing `SERVER_ROLE=worker` ownership model, durable DB-backed refresh ledger, optional Node/tsx execution wrapper only if it can safely participate in the same writer-lease discipline.

---

## Problem Summary

Current state:
- Automatic mart refresh queueing is disabled on Bun/macOS in `src/server/services/getDuckdbMartRefreshService.ts`.
- Periodic mart refresh draining is disabled on Bun/macOS in `src/server/utils/martRefreshDrainHeartbeat.ts`.
- This avoids Bun native crashes, but it also prevents automatic freshness for:
  - `/projects/$id/reviews`
  - `/projects/$id/reviews-llm`
  - `/projects/$id/reviews-unassessed`
  - review counts / filters / select-all matching
  - judgment-job unassessed counts/previews
  - prompt queue generation based on what still needs judgment
  - `projectsreviewswarnings` progress/status used by the frontend

Important code facts:
- The user-facing read paths prefer serving marts when present, especially:
  - `mart.review_article_serving`
  - `mart.review_article_serving_detail`
  - `mart.review_article_filter_member`
  - `mart.review_article_rollup`
  - `app.project_review_serving_generation`
  - `app.review_answer_dictionary`
- The actual refresh logic already exists and does not require the current queue design:
  - `refreshJudgmentArticle(articleId)`
  - `refreshProjectArticleServing(projectId, articleId)`
  - `refreshProject(projectId)`
- `refreshProject(projectId)` does not rebuild `mart.judgment_fact`; it rebuilds downstream project marts from `mart.judgment_fact`.
- New judgments currently enter the mart pipeline through `refreshJudgmentArticle(articleId)`, so any long-term plan must preserve an equivalent judgment-fact refresh stage.
- Article judgments can affect multiple projects that scope the same article; dirtying only the “originating” project is not correct.
- The unstable piece is the current Bun/macOS orchestration around `app.mart_refresh_queue`, timers, and in-process automatic drain behavior.

Core design goal:
- After new judgments land, every affected project must become fresh automatically.
- The API process should not perform high-risk refresh orchestration inline.
- The system must coalesce bursts of updates and avoid one-row-per-article fan-out queue writes.
- The resulting freshness contract must be explicit enough for correctness-sensitive consumers, not just UI warnings.

---

## Correctness Constraints We Must Preserve

### 1. `mart.judgment_fact` must be refreshed before downstream project marts

Current dependency chain:
- New/updated judgment
- `refreshJudgmentArticle(articleId)` updates `mart.judgment_fact`
- project/article-serving refreshes read from `mart.judgment_fact`

Therefore:
- Phase 1 cannot do “project refresh only” unless it also adds an equivalent judgment-fact rebuild step for all changed articles first.
- Any future project-level coalescing must maintain a stage ordering of:
  1. refresh changed article judgment facts
  2. refresh affected project-serving state

### 2. Dirtying must fan out to all affected projects, not just one project

Current behavior and tests already assume:
- one article can belong to many active, non-archived projects
- one new judgment can therefore stale several projects at once

Therefore:
- mutation handlers should not write “owning project only” into the dirty ledger
- they must resolve impacted project IDs from changed articles, or record enough article-level dirtiness for the worker to derive impacted projects safely

### 3. Ledger freshness semantics cannot reuse raw counter comparison with current serving generations

Current `app.project_review_serving_generation.active_generation` means:
- one increment per successful serving rebuild

Proposed `dirty_generation` would mean:
- one increment per coalesced write event or dirty mark

Those are not numerically comparable unless the plan changes one side.

Therefore:
- do not define freshness as `serving_generation >= dirty_generation`
- instead introduce a refresh token model, where the worker captures the dirty token it is satisfying and writes that exact token as the project’s `last_completed_refresh_token`
- read-side freshness uses token equality/ordering within the new ledger, not comparison against the old serving generation counter

### 4. Count and queueing endpoints need strict correctness rules

Endpoints like:
- `/api/articlesreviewscount`
- `/api/judgmentsjobs-unassessed-count`
- judgment prompt queue generation

cannot simply “show a warning and use the last completed generation” if freshness is required for behavior.

Therefore:
- these paths need an explicit raw-fallback or explicit “refresh-required” behavior in the plan
- the existing 10-second unassessed-count cache must also be addressed, or automatic-update verification will still be false in practice

### 5. The new worker must respect existing writer ownership

This repo already has:
- `SERVER_ROLE=worker`
- DuckDB ownership / writer lease
- background API/worker stack

Therefore:
- the new refresh worker must either:
  - run inside the existing writer-role process, or
  - participate in the same ownership/lease system
- it must not create a second independent writer that races DuckDB ownership

### 6. `projectsreviewswarnings` is a frontend contract, not just an internal status bit

The current warnings API exposes queue/progress semantics consumed directly by the reviews UI.

Therefore:
- the plan must preserve or deliberately replace that contract
- we cannot silently reduce it to a boolean stale/running flag without a matching frontend migration

---

## Desired End State

1. Every mutation that can stale review-serving marts records durable dirty state.
2. Dirty state coalesces by project, but article-level fact refresh dependencies are preserved.
3. A dedicated refresh worker, running under the existing writer-ownership discipline, claims dirty work and executes it deterministically.
4. Worker refresh order is:
   - rebuild `mart.judgment_fact` for changed articles
   - refresh affected project-serving state
5. The worker records a durable refresh token that explicitly states which dirty state has been fully satisfied.
6. Read paths can determine whether serving marts are fresh enough for their endpoint contract.
7. Project review pages, LLM assessment pages, reviews-unassessed pages, unassessed counts, projectsreviewswarnings, and prompt queueing all update automatically after new judgments.
8. Bun/macOS no longer depends on the current mart queue/timer path.

Non-goals for phase 1:
- Reintroducing article-fanout queue rows.
- Preserving the exact current `app.mart_refresh_queue` behavior.
- Perfectly minimal per-article incremental refresh logic before correctness is restored.

---

## High-Level Design

### Replace queue rows with a coalesced dirty-project ledger

Add a durable table that stores one row per project instead of one row per refresh event.

Proposed table: `app.project_mart_refresh_state`

Suggested columns:
- `project_id UUID PRIMARY KEY`
- `dirty_token BIGINT NOT NULL DEFAULT 0`
- `last_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_request_reason TEXT NULL`
- `requested_by TEXT NULL`
- `refresh_status TEXT NOT NULL DEFAULT 'idle'`
- `active_refresh_token BIGINT NOT NULL DEFAULT 0`
- `last_completed_refresh_token BIGINT NOT NULL DEFAULT 0`
- `last_started_at TIMESTAMPTZ NULL`
- `last_completed_at TIMESTAMPTZ NULL`
- `last_failed_at TIMESTAMPTZ NULL`
- `last_error TEXT NULL`
- `worker_id TEXT NULL`
- `lease_expires_at TIMESTAMPTZ NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Semantics:
- Writers never enqueue N article rows.
- Writers only bump `dirty_token` and update metadata.
- Worker refreshes a project until `last_completed_refresh_token >= dirty_token`.
- `active_refresh_token` records which dirty token the worker is currently satisfying.

Why this is better:
- Coalesces bursts of judgments into one project-level refresh target.
- Avoids row explosion and fan-out writes.
- Makes staleness explicit and queryable.
- Avoids the flawed assumption that current serving generation counters can stand in for write-side dirty counters.

### Preserve article-level fact refresh dependency with unresolved-range semantics

Project-level coalescing is the long-term correctness boundary for the review UI, but article-level judgment-fact refresh is still required before downstream project refreshes.

The crucial constraint is this:
- a worker claiming dirty token N cannot safely look only at article changes tagged exactly with N
- it must satisfy all unresolved article changes in the range `(last_completed_refresh_token, claimed_token]`
- otherwise a token N-1 judgment change could be skipped if token N is later only a project/config dirty mark

Therefore the design must use unresolved-range semantics, not “current token only” semantics.

Long-term design layers:

1. Coalesced project refresh state
- `app.project_mart_refresh_state`
- tracks dirty/completed tokens, lease state, status, timestamps

2. Bounded article-change accumulator for unresolved work
- stores enough information for the worker to answer:
  - “which articles changed for this project since `last_completed_refresh_token`?”
- this must support the unresolved range `(last_completed_refresh_token, claimed_token]`

Important design rule:
- do not model this as an unbounded row-per-project/article/token fan-out table in the steady state
- that would recreate the current write-amplification problem in a different table

Preferred durable forms for the article accumulator:
- `app.project_mart_refresh_article_state(project_id, article_id, first_dirty_token, last_dirty_token, updated_at)`
  - one row per `(project_id, article_id)`
  - updates widen the token range instead of inserting a new row per event
- or a project-scoped aggregate payload if bounded safely (for example, chunked JSON blobs), but only if operationally simpler than the row-per-article range table

Recommended phase-1 form:
- use one row per `(project_id, article_id)` with token range columns
- the worker resolves changed articles by querying rows where:
  - `last_dirty_token > last_completed_refresh_token`
  - and `first_dirty_token <= claimed_token`
- after successful refresh completion for the claimed token, either:
  - clear rows whose `last_dirty_token <= claimed_token`, or
  - advance/trim their token range if newer dirtiness already exists

This preserves correctness while keeping article dirtiness bounded and coalesced.

### Dedicated refresh worker

Create a new refresh worker entrypoint that:
- participates in the existing writer-role / DuckDB ownership discipline
- claims one or more dirty projects
- resolves changed articles relevant to the claimed dirty token
- refreshes changed article judgment facts
- refreshes the affected project-serving state
- records success/failure/lease state in the new ledger

Preferred ownership model:
- reuse existing `SERVER_ROLE=worker` / current writer-role process model
- if using Node/tsx on macOS, it must still acquire/obey the same writer lease semantics before mutating DuckDB

Recommended runtime on macOS:
- preferred: reuse the existing worker-role architecture and make the refresh worker part of the single writer owner
- if a separate Node/tsx process is introduced, it must not bypass the writer lease model

### Refresh scope policy

Phase 1 policy: correctness first
- For any new imported judgment or human assessment change:
  1. resolve all affected projects
  2. mark them dirty
  3. worker rebuilds `mart.judgment_fact` for changed articles
  4. worker performs project refresh for those affected projects
- For project-wide config/import/prompt changes:
  - mark affected projects dirty
  - worker performs full project refresh

This is heavier than the eventual ideal, but it is long-term architecturally clean and reliable.

Phase 2 optimization: article-aware delta routing
- Add explicit changed-article tracking per project/token.
- Worker may choose between:
  - `refreshProject(projectId)`
  - `refreshJudgmentArticle(articleId)` + `refreshProjectArticleServing(projectId, articleId)`
- Only do this after the project-level dirty ledger is stable.

### Read-side freshness contract

Read paths should treat serving marts as authoritative only when the project is fresh for the endpoint’s needs.

Freshness should be defined by the new ledger:
- fresh when `last_completed_refresh_token >= dirty_token`
- running when `refresh_status = 'running'` and `active_refresh_token < dirty_token` or work is still in progress
- failed/stale when `last_completed_refresh_token < dirty_token` and `refresh_status != 'running'`

Do not compare these values directly to `app.project_review_serving_generation.active_generation` for correctness decisions.

---

## Endpoint Contracts and Read-Side Policy

### Contract classes

#### A. Strict-correctness endpoints
These must not silently serve stale marts:
- `/api/articlesreviewscount`
- `/api/judgmentsjobs-unassessed-count`
- judgment prompt queue generation
- any API driving decisions about what still needs judgment

Required plan behavior:
- if project freshness is stale/running, either:
  - use a raw/slow fallback path, or
  - compute the answer directly from base tables / raw DuckDB views
- do not rely on stale serving marts just because they exist

Also required:
- remove or invalidate the current 10-second unassessed-count cache when the relevant project/job becomes dirty

#### B. User-facing list/detail pages
Examples:
- `/projects/$id/reviews`
- `/projects/$id/reviews-llm`
- `/projects/$id/reviews-unassessed`
- `/projects/$id/reviews-both`
- review detail pages

Required plan behavior:
- prefer fresh serving marts when available
- if stale/running, show explicit progress/warning state
- optionally fall back to raw reads where feasible, but the UI contract must remain explicit about freshness

#### C. `projectsreviewswarnings` frontend contract
This endpoint is currently consumed as queue/progress data, not just a stale boolean.

Therefore the long-term plan must either:
- preserve a compatible response shape backed by the new ledger/worker state, or
- deliberately version and migrate the frontend contract

Recommended approach:
- preserve compatibility where possible by mapping new ledger fields to existing warnings/progress concepts:
  - stale/running/failed
  - last started/completed times
  - affected project state
  - whether rebuild is required

---

## Mutation Sources That Must Mark Projects Dirty

These paths must call the new dirty-project API instead of queueing mart refresh tasks.

### New judgments / imported SQLite outbox judgments
Files to inspect/update:
- `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
- `src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- `src/agent/judge/judgeStoreJudgment.ts`
- any helpers that persist LLM judgments directly

Requirement:
- whenever a new LLM judgment is persisted, resolve all affected projects for the article and mark each affected project dirty

### Human assessments / review answers
Files to inspect/update:
- `src/server/routes/HumanAssessmentRoutes.ts`
- any service writing `app.judgment_human` / review-answer state

Requirement:
- whenever human answers change review completeness or article review state, resolve affected projects and mark them dirty

### Project and prompt configuration changes
Files to inspect/update:
- `src/server/routes/ProjectsRoutes.ts`
- `src/server/routes/PromptsRoutes.ts`
- project clone/archive/unarchive/import route mutation paths
- `src/server/routes/SubprojectsRoutes.ts`

Requirement:
- any change affecting project scope, enabled prompts, model linkage, or review-serving semantics marks the affected projects dirty

### Import pipeline / article membership changes
Files to inspect/update:
- `src/server/services/articleImportStoreService.ts`
- `src/server/services/insertArticlesIntoProject.ts`
- `src/server/routes/ProjectArticlesRoutes.ts`
- import routes / datasource import completion hooks

Requirement:
- any change that alters which articles belong to a project marks the affected projects dirty

### Warnings/progress data migration surface
Files to inspect/update:
- `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- `src/components/main/reviews/reviewsWarningsQuery.ts`
- `src/components/main/reviews/reviewsIndexingProgress.tsx`
- `src/components/main/reviews/reviewsProjectWarnings.tsx`

Requirement:
- preserve or intentionally migrate the progress/warnings contract to the new ledger-backed model

---

## Worker Design

### New files
- Create: `src/server/workers/projectMartRefreshWorker.ts`
- Create: `src/server/services/projectMartRefreshStateService.ts`
- Create: `scripts/runProjectMartRefreshWorker.ts`
- Create: `src/server/services/projectMartRefreshStateService.test.ts`
- Create: `src/server/workers/projectMartRefreshWorker.test.ts`

### Suggested service responsibilities

`projectMartRefreshStateService.ts`
- `markProjectsDirtyAtomically({projects, reason, requestedBy})`
  - where each item can include:
    - `projectId`
    - `articleIds` to merge into the bounded unresolved article accumulator
  - this must atomically:
    1. bump each project’s `dirty_token`
    2. merge/update article dirtiness for that exact project/token
    3. invalidate strict-count caches as needed
- `claimDirtyProjects({workerId, limit, leaseMs})`
- `heartbeatClaim({projectId, workerId, leaseMs})`
- `getDirtyArticlesForClaim({projectId, lastCompletedToken, claimedToken})`
- `completeProjectRefresh({projectId, workerId, completedToken})`
  - must also clear/trim resolved article dirtiness up to `completedToken`
- `failProjectRefresh({projectId, workerId, error})`
- `getProjectRefreshState(projectId)`
- `listDirtyProjects()`
- `invalidateProjectCaches(projectId)` for count caches as needed

Important constraint:
- do not split dirty-token bumping and article-dirtiness recording into two separate public calls
- the API must be atomic per project so a crash/concurrent write cannot leave a project dirty with missing article delta metadata

### Suggested worker loop
1. poll for dirty projects
2. claim one project
3. capture:
   - `claimed_token`
   - `last_completed_refresh_token`
4. resolve changed articles for the unresolved range:
   - `(last_completed_refresh_token, claimed_token]`
5. refresh judgment facts for all articles in that unresolved range
6. refresh project-serving state
7. on success:
   - set `last_completed_refresh_token = claimed_token`
   - clear/trim resolved article dirtiness through `claimed_token`
   - set status idle / complete timestamps
8. on failure:
   - record error and backoff
9. continue

Important constraint:
- the worker must never assume “articles tagged with claimed token only” is sufficient
- it must satisfy the full unresolved token range before considering the project fresh

### Lease model
Use DB-backed lease columns on the dirty-project row, not process-local state.
This must be resilient to process death.

### Ownership model
Preferred implementation:
- the worker runs only where DuckDB writer ownership is already allowed
- reuse current writer-role / DuckDB lease logic
- if a separate process/runtime is used, it must acquire the same writer lease before refresh execution

### Recommended first implementation detail
Process one project at a time.
Do not optimize concurrency until the system is stable.

---

## Review-Serving Refresh Strategy

### Phase 1: project-coalesced refresh with explicit judgment-fact stage

For each claimed dirty project/token:
1. refresh `mart.judgment_fact` for changed articles relevant to the token
2. run `refreshProject(projectId)`

This phase is intentionally correctness-first.
It does not rely on the current mart queue fan-out design.

Why phase 1 should do this:
- simplest correct behavior
- easiest to reason about
- avoids partial-staleness bugs
- avoids reviving crash-prone fine-grained queue fan-out prematurely
- preserves the required dependency that project-serving marts read from up-to-date `mart.judgment_fact`

### Phase 2: optional incremental optimization
After the worker is stable and correctness is proven:
- track touched article IDs per project/token
- for small deltas use:
  - `refreshJudgmentArticle(articleId)`
  - `refreshProjectArticleServing(projectId, articleId)`
- for large deltas or config changes, still use `refreshProject(projectId)`

---

## SQLite Import Architecture Follow-up

The current Bun/macOS stability work already reduced risk, but long-term architecture should also isolate import execution.

### Recommendation
Keep SQLite import out of the API server hot path.

Long-term preferred shape:
- use a subprocess or dedicated worker for background import cycles
- one job per invocation / per claim
- write imported judgments
- resolve all affected projects
- mark affected projects dirty
- let the mart refresh worker handle the rebuild

This cleanly separates:
- import correctness
- review-serving freshness
- worker orchestration

---

## Migration Plan

### Task 1: Add dirty-project ledger schema

Objective: Introduce the durable coalesced refresh state table with refresh-token semantics.

Files:
- Modify: migration files
- Modify: schema type files mirroring `app` tables
- Test: `src/server/services/projectMartRefreshStateService.test.ts`

Step 1: Write failing tests
- test dirty row creation for a project
- test repeated marks coalesce into one row while bumping `dirty_token`
- test claim/lease semantics
- test completion writes `last_completed_refresh_token`
- test failure transitions

Step 2: Add migration
- create `app.project_mart_refresh_state`
- add indexes on `refresh_status`, `lease_expires_at`, `dirty_token`

Step 3: Add schema typing

Step 4: Run tests

Step 5: Commit
- `git commit -m "feat: add project mart refresh state ledger"`

### Task 2: Add bounded unresolved article tracking for judgment-fact dependency

Objective: Preserve the upstream article refresh stage required before project-serving rebuilds without recreating one-row-per-event fan-out.

Files:
- Create/modify migration files for bounded article-dirty state
- Create: service helpers in `projectMartRefreshStateService.ts`
- Test: `src/server/services/projectMartRefreshStateService.test.ts`

Step 1: Write failing tests for:
- atomically marking one project dirty while merging changed article IDs
- atomically marking many projects dirty from one changed article fan-out
- deduping repeated article marks into one `(project_id, article_id)` row
- widening `first_dirty_token/last_dirty_token` instead of inserting a new row per event
- resolving dirty articles for the unresolved range `(last_completed_token, claimed_token]`
- trimming/clearing resolved article dirtiness after completion

Step 2: Add schema/service implementation
- preferred schema shape: one row per `(project_id, article_id)` with token range columns
- explicitly avoid one row per `(project_id, article_id, dirty_token)` event in the steady state

Step 3: Run tests

Step 4: Commit
- `git commit -m "feat: add bounded article dirtiness tracking for mart refresh"`

### Task 3: Implement state service

Objective: Wrap all dirty/claim/complete/fail operations in one service with atomic per-project dirtying.

Files:
- Create: `src/server/services/projectMartRefreshStateService.ts`
- Test: `src/server/services/projectMartRefreshStateService.test.ts`

Step 1: Write failing tests for:
- `markProjectsDirtyAtomically`
- per-project token assignment returned from one atomic call
- lease expiry recovery
- completion advancing refresh token
- failure recording
- cache invalidation hooks
- no split-brain state when concurrent dirty marks occur during worker processing

Step 2: Implement service
- do not expose a public two-step API of “mark dirty” then “record article dirtiness”
- either:
  - make `markProjectsDirtyAtomically` perform both actions transactionally, or
  - make it return a per-project token map and persist article dirtiness in that same transaction before commit

Step 3: Run targeted tests

Step 4: Commit
- `git commit -m "feat: add atomic project mart refresh state service"`

### Task 4: Add project dirty marking API with cross-project fan-out

Objective: Replace direct mart queue calls with project-dirty writes that resolve all affected projects.

Files:
- Modify: `src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts`
- Modify: `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- Modify: `src/agent/judge/judgeStoreJudgment.ts`
- Modify: `src/server/routes/HumanAssessmentRoutes.ts`
- Modify: `src/server/services/articleImportStoreService.ts`
- Modify: `src/server/services/insertArticlesIntoProject.ts`
- Modify: `src/server/routes/ProjectArticlesRoutes.ts`
- Modify: `src/server/routes/SubprojectsRoutes.ts`
- Modify: project/prompt/config mutation paths

Step 1: Write failing tests that assert dirty-project marking occurs after:
- imported judgments
- direct LLM judgments
- human assessments
- article membership changes
- prompt/project config changes

Step 2: Implement cross-project impact resolution
- changed article -> all active, non-archived affected projects
- changed project config -> affected project(s)

Step 3: Route all of those writes through `markProjectsDirtyAtomically`
- atomically bump each affected project token
- atomically merge bounded unresolved article dirtiness for each affected project
- atomically invalidate strict-count caches as needed

Step 4: Run tests

Step 5: Commit
- `git commit -m "feat: mark all affected projects dirty after judgment and scope mutations"`

### Task 5: Build refresh worker

Objective: Create a dedicated worker that processes dirty projects while obeying writer ownership.

Files:
- Create: `src/server/workers/projectMartRefreshWorker.ts`
- Create: `scripts/runProjectMartRefreshWorker.ts`
- Test: `src/server/workers/projectMartRefreshWorker.test.ts`

Step 1: Write failing tests for:
- claims one dirty project
- resolves changed articles for the claimed token
- rebuilds judgment facts first
- runs `refreshProject(projectId)` second
- marks success on completion
- records failure on exception
- resumes expired lease

Step 2: Implement polling/claim loop

Step 3: Integrate writer ownership checks / lease discipline

Step 4: Run tests

Step 5: Commit
- `git commit -m "feat: add project mart refresh worker"`

### Task 6: Integrate worker startup/runtime configuration

Objective: Make the worker runnable in development and production without violating writer ownership.

Files:
- Modify: startup scripts / package.json scripts
- Modify: background worker management helpers if needed
- Test: worker startup smoke tests if present

Step 1: Add scripts such as:
- `mart:worker`
- `dev:mart:worker`

Step 2: Decide runtime integration explicitly:
- preferred: existing worker-role stack owns DuckDB and refresh worker loop
- alternate: Node/tsx wrapper that participates in the same writer lease discipline

Step 3: Document local/dev startup path

Step 4: Commit
- `git commit -m "chore: wire project mart refresh worker into runtime scripts"`

### Task 7: Add read-side freshness checks and strict fallbacks

Objective: Stop silently preferring stale marts and preserve correctness-sensitive endpoint contracts, including review detail routes that bypass `duckdbOlap.ts`.

Files:
- Modify: `src/services/olap/duckdbOlap.ts`
- Modify: `src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts`
- Modify: `src/server/routes/JudgmentsJobsRoutes.ts`
- Modify: `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts`
- Test: review query tests / warnings tests / count tests / review-detail tests

Step 1: Write failing tests for:
- fresh project => mart fast path
- stale/running project => warnings endpoint reflects progress state
- strict count endpoints use raw fallback or bypass stale marts
- review detail route does not silently trust stale `mart.review_article_serving_detail`
- unassessed count cache invalidates when project/job becomes dirty

Step 2: Implement freshness gating
- cover both `duckdbOlap.ts` readers and direct review-detail readers

Step 3: Preserve or migrate `projectsreviewswarnings` response shape deliberately

Step 4: Run tests

Step 5: Commit
- `git commit -m "feat: gate serving reads on ledger freshness and preserve warnings contract"`

### Task 8: Retire legacy Bun/macOS mart queue workaround once replacement is live

Objective: Remove the current workaround only after the new architecture is active.

Files:
- Modify: `src/server/services/getDuckdbMartRefreshService.ts`
- Modify: `src/server/utils/martRefreshDrainHeartbeat.ts`
- Test: relevant mart refresh tests

Step 1: keep direct refresh primitives
Step 2: remove obsolete queue-on-write assumptions
Step 3: retain manual refresh APIs/scripts if still useful
Step 4: commit
- `git commit -m "refactor: retire legacy Bun mart queue workaround"`

### Task 9: Optional phase-2 optimization for article-level incremental refresh

Objective: Reintroduce lighter-weight updates where safe.

Files:
- Modify: state service and worker implementation
- Add tests for delta vs full rebuild routing

Step 1: add stable changed-article resolution per project/token
Step 2: choose threshold-based strategy:
- small delta => article refresh + project article-serving refresh
- large delta => full project refresh
Step 3: verify correctness against review pages/counts
Step 4: commit
- `git commit -m "feat: add incremental article-aware mart refresh routing"`

---

## Verification Checklist

The implementation is not complete until all of the following are true:

1. After a new imported LLM judgment:
- `/projects/$id/reviews-llm` updates automatically
- `/projects/$id/reviews-unassessed` removes/moves the article automatically
- `/api/articlesreviewscount` reflects the change automatically
- `/api/judgmentsjobs-unassessed-count` reflects the change automatically
- prompt queue generation sees the article/prompt as freshly assessed

2. After a human assessment update:
- `/projects/$id/reviews-both` and related review pages update automatically
- review completeness state is correct

3. After project/prompt/import-route/article-membership mutations:
- affected project review pages rebuild automatically
- filters/counts match the new scope

4. Cross-project propagation is correct:
- one article shared by multiple projects updates all affected projects automatically after judgment changes

5. `projectsreviewswarnings` still supplies the data the frontend expects, either in compatible form or via an intentional migrated contract.

6. If the worker crashes mid-refresh:
- lease expires
- another worker can resume
- project remains dirty
- strict-correctness endpoints remain correct via fallback

7. Bun/macOS API process no longer depends on the old mart queue/timer path.

---

## Recommended Commands During Implementation

Targeted tests/examples (adapt to your actual suite names):
- `bun test src/server/services/projectMartRefreshStateService.test.ts`
- `bun test src/server/workers/projectMartRefreshWorker.test.ts`
- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts`
- `bun test src/services/olap/duckdbOlap*.test.ts`
- `bun test src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings*.test.ts`

Smoke tests:
- start API server
- start refresh worker under the chosen ownership model
- inject/import a judgment on an article shared by multiple projects
- verify all affected project review pages and counts update automatically
- verify unassessed count and prompt queue generation update automatically

---

## Reasonable Path Forward

The most reasonable long-term path is:

1. Keep project-level coalescing as the primary orchestration boundary.
2. Preserve a bounded article-change accumulator per project so `mart.judgment_fact` can be refreshed correctly before project-serving rebuilds.
3. Use unresolved-range semantics `(last_completed_refresh_token, claimed_token]`, not “current token only” lookups.
4. Make dirtying atomic per project: token bump + article-change merge + cache invalidation in one transaction.
5. Run the refresh worker under the existing writer-ownership model.
6. Start with correctness-first project rebuilds after article-fact refresh, then optimize later.

Concretely, phase 1 should be:
- mutation happens
- resolve all affected projects
- atomically bump each affected project’s dirty token and merge changed article IDs into its bounded unresolved article state
- worker claims one project
- worker loads unresolved article IDs for `(last_completed_refresh_token, claimed_token]`
- worker runs article judgment-fact refresh for those articles
- worker runs `refreshProject(projectId)`
- worker marks `last_completed_refresh_token = claimed_token`
- worker trims/clears resolved article dirtiness through `claimed_token`

Why this is the right long-term architecture:
- It matches the system’s real correctness boundary: projects must become fresh, but article judgment facts still feed the project-serving marts.
- It avoids the brittle one-row-per-event mart queue model.
- It avoids replacing that queue with a new unbounded project/article/token fan-out table.
- It gives you durable, observable refresh state.
- It restores automatic updates for all critical review/count surfaces.
- It preserves cross-project correctness for shared articles.
- It creates a clean path to later article-level optimization without tying correctness to Bun/macOS-native behavior.

## Recommendation

Implement this plan with project-level dirty coalescing, bounded unresolved article tracking, and an explicit article-fact refresh stage.
