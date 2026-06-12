# OOM Errors

Record every out-of-memory issue and fix here.

Entry format:

## YYYY-MM-DD - Area

- Error: Short log excerpt.
- Context: Affected job, query, route, command, or runtime path.
- Cause: Short explanation of why memory was exhausted.
- Fix: Short explanation of the code, query, config, or operational change.
- Verification: Command, test, or runtime check used to verify the fix.

## 2026-06-12 - Judgment Queue Refill

- Error: `Out of Memory Error: failed to pin block of size 256.0 KiB (6.2 GiB/6.2 GiB used)` from `[cron] runAddToQueue`.
- Context: Raw summary-mode judgment queue refill query over `dirty_scope_candidate` and `app.judgment_human_summary`.
- Cause: The refill path sorted a broad summary-priority candidate bucket by article activity before applying the small queue limit.
- Fix: Queue-only raw summary scans now stage bounded `summary_article_candidate` IDs and order by article ID before joining dirty/scope article tables.
- Verification: `bun test src/services/olap/duckdbOlap.test.ts`; `bun test src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts`; scoped ESLint.
