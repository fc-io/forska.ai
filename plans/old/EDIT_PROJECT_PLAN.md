# Edit Project Feature Checklist

## Goal

- [x] Allow judged projects to edit only project title/name, description, and prompts.
- [x] Keep judgment-critical configuration locked when a judgment job exists.
- [x] Replace prompts immutably so only changed prompts need rerun.
- [x] Reuse unchanged judgments.
- [x] Soft-delete old LLM judgments only when no other active project or comparison project uses them.
- [x] Hard-delete only project-scoped human prompt answers for old replaced or removed prompts.

## Locked Fields

- [x] Keep model locked when a judgment job exists.
- [x] Keep `useTitle` locked when a judgment job exists.
- [x] Keep `useAbstract` locked when a judgment job exists.
- [x] Keep `useFulltext` locked when a judgment job exists.
- [x] Keep `useFulltextNoImages` locked when a judgment job exists.
- [x] Keep date filters locked when a judgment job exists.
- [x] Keep import routes locked when a judgment job exists.
- [x] Keep human judgment mode locked when a judgment job exists.

## Server Features

- [x] Evaluated project edit change-set helper extraction; kept logic inline to avoid an unnecessary refactor.
- [x] Detect metadata-only changes separately from prompt changes.
- [x] Detect protected field changes and return the exact protected fields that changed.
- [x] In judged-project restricted mode, validate protected fields only when they are explicitly changed.
- [x] Detect prompt replacement candidates with old prompt id, project prompt id, and reason.
- [x] Resolve submitted prompts to target immutable prompt ids before deleting or repointing any links.
- [x] Reject duplicate active target prompt ids in the same project before cleanup or link mutation.
- [x] Allow `/api/projects/:id` simple patch for name and description even when a judgment job exists.
- [x] Keep archived and delete-pending project checks on all edit routes.
- [x] Update `/api/projects/:id/edit` so no-job projects keep current full edit behavior.
- [x] Update `/api/projects/:id/edit` so judged projects reject protected config changes.
- [x] Update `/api/projects/:id/edit` so judged projects allow name and description changes.
- [x] Update `/api/projects/:id/edit` so judged projects allow safe prompt changes.
- [x] Return 409 for prompt changes while the job has unsafe local SQLite state or active work.
- [x] Use clear 409 text, such as `Pause or drain the judgment job before editing prompts.`
- [x] Preserve the existing edit response fields `{project, prompts}`.
- [x] Add an optional prompt cleanup summary to the edit response.

## Prompt Editing Features

- [x] Keep prompt rows immutable; do not update old `app.prompt` text or metadata in place.
- [x] Use `getOrCreateImmutablePromptTx()` for changed prompt text, heading, or type.
- [x] Reuse an existing immutable prompt row when the content hash matches.
- [x] Treat reused immutable prompt rows as full content matches, so matching active LLM judgments remain reusable.
- [x] Create a new immutable prompt row when no matching content hash exists.
- [x] Allow prompt heading and type to be cleared to null or empty values intentionally.
- [x] Do not globally unarchive reused immutable prompt rows during judged-project edits.
- [x] Repoint only this project's `app.project_prompt.prompt_id` for replaced prompts.
- [x] Preserve prompt order.
- [x] Preserve enabled state.
- [x] Preserve archived state.
- [x] Preserve origin project id where appropriate: edited/reused links detach ownership to `NULL`, while criteria metadata is preserved.
- [x] Preserve criteria disposition.
- [x] Preserve criteria section key.
- [x] Preserve criteria section label.
- [x] Do not move old-prompt LLM judgments to the new prompt id.
- [x] Treat newly created prompt ids as unjudged until rerun.
- [x] Allow prompt reorder without deleting LLM or human judgments.
- [x] Decide and document whether importable prompt disable counts as removal. It does not count as removal; preserve answers for re-enable.

## LLM Judgment Cleanup Features

- [x] Candidate old LLM judgments must have `deleted_at IS NULL`.
- [x] Candidate old LLM judgments must match old replaced or removed prompt ids.
- [x] Candidate old LLM judgments must match the edited project's model id.
- [x] Candidate old LLM judgments must match the edited project's `useTitle`.
- [x] Candidate old LLM judgments must match the edited project's `useAbstract`.
- [x] Candidate old LLM judgments must match the edited project's `useFulltext`.
- [x] Candidate old LLM judgments must match the edited project's `useFulltextNoImages`.
- [x] Candidate old LLM judgments must be scoped to articles visible in the edited project before the prompt edit.
- [x] Keep old LLM judgments if another non-archived project uses the same prompt id, model, content flags, and article scope.
- [x] Keep old LLM judgments if any non-archived comparison project references the old prompt id.
- [x] Soft-delete only candidate old LLM judgments not kept by shared usage rules.
- [x] Set `deleted_at` when soft-deleting old LLM judgments.
- [x] Set `updated_at` when soft-deleting old LLM judgments.
- [x] Bump `delete_generation` safely when soft-deleting old LLM judgments so future same-key reruns can insert active rows.
- [x] Keep `judgment_assessment` rows for auditability.
- [x] Keep token usage rows for auditability.
- [x] Keep execution snapshots and job telemetry for auditability.
- [x] Do not delete `app.prompt` rows as part of this feature.

## Performant Shared-Usage Check

- [x] Implement the shared-usage check with set-based SQL, not per-judgment loops.
- [x] Restrict candidate judgment queries by old prompt ids first.
- [x] Materialize changed prompt links into a small temp table or compact CTE.
- [x] Materialize candidate articles for the edited project before prompt link mutation.
- [x] Materialize candidate active judgments by old prompt id, candidate article id, model id, and content flags.
- [x] Materialize other candidate projects by same prompt id, model id, and content flags.
- [x] Restrict other project route scope by candidate article ids before joining broad route tables.
- [x] Restrict other project curated scope by candidate article ids before joining broad project article tables.
- [x] Apply other projects' date filters in the shared-usage check.
- [x] Exclude archived projects from shared active project usage.
- [x] Exclude the edited project itself from other active project usage.
- [x] Materialize active comparison prompt usage as a prompt-level keep set.
- [x] Avoid full scans over `app.judgment`.
- [x] Avoid JSON, full text, or historical job-table scans in cleanup queries.
- [ ] Add an explain or snapshot-query check during implementation for a large project before merging.

## Human Judgment Cleanup Features

- [x] Delete `app.judgment_human` rows only for the edited project and old replaced or removed prompt ids.
- [x] Delete both answered and pending human prompt rows for old replaced or removed prompt ids.
- [x] Do not delete `app.judgment_human` rows for other projects.
- [x] Do not touch `app.judgment_human_summary` for judged project edits because human judgment mode remains locked.
- [x] Ensure article detail human-answer aggregation reads only the edited project and current prompt ids after prompt edits.

## Job State Features

- [x] Classify the edit before checking job state.
- [x] Allow title and description edits even if a job is running.
- [x] Require safe job state for prompt-changing edits.
- [x] Treat no `app.judgment_job` row as safe.
- [x] Treat a job with no active local SQLite queue rows as potentially safe.
- [x] Treat a job with no in-flight rows as potentially safe.
- [x] Treat a job with no unexported outbox rows as potentially safe.
- [x] Treat a job with no claimed outbox rows as potentially safe.
- [x] Treat paused, completed, or drained jobs as safe only if retained SQLite state is drained or can be reset safely before rerun.
- [x] Reject prompt changes while stale old-prompt queue or outbox work can still be imported.
- [x] Do not silently rerun jobs when saving edits.
- [x] If a job row exists, guide rerun through `start-clean` or an equivalent existing clean rerun path.
- [x] Ensure a rerun queues only unassessed pairs for the changed prompt ids.

## Mart And Serving Features

- [x] Mark the edited project dirty project-wide when prompts are added.
- [x] Mark the edited project dirty project-wide when prompts are removed.
- [x] Mark the edited project dirty project-wide when prompts are replaced.
- [x] Mark the edited project dirty project-wide when prompts are reordered.
- [x] Mark the edited project dirty project-wide when prompts are enabled, disabled, or archived.
- [x] Mark affected article projects dirty for soft-deleted LLM judgments when article-level dirty state is needed. Project-wide dirty materialization is sufficient for this edit path.
- [x] Invalidate comparison serving when deleted judgments can affect comparison views.
- [x] Invalidate comparison serving when changed source project prompt metadata can affect comparison views.
- [x] Ensure unassessed endpoints use raw fallback or fresh mart state after prompt edits.
- [x] Treat dirty prompt-set state as stale even when review serving row counts still match article scope counts.
- [x] Ensure browser/web and desktop flows remain aligned for shared edit UI changes.

## Client Features

- [x] Replace single `isLocked()` in `src/app/routes/+projects/+$id/+edit.tsx` with field-level edit permissions.
- [x] Add client-side permission state for metadata, prompts, and judgment config.
- [x] In judged-project restricted mode, submit only allowed fields and omit protected config fields.
- [x] In judged-project restricted mode, do not call model ensure unless the model field is editable and changed.
- [x] Keep model selector disabled for judged projects.
- [x] Keep date range controls disabled for judged projects.
- [x] Keep import route controls disabled for judged projects.
- [x] Keep article title, abstract, and full-text toggles disabled for judged projects.
- [x] Enable project name for judged projects.
- [x] Enable description for judged projects.
- [x] Enable add prompt when prompt editing is allowed.
- [x] Enable prompt heading editing when prompt editing is allowed.
- [x] Enable prompt type editing when prompt editing is allowed.
- [x] Enable prompt text editing when prompt editing is allowed.
- [x] Enable prompt order editing when prompt editing is allowed.
- [x] Enable prompt removal when prompt editing is allowed.
- [x] Enable importable prompt checkbox only if server semantics are safe.
- [x] Enable submit for allowed restricted edits.
- [x] Replace `Project Locked for Editing` with partial-lock copy.
- [x] Explain that judgment config fields remain locked to preserve existing judgment integrity.
- [x] Avoid sending protected field updates from the client in restricted mode where possible.
- [x] Still rely on server validation for protected field enforcement.
- [x] Preserve intentional clearing of prompt heading and type instead of omitting empty values.
- [x] Show cleanup summary or rerun guidance after prompt edits if returned by the server.
- [x] If an existing job row remains, guide the user to clean rerun rather than duplicate job creation.

## Response And Logging Features

- [x] Return `changedPromptLinks` in the prompt cleanup summary.
- [x] Return `deletedHumanPromptAnswers` in the prompt cleanup summary.
- [x] Return `keptSharedLlmJudgments` in the prompt cleanup summary.
- [x] Return `softDeletedLlmJudgments` in the prompt cleanup summary.
- [x] Return `skippedComparisonPromptReferencedJudgments` in the prompt cleanup summary.
- [x] Log cleanup summary with project id and changed prompt ids.
- [x] Do not log prompt full text unless needed for an existing debugging convention.

## Data Integrity Checklist

- [x] Prompt replacement creates a new or reused immutable prompt id.
- [x] Prompt replacement does not mutate the old prompt row.
- [x] Prompt replacement that resolves to an existing immutable prompt reuses matching active judgments by natural key.
- [x] Prompt replacement cannot collapse two project prompt links into one duplicate target prompt id.
- [x] Reusing an archived immutable prompt does not globally unarchive that prompt row.
- [x] Existing judgments for unchanged prompts remain visible.
- [x] New replaced prompt is unassessed for all scoped articles until rerun.
- [x] Removed prompts reduce required prompt count.
- [x] Other project usage keeps old LLM judgments active.
- [x] Active comparison prompt usage keeps old LLM judgments active.
- [x] Old project-scoped human answers for removed or replaced prompts are gone.
- [x] Project-wide dirty state is queued after any prompt-set change.
- [x] No protected config fields change while a job exists.
- [x] Running jobs cannot import stale old-prompt outbox rows after a prompt edit.
- [x] Existing no-job project editing behavior is not regressed.

## Server Test Checklist

- [x] `ProjectsRoutes.test.ts`: existing judgment job allows name-only edit.
- [x] `ProjectsRoutes.test.ts`: existing judgment job allows description-only edit.
- [x] `ProjectsRoutes.test.ts`: simple patch route allows name and description edit when a judgment job exists.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects model change.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects `useTitle` change.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects `useAbstract` change.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects `useFulltext` change.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects `useFulltextNoImages` change.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects date filter changes.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects import route changes.
- [x] `ProjectsRoutes.test.ts`: existing judgment job rejects human judgment mode changes.
- [x] `ProjectsRoutes.test.ts`: existing judgment job allows safe prompt replacement.
- [x] `ProjectsRoutes.test.ts`: safe prompt replacement returns a cleanup summary.
- [x] `ProjectsRoutes.test.ts`: safe prompt replacement rejects duplicate target prompt ids before cleanup.
- [x] `ProjectsRoutes.test.ts`: prompt replacement can clear heading and type.
- [x] `ProjectsRoutes.test.ts`: prompt replacement creates a new immutable prompt when content hash is new.
- [x] `ProjectsRoutes.test.ts`: prompt replacement reuses an immutable prompt when content hash exists.
- [x] `ProjectsRoutes.test.ts`: prompt replacement reuses matching active judgments when content hash exists.
- [x] `ProjectsRoutes.test.ts`: prompt replacement does not globally unarchive a reused archived prompt row.
- [x] `ProjectsRoutes.test.ts`: prompt replacement preserves order, heading, type, enabled state, and criteria metadata.
- [x] `ProjectsRoutes.test.ts`: old prompt LLM judgments not used elsewhere are soft-deleted.
- [x] `ProjectsRoutes.test.ts`: soft-deleted LLM judgments get a bumped `delete_generation`.
- [x] `ProjectsRoutes.test.ts`: old prompt LLM judgments used by another active route-scoped project are kept.
- [x] `ProjectsRoutes.test.ts`: old prompt LLM judgments used by another active curated project are kept.
- [x] `ProjectsRoutes.test.ts`: other project date filters are respected in shared-usage checks.
- [x] `ProjectsRoutes.test.ts`: old prompt LLM judgments used only by archived projects can be soft-deleted.
- [x] `ProjectsRoutes.test.ts`: old prompt LLM judgments used by an active comparison project are kept.
- [x] `ProjectsRoutes.test.ts`: old prompt human judgments for the edited project are deleted.
- [x] `ProjectsRoutes.test.ts`: human judgments for other projects are not deleted.
- [x] `ProjectsRoutes.test.ts`: prompt reorder does not delete LLM judgments.
- [x] `ProjectsRoutes.test.ts`: prompt reorder does not delete human judgments.
- [x] `ProjectsRoutes.test.ts`: prompt edit with unsafe running/local SQLite state returns 409.
- [x] `ProjectsRoutes.test.ts`: no-job edit behavior still supports currently allowed full edit fields.
- [x] `ProjectsRoutes.test.ts`: restricted judged-project edit does not validate an unchanged protected model.

## Cleanup Helper Test Checklist

- [x] Shared-usage helper handles route scope without scanning unrelated prompt ids.
- [x] Shared-usage helper handles curated `project_article` scope without scanning unrelated prompt ids.
- [x] Shared-usage helper applies other project date filters.
- [x] Shared-usage helper excludes the edited project.
- [x] Shared-usage helper excludes archived projects.
- [x] Shared-usage helper keeps prompt-level comparison references conservatively.
- [x] Candidate query returns only matching model and content settings.
- [x] Candidate query ignores already deleted judgments.

## OLAP And Mart Test Checklist

- [x] `duckdbOlap.test.ts`: after prompt replacement, unassessed pairs include only the new prompt for already judged articles.
- [x] `duckdbOlap.test.ts`: unchanged prompts remain judged after replacement of another prompt.
- [x] `duckdbOlap.test.ts`: removed prompt reduces complete prompt requirement.
- [x] Relevant mart worker test: dirty project state is queued after prompt replacement.
- [x] Relevant mart worker test: unassessed endpoints prefer raw fallback until mart refresh catches up.
- [x] Relevant OLAP test: stale serving rows are bypassed after prompt replacement even when article scope row counts are unchanged.
- [x] Relevant comparison serving test: comparison serving is invalidated when needed.

## Client Test Checklist

- [x] `src/app/routes/+projects/+$id/-+edit.vitest.tsx`: judged project shows partial-lock copy instead of full-lock copy.
- [x] Edit route test: name field is editable for judged projects.
- [x] Edit route test: description field is editable for judged projects.
- [x] Edit route test: prompt heading is editable when prompt editing is allowed.
- [x] Edit route test: prompt type is editable when prompt editing is allowed.
- [x] Edit route test: prompt text is editable when prompt editing is allowed.
- [x] Edit route test: prompt order is editable when prompt editing is allowed.
- [x] Edit route test: add prompt is enabled when prompt editing is allowed.
- [x] Edit route test: remove prompt is enabled when prompt editing is allowed.
- [x] Edit route test: model selector remains disabled for judged projects.
- [x] Edit route test: date controls remain disabled for judged projects.
- [x] Edit route test: import route controls remain disabled for judged projects.
- [x] Edit route test: content setting toggles remain disabled for judged projects.
- [x] Edit route test: submit is enabled for allowed restricted edits.
- [x] Edit route test: payload does not intentionally change protected fields in restricted mode.
- [x] Edit route test: restricted submit does not call model ensure for unchanged locked model.
- [x] Edit route test: clearing prompt heading and type is represented in the payload.
- [x] Edit route test: server 409 for unsafe prompt edit is surfaced to the user.
- [x] Edit route test: cleanup summary or rerun guidance renders if provided.

## Regression Test Checklist

- [x] Existing create project tests still pass.
- [x] Existing immutable prompt reuse tests still pass.
- [x] Existing project clone tests still pass.
- [x] Existing judgment job start-clean tests still pass.
- [x] Existing judgment job delete tests still pass.
- [x] Existing judgment job SQLite service tests still pass if job safety helpers are touched.

## Quality Gates

- [x] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [x] `bunx vitest run './src/app/routes/+projects/+$id/-+edit.vitest.tsx'`
- [x] `bun test src/services/olap/duckdbOlap.test.ts` if OLAP behavior is touched.
- [x] `bun test src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts` if job safety helpers touch SQLite job state.
- [x] `bun run lint`
- [x] `bun run build`
- [ ] Browser verification: edit a judged project, change title and description, and confirm protected fields remain locked.
- [ ] Browser verification: edit one prompt on a judged project and confirm rerun queues only the changed prompt.
- [x] Desktop verification: run `bun run desktop:build` if shared edit UI or runtime asset paths change.

## Rollout Checklist

- [x] Keep first implementation conservative: if shared usage cannot be proven false, keep the judgment.
- [x] Prefer soft-delete for LLM judgments over hard delete.
- [x] Keep cleanup summary available in logs or response data for auditability.
- [x] Require the operator to pause, drain, or start-clean when prompt edits would conflict with active job work.
- [x] Keep rerun as an explicit user/job action after saving edits.
