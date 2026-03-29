# FOR_KEY

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
- Prompt merge collision cases.
- Full-text conversion model refs after model deletion/change.
- Provider logical integrity after `0029`.

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
  - `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`
  - `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`
  - `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql`

### Findings By Classification

#### Confirmed bugs

- `src/server/routes/PromptsRoutes.ts`
  - delete checks miss `comparison_project_prompt`, so app-level allow can still hit live prompt FK on delete.
  - merge updates `project_prompt`, `judgment`, `judgment_human`, but misses `comparison_project_prompt` before parent prompt delete.

#### Likely bugs

- `src/server/routes/PromptsRoutes.ts`
  - merge can rewrite `app.judgment` and `app.judgment_human` into existing unique keys.
- `src/server/routes/ProjectsRoutes.ts`
  - child detach/restore around project edits is split across tx boundaries.
- `src/server/services/insertArticlesIntoProject.ts`
  - `project_article` insert and prompt autolink are not guaranteed in one tx.
- `src/server/routes/SubprojectsRoutes.ts`
  - project/prompt/article create flow can leave partial state on later failure.
- `src/server/routes/ComparisonProjectsRoutes.ts`
  - relink/delete/restore work is split across tx boundaries.
- `src/server/routes/AdminInvestigateRoutes.ts`
  - soft-delete updates `app.judgment`, a referenced parent of `app.judgment_assessment`; same DuckDB false-positive FK shape as the dropped provider FK.
- `src/server/routes/ArticleAdminRoutes.ts`, `src/server/cron/fullTextJobs.ts`, `src/server/cron/fullTextConversionJobs.ts`
  - all update high-fanout parent `app.article`; DuckDB parent-row rewrite risk remains untested on live child refs.
- `src/server/providers/providerModelRepository.ts`
  - provider config JSON + `app.model.enabled` dual-write can split.
- `src/server/routes/ProviderModelsRoutes.ts`
  - manual create is still read-before-write with no DB-backed duplicate regression.
- `src/server/services/covidenceImportService.ts`
  - prompt get-or-create remains select-then-insert on unique `content_hash`.
- `src/server/routes/JudgmentsJobsRoutes.ts`
  - DuckDB + SQLite delete lifecycle is still not atomic across stores.

#### Logical-ref risks

- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`
  - pending batches are keyed only by `judgment_human(project_id, article_id, prompt_id)`, but route behavior depends on live `project_prompt` membership; prompt drift can strand or mismatch pending rows.
- `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`
  - submit validates against current `project_prompt` membership, not the prompt set used when the batch was initialized.
- `src/server/providers/providerConnectionRepository.ts`
  - `model.provider_connection_id` is now app-validated only after `0029`.
- `src/server/routes/DataSourcesImportRoutes/**`
  - `data_source.import_route` remains a string logical ref.
- `src/server/cron/fullTextConversionJobs.ts`, `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql`
  - `article.full_text_conversion_model_id` and `user_config.full_text_conversion_model_id` only get one-shot migration validation; later model deletes/rebuilds can orphan refs.
- `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`
  - `app.llm_status` stores provider/model identity without FKs; shared-base-URL workers can drift logical attribution.

#### Already-fixed / accepted-low-risk

- `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`
  - dropped `model.provider_connection_id -> provider_connection.id` FK because normal parent updates already hit DuckDB false positives.
- `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`
  - maintenance-only rebuild of `app.judgment_human`; low risk because it rebuilds one child table and revalidates on reinsert.
- `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`
  - current rebuild/delete order is intentional and covered, but still needs future-schema guard coverage when new FK children are added.

### Initial Risk Matrix

| Classification     | Edge / surface                                | Writer path                                                                                                               | Risk   | Why it is risky                                                                                                                                                                               | Current tests                                                                                                                                                      | Gap                                                | Likely fix direction                                                 |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| confirmed bug      | `prompt <- comparison_project_prompt`         | `src/server/routes/PromptsRoutes.ts` delete                                                                               | high   | Prompt delete checks `project_prompt`, `judgment`, `judgment_human`, but misses `comparison_project_prompt`, so app-level allow can still hit DuckDB FK failure                               | none found for prompts                                                                                                                                             | add prompt delete test with comparison project ref | expand orphan check and keep it in one tx                            |
| confirmed bug      | `prompt <- comparison_project_prompt`         | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Prompt merge rewrites some child tables but not `comparison_project_prompt`, then deletes the merged prompt                                                                                   | none found for prompts                                                                                                                                             | add prompt merge test with comparison project ref  | update `comparison_project_prompt` before delete                     |
| likely bug         | `judgment.prompt_id` unique path              | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Merging prompts can rewrite rows into an existing `app.judgment` unique key                                                                                                                   | none found for prompts                                                                                                                                             | add collision repro                                | pre-dedupe or merge rows before update                               |
| likely bug         | `judgment_human.prompt_id` unique path        | `src/server/routes/PromptsRoutes.ts` merge                                                                                | high   | Same collision shape as `judgment`, but on `app.judgment_human` unique key                                                                                                                    | none found for prompts                                                                                                                                             | add collision repro                                | pre-dedupe or merge rows before update                               |
| likely bug         | `project` child detach/restore                | `src/server/routes/ProjectsRoutes.ts` edit                                                                                | high   | Child tables are detached outside the main tx and restored later, which is fragile for crash/concurrency/error windows                                                                        | `src/server/routes/ProjectsRoutes.test.ts` covers populated model-change path                                                                                      | no restore-failure regression                      | keep all detach/restore work inside one tx or remove unneeded detach |
| likely bug         | `project_article` then `project_prompt`       | `src/server/services/insertArticlesIntoProject.ts`                                                                        | high   | Service inserts `project_article` before prompt autolink without one tx, so partial writes are possible                                                                                       | no direct tests                                                                                                                                                    | add partial-failure repro                          | wrap service in tx or make caller always pass tx                     |
| likely bug         | subproject create multi-step flow             | `src/server/routes/SubprojectsRoutes.ts`                                                                                  | high   | Project/prompt creation and article linking happen in separate phases, so later failure can leave partial state                                                                               | `src/server/routes/SubprojectsRoutes.test.ts` only covers prompt detachment                                                                                        | missing article-link rollback test                 | make full flow transactional                                         |
| accepted low risk  | archived project purge rebuild                | `src/server/routes/projectsRoutes/projectsRoutesPostDeleteArchived.ts`                                                    | high   | Rebuild/delete flow is schema-drift sensitive; new FK child tables can silently break deletion later                                                                                          | `src/server/routes/ProjectsRoutes.test.ts` covers current delete-archived behavior                                                                                 | no future-schema guard test                        | centralize FK child inventory or add explicit audit test             |
| logical-ref risk   | provider logical parent-child                 | `src/server/providers/providerConnectionRepository.ts`                                                                    | high   | Real FK was dropped, so delete/archive safety now depends on app logic and non-transactional sequencing                                                                                       | `src/server/routes/providerProjectFlow.e2e.test.ts`, `src/server/routes/ProviderConnectionsRoutes.test.ts`                                                         | missing DB-backed logical orphan tests             | add app-level validation tests and tighten tx boundaries             |
| likely bug         | provider model toggle dual-write              | `src/server/providers/providerModelRepository.ts`                                                                         | high   | `config_json.disabledModelIds` and `app.model.enabled` update separately, so one can succeed and the other fail                                                                               | mocked route tests only                                                                                                                                            | add DB-backed partial-write repro                  | wrap both writes in one tx                                           |
| likely bug         | manual provider model create race             | `src/server/routes/ProviderModelsRoutes.ts`                                                                               | medium | Route does read-before-write duplicate check with no DB uniqueness backstop shown                                                                                                             | mocked route tests only                                                                                                                                            | add concurrent duplicate test                      | add DB uniqueness or transactional upsert                            |
| likely bug         | covidence prompt create                       | `src/server/services/covidenceImportService.ts`                                                                           | medium | `getOrCreate` is select-then-insert on unique `content_hash`, so concurrent create can collide                                                                                                | `src/server/services/covidenceImportService.test.ts` covers normal flow                                                                                            | no concurrent duplicate repro                      | use upsert-style pattern or catch/reload                             |
| likely bug         | judgment job cross-store delete               | `src/server/routes/JudgmentsJobsRoutes.ts`                                                                                | medium | DuckDB delete order is correct, but DuckDB + SQLite lifecycle is not atomic                                                                                                                   | `src/server/routes/JudgmentsJobsRoutes.test.ts` covers token-use delete path                                                                                       | no partial cross-store rollback test               | add consistency test and tighten compensating actions                |
| likely bug         | comparison project relink on model change     | `src/server/routes/ComparisonProjectsRoutes.ts`                                                                           | medium | Link delete/update/restore is split across transactions, so failure can leave missing links                                                                                                   | no comparison route tests found                                                                                                                                    | add relink failure regression                      | keep relink in one tx                                                |
| logical-ref risk   | `data_source.import_route` logical ref        | `src/server/routes/DataSourcesImportRoutes/**`                                                                            | medium | String field can drift from actual `import_route` and `project_import_route` rows; no FK catches it                                                                                           | route tests use mocks                                                                                                                                              | no DB-backed drift test                            | add consistency checks or normalize source of truth                  |
| logical-ref risk   | human assessment prompt membership            | `src/server/routes/HumanAssessmentRoutes/**`                                                                              | medium | `judgment_human` rows persist by `project_id/article_id/prompt_id`, but init/submit logic depends on live `project_prompt` membership, so prompt drift can strand pending rows                | `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts`, `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts` | no prompt-drift or DB-backed pending-row test      | snapshot prompt set or re-sync unanswered rows inside one tx         |
| likely bug         | `judgment <- judgment_assessment` soft delete | `src/server/routes/AdminInvestigateRoutes.ts`                                                                             | medium | Route soft-deletes `app.judgment`, a referenced parent, so DuckDB parent-row rewrite can still false-positive on `app.judgment_assessment`                                                    | `src/server/routes/AdminInvestigateRoutes.test.ts` only covers append metrics                                                                                      | no soft-delete FK repro                            | avoid parent update or detach/reinsert around assessed rows          |
| likely bug         | `article` parent updates from admin/cron      | `src/server/routes/ArticleAdminRoutes.ts`; `src/server/cron/fullTextJobs.ts`; `src/server/cron/fullTextConversionJobs.ts` | medium | All three paths update high-fanout parent `app.article`, which remains referenced by `article_import_route`, `project_article`, `review`, `judgment_job_prompt`, `judgment`, `judgment_human` | none found                                                                                                                                                         | no DuckDB parent-update repro on article           | add temp-DB repro; if needed detach/reinsert or drop low-value FK    |
| logical-ref risk   | full-text conversion model refs               | `src/server/cron/fullTextConversionJobs.ts`; `src/db/duckdbMigrations/0022_fullTextConversionModelConfig.sql`             | medium | `full_text_conversion_model_id` gets migration-time validation only; later model deletes/rebuilds can orphan `article` and `user_config` refs                                                 | none found                                                                                                                                                         | no post-delete logical-ref test                    | app-level validation on write/read and drift tests                   |
| logical-ref risk   | llm status model/provider attribution         | `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`                                                            | low    | `app.llm_status` stores logical provider/model identity without FKs; shared worker URLs can attribute rows to the wrong logical model                                                         | none found                                                                                                                                                         | no shared-base-url repro                           | normalize identity key or persist stable IDs                         |
| already-fixed item | `judgment_human` rebuild nullable project     | `src/db/duckdbMigrations/0028_judgmentHumanNullableProjectId.sql`                                                         | low    | maintenance-only single-table rebuild; reinsert revalidates the live FK edges and matches current nullable design                                                                             | none found                                                                                                                                                         | no migration regression                            | optional migration smoke test only                                   |

### Existing Test Coverage Snapshot

- Good coverage already exists for:
  - `src/server/routes/ProjectsRoutes.test.ts`
  - `src/server/routes/providerProjectFlow.e2e.test.ts`
  - `src/server/routes/ProviderConnectionsRoutes.test.ts`
  - `src/server/routes/JudgmentsJobsRoutes.test.ts`
  - `src/server/services/covidenceImportService.test.ts`
  - `src/server/services/articleImportStoreService.test.ts`
- Weak or missing coverage remains for:
  - `src/server/routes/PromptsRoutes.ts`
  - `src/server/routes/ComparisonProjectsRoutes.ts`
  - `src/server/services/insertArticlesIntoProject.ts`
  - `src/server/routes/ProjectArticlesRoutes.ts`
  - rollback/partial-write cases in `src/server/routes/SubprojectsRoutes.ts`
  - logical-ref integrity after `src/db/duckdbMigrations/0029_dropModelProviderConnectionForeignKey.sql`
  - prompt-membership drift in `src/server/routes/HumanAssessmentRoutes/**`
  - soft-delete parent-update safety in `src/server/routes/AdminInvestigateRoutes.ts`
  - parent-update safety for `app.article` writers in `src/server/routes/ArticleAdminRoutes.ts`
  - parent-update safety for `app.article` writers in `src/server/cron/fullTextJobs.ts`
  - parent-update safety for `app.article` writers in `src/server/cron/fullTextConversionJobs.ts`
  - logical-ref drift for `full_text_conversion_model_id`
  - logical attribution drift in `src/server/cron/judgmentsJobs/judgmentsJobsCheckLLMStatus.ts`

### Remaining Highest-Value Follow-Up

- Add prompt delete/merge regression tests first.
- Add temp-DB repros for `app.article` parent updates under live child refs.
- Add human-assessment prompt-drift regression.
- Add admin-investigate `judgment_assessment` soft-delete repro.
- Add DB-backed provider logical-integrity tests after the dropped FK.

### Current Read

- The remaining unreviewed human-assessment, admin, cron, and maintenance surfaces are now inventoried.
- New material risks from this pass are: `app.article` parent updates in admin/cron, `app.judgment` soft-delete in admin investigate, and human-assessment dependence on live `project_prompt` membership.
- The highest-confidence still-unfixed areas remain prompt delete/merge, non-transactional project article insertion, subproject partial writes, provider logical-ref drift after `0029`, and the newly added article/admin audit items.
