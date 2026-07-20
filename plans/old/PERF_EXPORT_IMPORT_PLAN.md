# Export And Import Performance Plan

## Goal

- Make project transfer import and export scale to large projects without high memory pressure, long DuckDB writer occupancy, or opaque progress.
- Treat this as a durable architecture improvement, not a threshold or batch-size tuning pass.
- Preserve package correctness, dependency fidelity, rollback safety, browser flow, and desktop flow.
- Allow clean transfer-schema and package-fingerprint cutovers; backward compatibility with old transfer packages, fingerprints, or transfer internals is not required.

## Current State

- Upload already streams request bodies to a temp artifact in `src/server/routes/projectTransferRoutes.ts`.
- Analyze reads the uploaded zip into memory, reads all zip entries into memory, parses NDJSON into JS arrays, validates target state, then writes extracted payload artifacts in `src/server/services/projectTransfer/projectTransferAnalyze.ts` and `projectTransferZip.ts`.
- Target analysis builds large JS arrays and SQL `IN (...)` or `OR` clauses in `projectTransferAnalyzeTarget.ts` and `projectTransferFidelityValidation.ts`.
- Commit revalidates target analysis before writes in `projectTransferCommit.ts`; this protects correctness but duplicates much of analyze.
- Commit writes many app tables through sequential 500-row literal `INSERT ... VALUES` batches in `projectTransferCommitWriter.ts`.
- Asset promotion reads, hashes, writes, rereads, and rehashes each promoted asset sequentially in `projectTransferCommitRollback.ts`.
- Large analyze, commit, and export jobs can run in the background, but backgrounding improves UX more than actual throughput.
- Export can write background package zips to temp files, but export assembly still materializes DB rows, serialized payloads, asset bytes, and byte-backed zip entries in memory.
- Raw article provenance currently supports `include` and `omit` only. `omit` is the default, and the removed `auto` mode should not be reintroduced as part of this performance plan.

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
-> streaming schema-vNext package fingerprint validation
-> set-based analysis plan
-> dependency resolution from staged rows
-> dirty-token-gated incremental revalidation
-> bounded asset promotion and path rewrite plan
-> set-based commit with promoted asset paths
-> cleanup
```

Commit ordering rule:

- Asset promotion and asset path rewriting happen before app-table writes begin.
- A failed promotion stops commit before any DB write.
- A failed DB commit rolls back promoted session-owned assets with the rollback manifest.
- Do not move asset promotion after DB commit unless assets become transactionally staged and only finalized after the DB commit succeeds.

Compatibility rule:

- The streaming cutover will reject old transfer schema versions and old package fingerprints with a clear error.
- Same-branch export/import for the new schema must work before merge.
- Until Phase 6 ships, Phases 1-5 must either preserve current-schema import behavior or land behind one stacked cutover branch/flag; do not merge an importer-only external schema break.
- Do not spend implementation effort preserving old package import paths unless a future product requirement reverses this decision.

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
- Record package fingerprint, schema version, package counts, target database counts, target conflict shape, commit/revalidation outcome, execution mode, export raw-article provenance mode when applicable, warning counts by code/scope/severity, key warning details, and a benchmark-critical dependency execution signature with every result.
- Run each benchmark at least three times when feasible and report median plus worst run.
- Keep raw benchmark logs or JSON output under an ignored local artifact path, and summarize results in the PR or implementation note.
- Treat memory, writer transaction time, correctness, and rollback safety as pass/fail, not only wall-time improvements.

Required before/after fields:

- `phase`
- `fixture`
- `packageFingerprint`
- `schemaVersion`
- `executionMode`
- `rawArticleProvenanceMode` (`include`, `omit`, or `not_applicable` for import-only benchmarks whose fixture was not produced in the same run)
- `dependencyExecutionSignature`
- `packageRows`
- `assetBytes`
- `targetRows`
- `wallMsBefore`
- `wallMsAfter`
- `peakRssBeforeMb`
- `peakRssAfterMb`
- `peakJsHeapBeforeMb`
- `peakJsHeapAfterMb`
- `duckdbSpillBytesBefore`
- `duckdbSpillBytesAfter`
- `duckdbWriterMsBefore`
- `duckdbWriterMsAfter`
- `rowsPerSecondBefore`
- `rowsPerSecondAfter`
- `bytesPerSecondBefore`
- `bytesPerSecondAfter`
- `targetConflictShape`
- `commitRevalidationOutcome`
- `warningCountsByCodeScopeSeverity`
- `warningDetailsValidated`
- `correctnessChecksPassed`

## Phase 0: Measurement Baseline

Purpose:

- Make import/export performance measurable before changing architecture.

Implementation checklist:

- Add phase timing helpers for upload, zip scan, payload parse, staging/load, target analysis, dependency resolution, revalidation, asset promotion, app-table writes, history write, cleanup, export assembly, and export package write.
- Add row counters keyed by the active `projectTransferPayloadKeys` surface so instrumentation stays aligned with package contracts. Pre-cutover, use the current keys: `project`, `articles`, `importRoutes`, `projectImportRoutes`, `articleImportRoutes`, `projectArticles`, `prompts`, `projectPrompts`, `providerConnections`, `models`, `judgments`, `judgmentAssessments`, `humanJudgments`, `humanJudgmentSummaries`, `reviews`, and `assetManifest`. If asset entry/reference cardinality needs separate pre-cutover tracking, expose it as additional `assetManifestEntryCount` and `assetReferenceCount` metrics rather than payload-key counters. After schema-vNext makes asset entries/references package payloads, count them as first-class payload keys.
- Add byte counters for upload bytes, zip bytes, expanded bytes, NDJSON bytes, asset bytes, promoted bytes, and export package bytes.
- Add DuckDB writer transaction timing around commit and any future staging metadata writes.
- Add peak-memory sampling when available in Bun/Node runtime APIs; if exact peak is unavailable, record sampled RSS at phase boundaries.
- Add warning counters by code/scope/severity plus validation for warning details used by fidelity review: `sourceRowId`, `triggeringField`, `dependencyReason`, `omittedParentRef`, and `rawArticleProvenanceMode`.
- Keep resource-gate metadata honest: do not report `usesStreamingParser: true` for import analyze until upload, zip entry, and NDJSON payload parsing are actually streaming.
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

- Stop holding full package payloads in JS arrays during scan, staging, and fingerprint validation, and create the foundation for set-based analyze and commit. Full analyze memory is bounded only after Phase 2 staged consumers replace full-payload-array reads.

Implementation checklist:

- Create a request-safe transfer staging abstraction keyed by session id and staging revision.
- Use temp-root staging files or app-scoped scratch keyed by `sessionId` plus `stagingRevision` as the source of truth between analyze, dependency-resolution, and commit requests.
- Write each new staging revision under a non-current path and atomically update the session's current `stagingRevision` only after the staging manifest, counts, checksums, blockers, and plan artifact are complete.
- Treat previous staging revisions as cleanup-only once a newer revision is published; dependency resolution and commit must reject requests whose reviewed plan revision points at a non-current staging revision.
- Use DuckDB temp tables only as operation-local acceleration that can be rebuilt from the persisted staging source.
- Do not rely on connection-local DuckDB temp tables or in-memory maps to survive across separate API requests.
- Because DuckDB temp tables are connection-scoped, require per-operation temp-table naming plus guaranteed teardown, or add any dedicated connection mode through the shared DuckDB service/helper layer rather than ad hoc per-feature connection management.
- Design Phase 1 staging around the next transfer `schemaVersion`, but keep the external schema cutover tied to the exporter/importer rollout in Phase 6; reject older schema versions clearly instead of adapting them once the new schema ships.
- If Phase 1 lands before Phase 6, it must either preserve the current external schema and current fingerprint behavior or remain on a stacked cutover branch/flag. Do not merge a Phase 1 importer path that requires schema-vNext packages before the matching exporter ships.
- Make archive member path allowlists and payload-path validation schema-version aware. Current-schema packages keep current root files until cutover; schema-vNext packages allow the new NDJSON payload files and reject unexpected legacy or unknown root files.
- Make every repeatable payload family NDJSON in the new schema. Keep JSON only for singleton metadata payloads such as `project`, the manifest, and compact summaries.
- Split asset manifest data into schema-vNext package payloads for asset entries and asset references; do not keep growing top-level `entries[]` or nested `references[]` arrays for asset-heavy packages.
- Treat asset-entry and asset-reference row families as explicit package contract data with payload paths, manifest entries, row counts, byte counts, checksums, and fingerprint inputs. Do not hide package-critical asset contract rows only in importer-local staging tables.
- Before the schema-vNext cutover, keep current `assetManifest.json` behavior intact or keep split asset-entry/reference package payloads behind the same stacked cutover branch/flag as the new exporter.
- Define deterministic export/staging sort keys for every NDJSON payload family, but keep fingerprint ordering safe from volatile metadata unless the sort key is derived only from canonical logical row bytes after fingerprint exclusions.
- Compute the new package fingerprint from staged canonical logical row digests and singleton payload digests, not from reconstructed full payload arrays.
- For order-insensitive row families, stage `{payloadKey, sortKey, rowDigest, canonicalRowBytes}` records. Calculate `rowDigest` and `canonicalRowBytes` after fingerprint exclusions, then hash rows sorted by `rowDigest` and canonical bytes. Never let source ids, target ids, DB ids, timestamps, or other fingerprint-excluded metadata influence fingerprint ordering through `sortKey`.
- For singleton JSON payloads, use a streaming canonicalizer or bounded metadata file; if a singleton can grow with project size, convert it to NDJSON before shipping the schema.
- Store per-payload checksum, logical digest, byte count, row count, and fingerprint inputs in the staging manifest.
- Extend import-side resource gates so available disk headroom budgets staged payload files, canonical row bytes, digests, manifests, and any temporary spill before staging begins, not only expanded archive bytes.
- Define staging schemas for package rows and normalized helper rows.
- Write staged files atomically: write to a temporary path, verify counts and checksums, then rename into the session staging directory.
- Write a staging manifest that records file paths, payload keys, schema version, row counts, byte counts, checksums, package fingerprint, upload checksum, producing plan revision when applicable, `stagingRevision`, and creation phase.
- Require later requests to validate the staging manifest and the reviewed plan's exact expected `stagingRevision` before using staged rows. Do not require the manifest to match a later dependency-resolution `planRevision` when that plan revision intentionally reuses the same staged package rows.
- Stage package metadata: schema version, package counts, checksums, asset bytes, row counts, source project id, and source project name.
- Stream NDJSON payloads into staging without `decode(...).split('\n').map(JSON.parse)`.
- Validate per-row payload shape while streaming and write validation failures to staged blocker records.
- Include staged validation blocker records in the plan summary and block commit whenever any staged package-contract blocker remains unresolved.
- Track staged row counts and checksum inputs as rows are loaded.
- Preserve extracted asset files only when asset promotion needs them.
- Add startup cleanup for abandoned temp roots and staged scratch state, but only after checking active DuckDB writer ownership, session state, and owner lease so live uploads/analyze/commit work is not removed.
- Add explicit behavior for lost staged state: fail or expire the session clearly and require a new upload/analyze attempt.

Candidate staging surfaces:

- `project_transfer_stage_project`
- `project_transfer_stage_import_route`
- `project_transfer_stage_project_import_route`
- `project_transfer_stage_article`
- `project_transfer_stage_article_identifier`
- `project_transfer_stage_article_import_route`
- `project_transfer_stage_project_article`
- `project_transfer_stage_prompt`
- `project_transfer_stage_project_prompt`
- `project_transfer_stage_provider_connection`
- `project_transfer_stage_model`
- `project_transfer_stage_judgment`
- `project_transfer_stage_judgment_assessment`
- `project_transfer_stage_human_judgment`
- `project_transfer_stage_human_summary`
- `project_transfer_stage_review`
- `project_transfer_stage_asset_entry`
- `project_transfer_stage_asset_reference`
- `project_transfer_stage_payload_digest`

Before measurement:

- Measure analyze memory and parse/load time for article-heavy, judgment-heavy, and asset-heavy packages.
- Record peak memory versus package row count.
- Record current time spent in zip entry read and NDJSON parse.

After measurement:

- Rerun the same packages and compare parse/load time, peak memory, and temp disk bytes.
- Verify Phase 1 parse/load JS memory is bounded by active batch size plus asset buffers, not total package row count; full analyze memory is not considered bounded until Phase 2 staged consumers land.
- Verify package counts, checksums, logical digests, and package fingerprints match the active schema rules. Use current schema rules for pre-cutover Phase 1 work and schema-vNext rules only on the stacked cutover branch or after Phase 6 ships.

Estimated impact:

- 1.2-3x faster analyze/load on large row packages.
- 1.1-2x faster overall import when parse/load is a visible bottleneck.
- Much lower memory pressure on large packages.

Acceptance criteria:

- Analyze validates package counts and checksums without holding all payload rows in memory.
- Analyze validates the active package fingerprint without holding all payload rows in memory. Pre-cutover work validates the current fingerprint; schema-vNext work validates the new fingerprint only once the exporter/importer cutover is shipped together.
- Staging survives normal request gaps between analyze, dependency resolution, and commit while the session remains active.
- Staging cleanup is deterministic on cancel, failure, expiry, successful commit, and startup cleanup of abandoned temp roots.
- Later requests never consume partially written staging files.
- Lost staged state produces a clear failed or expired session, not a partial commit path.

## Phase 2: Set-Based Analyze

Purpose:

- Move target matching and conflict detection from JS loops and generated SQL strings into DuckDB joins.

Implementation checklist:

- Replace article id and identifier matching `IN (...)` and `OR` predicates with joins from staged article ids and normalized strong article identifiers to `app.article` and `app.article_identifier`.
- Rebuild operation-local DuckDB tables from staged files at the start of analyze, dependency revalidation, and commit when needed.
- On shared queued DuckDB connections, isolate those operation-local tables with per-operation names plus teardown, or run them through a shared-helper-managed dedicated connection mode.
- Execute all multi-statement analyze and dependency-resolution work that depends on operation-local tables on the same helper-managed operation connection, or use app-scoped scratch tables keyed by operation id instead of DuckDB temp tables.
- Add indexes, sort order, or `ANALYZE` calls for operation-local tables when query plans need them.
- Compute article match actions in SQL or operation-local plan tables: `create`, `reuse`, `blocked`.
- Compute prompt matches by joining recomputed staged prompt content hashes to `app.prompt`; retain the package-declared content hash only for mismatch warnings, not target reuse decisions.
- Compute route availability by joining staged import route values to `app.import_route` and route/project link tables.
- Compute route/article overlap by joining staged article-route rows to target route memberships and project scopes.
- Compute article field fill candidates from staged article rows and matched target rows.
- Compute judgment physical keys and review-visible keys from staged judgment rows and resolved article/prompt/model mappings.
- Stage imported provider/model snapshot markers and dedicated snapshot fingerprints. Reuse only rows previously marked as imported snapshots when the fingerprint matches exactly; do not remap imported source providers/models onto arbitrary local provider/model rows.
- Resolve exact imported provider/model snapshot matches during analysis to concrete target ids, and preserve `new:provider:*` and `new:model:*` virtual ids only for source snapshots that do not already exist.
- Preserve model `variant` and `version` as separate staged fields and snapshot-fingerprint inputs throughout analysis, dependency resolution, reviewed plans, and commit materialization. Do not collapse `version` into `variant` except inside an explicitly versioned fingerprint-normalization rule.
- Compute judgment, assessment, and human-review fidelity plans from those concrete or virtual imported snapshot ids so provider/model metadata, thinking/options, and content settings remain benchmark-critical inputs.
- Compute judgment, assessment, and human-review blockers with set-based duplicate and target-conflict queries.
- Store reviewed target plan data as versioned transfer-schema rows or a rebuilt versioned artifact.
- Keep a compact JSON summary artifact for UI plan review.
- Change dependency resolution to read staged provider, model, judgment, assessment, and human-review rows instead of reparsing extracted payload files into full JS arrays.
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

- Identify every table and key range that can affect import safety: projects and project scope state (`archived`, `date_from`, `date_to`), articles, identifiers, import routes, article import routes, project links, prompts, judgments, assessments, human review rows, models, provider connections, imported provider/model snapshot marker JSON, imported snapshot fingerprint inputs, project-transfer history.
- Add a small shared target-state dirty-token or version service for those safety surfaces.
- Add a target-state coverage version that records which code version initialized token coverage and which safety surfaces are covered.
- Include dependency fingerprint algorithm/code version in the coverage version or token set so provider/model snapshot fingerprint changes force full dependency and fidelity revalidation.
- Store the coverage version with every analyze-time token set and reviewed plan revision.
- Allow incremental commit revalidation only when the current coverage version exactly matches the analyze-time coverage version and every required surface has a known token.
- Keep dirty-token updates coarse, cheap, and transactional with the write that changed the target surface.
- Update dirty tokens through shared write helpers inside existing write paths instead of spreading ad hoc dirty-token updates across the codebase.
- Route all app writes touching safety surfaces through those shared helpers. Direct maintenance scripts must update the token transactionally or advance a global unknown token that forces full revalidation.
- Store the analyze-time dirty-token set with the reviewed plan revision.
- At commit, compare current dirty tokens with analyze-time dirty tokens before running detailed revalidation.
- Fall back to full target revalidation when any relevant token is missing, unknown, stale, or not covered by shared write helpers.
- Fall back to full dependency and fidelity revalidation when imported snapshot markers, snapshot fingerprint inputs, provider/model enabled/archive state, or dependency fingerprint code/version are missing, unknown, stale, or changed.
- Keep detailed revalidation for changed target surfaces only when the dirty token tells us which surface changed.
- Persist stale-plan reasons by surface: dependency, target project, target article, target prompt, target route, judgment, assessment, human review, duplicate package history.
- Add a test inventory for every route, service, queue, cron, import, and maintenance path that writes safety surfaces.
- Add tests where target state changes after analyze and before commit.
- Add tests where target project archive/date-scope state changes after analyze and before commit.
- Add tests where dirty-token coverage is missing and full revalidation is forced.
- Add tests where the coverage version changes between analyze and commit and full revalidation is forced.

Before measurement:

- Measure commit revalidation time separately from app-table writes.
- Benchmark unchanged-target commits and changed-target commits.
- Record how often commit revalidation reopens plans during normal test scenarios.

After measurement:

- Rerun unchanged-target commits and verify full target analysis is skipped.
- Rerun changed-target commits and verify stale plans still reopen safely.
- Rerun missing dirty-token coverage tests and verify full revalidation runs.
- Rerun coverage-version mismatch tests and verify full revalidation runs.

Estimated impact:

- 2-5x faster revalidation on unchanged targets.
- 1.2-2x faster overall import when revalidation is a visible commit cost.

Acceptance criteria:

- Unchanged target state does not rerun full target analysis at commit time.
- Changed target state, including target project scope/archive/date changes, still reopens the plan safely before writes.
- Missing or unverifiable target-state coverage forces full revalidation instead of optimistic commit.
- Incremental revalidation is disabled by default until coverage has been initialized for every safety surface.

## Phase 4: Set-Based Commit Writer

Purpose:

- Shorten DuckDB writer occupancy and replace sequential literal `INSERT ... VALUES` batches with set-based writes.

Implementation checklist:

- Create operation-local source-to-target id mapping tables for articles, prompts, routes, judgments, assessments, and human review rows.
- Generate new target ids once per reviewed commit attempt, validate collisions before writes, and persist them in request-safe staging or a reviewed commit plan artifact.
- Rebuild operation-local mapping tables from the persisted id map at commit time.
- Load operation-local source/mapping tables and execute all dependent `INSERT ... SELECT` and `UPDATE ... FROM` statements on the same DuckDB connection, inside the same commit transaction when the tables are transaction-scoped. If the shared helper layer cannot guarantee that connection boundary, use app-scoped scratch tables keyed by `commitId` instead of temp tables.
- Rebuild provider/model snapshot resolution maps from the reviewed plan before dependent writes. Reuse exact imported snapshot matches by fingerprint and materialize only the remaining virtual imported snapshots.
- Materialize imported provider/model snapshots as disabled rows with imported-snapshot markers and no usable provider secret reference before judgment, assessment, human-review, or project rows that depend on them are written.
- Materialize/reuse imported model snapshots using the same fingerprint inputs as dependency resolution, including separate `variant` and `version` values. If the target app table has no dedicated version column, persist the source version in the imported snapshot marker and fingerprint metadata rather than folding it into `variant`.
- Preserve the adjustment-plan behavior that reused imported snapshots are also disabled after import, accepting the documented shared-row tradeoff.
- Persist and rebuild a separate asset `packagePath -> promotedPath` map for promoted assets; do not model asset promotion as relational target-id generation.
- Begin app-table writes only after asset promotion has verified copied byte counts/checksums and produced a promoted-path map.
- Join staged article rows with the promoted-path map before app-table writes so DB rows never point at unverified package asset paths.
- Convert created-article inserts to `INSERT ... SELECT` from staged article rows and target id maps.
- Convert reused-article field-fill updates to set-based `UPDATE ... FROM` statements from staged update-plan rows and the promoted-path map, with affected-row count validation.
- Convert article identifier inserts to set-based insert from staged normalized strong identifiers, with conflict validation proving every skipped `ON CONFLICT DO NOTHING` row belongs to the intended target article.
- Convert article import route inserts to set-based insert from staged article-route plan rows.
- Convert project import route and project article inserts to set-based insert from staged plan rows.
- Convert judgment inserts to set-based insert from staged judgment rows joined to article, prompt, and model maps.
- Convert judgment assessment inserts to set-based insert from staged assessment rows joined to judgment maps.
- Convert human judgment, human summary, and review inserts to set-based insert from staged human-review plan rows.
- Keep uniqueness checks where constraints enforce safety.
- Keep count/key validation for `ON CONFLICT DO NOTHING` paths and any table where skipped rows must be detected.
- Remove only post-insert scans whose condition is fully proven by constraints and insert result counts.
- Keep one commit transaction, but minimize statement count and generated SQL size.
- Advance target-state dirty tokens transactionally inside the same set-based commit transaction for every safety surface the import writes, so the new writer cannot bypass Phase 3 revalidation coverage.
- Preserve rollback, history, dirty-project marking, and completion payload semantics.
- Preserve the existing safety boundary: promotion failure produces no app-table writes; app-table write failure rolls back DB changes and removes session-owned promoted assets.
- Add failure tests proving partial set-based writes roll back cleanly.

High-value write paths to convert first:

- Created articles.
- Article identifiers.
- Article import routes.
- Project articles.
- Reused-article field fills.
- Judgments.
- Judgment assessments.
- Human judgments, summaries, and reviews.

Before measurement:

- Measure commit app-table write time, DuckDB writer transaction duration, statement count, generated SQL size, and rows/sec per target table.
- Capture current rows/sec for article-heavy, reuse-heavy field-fill, and judgment-heavy commits.
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
- Keep asset promotion before app-table writes. Do not commit DB rows before required asset copies are verified.
- Write rollback-safe, persisted session-scoped promotion status with less manifest churn.
- Record each promotion as pending before copy and copied only after byte count and checksum verification.
- Use bounded concurrency for independent asset copies.
- Serialize promotion-state updates through one manifest writer, append-only log, or atomic per-asset state files so bounded concurrent copies cannot overwrite each other's pending or copied status.
- Keep per-asset rollback state in a persisted session-scoped promotion manifest and keep promoted asset paths session-owned so crash recovery and abandoned-session cleanup stay deterministic.
- Keep safety checks for unsafe paths, symlinks, path traversal, declared package asset references, and runtime asset URL rewriting.
- Treat content-addressed asset storage, if pursued, as a separate design with explicit shared-lifetime ownership and cleanup rules.
- Add tests for failed copy, checksum mismatch, destination conflict, rollback cleanup, and reused asset references.

Before measurement:

- Measure asset promotion time, bytes/sec, peak memory, number of asset reads, number of manifest writes, and rollback cleanup time.
- Benchmark asset-heavy imports with many small assets and fewer large assets whose total volume spans multiple GiB while staying within current per-file limits.

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

- Stream large exports with bounded memory and one clean transfer schema cutover with `schemaVersion`-bound fingerprint semantics.

Implementation checklist:

- Add one new transfer `schemaVersion` for the streaming import/export cutover, and bind the new fingerprint algorithm, canonical ordering rules, and package-validation semantics to that `schemaVersion`.
- Add export disk-headroom gates at preflight and export-start using estimated staged payload bytes, asset bytes, and package bytes; fail before staging or asset copy begins when temp headroom is insufficient.
- Run export assembly against one consistent DuckDB snapshot. Materialize export rows plus asset references/paths from that snapshot into request-safe staged files before releasing it; then copy and hash asset files after the snapshot with stable-source verification before manifest and fingerprint finalization. Do not hold a DuckDB transaction open across asset copy or package streaming.
- Stream payload assembly from DuckDB queries into deterministic NDJSON files instead of collecting large payload arrays.
- Stream export asset collection in two steps: discover asset references while materializing article payloads under the DuckDB snapshot, then after releasing that snapshot copy asset files to package staging with bounded concurrency, compute byte counts/checksums incrementally, and preserve a stable-source verification step so assets that change during copy fail the export before manifest and fingerprint finalization.
- Build judgment, assessment, human-review, and review payload signatures from the staged article payload after runtime asset rewriting, not from pre-rewrite DB article rows, so same-branch import fidelity matches the exported package bytes.
- Preserve current export-asset safety checks for runtime asset path validation, runtime asset URL rewriting, symlink rejection, and regular-file checks while moving to the streaming path.
- Preserve current external URL behavior while streaming: recognized non-local URLs with credentials, query strings, or fragments remain byte-preserved in payloads, do not become runtime asset references, and do not trigger article or dependent-row omission cascades. Do not add `nonLocalUrlPreserved` warnings unless a separate correctness change intentionally reintroduces that behavior.
- Define an asset-field URL policy matrix before changing discovery: `fullTextHtml` non-runtime non-local URLs stay byte-preserved in attributes, `fullTextPdf` remains a required runtime asset path or null unless a separate schema change explicitly supports URL PDFs, and `fullTextAssets` must distinguish metadata URLs from runtime asset references. Unsupported asset-shaped non-local values must block or be documented explicitly; they must never be reinterpreted as runtime asset paths.
- Exercise signed or credential-bearing non-local URLs through full export assembly, including asset discovery. Explicitly document or block unsupported asset-shaped fields such as `fullTextAssets` instead of letting asset discovery reinterpret preserved non-local URLs as runtime asset paths.
- Do not store export asset bytes in JS arrays. Package entries should reference staged files or streams plus metadata.
- Stream package creation to file for large exports and keep in-memory zip bytes only for small inline exports.
- Extend the zip writer to accept staged files or streams so large payloads and assets are not converted back into `Uint8Array` entries.
- For streamed zip entries, either precompute CRC32 and uncompressed size during staging and write correct local headers, or implement ZIP data descriptors correctly. Do not stream entries with placeholder CRC/size values that produce invalid archives.
- Persist per-package-entry CRC32, uncompressed size, content checksum, and package path metadata during staging when using precomputed ZIP headers so package writing does not reread large entries solely to discover header values.
- Keep package-level byte counts and checksums based on bytes actually written, not advisory archive metadata.
- Preserve deterministic ordering within the new schema version.
- Compute package checksums and fingerprints from staged payload files, staged asset metadata, and streaming logical digest inputs.
- Preserve benchmark-critical model, provider, thinking, content-setting, judgment, `variant`, and `version` settings exactly.
- Preserve failure behavior: do not silently retry, downgrade, or mutate model/provider settings to make export succeed.
- Add golden package tests for new schema version, payload ordering, checksums, and package fingerprints.
- Add export tests for small inline packages and large background package-file output.
- Add export tests proving `rawArticleProvenanceMode` `include` and `omit` preflight estimates, execution mode, actual package bytes, and omission-warning behavior match the selected mode.
- Add explicit export-asset failure-path tests for symlink rejection, non-file rejection, missing assets, and source-change-during-copy.
- Ship exporter and importer changes together for the new schema version; cross-version compatibility is not required, but same-branch export/import must work before merge.
- Add cleanup tests for failed large exports.

Before measurement:

- Measure export assembly time, package write time, peak memory, output bytes/sec, package bytes, expanded bytes, and package fingerprint cost.
- Measure export asset read count, concurrent asset copy count, asset bytes/sec, and asset bytes resident in JS memory.
- Measure `rawArticleProvenanceMode` impact for `include` and `omit`: preflight estimate bytes, execution mode, actual package bytes, warning counts/details, and import round-trip behavior.
- Benchmark article-heavy, judgment-heavy, and asset-heavy exports.

After measurement:

- Rerun the same exports and compare assembly time, package write time, peak memory, and bytes/sec.
- Verify asset-heavy exports do not hold asset bytes or all payload rows in JS memory.
- Verify golden package tests pass for the new schema version.
- Verify exported packages import successfully through the same-branch new import flow.
- Verify same-branch export/import round trips preserve counts, warnings, and dependency-resolution semantics under the new schema version.
- Verify signed, credential-bearing, query-string, and fragment non-local URLs remain unchanged, do not become runtime asset references, preserve current warning behavior, and do not create decision-bearing or dependent omission cascades.
- Verify `rawArticleProvenanceMode` `include` and `omit` fixtures keep preflight estimate, selected execution mode, actual package bytes, and warning output consistent.

Estimated impact:

- 1.5-5x faster export assembly/package writing for large exports.
- 1.5-4x faster overall large export.

Acceptance criteria:

- Large exports write package files with bounded memory.
- Large asset-heavy exports package staged asset files or streams without materializing all asset bytes in JS.
- Export asset validation still enforces runtime asset path validation, runtime asset URL rewriting, symlink rejection, and regular-file checks under the streaming export path.
- Export asset discovery follows the documented field-specific URL policy matrix and never reinterprets preserved non-local URLs as runtime asset paths.
- Raw article provenance modes `include` and `omit` produce expected preflight estimates, package output, manifest warnings, and same-branch import behavior.
- Warning output preserves code/scope/severity and key details for raw provenance, provider-secret, decision-bearing omission, and dependent omission cases. External URL preservation keeps current no-warning behavior unless intentionally changed in a separate correctness update.
- Export payload rows are internally consistent because they are read from one snapshot or from staged rows materialized from one snapshot.
- Export packages are deterministic within the new schema version for payload ordering, checksums, and fingerprints.
- Streamed ZIP packages have valid local headers, CRC32 values, sizes, central directory entries, and package checksums.
- Golden package tests prove the new schema version, asset-entry/reference payloads, and fingerprint rules are stable.
- Same-branch export/import works for the new transfer schema version before shipping.

## Phase 7: Progress And UX

Purpose:

- Make long-running import/export work understandable and recoverable from the user’s perspective.

Implementation checklist:

- Keep layout-first import UI behavior and avoid full-page blocking spinners.
- Add progress phases for upload, package scan, staging load, fingerprint validation, analyze, dependency resolution, revalidation, asset promotion, commit, cleanup, export assembly, export asset staging, and export package write.
- Show row progress when row totals are reliable.
- Show byte progress when byte totals are reliable.
- Avoid fake precision when a phase cannot know total work.
- Include stale-plan reason details in the plan review UI when commit revalidation reopens a plan.
- Keep `/projects/import` and export entry points working in browser and desktop.
- Verify upload, polling, background job, download, and runtime asset paths in desktop when those paths change.

Before measurement:

- Record current perceived-progress gaps for large analyze and commit phases.
- Measure time spent in states where progress is `0%`, missing, or stale.
- Capture current browser and desktop flow screenshots or notes for large package import/export.

After measurement:

- Rerun large import/export flows and record time spent without meaningful progress updates.
- Verify users can tell whether work is in scan, analyze, dependency, commit, asset, or cleanup phase.
- Verify browser and desktop import/export flows still complete and show phase progress for both import and export work.

Estimated impact:

- No direct backend speedup.
- Large perceived improvement for multi-minute jobs.

Acceptance criteria:

- Browser and desktop import flows show useful progress for large package analyze and commit.
- Browser and desktop export flows show useful progress for export assembly, asset staging, and package write.
- Background jobs keep heartbeat and owner safety while the process is alive.
- Server restart does not need to resume staged work, but incomplete staged sessions fail or expire clearly.

## Cross-Phase Implementation Checklist

- Add import/export benchmark fixtures and timing helpers under existing project-transfer tests or scripts.
- Add a dedicated `bun run bench:project-transfer` benchmark entrypoint with fixture selection and machine-readable output for the benchmark matrix.
- Prefer temp-root staging files plus operation-local DuckDB temp tables. Add DuckDB migrations under `src/db/duckdbMigrations/` only for target-state dirty tokens, transfer metadata, or app-scoped scratch tables that must persist beyond one helper-managed connection. App-scoped scratch tables need operation/session keys plus cleanup or TTL rules.
- Add a staging repository/helper near `src/server/services/projectTransfer/`.
- Change `projectTransferSchemas.ts`, `projectTransferManifest.ts`, `projectTransferPayloadSchemas.ts`, `projectTransferPaths.ts`, and `projectTransferContracts.ts` together for any schema, payload-path, fingerprint, manifest, or progress contract cutover.
- Change `projectTransferPaths.ts`, `projectTransferSession.ts`, `projectTransferSessionRepository.ts`, and `projectTransferSessionRecovery.ts` together when staging paths, staging revisions, temp-layout contracts, request-gap survival, ownership leases, or cleanup semantics change.
- Change `projectTransferFingerprint.ts` to support schema-vNext streaming logical fingerprints from staged row digests and singleton payload digests, with tests proving excluded source/target ids cannot influence row ordering through `sortKey`.
- Change `projectTransferAnalyze.ts` to stream/load payloads into staging before target analysis.
- Change `projectTransferAnalyzeTarget.ts` to query staged rows with joins instead of generated `IN` and `OR` clauses.
- Change `projectTransferDependencyResolution.ts` to query staged dependency and fidelity rows instead of reparsing extracted payload files.
- Change `projectTransferFidelityValidation.ts` to use staged judgment and human-review rows for conflict detection.
- Add target-state dirty tokens or fingerprints used by analyze and commit revalidation, plus tests proving missing coverage forces full revalidation.
- Change `projectTransferCommit.ts` and `projectTransferCommitWriter.ts` together so staged-row consumption, commit revalidation, same-connection operation-local tables, and set-based writes move in lockstep.
- Change `projectTransferCommitRollback.ts` to stream asset promotion with rollback-safe manifests.
- Change export assembly in `projectTransferExport.ts`, `projectTransferExportAssets.ts`, `projectTransferExportPackage.ts`, and `projectTransferZip.ts` to stream large payloads, assets, and packages while preserving field-specific URL policy and valid ZIP CRC/size metadata.
- Add one new transfer `schemaVersion` for the streaming cutover and bind the new fingerprint semantics to that `schemaVersion`.
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
- JS heap growth must be bounded by active batch size plus asset copy buffers, not by total package rows; RSS and DuckDB spill must stay within configured DuckDB memory and temp-spill budgets.
- Small inline package latency must not regress by more than 5% unless the PR explicitly trades small-package latency for large-package capacity.
- Any PR that changes shared/core import or export paths must include the small inline package fixture in its benchmark results in addition to the targeted bottleneck fixture.
- Large package rows/sec or bytes/sec should improve by at least 10% for the bottleneck phase the PR targets, or the PR should justify why correctness, memory, or writer-duration improvement is the real win.
- DuckDB writer transaction duration must not increase for commit-writer changes.
- Correctness, rollback safety, and benchmark-critical model/provider settings must not regress even when speed results are noisy.

## Quality Gates

- `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferAnalyzeTarget.test.ts` for Phase 2 set-based analyze changes, including recomputed prompt-content-hash matching, normalized strong article identifier matching, same-operation connection use for temp tables, and staged package-contract blockers preventing commit readiness.
- Add and run `bun test src/server/services/projectTransfer/projectTransferDirtyTokenRevalidation.test.ts` for Phase 3 dirty-token coverage, missing-token fallback, changed-surface, coverage-version mismatch behavior, and set-based commit writes advancing dirty tokens transactionally.
- `bun test src/server/services/projectTransfer/projectTransferContracts.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts` including imported snapshot reuse by fingerprint, virtual `new:provider:*`/`new:model:*` ids, and no remapping onto arbitrary local provider/model rows.
- Add and run `bun test src/server/services/projectTransfer/projectTransferSnapshotFingerprint.test.ts` for dependency-resolution and commit-materialization fingerprint parity over metadataJson, provider runtime config, imported markers, disabled reuse, and variant/version handling.
- `bun test src/server/services/projectTransfer/projectTransferFidelityValidation.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts` including disabled imported provider/model snapshot materialization, exact-match snapshot reuse, repeated-import behavior, same-connection operation-local table consumption, normalized strong identifier conflict validation, and separate `variant`/`version` preservation.
- `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts` including bounded-concurrency promotion status updates that cannot lose pending/copied rollback state.
- `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferExport.test.ts` including `rawArticleProvenanceMode` `include`/`omit`, threshold-boundary preflight estimates, execution mode, actual package bytes, manifest warning details, import round trips, article-dependent signatures from post-rewrite staged article payloads, and full-assembly signed/credential URL preservation without runtime-asset reinterpretation.
- `bun test src/server/services/projectTransfer/projectTransferExportAssets.test.ts` including failure-path coverage for symlink rejection, non-file rejection, missing assets, source-change-during-copy, the field-specific URL policy matrix, and signed/credential non-local URLs in asset-shaped fields.
- `bun test src/server/services/projectTransfer/projectTransferExportPackage.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferFingerprint.test.ts` including schema-vNext row-order tests proving source ids, target ids, DB ids, and other excluded fields cannot affect package fingerprints through staging `sortKey` values.
- `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferIdentifierNormalization.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts` including schema-vNext manifest entries for asset-entry and asset-reference payload files, and schema-version-bound payload path validation.
- `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts` including schema-version-aware archive root allowlists for current schema and schema-vNext.
- `bun test src/server/services/projectTransfer/projectTransferPayloadSchemas.test.ts` including schema-vNext asset-entry and asset-reference payload contracts and active-payload-key row-count coverage.
- Add and run `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts` for redaction or external-URL behavior changes, including byte-preserved signed, credential-bearing, query-string, and fragment non-local URLs with current no-warning external URL preservation and no dependent omission cascade.
- `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts` including cleanup safety for staged roots keyed by stale `stagingRevision`.
- `bun test src/server/services/projectTransfer/projectTransferSessionRepository.test.ts` including atomic current-`stagingRevision` publish and reviewed-plan `stagingRevision` validation for staged state handoff.
- `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`
- `bun test src/server/services/projectTransfer/projectTransferZip.test.ts` including streamed file/stream entries with staged CRC32/uncompressed-size metadata, correct central-directory metadata, and package checksum.
- `bun test src/server/routes/projectTransferRoutes.test.ts`
- Add and run golden package/fingerprint tests for any new transfer schema version, including asset-entry/reference payloads and model `variant`/`version` fingerprint parity.
- Add and run unsupported old-schema and old-fingerprint import rejection tests for the streaming cutover.
- Add and run same-branch export/import tests for any new transfer schema version.
- After Phase 0 adds the benchmark entrypoint, run `bun run bench:project-transfer -- --fixture=<targeted-fixture>` for each benchmark shape the PR claims to improve, with before/after median and worst-run results attached to the PR or implementation note.
- After Phase 0 adds the benchmark entrypoint, run `bun run bench:project-transfer -- --fixture=small-inline-package` for any PR that changes shared/core import or export paths.
- `bun run db:mig` if target-state dirty tokens, app-scoped scratch tables, or transfer metadata migrations are added.
- `bun test src/db/migrateDuckdb.test.ts` if project-transfer migrations are added or changed.
- `bun run lint`
- `bun run test:vitest -- "src/app/routes/+projects/-+import.vitest.tsx"` if import/export progress payloads, warning codes/details, omission-warning grouping, or wizard behavior changes.
- `bun run test:vitest -- "src/app/routes/+projects/-+index.vitest.tsx"` if active Projects-page import/export entry-point visibility, order, or routing changes.
- `bun run test:vitest -- "src/app/routes/+projects/+archived/archivedProjectsTable.vitest.tsx"` if export/import entry-point behavior changes for archived projects.
- `bun test src/app/routes/+projects/importWizard/projectImportClient.test.ts` if upload headers, session URLs, or upload progress wiring changes.
- `bun run test:vitest -- "src/components/main/projectsGrid.vitest.tsx"` if import/export progress UX or export/import entry-point behavior changes.
- `bun run build` if shared UI, route response types, or import wizard progress changes.
- `bun run desktop:build` if runtime asset paths, temp paths, upload/download wiring, or import/export UI paths change.
- Browser verify: export a project with `rawArticleProvenanceMode` `include` and `omit`, import it through `/projects/import`, resolve dependencies if needed, commit, and open the imported project.
- Browser verify: export a project containing signed or credential-bearing URLs and confirm exact URL values are preserved, asset discovery does not reinterpret them as runtime asset paths, and no article/dependent omission cascades occur.
- Browser verify: import the same package twice and confirm exact-match imported provider/model snapshots are reused by fingerprint.
- Browser verify: import a package with judgments/human review rows and confirm analysis resolves those rows against reused or virtual imported snapshots without remapping to arbitrary local provider/model rows.
- Browser verify: import a package with judgments/human review rows and confirm provider/model rows are imported as disabled snapshots without usable secret references.
- Desktop verify: same flows when shared/core project-transfer server, session, polling, progress, export/import flow, runtime asset path, file upload/download, export UI, import wizard, or temp-storage behavior changes.

## Non-Goals

- Do not solve performance by raising `DUCKDB_MEMORY_LIMIT`.
- Do not silently skip commit revalidation.
- Do not silently retry, downgrade, or alter benchmark-critical model/provider settings.
- Do not require staged analyze or commit state to survive server restart, but do keep active-session staging available across normal API request gaps.
- Do not import old transfer schema versions after the streaming cutover; fail with a clear unsupported-schema error.
- Do not preserve old transfer package fingerprints across the streaming export cutover.
- Do not add backward-compatibility shims for old transfer packages or intermediate staging state.
- Do not optimize only one happy-path package shape; article-heavy, judgment-heavy, and asset-heavy packages need separate coverage.
