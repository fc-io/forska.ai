# FOR_KEY_PLAN

## Goal

- Audit all live API mutations, DuckDB write paths, schema FKs, and FK-like logical refs.
- Find true FK bugs and DuckDB over-eager FK/index failures before users hit them.
- End with ranked fixes, regression tests, and a clear keep/drop/rework decision per risky edge.

## Scope

- In: `src/server/routes/**`, `src/server/services/**`, `src/server/providers/**`, `src/server/cron/**`, `src/db/**`.
- In: `queryJson`, `run`, `transaction`, app DB helpers, rebuild migrations, archive/delete flows.
- In: logical refs without live FK if same failure shape still matters:
  - `app.model.provider_connection_id`
  - `app.comparison_project.model_ids`
  - `full_text_conversion_model_id` validation paths
- Out: client-only reads, perf-only issues, unrelated unique/check constraints unless they block FK work.

## Current Context

- DuckDB can rewrite parent-row `UPDATE` into `DELETE` + `INSERT`.
- That can trigger false FK failures on referenced parents even when the key value did not change.
- We already hit this on `app.provider_connection <- app.model` and dropped that FK in `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`.
- More risk likely remains on high-fanout parents: `app.model`, `app.project`, `app.prompt`, `app.article`, `app.judgment_job`, `app.judgment`, `app.comparison_project`.

## Outputs

- FK inventory: current live edges, historical edges, logical non-FK edges.
- Mutation inventory: route -> service/repo -> SQL -> tables written.
- Risk matrix: edge + writer + failure mode + severity + current test coverage.
- Repro matrix: temp-DB tests for high-risk paths.
- Fix plan: reorder, detach/reinsert, archive-not-delete, logical validation, or FK removal.
- Final audit report: fixed, accepted risk, deferred risk.

## Workstreams

### 1. Build Canonical FK Graph

- Derive current live schema from latest DuckDB migrations, not old assumptions.
- Record for each edge:
  - child table
  - child column
  - parent table
  - parent column
  - nullable or not
  - current migration file
  - live FK vs logical ref only
- Split inventory into:
  - live enforced FKs
  - migration-only historical FKs
  - logical refs with no FK but same integrity risk
- Note all missing `ON DELETE` / `ON UPDATE` actions; assume restrictive defaults.

### 2. Build Mutation Surface Map

- Enumerate all live `POST` / `PATCH` / `PUT` / `DELETE` routes.
- Map each route to the service/repo/helper that writes DB rows.
- Map each writer to exact tables touched.
- Include cron/maintenance paths that mutate FK tables even if not HTTP-exposed.
- Produce one matrix row per mutation path:
  - route or job
  - writer fn
  - SQL verb(s)
  - parent tables touched
  - child tables touched
  - transaction boundary
  - existing test file

### 3. Static Risk Scan Rules

- Flag parent-side `UPDATE` on referenced tables.
- Flag parent-side `DELETE` on referenced tables.
- Flag child inserts that assume parent existence without same-tx guarantee.
- Flag rebuild flows with `DROP TABLE` / `CREATE TABLE` / reinsert ordering.
- Flag mixed parent+child writes inside one transaction where ordering is fragile.
- Flag manual cleanup code that deletes dependents in partial order.
- Flag code paths that catch FK errors and archive instead; verify this is intentional, tested, and user-visible.

## Priority Surfaces

### P0: Live API + Enforced FK + Parent Update/Delete

- Project edit / clone / archived delete cleanup
  - `src/server/routes/ProjectsRoutes.ts`
  - `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`
- Prompt merge / delete
  - `src/server/routes/PromptsRoutes.ts`
- Judgment job delete
  - `src/server/routes/JudgmentsJobsRoutes.ts`
- Human assessment init / submit
  - `src/server/routes/HumanAssessmentRoutes/**`
- Comparison project create / update
  - `src/server/routes/ComparisonProjectsRoutes.ts`
- Article import + article/import-route linking
  - `src/server/services/articleImportStoreService.ts`
  - `src/server/services/structuredFileImportService.ts`
- Covidence import + scope sync + human seed sync
  - `src/server/services/covidenceImportService.ts`

### P1: Live API + Logical Ref Only

- Provider connection <-> model after FK drop
  - `src/server/routes/ProviderConnectionsRoutes.ts`
  - `src/server/routes/ProviderModelsRoutes.ts`
  - `src/server/providers/providerConnectionRepository.ts`
  - `src/server/providers/providerModelRepository.ts`
- Comparison project `model_ids` list integrity
  - `src/server/routes/ComparisonProjectsRoutes.ts`
- Full-text conversion model ref validation
  - `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql`

### P2: Migration / Maintenance Only

- Rebuild migrations touching FK tables:
  - `src/db/duckdbMigrations/0013_rebuildArticleWithoutOpenalexId.sql`
  - `src/db/duckdbMigrations/0021_rebuildModelWithProviderConnections.sql`
  - `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`
  - `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`
- Any future schema rebuild should use this audit's rules before merge.

## Route-by-Route Audit Method

For each mutation route/job:

- Read route handler.
- Read downstream service/repo/helper.
- List exact SQL writes in execution order.
- Mark whether each write hits:
  - parent table update
  - parent table delete
  - child insert
  - child delete
  - detach/relink
  - rebuild
- Check if all related writes share one transaction.
- Check if rollback behavior exists and preserves original error.
- Check if code depends on catching FK errors instead of preventing them.
- Check if tests cover:
  - success path
  - referenced-parent path
  - rollback path
  - repeated/idempotent path

## SQL Audit Method

- Search all DB writers for `INSERT INTO`, `UPDATE`, `DELETE FROM`, `DROP TABLE`, `CREATE TABLE`, `MERGE INTO`.
- Bucket results by table.
- Build parent-child ordering checks per table.
- Verify any parent delete uses one of:
  - prior child delete in correct order
  - detach child refs first
  - archive instead of delete
  - explicit justification for keeping risky path
- Verify any parent update on referenced table avoids DuckDB false-positive shape where possible.
- Where impossible, prefer:
  - update child first if valid
  - detach/reinsert pattern
  - archive path
  - dropping low-value FK and replacing with app-level validation

## Repro Strategy

- Use temp DuckDB DBs only; no direct work on live app DB.
- Prefer route e2e tests adjacent to code.
- For each P0/P1 surface, add a minimal repro that proves one of:
  - referenced parent can still be updated safely
  - referenced parent delete is blocked cleanly or archived intentionally
  - child inserts fail cleanly when parent missing
  - rebuild path preserves referential integrity
- Keep repros tiny: create parent, create child, trigger risky mutation, assert final DB state.

## Expected High-Risk Repros

- Update referenced `app.project` model/link state.
- Delete archived project with dependent `review`, `judgment`, `judgment_human`, `token_use`, `project_*` rows.
- Merge prompt with dependent `project_prompt`, `judgment`, `judgment_human` rows.
- Delete `judgment_job` with `token_use` rows still present.
- Update/create comparison project with prompt/import-route links.
- Import article + import-route link creation under repeated/idempotent runs.
- Covidence scope sync deleting/reinserting `project_article` and `judgment_human` rows.
- Provider logical ref flows after FK drop: patch/delete connection with model/project/judgment dependents.

## Fix Decision Rules

- Keep FK if:
  - catches real corruption risk
  - path is low-churn
  - DuckDB false-positive risk is low
  - route can be made safe with ordering/transactions/tests
- Replace FK with app validation if:
  - DuckDB false-positive risk is high on normal user flow
  - key is stable and validated at app boundary
  - logical corruption can be prevented cheaply elsewhere
- Prefer archive over hard delete when parent has long-lived dependents and delete is not core UX.
- Prefer explicit detach/relink over broad catch-and-ignore FK errors.
- Never drop a high-value FK without adding:
  - write-path validation
  - regression test
  - rationale in code/migration history

## Missing / Likely Weak Test Areas

- `comparison_project_prompt` / `comparison_project_import_route` mutation safety.
- `article_import_route` repeated insert + parent delete behavior.
- `data_source_import_route` if/when live writes exist.
- Full-text conversion model refs after model deletion/change.

## Execution Order

1. Lock scope: schema + routes + services + cron.
2. Build FK/logical-ref inventory.
3. Build mutation matrix.
4. Rank P0/P1/P2 surfaces.
5. Add missing repro tests for P0 first.
6. Fix highest-confidence issues first.
7. Re-run targeted tests after each batch.
8. Do P1 logical-ref hardening.
9. Audit migrations / maintenance paths.
10. Publish final audit report with remaining accepted risks.

## Deliverable Format

- `table | edge | writers | risk | current tests | gap | proposed fix | priority`
- One short note per fix:
  - real bug
  - DuckDB false positive
  - accepted risk
  - FK removed by design

## Quality Gates

### Plan Gate

- Pass if this file names scope, workstreams, priorities, repro strategy, fix rules, and repo-native gates.

### Audit/Fix Gates

- Pass if every touched risky surface has:
  - inventory row
  - risk classification
  - test status
  - decision status
- Pass if schema work uses DuckDB migration flow and `bun run db:mig` succeeds.
- Pass if touched route/service suites pass with targeted tests.
- Minimum expected targeted suites, depending on touched code:
  - `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
  - `bun test src/server/routes/ProviderConnectionsRoutes.test.ts`
  - `bun test src/server/routes/ProjectsRoutes.test.ts`
  - `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
  - `bun test src/server/services/covidenceImportService.test.ts`
  - `bun test src/server/routes/SubprojectsRoutes.test.ts`
- Pass if `bun run lint` succeeds when TS/route/service code changes.
- Skip `bun run build` unless UI/client code changes.

## Notes

- Do not inspect the live DuckDB file directly.
- Use temp DBs, route tests, or repo-native DB tooling only.
- Keep fixes narrow. No unrelated cleanup during audit.

## Audit Status

### Coverage Check

- Included in plan and audit:
  - live DuckDB FKs
  - logical refs without live FKs
  - HTTP mutation routes
  - service/repository DuckDB writes
  - rebuild and maintenance paths
  - existing tests and missing regression tests

### Audited So Far

- Project flows:
  - `src/server/routes/ProjectsRoutes.ts`
  - `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`
  - `src/server/routes/ProjectArticlesRoutes.ts`
  - `src/server/routes/ProjectsAddArticlesRoutes.ts`
  - `src/server/routes/SubprojectsRoutes.ts`
  - `src/server/services/insertArticlesIntoProject.ts`
- Prompt, job, comparison flows:
  - `src/server/routes/PromptsRoutes.ts`
  - `src/server/routes/JudgmentsJobsRoutes.ts`
  - `src/server/routes/ComparisonProjectsRoutes.ts`
- Import, covidence, provider flows:
  - `src/server/services/articleImportStoreService.ts`
  - `src/server/services/structuredFileImportService.ts`
  - `src/server/services/covidenceImportService.ts`
  - `src/server/routes/DataSourcesImportRoutes/**`
  - `src/server/routes/ProviderConnectionsRoutes.ts`
  - `src/server/routes/ProviderModelsRoutes.ts`
  - `src/server/providers/providerConnectionRepository.ts`
  - `src/server/providers/providerModelRepository.ts`
- Human assessment, admin, cron, maintenance flows:
  - `src/server/routes/HumanAssessmentRoutes/**`
  - `src/server/routes/AdminInvestigateRoutes.ts`
  - `src/server/routes/ArticleAdminRoutes.ts`
  - `src/server/cron/fullTextJobs.ts`
  - `src/server/cron/fullTextConversionJobs.ts`
  - `src/server/services/userConfigQueryService.ts`
  - `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`
  - `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`
  - `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql`

### Findings By Classification

#### Confirmed bugs

- None currently open. Prior prompt delete/merge FK bugs are tracked under fixed issues.

#### Likely bugs

- None currently open. Previously likely project, provider, Covidence, and judgment-job issues are now fixed or covered below.

#### Logical-ref risks

- None currently open.

#### Already-fixed / accepted-low-risk

- `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`
  - dropped `model.provider_connection_id -> provider_connection.id` FK because normal parent updates already hit DuckDB false positives.
- `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`
  - maintenance-only rebuild of `app.judgment_human`; low risk because it rebuilds one child table and revalidates on reinsert.
- `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`
  - current rebuild/delete order is intentional and covered by live FK inventory guards.
- `src/server/routes/ArticleAdminRoutes.ts`, `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`
  - high-fanout `app.article` parent updates pass temp-DuckDB repro coverage under live child refs.
- `src/server/routes/AdminInvestigateRoutes.ts`
  - `app.judgment` soft-delete passes temp-DuckDB repro coverage under live `app.judgment_assessment` refs.
- `src/server/routes/HumanAssessmentRoutes/**`
  - prompt-mode human assessment now resyncs unanswered `app.judgment_human` rows to current `app.project_prompt` membership during init and submit.
- `src/server/providers/providerConnectionRepository.ts`, `src/server/providers/providerModelRepository.ts`
  - post-`0029` provider/model logical refs are covered by DB-backed delete/archive, rollback, disable, and re-enable tests.
- `src/server/services/userConfigQueryService.ts`, `src/server/cron/fullTextConversionJobs.ts`
  - `user_config.full_text_conversion_model_id` now validates configured conversion models on write and read; historical `article.full_text_conversion_model_id` remains read-only provenance and is covered after model deletion.
- `src/server/routes/DataSourcesRoutes.ts`, `src/server/routes/DataSourcesImportRoutes/**`
  - `data_source.import_route` is intentionally an open-ended string ref so custom `fhir:<folder>` and future route values can exist before `app.import_route` rows are created by article import storage.
- `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`
  - `app.llm_status` now keys status targets by worker URL and labels ambiguous shared-worker model attribution as `multiple` instead of assigning the first running model name.
- `src/server/routes/JudgmentsJobsRoutes.ts`
  - delete now keeps local SQLite state until the DuckDB job deletion transaction succeeds, so a DuckDB delete failure no longer strands a DuckDB job without its local SQLite state.
- `src/db/duckdbMigrations/0080_dropComparisonProjectChildParentForeignKeys.sql`, `src/server/routes/ComparisonProjectsRoutes.ts`
  - comparison-project child tables no longer keep parent `comparison_project_id` FKs, and project updates relink prompt/import/source links in one transaction without touching conflict-resolution rows.
- `src/db/duckdbMigrations/0081_dropProjectChildParentForeignKeys.sql`, `src/server/routes/ProjectsRoutes.ts`
  - hot `app.project` child parent FKs are removed, project edit no longer detaches/restores child rows, and cleanup services now treat project refs as logical refs.
- `src/server/routes/ProjectArticlesRoutes.ts`
  - project-article delete keeps row deletion and dirty marking in one transaction; DB-backed route tests cover commit and rollback behavior.
- `src/db/duckdbMigrations/0082_judgmentJobSqliteDeletePending.sql`, `src/server/routes/JudgmentsJobsRoutes.ts`, `src/server/services/judgmentJobDeleteService.ts`
  - judgment-job delete now records a persistent local-SQLite cleanup marker, deletes DuckDB state first, retries pending local cleanup, and surfaces pending cleanup in the response.
- `src/db/duckdbMigrations/0083_providerModelNaturalKey.sql`, `src/server/providers/providerModelRepository.ts`
  - provider models now have a DB-backed natural key and duplicate-race fallback lookup for `(provider_connection_id, remote_model_id, variant)`.
- `src/server/services/immutablePromptService.ts`, `src/server/services/covidenceImportService.ts`
  - immutable prompt creation now uses conflict-safe insert/update by `content_hash`, closing the Covidence prompt get-or-create race.

### Initial Risk Matrix

| Classification     | Edge / surface                                | Writer path                                                                                                               | Risk   | Why it is risky                                                                                                                                                                               | Current tests                                                                                                                                                      | Gap                                                | Likely fix direction                                                 |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| fixed bug          | `prompt <- comparison_project_prompt`         | `src/server/routes/PromptsRoutes.ts` delete                                                                               | high   | Prompt delete previously missed `comparison_project_prompt`, so app-level allow could still hit DuckDB FK failure                                                                             | `src/server/routes/PromptsRoutes.test.ts`                                                                                                                          | covered                                            | preflight `comparison_project_prompt` before delete                  |
| fixed bug          | `prompt <- comparison_project_prompt`         | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Prompt merge previously rewrote some child tables but not `comparison_project_prompt`, then deleted the merged prompt                                                                         | `src/server/routes/PromptsRoutes.test.ts`                                                                                                                          | covered                                            | update `comparison_project_prompt` before delete                     |
| fixed bug          | `judgment.prompt_id` unique path              | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Merging prompts could rewrite rows into an existing `app.judgment` unique key                                                                                                                 | `src/server/routes/PromptsRoutes.test.ts`                                                                                                                          | covered                                            | dedupe `app.judgment` rows before prompt merge update                |
| fixed bug          | `judgment_human.prompt_id` unique path        | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Same collision shape as `judgment`, but on `app.judgment_human` unique key                                                                                                                    | `src/server/routes/PromptsRoutes.test.ts`                                                                                                                          | covered                                            | dedupe `app.judgment_human` rows before prompt merge update          |
| fixed bug          | `project` child detach/restore                | `src/server/routes/ProjectsRoutes.ts` edit                                                                                | high   | Child tables were detached outside the main tx and restored later, which was fragile for crash/concurrency/error windows                                                                       | `src/server/routes/ProjectsRoutes.test.ts`                                                                                                                         | covered                                            | removed detach/restore and dropped hot project parent FKs            |
| fixed bug          | `project_article` then `project_prompt`       | `src/server/services/insertArticlesIntoProject.ts`                                                                        | high   | Service inserted `project_article` before prompt autolink without one tx, so partial writes were possible                                                                                     | `src/server/services/insertArticlesIntoProject.test.ts`                                                                                                            | covered                                            | wrap insert + prompt autolink in one tx                              |
| covered low risk   | `project_article` delete + dirty mark         | `src/server/routes/ProjectArticlesRoutes.ts`                                                                              | medium | Route deletes a child row and must mark mart refresh state dirty in the same rollback-safe transaction                                                                                         | `src/server/routes/ProjectArticlesRoutes.test.ts`                                                                                                                  | covered                                            | keep delete and dirty mark in one tx                                 |
| fixed bug          | subproject create multi-step flow             | `src/server/routes/SubprojectsRoutes.ts`                                                                                  | high   | Project/prompt creation and article linking previously happened in separate phases, so later failure could leave partial state                                                                 | `src/server/routes/SubprojectsRoutes.rollback.test.ts`                                                                                                             | covered                                            | make full flow transactional                                         |
| accepted low risk  | archived project purge rebuild                | `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`                                                    | high   | Rebuild/delete flow is schema-drift sensitive; new FK child tables can silently break deletion later                                                                                          | `src/server/routes/ProjectsRoutes.test.ts`, `src/server/services/archivedProjectCleanupService.test.ts`                                                            | covered                                            | keep FK child inventory guard current                                |
| fixed logical-ref  | provider logical parent-child                 | `src/server/providers/providerConnectionRepository.ts`                                                                    | high   | Real FK was dropped, so delete/archive safety depends on app logic; provider delete/archive now keeps model refs non-orphaned or archived                                                     | `src/server/providers/providerConnectionRepository.atomic.test.ts`, `src/server/routes/providerProjectFlow.e2e.test.ts`, `src/server/routes/ProviderConnectionsRoutes.test.ts` | covered                                            | keep delete/archive cleanup transactional                            |
| fixed bug          | provider model toggle dual-write              | `src/server/providers/providerModelRepository.ts`                                                                         | high   | `config_json.disabledModelIds` and `app.model.enabled` must stay consistent across disable, re-enable, and rollback paths                                                                     | `src/server/providers/providerModelRepository.atomic.test.ts`                                                                                                       | covered                                            | keep model row and provider config writes in one tx                  |
| fixed bug          | manual provider model create race             | `src/server/routes/ProviderModelsRoutes.ts`, `src/server/providers/providerModelRepository.ts`                            | medium | Manual and discovered model creation used natural identity without a DB uniqueness backstop                                                                                                   | `src/server/providers/providerModelRepository.test.ts`                                                                                                             | covered                                            | natural-key unique index plus conflict fallback lookup               |
| fixed bug          | covidence prompt create                       | `src/server/services/covidenceImportService.ts`, `src/server/services/immutablePromptService.ts`                          | medium | `getOrCreate` selected before inserting on unique `content_hash`, so concurrent create could collide                                                                                          | `src/server/services/covidenceImportService.test.ts`                                                                                                               | covered                                            | conflict-safe immutable prompt insert/update                         |
| fixed bug          | judgment job DuckDB/SQLite delete ordering    | `src/server/routes/JudgmentsJobsRoutes.ts`                                                                                | medium | Delete previously removed local SQLite before the DuckDB deletion transaction, and post-commit local cleanup failure needed persistent recovery                                                | `src/server/routes/JudgmentsJobsRoutes.test.ts`, `src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`                                                  | covered                                            | DuckDB delete first plus persistent pending local cleanup marker      |
| fixed bug          | comparison project relink on model change     | `src/server/routes/ComparisonProjectsRoutes.ts`                                                                           | medium | Link delete/update/restore was split across transactions, so failure could leave missing links and large conflict-resolution tables were copied during routine updates                         | `src/server/routes/ComparisonProjectsRoutes.fk.test.ts`, `src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`                                             | covered                                            | remove child parent FKs and keep relink in one tx                    |
| accepted low risk  | `data_source.import_route` logical ref        | `src/server/routes/DataSourcesRoutes.ts`; `src/server/routes/DataSourcesImportRoutes/**`                                  | medium | String field is intentionally open-ended for custom imports, including `fhir:<folder>` data sources before `app.import_route` rows exist; import storage creates stable route rows before article links | route tests use mocks                                                                                                                                              | keep behavior documented                           | do not add existence validation that would break pre-import custom routes |
| fixed logical-ref  | human assessment prompt membership            | `src/server/routes/HumanAssessmentRoutes/**`                                                                              | medium | `judgment_human` rows persist by `project_id/article_id/prompt_id`, so prompt drift could strand pending rows or submit an article without newly added prompts                                | `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPromptDrift.test.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts` | covered                                            | resync unanswered rows inside init/submit before returning/updating  |
| accepted low risk  | `judgment <- judgment_assessment` soft delete | `src/server/routes/AdminInvestigateRoutes.ts`                                                                             | medium | Route soft-deletes `app.judgment`, a referenced parent; current DuckDB accepts the tested parent-update shape with `app.judgment_assessment` child rows                                       | `src/server/routes/AdminInvestigateRoutes.fk.test.ts`                                                                                                               | keep coverage current if new judgment FKs are added | no runtime fix needed while repro remains green                      |
| accepted low risk  | `article` parent updates from admin/cron      | `src/server/routes/ArticleAdminRoutes.ts`; `src/server/cron/fullTextJobs.ts`; `src/server/cron/fullTextConversionJobs.ts` | medium | All three paths update high-fanout parent `app.article`, which remains referenced by live child rows; current DuckDB accepts the tested parent-update shapes                                | `src/server/routes/ArticleAdminRoutes.fk.test.ts`                                                                                                                   | keep coverage current if new article FKs are added | no runtime fix needed while repro remains green                      |
| fixed logical-ref  | full-text conversion model refs               | `src/server/services/userConfigQueryService.ts`; `src/server/cron/fullTextConversionJobs.ts`; `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql` | medium | `user_config.full_text_conversion_model_id` is logical-only and must not select deleted, disabled, archived, or config-disabled models; historical article refs are provenance-only | `src/server/services/userConfigQueryService.test.ts`                                                                                                               | covered                                            | runtime read/write validation; keep article provenance readable      |
| fixed logical-ref  | llm status model/provider attribution         | `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`                                                            | low    | `app.llm_status` stores logical provider/model identity without FKs; shared worker URLs previously attributed metrics to the first running model                                               | `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.test.ts`                                                                                                | covered                                            | key targets by worker URL and use `multiple` for ambiguous model attribution |
| already-fixed item | `judgment_human` rebuild nullable project     | `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`                                                         | low    | maintenance-only single-table rebuild; reinsert revalidates the live FK edges and matches current nullable design                                                                             | none found                                                                                                                                                         | no migration regression                            | optional migration smoke test only                                   |

### Existing Test Coverage Snapshot

- Good coverage already exists for:
  - `src/server/routes/ProjectArticlesRoutes.test.ts`
  - `src/server/routes/ProjectsRoutes.test.ts`
  - `src/server/routes/providerProjectFlow.e2e.test.ts`
  - `src/server/routes/ProviderConnectionsRoutes.test.ts`
  - `src/server/routes/JudgmentsJobsRoutes.test.ts`
  - `src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`
  - `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.test.ts`
  - `src/server/services/userConfigQueryService.test.ts`
  - `src/server/services/covidenceImportService.test.ts`
  - `src/server/services/articleImportStoreService.test.ts`
- Weak or missing coverage remains for:
  - None currently open from this pass.

### Remaining Highest-Value Follow-Up

- No open FK/logical-ref follow-up remains from this pass.

### Current Read

- Project edit, judgment-job cleanup recovery, provider model natural-key races, Covidence prompt creation, and ProjectArticles rollback coverage are now resolved or covered.
- New material FK/logical-ref risks from this pass are now resolved or accepted.
- No highest-confidence unfixed FK/logical-ref issue remains in the current audit scope.

## Final Findings

### Fixed issues

- Prompt delete now preflights `app.comparison_project_prompt` and blocks cleanly in `src/server/routes/PromptsRoutes.ts`; covered in `src/server/routes/PromptsRoutes.test.ts`.
- Prompt merge now rewrites `app.comparison_project_prompt`, dedupes `app.judgment` and `app.judgment_human`, then deletes merged prompts in a follow-up phase in `src/server/routes/PromptsRoutes.ts`; covered in `src/server/routes/PromptsRoutes.test.ts`.
- Project article insert + prompt autolink now commit atomically in `src/server/services/insertArticlesIntoProject.ts`; covered in `src/server/services/insertArticlesIntoProject.test.ts`.
- Project article delete now keeps `app.project_article` deletion and dirty-refresh marking in one DuckDB transaction in `src/server/routes/ProjectArticlesRoutes.ts`; covered in `src/server/routes/ProjectArticlesRoutes.test.ts`, including dirty-mark failure rollback.
- Subproject create now keeps project, detached prompt, `app.project_prompt`, and `app.project_article` writes in one transaction in `src/server/routes/SubprojectsRoutes.ts`; covered in `src/server/routes/SubprojectsRoutes.rollback.test.ts`.
- Comparison-project updates now drop the hot child-table parent FKs in `src/db/duckdbMigrations/0080_dropComparisonProjectChildParentForeignKeys.sql`, relink prompt/import/source links in one transaction in `src/server/routes/ComparisonProjectsRoutes.ts`, and leave `app.comparison_project_conflict_resolution` untouched during routine edits; covered in `src/server/routes/ComparisonProjectsRoutes.fk.test.ts` and `src/server/routes/ComparisonProjectsRoutes.rollback.test.ts`.
- Project edits now avoid project child detach/restore entirely, and `src/db/duckdbMigrations/0081_dropProjectChildParentForeignKeys.sql` removes hot child-table parent FKs to avoid DuckDB parent-update false positives; archived cleanup treats project refs as logical refs in `src/server/services/archivedProjectCleanupService.ts` and `src/server/services/archivedProjectCleanupProjectForeignKeys.ts`; covered in `src/server/routes/ProjectsRoutes.test.ts`.
- Provider logical hardening now keeps `app.model.enabled` + provider config toggles atomic in `src/server/providers/providerModelRepository.ts`, and provider-connection delete/archive cleanup atomic in `src/server/providers/providerConnectionRepository.ts`; covered in `src/server/providers/providerModelRepository.atomic.test.ts`, `src/server/providers/providerConnectionRepository.atomic.test.ts`, and `src/server/routes/providerProjectFlow.e2e.test.ts`, including DB-backed no-orphan, comparison-project-only archive, rollback, disable, and re-enable paths.
- Provider model creation now uses `src/db/duckdbMigrations/0083_providerModelNaturalKey.sql` for natural-key uniqueness and `src/server/providers/providerModelRepository.ts` conflict fallback lookup to handle duplicate create/discovery races; covered in `src/server/providers/providerModelRepository.test.ts`.
- Immutable prompt creation now uses conflict-safe insert/update by `content_hash` in `src/server/services/immutablePromptService.ts`, which covers Covidence prompt get-or-create via `src/server/services/covidenceImportService.ts`; covered in `src/server/services/covidenceImportService.test.ts`.
- Archived-project purge now asserts live `app.project` FK inventory before delete requests and cleanup batches, includes the live `project_mart_dirty_refresh_article_quarantine` FK, cleans stale project mart dictionary state, and safely detaches comparison-project children while clearing `summary_source_project_id` in `src/server/services/archivedProjectCleanupService.ts` and `src/server/services/archivedProjectCleanupProjectForeignKeys.ts`; covered in `src/server/routes/ProjectsRoutes.test.ts` and `src/server/services/archivedProjectCleanupService.test.ts`.
- Human assessment init and submit now resync unanswered `app.judgment_human` rows against current `app.project_prompt` membership before returning or updating prompt-mode pending rows in `src/server/routes/HumanAssessmentRoutes/humanAssessmentPendingJudgments.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`, and `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`; covered in `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPromptDrift.test.ts`.
- Full-text conversion model selection now validates logical `user_config.full_text_conversion_model_id` refs on write and read in `src/server/services/userConfigQueryService.ts`, ignoring deleted, disabled, provider-disabled, archived, and config-disabled models while preserving historical `article.full_text_conversion_model_id` provenance after model deletion; covered in `src/server/services/userConfigQueryService.test.ts`.
- LLM status ingestion now keys SGLang status rows by worker URL and labels ambiguous shared-worker model attribution as `multiple` instead of assigning metrics to the first running model in `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`; covered in `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.test.ts`.
- Judgment job deletion now performs the DuckDB deletion transaction before deleting local SQLite state in `src/server/routes/JudgmentsJobsRoutes.ts`, records persistent pending cleanup rows in `src/db/duckdbMigrations/0082_judgmentJobSqliteDeletePending.sql`, and retries local cleanup through `src/server/services/judgmentJobDeleteService.ts`; covered in `src/server/routes/JudgmentsJobsRoutes.test.ts` and `src/server/routes/JudgmentsJobsRoutes.crashContainment.test.ts`.

### Accepted risks

- `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`: accepted FK removal for `app.model.provider_connection_id` because DuckDB parent updates already false-positived on normal writes; runtime safety now lives in `src/server/providers/providerConnectionRepository.ts` and `src/server/providers/providerModelRepository.ts` with DB-backed regression coverage.
- `src/db/duckdbMigrations/0080_dropComparisonProjectChildParentForeignKeys.sql`: accepted FK removal for comparison-project child `comparison_project_id` columns because normal comparison-project edits update the hot parent row under live child rows; runtime safety now lives in route validation, transactional relink, uniqueness constraints, and archive-not-delete behavior.
- `src/db/duckdbMigrations/0081_dropProjectChildParentForeignKeys.sql`: accepted FK removal for hot child `project_id` refs because normal project edits update a high-fanout parent row; runtime safety now lives in route validation, transactional cleanup, and archived-project logical-ref checks.
- `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`: accepted maintenance-only rebuild risk; this path rebuilds one child table and revalidates on reinsert.
- `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`: accepted schema-sensitive rebuild strategy, now guarded by live FK inventory checks rather than broader FK removal.
- `src/server/routes/ArticleAdminRoutes.ts`, `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`: accepted current `app.article` parent-update behavior because temp-DuckDB repro coverage in `src/server/routes/ArticleAdminRoutes.fk.test.ts` passes under live child refs.
- `src/server/routes/AdminInvestigateRoutes.ts`: accepted current `app.judgment` soft-delete behavior because temp-DuckDB repro coverage in `src/server/routes/AdminInvestigateRoutes.fk.test.ts` passes under live `app.judgment_assessment` refs.
- `src/server/routes/DataSourcesRoutes.ts`, `src/server/routes/DataSourcesImportRoutes/**`: accepted `data_source.import_route` as an intentionally open-ended route string because custom imports can be configured before `app.import_route` exists; article import storage owns creation of canonical `app.import_route` rows before article links are written.

### Deferred risks

- None currently open from this pass.

### Remaining logical-ref checks

- None currently open.

## Future Guardrails

- One user action -> one rollback-safe write flow. No child delete now / restore later across tx boundaries.
- Treat hot parents as dangerous: `app.prompt`, `app.project`, `app.article`, `app.judgment`, `app.model`, `app.judgment_job`.
- Any new update/delete path on a hot parent needs a temp-DB repro under live child refs.
- Keep FKs selectively. No new hot-parent FK without a DuckDB repro proving normal writes stay safe.
- If a FK is dropped, replace it with one owner write path, runtime validation, regression coverage, and a note here.
- Prefer DB uniqueness + upsert-style flows over select-then-insert on natural keys.
- Cleanup and rebuild flows must assert the live FK child inventory they handle.
- Every logical ref needs one named owner and one validation layer.

### Future Quality Gates

- TS route/service/provider changes: `bun run lint` + targeted `bun test <file>`.
- Schema changes: `bun run db:mig` + targeted migration-adjacent tests.
- FK-sensitive parent updates/deletes: add or update one temp-DB repro proving safe behavior under live children.
