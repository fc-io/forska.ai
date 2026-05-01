# Shared Prompt Plan

## Goal

Keep project prompts shared by content in normal project flows, avoid prompt copy semantics, and make judgment reuse and visibility consistent across queueing, marts, and review details.

Touched layers: server, database, client

## Current Repo State

1. Shared prompt creation already exists via the immutable prompt helper, which hashes:
   - `original_text`
   - `transformed_text`
   - `prompt_heading`
   - `type`
2. Project create and project edit already reuse or repoint to shared `app.prompt` rows instead of mutating prompt content in place.
3. Project clone already reuses source `prompt_id` values and preserves per-project metadata on `app.project_prompt`.
4. Judgment queue reuse already keys off:
   - `article_id`
   - `prompt_id`
   - `model_id`
   - `use_title`
   - `use_abstract`
   - `use_fulltext`
   - `use_fulltext_no_images`
5. Incremental mart refresh already allows cross-project LLM judgment reuse for matching prompt/config combinations on in-scope articles.
6. Large rebuild mart logic still applies stricter project/snapshot judgment joins, so rebuilt marts can diverge from incremental refresh behavior unless we align them deliberately.
7. The stale or running review-details fallback path still filters raw LLM judgments to the same project only, so it can disagree with fresh mart-backed results.
8. `origin_project_id` is already mostly legacy. Normal create, edit, clone, and Covidence flows write `NULL`, but model-detach and archived-project cleanup still read it.
9. Prompt archival is still underspecified. `app.prompt.archived` is mutable global state, `app.project_prompt.archived` already exists for per-project archive state, and immutable prompt lookup currently includes `archived` in its lookup behavior.

## Desired Behavior

1. Treat shared prompt reuse in project create, edit, and clone as established behavior and keep it that way.
2. Treat prompt content identity as:
   - `original_text`
   - `transformed_text`
   - `prompt_heading`
   - `type`
3. Do not let archived state create parallel prompt identities or accidental hash conflicts.
4. Reuse LLM judgments across projects only when all judgment-affecting inputs match.
5. Use one consistent rule for when a project can see a reusable judgment across:
   - incremental mart refresh
   - large rebuild mart refresh
   - stale/raw review-detail fallback
6. Keep project or import-route scope out of the intrinsic judgment natural key, but never surface or skip work for articles outside the target project's scope.
7. Keep `origin_project_id` as legacy-only metadata unless the remaining detach and cleanup paths still require it after audit.

## Judgment-Affecting Inputs

These must match before LLM judgments are reused:

1. `article_id`
2. `prompt_id`
3. `model_id`
4. `use_title`
5. `use_abstract`
6. `use_fulltext`
7. `use_fulltext_no_images`

## Remaining Work

### 0. Add regression tests before any behavior change

Test-first requirement:

1. Add the clone and judgment regression tests before changing prompt, queue, mart, or review-details behavior.
2. Run the targeted regression suite immediately after adding the tests and before implementation work starts.
3. For a test that intentionally captures a known current bug, allow the first run to fail, record that failure as expected pre-change evidence, then use the same test as the proof that the implementation fixed the bug.
4. Do not merge behavior changes without keeping these regression tests in place.

Required pre-change regression scenarios:

1. Clone a project, edit the cloned project's prompt content, rerun judgments for the clone, and verify the source project still points at the original prompt and keeps its original judgment behavior.
2. Clone a project, change the cloned project's `model_id`, rerun judgments, and verify the clone does not reuse source judgments while the source project remains unchanged.
3. Clone a project, change the cloned project's `use_title`, rerun judgments, and verify no accidental reuse from the source project.
4. Clone a project, change the cloned project's `use_abstract`, rerun judgments, and verify no accidental reuse from the source project.
5. Clone a project, change the cloned project's `use_fulltext`, rerun judgments, and verify no accidental reuse from the source project.
6. Clone a project, change the cloned project's `use_fulltext_no_images`, rerun judgments, and verify no accidental reuse from the source project.
7. For unchanged clone settings, verify rerunning judgments still safely reuses shared judgments without mutating or hiding source-project results.

### 1. Resolve prompt archival semantics

Preferred direction:

1. Keep `content_hash` as the canonical prompt identity for normal project flows.
2. Keep `app.project_prompt.archived` as the per-project archive flag.
3. Treat `app.prompt.archived` as global library or admin metadata, not as a second prompt identity dimension.
4. Update immutable prompt lookup and any project prompt reuse path so lookup is driven by content hash rather than archived state.
5. Decide and document what happens when a project references a hash-matching prompt row whose global `app.prompt.archived` flag is already `TRUE`:
   - either reuse the archived canonical row without minting a duplicate row
   - or automatically unarchive that canonical row when it becomes linked again
6. Keep prompt admin hash or archive endpoints from breaking the one-row-per-hash invariant.

### 2. Narrow `origin_project_id` work to the remaining live paths

1. Keep normal create, edit, clone, and import flows writing `NULL`.
2. Audit the model-update detach plan against shared prompt links instead of assumed project-owned prompt copies.
3. Audit archived-project cleanup so it does not accidentally preserve obsolete ownership semantics.
4. After the audit, either:
   - leave `origin_project_id` as nullable legacy metadata only
   - or remove the remaining active reads if they are no longer needed

### 3. Make judgment visibility consistent across all read paths

1. Define one reusable eligibility rule for when a judgment is visible to a target project.
2. Apply that rule to:
   - incremental mart refresh
   - large rebuild executor
   - project review details when mart data is stale or running and the route falls back to raw `app.judgment`
3. The fallback route should filter by:
   - article in target project scope
   - prompt linked and enabled for the target project
   - matching model and content flags
   - the standardized project or snapshot visibility rule
4. Keep `allJudgments` or any diagnostic view separate from the main project-visible judgments list if the UI still wants a cross-project inspection surface.

### 4. Keep queue reuse strict and explicit

1. Preserve the existing LLM judgment natural key:
   - `article_id`
   - `prompt_id`
   - `model_id`
   - `use_title`
   - `use_abstract`
   - `use_fulltext`
   - `use_fulltext_no_images`
2. Add explicit regression coverage for:
   - different `model_id`
   - different content flags
   - same article and prompt reused from another project
3. Keep import-route membership out of the intrinsic natural key, but only skip work when the article is actually in the target project's scope.

### 5. Align fresh and rebuilt mart behavior

1. Treat parity between incremental refresh and large rebuild as a requirement if both remain supported paths.
2. If large rebuild stays in use, align its judgment eligibility logic with the chosen shared-judgment visibility rule instead of letting it stay project-scoped by default.
3. If any intentional difference remains, document it explicitly and keep review surfaces consistent with that decision.

### 6. Update tests

Keep the existing shared-prompt regression tests for create, edit, and clone. Add or update tests for:

1. Clone-edit-rerun regression coverage where the cloned project changes prompt content and the source project remains unaffected.
2. Clone-edit-rerun regression coverage for changed `model_id`, `use_title`, `use_abstract`, `use_fulltext`, and `use_fulltext_no_images`.
3. Unchanged clone settings still reuse shared judgments without mutating source-project prompt or judgment visibility.
4. Stale review-details fallback shows project-visible reused judgments instead of hiding them behind same-project-only filtering.
5. Incremental mart refresh and large rebuild agree on cross-project reusable judgments.
6. Different `model_id` prevents queue reuse.
7. Different content flags prevent queue reuse.
8. Out-of-scope articles do not leak reused judgments.
9. Archived prompt reuse follows the chosen canonical behavior.

## Risks

1. `app.prompt.archived` and `content_hash` can still conflict if archival semantics remain fuzzy.
2. Incremental marts, large rebuilds, and stale review-details fallback can drift into different truth models.
3. Remaining `origin_project_id` reads may preserve old project-owned prompt assumptions.
4. Prompt admin endpoints still mutate global shared prompt rows and can surprise project flows.
5. Historical prompt rows with `NULL` content hashes still exist and must not break mixed-state reads.

## Migration Notes

1. No destructive backfill is required.
2. Existing hash-backed shared prompts remain valid.
3. Historical detached prompts and `NULL` hash rows can remain as legacy data; new project flows should keep preferring hash-backed lookup.
4. If archival semantics change, prefer the smallest migration that preserves one canonical row per content hash.

## Quality Gates

Pass/fail checks for this change:

1. Add the new regression tests first and run the targeted suite before implementation changes.
2. `bun test src/server/routes/ProjectsRoutes.test.ts`
3. `bun test src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts`
4. `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`
5. `bun test src/server/services/getDuckdbMartRefreshService.test.ts`
6. If large rebuild eligibility changes, `bun test src/server/services/projectMartLargeRebuildExecutor.test.ts`
7. `bun run lint`

## Commands To Run

1. Add the new regression tests in the targeted files before implementation.
2. Run targeted `bun test` commands for project routes, review-details fallback, queue reuse, and mart refresh behavior before code changes.
3. Re-run the same targeted `bun test` commands after implementation.
4. `bun run lint`

## Open Decisions During Build

1. Whether re-linking a globally archived prompt should reuse the archived row as-is or unarchive the canonical row.
2. Whether to fully retire `origin_project_id` after the detach and cleanup audit or leave it as legacy nullable metadata.
3. Where the shared project-visible judgment eligibility rule should live so incremental marts, large rebuilds, and fallback reads all use the same logic.
