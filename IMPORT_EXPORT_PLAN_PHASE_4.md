# Project Import/Export Plan Phase 4

## Scope

- Build final import commit behavior after analyze and dependency resolution are complete.
- Source orchestrator: [IMPORT_EXPORT_PLAN.md](./IMPORT_EXPORT_PLAN.md).
- External prerequisites: Phases 1 through 3 are complete and analyze can produce a frozen, commit-ready plan.
- Do not add new package export behavior in this phase except commit-time revalidation needed to consume exported packages safely.

## Ralph Conversion Metadata

- `name`: `Project Transfer Commit`
- `branchName`: `ralph/project-transfer-commit`
- `description`: `Implement final-path asset promotion, transactional import commit, remapped writes, judgment and review fidelity preservation, mart refresh dirtying, rollback, and commit recovery.`
- Convert only `Ralph User Stories` into `userStories[]`.

## Ralph User Stories

### US-001: Add asset promotion and rollback foundation

Description: As an implementer, I need asset promotion to move only still-needed validated assets into final runtime-owned paths before database writes.

dependsOn: []

Acceptance criteria:

- Promote only assets referenced by the frozen import plan into session-owned final `assets/...` paths.
- Persist and update `promotionManifest.json` before and after each copy/checksum step.
- Fail before database writes on copy, checksum, destination collision, or rewrite failures.
- Best-effort delete only files created for the failed import session when later database work fails.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-002: Add project, prompt, article, route, and link commit writer

Description: As an implementer, I need a dedicated project-transfer commit writer so imported projects preserve package semantics without reusing clone or generic article import behavior.

dependsOn: ["US-001"]

Acceptance criteria:

- Create the new active project with target timestamps and normalized `humanJudgmentMode`.
- Remap immutable prompts through canonical prompt content hashes, preserve project-prompt link metadata, and block post-remap duplicate project-prompt links.
- Create or non-destructively merge article rows according to analyzed identifier and missing-field plans.
- Create project article links, safe route links, safe article-route links, and snapshot fallback links with source provenance outside clone-specific columns.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun run db:mig` passes if typed DB records or schema changed in this phase.
- `bun run lint` passes for touched `src` files.

### US-003: Add judgment, assessment, human judgment, summary, and review commit writer

Description: As an implementer, I need dedicated import writers for durable decision state so imported rows point at remapped ids and global judgment/assessment conflicts are never hidden.

dependsOn: ["US-002"]

Acceptance criteria:

- Insert only new judgments preclassified as safe; reuse only equivalent existing judgments without mutating snapshot labels.
- Write `is_answered = TRUE`, `delete_generation`, `deleted_at = NULL`, `snapshot_project_id`, `snapshot_project_model_name`, answer fields, timestamps, and non-null `confidence_original` for new imported judgments.
- Re-link assessments, human judgments, human summaries, and review rows through new project/article/prompt/judgment ids.
- Block missing, extra, or different global judgment assessments instead of mutating unrelated global rows.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts` passes if provider/model commit paths are touched.
- `bun run lint` passes for touched `src` files.

### US-004: Add commit-time revalidation and idempotent retry behavior

Description: As an implementer, I need final commit requests to revalidate stale-sensitive plan assumptions and be idempotent per session.

dependsOn: ["US-002", "US-003"]

Acceptance criteria:

- Reject stale `planRevision` before asset promotion or database writes.
- Revalidate provider/model selectability, article matches, route safety, judgment conflicts, `judgmentInputSignature`, and `humanReviewInputSignature` immediately before commit.
- Use a server-generated `commitId` and compare-and-set transition to `committing` before promotion.
- Completed-session commit retries return recorded completion for the same session without replaying writes.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-005: Add transfer history, crash recovery, and completion persistence

Description: As an implementer, I need commit completion and crash recovery to rely on transfer history rather than filesystem artifacts alone.

dependsOn: ["US-004"]

Acceptance criteria:

- Write completed transfer-history row with import session id, commit id, target project snapshot, counts, and completion payload inside the successful transaction.
- Persist `completion.json` after transaction success.
- Recover completion from transfer history if the transaction committed before `completion.json` was written.
- Do not delete promoted assets for sessions with completed import history.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts` passes.
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts` passes.
- `bun run lint` passes for touched `src` files.

### US-006: Add mart refresh dirtying and unarchive rebuild safety

Description: As an implementer, I need imported and shared article changes to dirty the correct active projects without depending on archived dirty rows.

dependsOn: ["US-002", "US-003"]

Acceptance criteria:

- Mark the new project dirty with the date-bounded imported article ids or deliberate project-scope dirty materialization, never explicit empty article ids.
- Mark active existing projects dirty when reused article rows are updated by non-destructive merge.
- Patch and test the unarchive path so archived projects derive dirty article ids from current app tables after archived-project route or article side effects.
- Chunk large import row inserts and dirty-state writes or extend refresh-state service chunking.

Quality gates:

- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` passes.
- `bun test src/server/routes/ProjectsRoutes.test.ts` passes.
- `bun run build` passes.
- `bun run lint` passes for touched `src` files.

### US-007: Finish commit route, progress, and post-import wizard behavior

Description: As a user, I need commit to expose progress, return completion consistently, navigate to the imported project, and show post-import warnings.

dependsOn: ["US-004", "US-005", "US-006"]

Acceptance criteria:

- Add final `POST /api/projects/import/:sessionId/commit` behavior for inline and large background commit execution.
- Expose commit progress and terminal session states through session polling.
- Import wizard handles stale-plan responses, in-flight commit, completed retry, navigation to imported project, and post-import warnings.
- Runtime events cover commit progress, promotion, transactional success, rollback cleanup, and recovery decisions.

Quality gates:

- `bun test src/server/routes/projectTransferRoutes.test.ts` passes.
- `bunx vitest run src/app/routes/+projects/-+import.vitest.tsx` passes.
- `bun run build` passes.
- `bun run desktop:build` passes.
- `bun run lint` passes for touched `src` files.
