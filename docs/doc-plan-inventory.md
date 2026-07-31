# Documentation And Plan Inventory

Last curated: 2026-07-31.

This inventory records creation and last-edit dates for the documentation and
plan files reviewed during the July 2026 cleanup. Dates are from `git log
--follow`; filesystem birth dates were also checked and matched the recent
working-tree materialization, so git dates are the durable source.

## Kept Active

| File                                         | Created              | Last edited | Disposition                                                                                                                                           |
| -------------------------------------------- | -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                  | existing project doc | active      | Keep as project entry point.                                                                                                                          |
| `CONTRIBUTING.md`                            | existing project doc | active      | Keep.                                                                                                                                                 |
| `SECURITY.md`                                | existing project doc | active      | Keep.                                                                                                                                                 |
| `TESTS.md`                                   | 2026-06-26           | 2026-07-29  | Keep as test gate contract.                                                                                                                           |
| `PERF.md`                                    | 2026-07-09           | 2026-07-23  | Keep as benchmark/performance command contract.                                                                                                       |
| `OOM_ERRORS.md`                              | 2026-06-12           | 2026-07-27  | Keep; `AGENTS.md` requires entries for OOM fixes.                                                                                                     |
| `docs/README_RUN_LOCAL.md`                   | 2025-08-07           | 2026-05-13  | Keep as local development guide.                                                                                                                      |
| `docs/network-smoke.md`                      | 2026-07-31           | 2026-07-31  | New consolidation of the network-smoke plan and June cutover evidence.                                                                                |
| `docs/review-serving-operations.md`          | 2026-07-31           | 2026-07-31  | New consolidation of DuckDB recovery, current-DB fatal-restart proof, stale rebuild artifacts, and operator commands.                                 |
| `docs/review-serving-storage-performance.md` | 2026-07-31           | 2026-07-31  | New consolidation of review-serving storage-slimming, selected-import ownership, post-import mart creation, benchmark boundaries, and remaining work. |
| `docs/open-source-readiness.md`              | 2026-07-31           | 2026-07-31  | New consolidation of open-source route, Docker/docs, local API, and secret-history findings.                                                          |
| `docs/doc-plan-inventory.md`                 | 2026-07-31           | 2026-07-31  | This inventory.                                                                                                                                       |

## Condensed Into Current Docs

| Old file                                                                | Created    | Last edited | Condensed into                                                                  |
| ----------------------------------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------- |
| `docs/network-smoke-audit-plan.md`                                      | 2026-06-23 | 2026-06-25  | `docs/network-smoke.md`                                                         |
| `docs/network-smoke-oom-cutover-evidence.md`                            | 2026-06-25 | 2026-06-25  | `docs/network-smoke.md`                                                         |
| `docs/review-serving-duckdb-index-recovery.md`                          | 2026-07-09 | 2026-07-09  | `docs/review-serving-operations.md`                                             |
| `docs/review-serving-current-db-duckdb-fatal-restart-evidence.md`       | 2026-07-24 | 2026-07-24  | `docs/review-serving-operations.md`                                             |
| `docs/review-serving-rebuild-artifact-operator-candidates.md`           | 2026-07-24 | 2026-07-27  | `docs/review-serving-operations.md`                                             |
| `docs/review-serving-rebuild-request-lifecycle-field-evidence.md`       | 2026-07-24 | 2026-07-24  | `docs/review-serving-operations.md`                                             |
| `docs/review-serving-baseline-route-parity-and-benchmark-evidence.md`   | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-selected-import-display-copy-write-suppression.md` | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-selected-import-full-ownership-plan.md`            | 2026-07-29 | 2026-07-29  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-selected-import-further-work-PLAN.md`              | 2026-07-29 | 2026-07-29  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-selected-import-payload-consumer-proof.md`         | 2026-07-24 | 2026-07-27  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-storage-retention-cleanup-evidence.md`             | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-storage-slimming-candidate-ledger.md`              | 2026-07-24 | 2026-07-27  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-storage-slimming-first-slice-plan.md`              | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-summary-contribution-recoverability.md`            | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-summary-contribution-row-classification.md`        | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-summary-contribution-serving-proof.md`             | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `docs/review-serving-post-import-mart-creation-performance-PLAN.md`     | 2026-07-30 | 2026-07-30  | `docs/review-serving-storage-performance.md`                                    |
| `REVIEW_APPEND_STORAGE_STRATEGY_PLAN.md`                                | 2026-07-23 | 2026-07-23  | `docs/review-serving-storage-performance.md`                                    |
| `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`                                    | 2026-07-23 | 2026-07-23  | `docs/review-serving-storage-performance.md`                                    |
| `REVIEW_STORAGE_SHAPE_EVIDENCE_UNBLOCKER.md`                            | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `REVIEW_STORAGE_SHAPE_PHYSICAL_EVIDENCE.md`                             | 2026-07-24 | 2026-07-24  | `docs/review-serving-storage-performance.md`                                    |
| `STORAGE_SHAPE_AUDIT_PLAN.md`                                           | 2026-07-23 | 2026-07-23  | `docs/review-serving-storage-performance.md`                                    |
| `plans/openSourceDocsDockerPlan.md`                                     | 2026-05-13 | 2026-07-23  | `docs/open-source-readiness.md`                                                 |
| `plans/openSourceRouteSurface.md`                                       | 2026-05-11 | 2026-05-29  | `docs/open-source-readiness.md`                                                 |
| `plans/openSourceSecretsHistoryFindings.md`                             | 2026-05-29 | 2026-07-23  | `docs/open-source-readiness.md`                                                 |
| `plans/supportedLocalApi.md`                                            | 2026-05-12 | 2026-05-13  | `docs/open-source-readiness.md`                                                 |
| `plans/requestAttemptCloseoutBackfillPlan.md`                           | 2026-05-14 | 2026-05-14  | `docs/review-serving-operations.md`                                             |
| `plans/FLEX_SYSTEM_PROMPT.md`                                           | 2026-06-09 | 2026-06-09  | `docs/review-serving-storage-performance.md` as future product work.            |
| `plans/MATCH_PROVIDER_LIMIT.md`                                         | 2026-04-16 | 2026-04-20  | `docs/review-serving-storage-performance.md` as future runtime throughput work. |

## Deleted As Obsolete Scratch

All files under `plans/old/` were removed. They were historical implementation
scratchpads or superseded phase plans. The only still-useful themes were folded
into the consolidated docs above:

- DuckDB/review-serving recovery and OOM lessons are retained in
  `docs/review-serving-operations.md` and `OOM_ERRORS.md`.
- Review-serving storage, benchmark, and import-to-readiness work is retained in
  `docs/review-serving-storage-performance.md`.
- Open-source release, route surface, and secret-history gates are retained in
  `docs/open-source-readiness.md`.
- Provider scheduling/system-prompt ideas are retained only as future-work
  bullets, not as active implementation plans.

`DEV_REPORT.md` and `TODO.md` were also removed: `DEV_REPORT.md` was a May 2026
status narrative superseded by source history and current docs, and `TODO.md`
contained no actionable content.

Generated `tasks/*.json` PRD/task specs were removed with their corresponding
stale plans. No non-task source files referenced them during cleanup.
