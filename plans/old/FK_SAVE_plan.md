# FK_SAVE Plan

## Goal

- Stop recurring DuckDB FK false-positives and partial-write integrity bugs.
- Keep high-value integrity checks.
- Move hot paths from fragile FK reliance to atomic writes + explicit validation.
- Make future schema or route changes safer by default.

## Why this happens

- DuckDB can rewrite parent `UPDATE` as `DELETE` + `INSERT`.
- High-fanout parent tables then false-positive on live child refs.
- Multi-step writes outside one tx leave partial state.
- Some refs are now logical only, so they need one clear owner.

## Quality Gates

- For TS route/service/provider changes:
  - `bun run lint`
  - targeted `bun test <file>` for each touched path
- For schema changes:
  - `bun run db:mig`
  - targeted migration-adjacent tests
- For FK-sensitive parent updates/deletes:
  - add or update one temp-DB repro test proving safe update/delete under live children

## Core Rules

### 1. One user action -> one rollback-safe write flow

- Multi-table writes default to one tx.
- No delete child now / restore later across tx boundaries.
- No dual-write split across config JSON + DB row state.

### 2. Treat hot parents as dangerous

- Hot parents:
  - `app.prompt`
  - `app.project`
  - `app.article`
  - `app.judgment`
  - `app.model`
  - `app.judgment_job`
- Any new update/delete path on a hot parent needs a repro under live child refs.

### 3. Keep FKs selectively

- Keep FKs when they catch real corruption and do not break normal writes.
- Avoid new FKs on hot parent write paths without a DuckDB repro.
- If a FK must be dropped, replace it with:
  - one owner write path
  - runtime validation
  - regression coverage
  - explicit note in `FOR_KEY.md`

### 4. No read-before-write races on natural keys

- Prefer DB uniqueness + upsert-style flows.
- Avoid select-then-insert for prompts, models, or other dedupe keys.
- If retry/reload is needed, keep it explicit and local.

### 5. Cleanup flows need live inventory guards

- Rebuild/delete maintenance code must derive or assert the FK child inventory it handles.
- No hard-coded cleanup list without a guard.
- Future schema work must update the guard in the same change.

### 6. Logical refs need one owner

- Every logical ref needs one source of truth and one validation layer.
- Current logical-ref hotspots:
  - `model.provider_connection_id`
  - `data_source.import_route`
  - `full_text_conversion_model_id`
  - `llm_status` provider/model attribution
  - human-assessment dependence on live `project_prompt`

## Near-Term Work

### P0: Finish remaining proven-risk gaps

- Add temp-DB repro for `src/server/routes/AdminInvestigateRoutes.ts` soft-delete on `app.judgment` with live `app.judgment_assessment`.
- Add temp-DB repros for `app.article` parent updates in:
  - `src/server/routes/ArticleAdminRoutes.ts`
  - `src/server/cron/fullTextJobs.ts`
  - `src/server/cron/fullTextConversionJobs.ts`
- Add human-assessment prompt-drift repros for:
  - `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts`
  - `src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts`

### P1: Remove remaining integrity-adjacent races

- Harden select-then-insert in `src/server/services/covidenceImportService.ts`.
- Harden manual model create in `src/server/routes/ProviderModelsRoutes.ts`.
- Revisit cross-store lifecycle in `src/server/routes/JudgmentsJobsRoutes.ts`.

### P2: Normalize logical refs

- Decide whether `data_source.import_route` becomes FK-backed or fully app-owned.
- Add runtime validation for `full_text_conversion_model_id` after model deletes/rebuilds.
- Add drift checks for `app.llm_status` provider/model identity.

## Structural Improvements

### Shared helpers

- Add small shared helpers for:
  - tx-wrapped multi-table writes
  - FK inventory assertions for cleanup flows
  - temp-DB repro setup for parent-update tests
- Keep helpers narrow; do not hide SQL order.

### Effect-first non-trivial server flows

- Prefer `Effect` for multi-step server flows with cleanup, retries, or cross-resource state.
- Best fit:
  - provider cleanup
  - job lifecycle
  - import/rebuild flows

### Test shape

- Each risky path should have:
  - happy path test
  - referenced-parent repro
  - rollback or partial-failure repro
  - idempotent replay test when applicable

## Change Policy

### For schema PRs

- Review against `FOR_KEY.md`.
- If adding a FK to a hot parent, include a DuckDB repro or do not add it.
- If adding a new child of `app.project`, update archived-delete guard logic in the same PR.

### For route/service PRs

- If touching a hot parent, add/update a temp-DB repro.
- If touching 2+ tables, use one tx or explain why not.
- If introducing a logical ref, name its owner and validation point in the PR.

## Documentation

- Keep `FOR_KEY.md` as the running audit log.
- Add a short `Findings` section update whenever a risk is fixed, accepted, or deferred.
- Use four labels only:
  - fixed
  - accepted risk
  - deferred risk
  - logical-ref check

## Success Metrics

- No raw DuckDB FK errors on normal prompt/project/provider workflows.
- No known multi-table partial-write gaps in audited hot paths.
- Every hot parent update/delete path has a repro test.
- Every logical ref hotspot has one named owner and validation rule.
- Future schema drift on archived-project cleanup fails in tests, not in production.

## Done Looks Like

- Deferred items in `FOR_KEY.md` are either fixed or explicitly accepted.
- New FK-sensitive PRs follow these rules by default.
- Constraint errors become rare and explainable, not recurring surprises.

## FK-sensitive PR Checklist

- [ ] Touches a hot parent? Add/update a temp-DB repro under live child refs.
- [ ] Writes 2+ related tables? Keep it in one tx or explain why not.
- [ ] Adds or changes a FK? Prove normal writes stay safe in DuckDB.
- [ ] Adds a new child of `app.project`? Update archived-delete guard logic.
- [ ] Introduces or changes a logical ref? Name the owner and validation point.
- [ ] Uses a natural-key create path? Prefer DB uniqueness + upsert over select-then-insert.
- [ ] Update `FOR_KEY.md` if the risk posture changed.
- [ ] Run the relevant gates: `bun run lint`, targeted `bun test <file>`, `bun run db:mig` for schema work.
