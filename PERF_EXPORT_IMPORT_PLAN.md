# Export And Import Performance Plan

## Goal

- Make project transfer import and export scale to large projects without high memory pressure, long DuckDB writer occupancy, or opaque progress.
- Treat this as a durable architecture improvement, not a threshold or batch-size tuning pass.
- Preserve package correctness, dependency fidelity, rollback safety, browser flow, and desktop flow.
- Allow clean transfer-schema and package-fingerprint cutovers; backward compatibility with old transfer internals is not required.

## Current State

- Upload already streams request bodies to a temp artifact in `src/server/routes/projectTransferRoutes.ts`.
- Analyze reads the uploaded zip into memory, reads all zip entries into memory, parses NDJSON into JS arrays, validates target state, then writes extracted payload artifacts in `src/server/services/projectTransfer/projectTransferAnalyze.ts` and `projectTransferZip.ts`.
- Target analysis builds large JS arrays and SQL `IN (...)` or `OR` clauses in `projectTransferAnalyzeTarget.ts` and `projectTransferFidelityValidation.ts`.
- Commit revalidates target analysis before writes in `projectTransferCommit.ts`; this protects correctness but duplicates much of analyze.
- Commit writes many app tables through sequential 500-row literal `INSERT ... VALUES` batches in `projectTransferCommitWriter.ts`.
- Asset promotion reads, hashes, writes, rereads, and rehashes each promoted asset sequentially in `projectTransferCommitRollback.ts`.
- Large analyze and commit jobs can run in the background, but backgrounding improves UX more than actual throughput.

## Performance Problems

- Memory grows with package size because zip entries, payload rows, and plan rows are materialized in JS.
- DuckDB receives giant generated SQL strings instead of staged package data it can join and insert set-wise.
- Repeated JS `filter` and `reduce` passes over large arrays create avoidable O(n*m) work in article, route, judgment, and human-review planning.
- Commit holds one writer transaction while doing many sequential operations that could be set-based.
- Asset-heavy packages pay repeated full-file reads and checksums.
- Progress reporting is coarse, so regressions are hard to attribute to unzip, parse, analyze, dependency resolution, asset copy, commit, or mart dirtying.

## Recommended Architecture

Move transfer processing to a staged, set-based pipeline.

```text
upload artifact
-> streaming package scan
-> request-safe temp-root staging files and operation-local DuckDB tables
-> set-based analysis plan
-> dependency resolution
-> incremental revalidation
-> set-based commit
-> bounded asset promotion
-> cleanup
```

## Estimated Impact

These are planning estimates. The benchmark rules below decide whether a change is successful.

| Improvement | Best-Fit Workload | Phase Speedup | Overall Speedup |
|---|---:|---:|---:|
| Measurement baseline | All | 0x | 0x directly |
| Request-safe staging and streaming parse | Large row packages | 1.2-3x analyze/load | 1.1-2x import |
| Set-based analyze | Article, route, and judgment-heavy imports | 3-10x analyze | 1.5-5x import |
| Incremental commit revalidation | Unchanged target at commit | 2-5x revalidation | 1.2-2x import |
| Set-based commit writer | Judgment and article-heavy commits | 5-20x commit writes | 2-8x import |
| Asset promotion streaming | Asset-heavy imports | 1.5-3x asset phase | 1.2-3x import |
| Export streaming | Large exports | 1.5-5x export assembly/package | 1.5-4x export |
| Progress and UX | All large packages | 0x backend | Better perceived progress |

Expected cumulative results:

| Package Shape | Expected Total Improvement |
|---|---:|
| Small package | 0-20% |
| Article-heavy import | 2-5x |
| Judgment-heavy import | 4-10x |
| Asset-heavy import | 1.5-4x |
| Huge mixed import | 5-15x |
| Large export | 2-6x |

## Measurement Protocol

- Measure before and after every implementation PR that claims a performance improvement.
- Use the same machine, same package fixture, same target database shape, same model/provider settings, same shell env, and same app build mode for before/after runs.
- Record package fingerprint or schema version, package counts, target database counts, target conflict shape, and commit/revalidation outcome with every result.
- Run each benchmark at least three times when feasible and report median plus worst run.
- Keep raw benchmark logs or JSON output under an ignored local artifact path, and summarize results in the PR or implementation note.
- Treat memory, writer transaction time, correctness, and rollback safety as pass/fail, not only wall-time improvements.

Required before/after fields:

- `phase`
- `fixture`
- `schemaVersion`
- `packageRows`
- `assetBytes`
- `targetRows`
- `wallMsBefore`
- `wallMsAfter`
- `peakMemoryBeforeMb`
- `peakMemoryAfterMb`
- `duckdbWriterMsBefore`
- `duckdbWriterMsAfter`
- `rowsPerSecondBefore`
- `rowsPerSecondAfter`
- `bytesPerSecondBefore`
- `bytesPerSecondAfter`
- `correctnessChecksPassed`

## Phase 0: Measurement Baseline

Purpose:

- Make import/export performance measurable before changing architecture.

Implementation checklist:

- Add phase timing helpers for upload, zip scan, payload parse, staging/load, target analysis, dependency resolution, revalidation, asset promotion, app-table writes, history write, cleanup, export assembly, and export package write.
- Add row counters per payload family: articles, identifiers, article import routes, project articles, prompts, project prompts, judgments, assessments, human judgments, human summaries, reviews, assets.
- Add byte counters for upload bytes, zip bytes, expanded bytes, NDJSON bytes, asset bytes, promoted bytes, and export package bytes.
- Add DuckDB writer transaction timing around commit and any future staging metadata writes.
- Add peak-memory sampling when available in Bun/Node runtime APIs; if exact peak is unavailable, record sampled RSS at phase boundaries.
- Add structured log events or session progress metadata for all phase timings.
- Add benchmark runner scripts or tests that can generate or reuse fixed package fixtures.
- Add a compact benchmark result format using the required before/after fields above.

Before measurement:

- Run the benchmark matrix on the current implementation.
- Capture total wall time, phase times where available, current memory, and commit transaction duration.
- Mark missing metrics as `unavailable`, not `0`.

After measurement:

- Rerun the same benchmark matrix after instrumentation.
- Confirm instrumentation overhead is less than 5% on small inline packages.
- Confirm metrics are stable enough to compare later phases.

Acceptance criteria:

- Each import/export session exposes or logs per-phase duration, rows/sec, bytes/sec, package counts, asset bytes, and transaction duration.
- Benchmarks can be rerun without hand-editing package contents.
- Instrumentation does not materially change small-package latency.

## Phase 1: Request-Safe Staging Layer

Purpose:

- Stop holding full package payloads in JS arrays and create the foundation for set-based analyze and commit.

Implementation checklist:

- Create a request-safe transfer staging abstraction keyed by session id.
- Use temp-root staging files or app-scoped scratch keyed by `sessionId` as the source of truth between analyze, dependency-resolution, and commit requests.
- Use DuckDB temp tables only as operation-local acceleration that can be rebuilt from the temp-root staging files.
- Do not rely on connection-local DuckDB temp tables or in-memory maps to survive across separate API requests.
- Define staging schemas for package rows and normalized helper rows.
- Write staged files atomically: write to a temporary path, verify counts and checksums, then rename into the session staging directory.
- Write a staging manifest that records file paths, payload keys, schema version, row counts, byte counts, checksums, and creation phase.
- Require later requests to validate the staging manifest before using staged rows.
- Stage package metadata: schema version, package counts, checksums, asset bytes, row counts, source project id, and source project name.
- Stream NDJSON payloads into staging without `decode(...).split('\n').map(JSON.parse)`.
- Validate per-row payload shape while streaming and write validation failures to staged blocker records.
- Track staged row counts and checksum inputs as rows are loaded.
- Preserve extracted asset files only when asset promotion needs them.
- Add startup cleanup for abandoned temp roots and staged scratch state, but only after checking session state and owner lease so live uploads/analyze/commit work is not removed.
- Add explicit behavior for lost staged state: fail or expire the session clearly and require a new upload/analyze attempt.

Candidate staging surfaces:

- `project_transfer_stage_article`
- `project_transfer_stage_article_identifier`
- `project_transfer_stage_article_import_route`
- `project_transfer_stage_project_article`
- `project_transfer_stage_prompt`
- `project_transfer_stage_project_prompt`
- `project_transfer_stage_judgment`
- `project_transfer_stage_judgment_assessment`
- `project_transfer_stage_human_judgment`
- `project_transfer_stage_human_summary`
- `project_transfer_stage_review`
- `project_transfer_stage_asset_manifest`

Before measurement:

- Measure analyze memory and parse/load time for article-heavy, judgment-heavy, and asset-heavy packages.
- Record peak memory versus package row count.
- Record current time spent in zip entry read and NDJSON parse.

After measurement:

- Rerun the same packages and compare parse/load time, peak memory, and temp disk bytes.
- Verify peak memory is bounded by active batch size plus asset buffers, not total package row count.
- Verify package counts and checksums match the current implementation or the new schema-version rules.

Estimated impact:

- 1.2-3x faster analyze/load on large row packages.
- 1.1-2x faster overall import when parse/load is a visible bottleneck.
- Much lower memory pressure on large packages.

Acceptance criteria:

- Analyze validates package counts and checksums without holding all payload rows in memory.
- Staging survives normal request gaps between analyze, dependency resolution, and commit while the session remains active.
- Staging cleanup is deterministic on cancel, failure, expiry, successful commit, and startup cleanup of abandoned temp roots.
- Later requests never consume partially written staging files.
- Lost staged state produces a clear failed or expired session, not a partial commit path.

## Phase 2: Set-Based Analyze

Purpose:

- Move target matching and conflict detection from JS loops and generated SQL strings into DuckDB joins.

Implementation checklist:

- Replace article id and identifier matching `IN (...)` and `OR` predicates with joins from staged article identifiers to `app.article` and `app.article_identifier`.
- Rebuild operation-local DuckDB tables from staged files at the start of analyze, dependency revalidation, and commit when needed.
- Add indexes, sort order, or `ANALYZE` calls for operation-local tables when query plans need them.
- Compute article match actions in SQL or operation-local plan tables: `create`, `reuse`, `blocked`.
- Compute prompt matches by joining staged prompt content hashes to `app.prompt`.
- Compute route availability by joining staged import route values to `app.import_route` and route/project link tables.
- Compute route/article overlap by joining staged article-route rows to target route memberships and project scopes.
- Compute article field fill candidates from staged article rows and matched target rows.
- Compute judgment physical keys and review-visible keys from staged judgment rows and resolved article/prompt/model mappings.
- Compute judgment, assessment, and human-review blockers with set-based duplicate and target-conflict queries.
- Store reviewed target plan data as versioned transfer-schema rows or a rebuilt versioned artifact.
- Keep a compact JSON summary artifact for UI plan review.
- Ensure dependency resolution and commit read exactly the reviewed plan revision.
- Remove plan shapes that store full duplicate target row payloads unless the UI needs them.

Before measurement:

- Measure target analysis time for article-heavy, route-heavy, judgment-heavy, reuse-heavy, and conflict-heavy packages.
- Capture generated SQL string sizes if possible.
- Capture JS CPU time or approximate target-analysis wall time.

After measurement:

- Rerun the same packages and compare target-analysis wall time, generated SQL size, and memory.
- Verify blocker and warning counts match expected semantics for equivalent package contents under the new schema version.
- Verify the UI plan summary remains usable for dependency resolution and review.

Estimated impact:

- 3-10x faster target analysis on article, route, and judgment-heavy imports.
- 1.5-5x faster overall import when analyze dominates.

Acceptance criteria:

- Analyze time is dominated by DuckDB joins rather than JS array traversal.
- Package size increases linearly in runtime and does not produce very large SQL strings.
- Dependency resolution and commit cannot accidentally read a different plan revision from the one the user reviewed.

## Phase 3: Incremental Commit Revalidation

Purpose:

- Keep commit correctness while avoiding full target re-analysis when target state has not changed.

Implementation checklist:

- Identify every table and key range that can affect import safety: articles, identifiers, import routes, project links, prompts, judgments, assessments, human review rows, models, provider connections, project-transfer history.
- Add a small shared target-state dirty-token or version service for those safety surfaces.
- Keep dirty-token updates coarse, cheap, and transactional with the write that changed the target surface.
- Update dirty tokens through shared write helpers inside existing write paths instead of spreading ad hoc dirty-token updates across the codebase.
- Store the analyze-time dirty-token set with the reviewed plan revision.
- At commit, compare current dirty tokens with analyze-time dirty tokens before running detailed revalidation.
- Fall back to full target revalidation when any relevant token is missing, unknown, stale, or not covered by shared write helpers.
- Keep detailed revalidation for changed target surfaces only when the dirty token tells us which surface changed.
- Persist stale-plan reasons by surface: dependency, target article, target prompt, target route, judgment, assessment, human review, duplicate package history.
- Add tests where target state changes after analyze and before commit.
- Add tests where dirty-token coverage is missing and full revalidation is forced.

Before measurement:

- Measure commit revalidation time separately from app-table writes.
- Benchmark unchanged-target commits and changed-target commits.
- Record how often commit revalidation reopens plans during normal test scenarios.

After measurement:

- Rerun unchanged-target commits and verify full target analysis is skipped.
- Rerun changed-target commits and verify stale plans still reopen safely.
- Rerun missing dirty-token coverage tests and verify full revalidation runs.

Estimated impact:

- 2-5x faster revalidation on unchanged targets.
- 1.2-2x faster overall import when revalidation is a visible commit cost.

Acceptance criteria:

- Unchanged target state does not rerun full target analysis at commit time.
- Changed target state still reopens the plan safely before writes.
- Missing or unverifiable target-state coverage forces full revalidation instead of optimistic commit.

## Phase 4: Set-Based Commit Writer

Purpose:

- Shorten DuckDB writer occupancy and replace sequential literal `INSERT ... VALUES` batches with set-based writes.

Implementation checklist:

- Create operation-local source-to-target id mapping tables for articles, prompts, routes, judgments, assessments, human review rows, and assets.
- Generate new target ids once per reviewed commit attempt, validate collisions before writes, and persist them in request-safe staging or a reviewed commit plan artifact.
- Rebuild operation-local mapping tables from the persisted id map at commit time.
- Convert created-article inserts to `INSERT ... SELECT` from staged article rows and target id maps.
- Convert article identifier inserts to set-based insert from staged normalized identifiers.
- Convert article import route inserts to set-based insert from staged article-route plan rows.
- Convert project import route and project article inserts to set-based insert from staged plan rows.
- Convert judgment inserts to set-based insert from staged judgment rows joined to article, prompt, and model maps.
- Convert judgment assessment inserts to set-based insert from staged assessment rows joined to judgment maps.
- Convert human judgment, human summary, and review inserts to set-based insert from staged human-review plan rows.
- Keep uniqueness checks where constraints enforce safety.
- Keep count/key validation for `ON CONFLICT DO NOTHING` paths and any table where skipped rows must be detected.
- Remove only post-insert scans whose condition is fully proven by constraints and insert result counts.
- Keep one commit transaction, but minimize statement count and generated SQL size.
- Preserve rollback, history, dirty-project marking, and completion payload semantics.
- Add failure tests proving partial set-based writes roll back cleanly.

High-value write paths to convert first:

- Created articles.
- Article identifiers.
- Article import routes.
- Project articles.
- Judgments.
- Judgment assessments.
- Human judgments, summaries, and reviews.

Before measurement:

- Measure commit app-table write time, DuckDB writer transaction duration, statement count, generated SQL size, and rows/sec per target table.
- Capture current rows/sec for article-heavy and judgment-heavy commits.
- Capture lock/writer occupancy impact on concurrent foreground reads if available.

After measurement:

- Rerun the same packages and compare commit app-table write time, writer transaction duration, statement count, SQL size, and rows/sec.
- Verify final row counts, unique constraints, imported project behavior, and history rows match expected semantics.
- Verify failed commits roll back app-table writes and promoted assets according to the rollback contract.

Estimated impact:

- 5-20x faster commit writes for judgment and article-heavy imports.
- 2-8x faster overall import when commit dominates.

Acceptance criteria:

- Large imports issue a small number of set-based statements per target table.
- Commit rows/sec improves measurably without relaxing uniqueness, fidelity, or rollback behavior.
- DuckDB writer transaction duration does not regress for commit-writer changes.

## Phase 5: Asset Promotion

Purpose:

- Make asset-heavy imports bounded-memory and reduce repeated full-file reads.

Implementation checklist:

- Replace whole-file asset reads with stream copy and incremental checksum.
- Avoid reading promoted assets a second time when the copy path already verified byte count and checksum.
- Write rollback-safe promotion status with less manifest churn.
- Record each promotion as pending before copy and copied only after byte count and checksum verification.
- Use bounded concurrency for independent asset copies.
- Keep per-asset rollback state durable enough for the current live commit operation.
- Keep safety checks for unsafe paths, symlinks, path traversal, declared package asset references, and runtime asset URL rewriting.
- Consider content-addressed asset storage when duplicate package assets are common.
- Add tests for failed copy, checksum mismatch, destination conflict, rollback cleanup, and reused asset references.

Before measurement:

- Measure asset promotion time, bytes/sec, peak memory, number of asset reads, number of manifest writes, and rollback cleanup time.
- Benchmark asset-heavy imports with many small assets and fewer multi-GB assets.

After measurement:

- Rerun asset-heavy imports and compare promotion time, bytes/sec, peak memory, manifest writes, and cleanup time.
- Verify asset paths in imported articles and full-text HTML are valid in browser and desktop.
- Verify failed asset promotion still rolls back promoted files safely.

Estimated impact:

- 1.5-3x faster asset phase.
- 1.2-3x faster asset-heavy imports.
- Large memory reduction for multi-GB asset packages.

Acceptance criteria:

- Asset-heavy imports scale with bounded memory.
- Failed asset promotion still rolls back promoted files safely.
- Browser and desktop runtime asset rendering still works after import.

## Phase 6: Export Path Improvements

Purpose:

- Stream large exports with bounded memory and a clean transfer schema/fingerprint cutover.

Implementation checklist:

- Add a new transfer schema version for streaming export output.
- Add a new package fingerprint version when canonical payload formatting changes.
- Stream payload assembly from DuckDB queries into NDJSON files instead of collecting large payload arrays.
- Stream package creation to file for large exports and keep in-memory zip bytes only for small inline exports.
- Preserve deterministic ordering within the new schema version.
- Preserve benchmark-critical model, provider, thinking, content-setting, and judgment settings exactly.
- Preserve failure behavior: do not silently retry, downgrade, or mutate model/provider settings to make export succeed.
- Add golden package tests for new schema version, payload ordering, checksums, and package fingerprints.
- Add export tests for small inline packages and large background package-file output.
- Ship exporter and importer changes together for the new schema version; cross-version compatibility is not required, but same-branch export/import must work before merge.
- Add cleanup tests for failed large exports.

Before measurement:

- Measure export assembly time, package write time, peak memory, output bytes/sec, package bytes, expanded bytes, and package fingerprint cost.
- Benchmark article-heavy, judgment-heavy, and asset-heavy exports.

After measurement:

- Rerun the same exports and compare assembly time, package write time, peak memory, and bytes/sec.
- Verify golden package tests pass for the new schema version.
- Verify exported packages import successfully through the optimized or current import flow.
- Verify new packages exported by the branch import successfully in the same branch.

Estimated impact:

- 1.5-5x faster export assembly/package writing for large exports.
- 1.5-4x faster overall large export.

Acceptance criteria:

- Large exports write package files with bounded memory.
- Export packages are deterministic within the new schema version for payload ordering, checksums, and fingerprints.
- Golden package tests prove the new schema version and fingerprint rules are stable.
- Same-branch export/import works for the new transfer schema version before shipping.

## Phase 7: Progress And UX

Purpose:

- Make long-running import/export work understandable and recoverable from the user’s perspective.

Implementation checklist:

- Keep layout-first import UI behavior and avoid full-page blocking spinners.
- Add progress phases for upload, package scan, staging load, analyze, dependency resolution, revalidation, asset promotion, commit, cleanup, export assembly, and export package write.
- Show row progress when row totals are reliable.
- Show byte progress when byte totals are reliable.
- Avoid fake precision when a phase cannot know total work.
- Include stale-plan reason details in the plan review UI when commit revalidation reopens a plan.
- Keep `/projects/import` working in browser and desktop.
- Verify upload, polling, background job, download, and runtime asset paths in desktop when those paths change.

Before measurement:

- Record current perceived-progress gaps for large analyze and commit phases.
- Measure time spent in states where progress is `0%`, missing, or stale.
- Capture current browser and desktop flow screenshots or notes for large package import/export.

After measurement:

- Rerun large import/export flows and record time spent without meaningful progress updates.
- Verify users can tell whether work is in scan, analyze, dependency, commit, asset, or cleanup phase.
- Verify browser and desktop flows still complete.

Estimated impact:

- No direct backend speedup.
- Large perceived improvement for multi-minute jobs.

Acceptance criteria:

- Browser and desktop import flows show useful progress for large package analyze and commit.
- Background jobs keep heartbeat and owner safety while the process is alive.
- Server restart does not need to resume staged work, but incomplete staged sessions fail or expire clearly.

## Cross-Phase Implementation Checklist

- Add import/export benchmark fixtures and timing helpers under existing project-transfer tests or scripts.
- Prefer temp-root staging files plus operation-local DuckDB temp tables. Add DuckDB migrations under `src/db/duckdbMigrations/` only for target-state dirty tokens, transfer metadata, or app-scoped scratch tables that must be queryable across request boundaries.
- Add a staging repository/helper near `src/server/services/projectTransfer/`.
- Change `projectTransferAnalyze.ts` to stream/load payloads into staging before target analysis.
- Change `projectTransferAnalyzeTarget.ts` to query staged rows with joins instead of generated `IN` and `OR` clauses.
- Change `projectTransferFidelityValidation.ts` to use staged judgment and human-review rows for conflict detection.
- Add target-state dirty tokens or fingerprints used by analyze and commit revalidation, plus tests proving missing coverage forces full revalidation.
- Change `projectTransferCommitWriter.ts` to rebuild operation-local DuckDB tables from request-safe staged rows and commit from those tables.
- Change `projectTransferCommitRollback.ts` to stream asset promotion with rollback-safe manifests.
- Change export assembly in `projectTransferExport.ts` and `projectTransferExportPackage.ts` to stream large payloads and packages.
- Add a new transfer schema/fingerprint version for the streaming cutover.
- Update `projectTransferRoutes.ts` progress payloads to report phase-specific metrics.
- Add cleanup and recovery tests for staged rows/files.

## Benchmark Matrix

- Small inline package: a few articles, prompts, judgments, and no assets.
- Article-heavy package: at least 100k articles with identifiers and routes.
- Judgment-heavy package: at least 500k judgments and assessments.
- Asset-heavy package: multi-GB full text, PDFs, and image assets.
- Reuse-heavy package: most articles and judgments already exist in target.
- Conflict-heavy package: ambiguous identifiers, route omissions, and stale dependency mappings.

Track for each benchmark:

- Total wall time.
- Upload, staging, analyze, dependency, revalidation, commit, asset, cleanup durations.
- Rows/sec per payload family.
- Bytes/sec for upload, zip read, export package write, and asset promotion.
- Peak memory.
- DuckDB writer transaction duration.
- Temporary disk bytes and final asset bytes.

Benchmark pass/fail rules:

- Each optimization PR records before/after median and worst-run results for the package shape it targets.
- Treat wall-time changes within 5% as measurement noise unless they repeat across all runs or are paired with clear memory/writer-duration improvement.
- Peak memory must be bounded by active batch size plus asset copy buffers, not by total package rows.
- Small inline package latency must not regress by more than 5% unless the PR explicitly trades small-package latency for large-package capacity.
- Large package rows/sec or bytes/sec should improve by at least 10% for the bottleneck phase the PR targets, or the PR should justify why correctness, memory, or writer-duration improvement is the real win.
- DuckDB writer transaction duration must not increase for commit-writer changes.
- Correctness, rollback safety, and benchmark-critical model/provider settings must not regress even when speed results are noisy.

## Quality Gates

- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferAnalyzeTarget.test.ts` if added.
- `bun test src/server/services/projectTransfer/projectTransferFidelityValidation.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferExportPackage.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts`
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- Add and run golden package/fingerprint tests for any new transfer schema version.
- Add and run same-branch export/import tests for any new transfer schema version.
- `bun run db:mig` if target-state dirty tokens, app-scoped scratch tables, or transfer metadata migrations are added.
- `bun run lint`
- `bun run build` if shared UI, route response types, or import wizard progress changes.
- `bun run desktop:build` if runtime asset paths, temp paths, upload/download wiring, or import/export UI paths change.
- Browser verify: export a project, import it through `/projects/import`, resolve dependencies if needed, commit, and open the imported project.
- Desktop verify: same flow when runtime asset paths, file upload/download, or temp storage behavior changes.

## Non-Goals

- Do not solve performance by raising `DUCKDB_MEMORY_LIMIT`.
- Do not silently skip commit revalidation.
- Do not silently retry, downgrade, or alter benchmark-critical model/provider settings.
- Do not require staged analyze or commit state to survive server restart, but do keep active-session staging available across normal API request gaps.
- Do not preserve old transfer package fingerprints across the streaming export cutover.
- Do not add backward-compatibility shims for old transfer packages or intermediate staging state.
- Do not optimize only one happy-path package shape; article-heavy, judgment-heavy, and asset-heavy packages need separate coverage.
