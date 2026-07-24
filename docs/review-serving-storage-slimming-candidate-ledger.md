# Review-Serving Storage Slimming Candidate Ledger

## Scope

This ledger is limited to review-serving storage surfaces observed in `REVIEW_STORAGE_SHAPE_PHYSICAL_EVIDENCE.md` for project `7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac`. It is a mechanical delete/slimming candidate ledger only. It does not authorize deletion, slimming, schema changes, migration, retention changes, or writer rewrites.

Current-DB gates now have passing evidence after PR #131: `bun run test:dev-server:current-db` and `bun run test:network-smoke:current-db` completed without the forbidden DuckDB fatal runtime restart. That unblocks investigation, but every storage deletion or slimming candidate still needs per-candidate route parity, benchmark, recovery, and live progress proof before implementation.

Post-#140 status: the five empty legacy patch tables observed in the original evidence have been retired by bounded forward migrations `0118` through `0122`. After PR #142's title-search contract proof, `mart.review_title_search_serving_v4.activity_sort_at` is retired by bounded forward migration `0123`. The selected-import payload evidence added after PR #140 still does not authorize column slimming because the inspected project has no same-project hot-field rows and current writer/reader/recovery paths still carry those fields.

## Retired Since Original Evidence

| Retired surface | Migration | Current status | Notes |
| --- | --- | --- | --- |
| `mart.review_queue_patch_v4` | `0118_dropReviewQueuePatchV4.sql` | Retired | Removed from active schema/evidence expectations; guarded against non-test runtime reintroduction. |
| `mart.review_human_status_patch_v4` | `0119_dropReviewHumanStatusPatchV4.sql` | Retired | Removed from active schema/evidence expectations; guarded against non-test runtime reintroduction. |
| `mart.review_llm_status_patch_v4` | `0120_dropReviewLlmStatusPatchV4.sql` | Retired | Removed from active schema/evidence expectations; guarded against non-test runtime reintroduction. |
| `mart.review_article_filter_posting_patch_v4` | `0121_dropReviewArticleFilterPostingPatchV4.sql` | Retired | Removed from active schema/evidence expectations; guarded against non-test runtime reintroduction. |
| `mart.review_article_display_patch_v4` | `0122_dropReviewArticleDisplayPatchV4.sql` | Retired | Removed from active schema/evidence expectations; guarded against non-test runtime reintroduction. |
| `mart.review_title_search_serving_v4.activity_sort_at` | `0123_dropReviewTitleSearchActivitySortAt.sql` | Retired | Removed from active title-search schema and writers after PR #142 contract proof; title-search rows remain token membership only. |

## Candidate Ledger

| Candidate | Table/columns | Current evidence | Known writer/consumer to trace | Risk class | Required proof before removal/slimming | Recommended disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Empty display patch surface | `mart.review_article_display_patch_v4` | 0 rows, 25 columns, 1 index in the original evidence | Retired by migration `0122` | Retired | Already proven by focused tests, route parity, benchmark, current-DB gates, and regenerated evidence | Closed; no longer an active candidate |
| Empty LLM status patch surface | `mart.review_llm_status_patch_v4` | 0 rows, 14 columns, 1 index in the original evidence | Retired by migration `0120` | Retired | Already proven by focused tests, route parity, benchmark, current-DB gates, and regenerated evidence | Closed; no longer an active candidate |
| Empty human status patch surface | `mart.review_human_status_patch_v4` | 0 rows, 12 columns, 1 index in the original evidence | Retired by migration `0119` | Retired | Already proven by focused tests, route parity, benchmark, current-DB gates, and regenerated evidence | Closed; no longer an active candidate |
| Empty queue patch surface | `mart.review_queue_patch_v4` | 0 rows, 10 columns, 1 index in the original evidence | Retired by migration `0118` | Retired | Already proven by focused tests, route parity, benchmark, current-DB gates, and regenerated evidence | Closed; no longer an active candidate |
| Empty filter-posting patch surface | `mart.review_article_filter_posting_patch_v4` | 0 rows, 11 columns, 1 index in the original evidence | Retired by migration `0121` | Retired | Already proven by focused tests, route parity, benchmark, current-DB gates, and regenerated evidence | Closed; no longer an active candidate |
| Empty unassessed queue serving surface | `mart.review_unassessed_queue_serving_v4` | 0 rows, 10 columns, 1 index, duplicate key count 0 | Queue builder, unassessed queue route/UI consumers | High | Prove empty state is valid for representative projects and not data loss; live current-DB progress with unassessed work present | Keep until queue route and workload proof exists |
| Empty summary contribution serving surface | `mart.review_article_summary_contribution_v4` | 0 rows, 9 columns, 1 index | Summary contribution writer, summary/count/facet consumers | Medium | Prove contribution serving reads are fully replaced by current summary/count tables; route parity for summaries | Investigate, but do not remove without summary route proof |
| Null selected-import payload columns | `app.review_selected_article_import_v4`: `import_route_id`, `source_record_key`, `selected_rank_key`, `selected_rank_numeric`, `publication_year`, `article_title`, `journal_title`, `external_id` | 18,784 rows; each listed column is 100% null; same-project hot-field rows are 0 in PR #140 evidence | Selected import writer, review import/rebuild readers, recovery tools | Medium | Prove runtime non-population across intended source scopes or change writer/reader/recovery consumers before slimming; route parity for selected article fields | Keep for now; PR #140 evidence blocks immediate column slimming |
| Null projector watermark lease/cursor fields | `app.review_serving_projector_watermark`: `snapshot_id`, `import_route_id`, `lease_owner`, `lease_expires_at`, `cursor_json`, `last_error` | 21,025 rows; listed fields are 100% null | Projector watermark writer, maintenance owner, recovery/readiness routes | High | Prove owner/lease/recovery semantics are not latent; current-DB progress and recovery proof under active worker load | Keep for now; investigate only with recovery tests |
| Rebuild request inactive lease/OOM fields | `app.review_rebuild_request`: `retry_after`, `oom_category`, `over_budget_reason`, `lease_owner`, `lease_expires_at` | 14 rows; listed fields are 100% null | Rebuild admission/claiming, OOM recovery, operator diagnostics | High | Prove OOM/retry/lease states are obsolete or moved; focused recovery tests; live progress proof | Non-candidate until recovery semantics are replaced or proven unused |
| Rebuild chunk diagnostics payload | `app.review_rebuild_chunk_manifest`: `budget_json`, `diagnostics_json` | 96,202 rows, 50 columns; size proxies about 3.2 MB and 13.8 MB | Rebuild worker, benchmark/timing inspectors, operator evidence | High | Prove diagnostics retention window or external artifact replaces operator evidence; benchmark and recovery evidence remain adequate | Retention/slimming candidate, not deletion-ready |
| Large judgment payload serving | `mart.review_article_judgment_detail_serving_v4`: `judgment_payload_json`, nullable `model_id`, sparse answer columns | 262,976 rows; `judgment_payload_json` size proxy about 910 MB; `model_id` 100% null; answer columns mostly null | Judgment detail route, filters, export/detail consumers | Very high | Route parity for detail and export payloads; model/config safety proof; benchmark on payload-heavy routes | Non-candidate for deletion; consider payload projection slimming only |
| Large summary rebuild partial | `mart.review_article_summary_rebuild_partial_v4` | 320,969 rows, 22 columns; many branch-specific nullable columns | Rebuild worker partial aggregation, summary/count/facet finalizers | High | Prove rebuild partial lifecycle is bounded and cleaned; route parity after rebuild; current-DB progress under rebuild | Retention/cleanup candidate only |
| Very large contribution rebuild partial | `mart.review_article_summary_contribution_rebuild_partial_v4` | 4,257,474 rows, 11 columns; largest row-count surface in evidence | Summary contribution rebuild worker/finalizer | High | Prove partial rows are transient, reproducible, and safe to clean after finalization; benchmark and live progress proof | Highest-priority retention candidate, not reader deletion |
| Main article serving table | `mart.review_article_serving_v4` | 150,272 rows, 45 columns, 0 duplicate keys | Primary review list/detail routes | Very high | Full route parity, cursor/order parity, physical benchmark, recovery and live progress proof | Non-candidate; use as protected baseline |
| Filter posting serving table | `mart.review_article_filter_posting_serving_v4` | 244,758 rows, 10 columns, 0 duplicate keys | Filtered list readers and count/facet consumers | Very high | Filter route parity, ordering/cursor proof, benchmark under filter workloads | Non-candidate; protected unless a replacement index is proven |
| Title search serving table | `mart.review_title_search_serving_v4` | 229,174 rows, 9 columns, 1 index in original evidence; `activity_sort_at` retired by migration `0123` after PR #142 | Title search route/read model | High | Continue to protect token membership route parity and benchmark evidence for the table itself | Keep table; retired repeated null sort metadata |

## Post-#140 Remaining Candidate Ranking

1. `mart.review_article_summary_contribution_v4` has encouraging static evidence because current summary recompute paths write count/facet serving tables directly, but it is not ready for a drop. The current physical proof is one-project scoped; global/current-DB row proof and summary route parity evidence should come first.
2. `app.review_selected_article_import_v4` payload columns stay blocked. PR #140 makes the null evidence explicit, but same-project hot-field rows are also zero and active writer/reader/recovery paths still carry the fields.
3. `mart.review_unassessed_queue_serving_v4` stays protected. Current code actively uses it for foreground unassessed routes, queue ordering, judgment-job scheduling, summary projection, and retention.
4. `app.review_serving_projector_watermark` nullable lease/cursor fields stay protected because they belong to lifecycle and recovery semantics, even when current scoped evidence shows nulls.

## Quality Gates

- This ledger includes candidate, non-candidate, blocked, and retired rows and states that it does not authorize deletion.
- Every future candidate implementation must provide per-candidate route parity, benchmark, recovery, and live progress proof before removal/slimming.
- `git diff --check -- docs/review-serving-storage-slimming-candidate-ledger.md` passes.
