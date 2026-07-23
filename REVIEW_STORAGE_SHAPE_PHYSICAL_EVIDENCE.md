# Review Storage Shape Physical Evidence

Generated at: 2026-07-23T20:25:05.239Z

Mode: readonly-snapshot

Project ID: `7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac`

Snapshot path used during collection: `/Users/fredrik/.openclaw/tmp/forska-duckdb-studio/forska.duckdb.2026-07-23T20-25-02.491Z.cde743e9-36ac-4a93-bbfe-d51005e4fdc1.duckdb`

This file is a small follow-up evidence artifact for the storage-shape audit. It does not update `STORAGE_SHAPE_AUDIT_PLAN.md` and does not authorize deletion, slimming, or migration work by itself.

## Table Summary

| Table | Rows | Columns | Scope | Indexes | Duplicate keys | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `app.review_selected_article_import_v4` | 18784 | 16 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 | 0 | ok |
| `app.review_selected_import_snapshot` | 1 | 14 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 |  | ok |
| `app.review_projection_identity_manifest` | 11 | 18 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 |  | ok |
| `app.review_serving_snapshot_manifest` | 2 | 17 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 | 0 | ok |
| `app.review_serving_dirty_work` | 190072 | 16 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 |  | ok |
| `app.review_serving_projector_watermark` | 21025 | 17 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 |  | ok |
| `app.review_rebuild_request` | 14 | 23 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 |  | ok |
| `app.review_rebuild_chunk_manifest` | 96202 | 50 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 | 0 | ok |
| `app.review_serving_retention_mark` | 8 | 8 | global | 0 |  | ok |
| `mart.review_article_serving_v4` | 150272 | 45 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 | 0 | ok |
| `mart.review_article_display_patch_v4` | 0 | 25 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_llm_status_patch_v4` | 0 | 14 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_human_status_patch_v4` | 0 | 12 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_queue_patch_v4` | 0 | 10 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_article_filter_posting_patch_v4` | 0 | 11 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_article_filter_posting_serving_v4` | 244758 | 10 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 | 0 | ok |
| `mart.review_article_judgment_detail_serving_v4` | 262976 | 15 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 | 0 | ok |
| `mart.review_article_count_serving_v4` | 32 | 12 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 | 0 | ok |
| `mart.review_filter_facet_serving_v4` | 6 | 14 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 | 0 | ok |
| `mart.review_filter_option_serving_v4` | 39 | 16 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 2 | 0 | ok |
| `mart.review_filter_posting_stats_v4` | 72 | 10 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 0 | 0 | ok |
| `mart.review_title_search_serving_v4` | 229174 | 9 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 | 0 | ok |
| `mart.review_unassessed_queue_serving_v4` | 0 | 10 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 | 0 | ok |
| `mart.review_article_summary_contribution_v4` | 0 | 9 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_article_summary_rebuild_partial_v4` | 320969 | 22 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |
| `mart.review_article_summary_contribution_rebuild_partial_v4` | 4257474 | 11 | `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'` | 1 |  | ok |

## app.review_selected_article_import_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 18784
- Columns: 16
- Indexes observed: 0
- Duplicate key columns: `project_id`, `project_scope_identity`, `selected_import_snapshot_id`, `article_id`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 18784 | 1 |
| `selected_import_snapshot_id` | `VARCHAR` | 0 | 18784 | 1 |
| `article_id` | `VARCHAR` | 0 | 18784 | 17875 |
| `project_scope_identity` | `VARCHAR` | 0 | 18784 | 1 |
| `import_route_id` | `VARCHAR` | 18784 | 0 | 0 |
| `source_record_key` | `VARCHAR` | 18784 | 0 | 0 |
| `selected_rank_key` | `VARCHAR` | 18784 | 0 | 0 |
| `selected_rank_numeric` | `DOUBLE` | 18784 | 0 | 0 |
| `publication_year` | `INTEGER` | 18784 | 0 | 0 |
| `article_title` | `VARCHAR` | 18784 | 0 | 0 |
| `journal_title` | `VARCHAR` | 18784 | 0 | 0 |
| `external_id` | `VARCHAR` | 18784 | 0 | 0 |
| `duplicate_flag` | `BOOLEAN` | 0 | 18784 | 1 |
| `conflict_flag` | `BOOLEAN` | 0 | 18784 | 1 |
| `tombstone` | `BOOLEAN` | 0 | 18784 | 1 |
| `selected_import_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 18784 | 4 |

_No JSON/payload size proxies collected._
## app.review_selected_import_snapshot

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 1
- Columns: 14
- Indexes observed: 0
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:42:06.245431+02 | 2026-07-10 07:42:06.245431+02 |
| `updated_at` | 2026-07-21 11:29:05.271058+02 | 2026-07-21 11:29:05.271058+02 |
| `started_at` | 2026-07-10 07:42:06.245431+02 | 2026-07-10 07:42:06.245431+02 |
| `completed_at` | 2026-07-21 11:29:05.271058+02 | 2026-07-21 11:29:05.271058+02 |
| `lease_expires_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 1 | 1 |
| `selected_import_snapshot_id` | `VARCHAR` | 0 | 1 | 1 |
| `status` | `VARCHAR` | 0 | 1 | 1 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 1 | 1 |
| `project_scope_identity` | `VARCHAR` | 0 | 1 | 1 |
| `source_delta_high_water` | `BIGINT` | 0 | 1 | 1 |
| `cursor_json` | `JSON` | 1 | 0 | 0 |
| `owner` | `VARCHAR` | 1 | 0 | 0 |
| `lease_owner` | `VARCHAR` | 1 | 0 | 0 |
| `lease_expires_at` | `TIMESTAMP WITH TIME ZONE` | 1 | 0 | 0 |
| `started_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 1 | 1 |
| `completed_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 1 | 1 |
| `last_error` | `VARCHAR` | 1 | 0 | 0 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 1 | 1 |

| Size proxy | Value |
| --- | --- |
| `cursor_json_stringBytes` |  |
## app.review_projection_identity_manifest

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 11
- Columns: 18
- Indexes observed: 0
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:41:59.964428+02 | 2026-07-10 07:42:00.320966+02 |
| `updated_at` | 2026-07-15 23:06:34.72522+02 | 2026-07-20 06:55:37.335478+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 11 | 1 |
| `review_config_hash` | `VARCHAR` | 1 | 10 | 1 |
| `projection_component` | `VARCHAR` | 0 | 11 | 11 |
| `status` | `VARCHAR` | 0 | 11 | 1 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 11 | 3 |
| `manifest_id` | `VARCHAR` | 0 | 11 | 12 |
| `projection_identity` | `VARCHAR` | 0 | 11 | 10 |
| `base_generation` | `BIGINT` | 0 | 11 | 1 |
| `patch_watermark` | `BIGINT` | 0 | 11 | 2 |
| `patch_range_start` | `BIGINT` | 0 | 11 | 2 |
| `patch_range_end` | `BIGINT` | 0 | 11 | 2 |
| `input_watermark` | `BIGINT` | 0 | 11 | 2 |
| `input_digest` | `VARCHAR` | 0 | 11 | 2 |
| `definition_version` | `VARCHAR` | 0 | 11 | 11 |
| `prompt_config_hash` | `VARCHAR` | 11 | 0 | 0 |
| `invalidation_reason` | `VARCHAR` | 0 | 11 | 2 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 11 | 3 |
| `input_watermarks_json` | `JSON` | 0 | 11 | 2 |

| Size proxy | Value |
| --- | --- |
| `input_watermarks_json_stringBytes` | 1003 |
## app.review_serving_snapshot_manifest

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 2
- Columns: 17
- Indexes observed: 2
- Duplicate key columns: `project_id`, `snapshot_id`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:42:00.320966+02 | 2026-07-15 23:06:34.72522+02 |
| `updated_at` | 2026-07-10 07:42:00.320966+02 | 2026-07-20 06:55:09.371048+02 |
| `failed_at` |  |  |
| `activated_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 2 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 2 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 2 | 2 |
| `selected_import_snapshot_id` | `VARCHAR` | 0 | 2 | 1 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 2 | 2 |
| `snapshot_status` | `VARCHAR` | 0 | 2 | 1 |
| `composed_identity_json` | `JSON` | 0 | 2 | 2 |
| `component_state_json` | `JSON` | 0 | 2 | 1 |
| `required_components_json` | `JSON` | 0 | 2 | 1 |
| `optional_components_json` | `JSON` | 0 | 2 | 1 |
| `source_watermarks_json` | `JSON` | 0 | 2 | 2 |
| `validation_result_json` | `JSON` | 2 | 0 | 0 |
| `last_known_good_snapshot_id` | `VARCHAR` | 2 | 0 | 0 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 2 | 2 |
| `activated_at` | `TIMESTAMP WITH TIME ZONE` | 2 | 0 | 0 |
| `failed_at` | `TIMESTAMP WITH TIME ZONE` | 2 | 0 | 0 |
| `last_error` | `VARCHAR` | 2 | 0 | 0 |

| Size proxy | Value |
| --- | --- |
| `composed_identity_json_stringBytes` | 740 |
| `component_state_json_stringBytes` | 4280 |
| `required_components_json_stringBytes` | 260 |
| `optional_components_json_stringBytes` | 20 |
| `source_watermarks_json_stringBytes` | 194 |
| `validation_result_json_stringBytes` |  |
## app.review_serving_dirty_work

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 190072
- Columns: 16
- Indexes observed: 0
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:41:31.419374+02 | 2026-07-11 14:22:58.175706+02 |
| `updated_at` | 2026-07-10 07:42:00.761116+02 | 2026-07-18 20:04:32.130056+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 190072 | 1 |
| `status` | `VARCHAR` | 0 | 190072 | 1 |
| `article_id` | `VARCHAR` | 46 | 190026 | 17875 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 190072 | 24474 |
| `dirty_work_id` | `VARCHAR` | 0 | 190072 | 208849 |
| `scope_kind` | `VARCHAR` | 0 | 190072 | 3 |
| `scope_id` | `VARCHAR` | 0 | 190072 | 19404 |
| `projection_key` | `VARCHAR` | 0 | 190072 | 11 |
| `dirty_kind` | `VARCHAR` | 0 | 190072 | 4 |
| `source_partition` | `VARCHAR` | 0 | 190072 | 3904 |
| `first_source_high_water_mark` | `BIGINT` | 0 | 190072 | 16914 |
| `latest_source_high_water_mark` | `BIGINT` | 0 | 190072 | 16914 |
| `latest_delta_id` | `VARCHAR` | 0 | 190072 | 21121 |
| `dirty_range_start` | `VARCHAR` | 190072 | 0 | 0 |
| `dirty_range_end` | `VARCHAR` | 190072 | 0 | 0 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 190072 | 3748 |

_No JSON/payload size proxies collected._
## app.review_serving_projector_watermark

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 21025
- Columns: 17
- Indexes observed: 0
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:41:59.966811+02 | 2026-07-18 20:04:32.130056+02 |
| `updated_at` | 2026-07-10 07:42:00.761116+02 | 2026-07-18 20:04:32.130056+02 |
| `lease_expires_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 21025 | 1 |
| `snapshot_id` | `VARCHAR` | 21025 | 0 | 0 |
| `projection_component` | `VARCHAR` | 0 | 21025 | 10 |
| `status` | `VARCHAR` | 0 | 21025 | 1 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 21025 | 19630 |
| `watermark_id` | `VARCHAR` | 0 | 21025 | 19017 |
| `projector_name` | `VARCHAR` | 0 | 21025 | 11 |
| `import_route_id` | `VARCHAR` | 21025 | 0 | 0 |
| `source_partition` | `VARCHAR` | 0 | 21025 | 3904 |
| `source_high_water_mark` | `BIGINT` | 0 | 21025 | 3 |
| `base_generation` | `BIGINT` | 0 | 21025 | 1 |
| `patch_watermark` | `BIGINT` | 0 | 21025 | 1 |
| `lease_owner` | `VARCHAR` | 21025 | 0 | 0 |
| `lease_expires_at` | `TIMESTAMP WITH TIME ZONE` | 21025 | 0 | 0 |
| `cursor_json` | `JSON` | 21025 | 0 | 0 |
| `last_error` | `VARCHAR` | 21025 | 0 | 0 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 21025 | 19630 |

| Size proxy | Value |
| --- | --- |
| `cursor_json_stringBytes` |  |
## app.review_rebuild_request

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 14
- Columns: 23
- Indexes observed: 2
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:42:00.320966+02 | 2026-07-20 06:55:09.371048+02 |
| `updated_at` | 2026-07-16 17:13:43.039274+02 | 2026-07-23 22:13:31.076924+02 |
| `completed_at` |  |  |
| `failed_at` | 2026-07-16 17:13:43.039274+02 | 2026-07-20 19:02:25.915006+02 |
| `lease_expires_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 14 | 1 |
| `status` | `VARCHAR` | 0 | 14 | 2 |
| `admission_state` | `VARCHAR` | 0 | 14 | 1 |
| `request_id` | `VARCHAR` | 0 | 14 | 14 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 14 | 12 |
| `reason` | `VARCHAR` | 0 | 14 | 2 |
| `requested_components_json` | `JSON` | 0 | 14 | 1 |
| `source_watermarks_json` | `JSON` | 0 | 14 | 12 |
| `identity_json` | `JSON` | 0 | 14 | 5 |
| `priority` | `INTEGER` | 0 | 14 | 1 |
| `retry_policy_json` | `JSON` | 0 | 14 | 2 |
| `retry_count` | `INTEGER` | 0 | 14 | 1 |
| `retry_after` | `TIMESTAMP WITH TIME ZONE` | 14 | 0 | 0 |
| `oom_category` | `VARCHAR` | 14 | 0 | 0 |
| `over_budget_reason` | `VARCHAR` | 14 | 0 | 0 |
| `diagnostics_json` | `JSON` | 0 | 14 | 3 |
| `lease_owner` | `VARCHAR` | 14 | 0 | 0 |
| `lease_expires_at` | `TIMESTAMP WITH TIME ZONE` | 14 | 0 | 0 |

| Size proxy | Value |
| --- | --- |
| `requested_components_json_stringBytes` | 1946 |
| `source_watermarks_json_stringBytes` | 8474 |
| `identity_json_stringBytes` | 2974 |
| `retry_policy_json_stringBytes` | 768 |
| `diagnostics_json_stringBytes` | 7620 |
## app.review_rebuild_chunk_manifest

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 96202
- Columns: 50
- Indexes observed: 1
- Duplicate key columns: `chunk_id`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-07-10 07:42:00.320966+02 | 2026-07-21 06:13:37.471528+02 |
| `updated_at` | 2026-07-20 06:54:57.555338+02 | 2026-07-23 22:13:30.117519+02 |
| `started_at` | 2026-07-20 06:43:40.362509+02 | 2026-07-23 22:13:30.109319+02 |
| `completed_at` | 2026-07-20 06:43:40.611619+02 | 2026-07-23 22:13:30.117519+02 |
| `lease_expires_at` | 2026-07-20 08:22:11.175+02 | 2026-07-20 08:25:40.034+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 96202 | 1 |
| `snapshot_id` | `VARCHAR` | 0 | 96202 | 2 |
| `projection_component` | `VARCHAR` | 0 | 96202 | 11 |
| `status` | `VARCHAR` | 0 | 96202 | 5 |
| `admission_state` | `VARCHAR` | 0 | 96202 | 2 |
| `request_id` | `VARCHAR` | 0 | 96202 | 3 |
| `chunk_id` | `VARCHAR` | 0 | 96202 | 81087 |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 96202 | 12277 |
| `projection_identity` | `VARCHAR` | 0 | 96202 | 10 |
| `input_digest` | `VARCHAR` | 0 | 96202 | 1 |
| `input_watermark` | `BIGINT` | 0 | 96202 | 3 |
| `chunk_start_key` | `VARCHAR` | 0 | 96202 | 42182 |
| `chunk_end_key` | `VARCHAR` | 0 | 96202 | 32465 |
| `output_base_generation` | `BIGINT` | 0 | 96202 | 1 |
| `checksum` | `VARCHAR` | 84680 | 11522 | 1440 |
| `lease_owner` | `VARCHAR` | 96200 | 2 | 2 |
| `lease_expires_at` | `TIMESTAMP WITH TIME ZONE` | 96200 | 2 | 2 |
| `last_error` | `VARCHAR` | 96153 | 49 | 1 |

| Size proxy | Value |
| --- | --- |
| `budget_json_stringBytes` | 3247902 |
| `diagnostics_json_stringBytes` | 13776916 |
## app.review_serving_retention_mark

- Row count scope: global table count
- Rows: 8
- Columns: 8
- Indexes observed: 0
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `created_at` | 2026-06-27 13:23:49.392749+02 | 2026-07-07 18:30:00.617193+02 |
| `updated_at` | 2026-07-23 22:13:30.748819+02 | 2026-07-23 22:13:30.919215+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 8 | 9 |
| `retention_scope` | `VARCHAR` | 0 | 8 | 7 |
| `cutoff_snapshot_id` | `VARCHAR` | 8 | 0 | 0 |
| `cutoff_base_generation` | `BIGINT` | 0 | 8 | 1 |
| `cutoff_patch_watermark` | `BIGINT` | 0 | 8 | 1 |
| `cleanup_cursor_json` | `JSON` | 0 | 8 | 5 |
| `last_cleaned_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 8 | 9 |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 8 | 6 |

| Size proxy | Value |
| --- | --- |
| `cleanup_cursor_json_stringBytes` | 128 |
## mart.review_article_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 150272
- Columns: 45
- Indexes observed: 0
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `list_mode_key`, `article_id`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `sort_key` | 2026-07-20 07:31:50.828776+02 | 2026-07-20 07:32:10.398015+02 |
| `activity_sort_at` | 2026-07-20 07:31:50.828776+02 | 2026-07-20 07:32:10.398015+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 150272 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 150272 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 150272 | 2 |
| `list_mode_key` | `VARCHAR` | 0 | 150272 | 4 |
| `article_id` | `VARCHAR` | 0 | 150272 | 17875 |
| `sort_key` | `TIMESTAMP WITH TIME ZONE` | 0 | 150272 | 20 |
| `activity_sort_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 150272 | 20 |
| `base_generation` | `BIGINT` | 0 | 150272 | 1 |
| `patch_watermark` | `BIGINT` | 0 | 150272 | 1 |
| `display_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `project_scope_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `selected_import_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `llm_status_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `human_status_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `posting_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `summary_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `payload_identity` | `VARCHAR` | 0 | 150272 | 1 |
| `article_title` | `VARCHAR` | 0 | 150272 | 18003 |

_No JSON/payload size proxies collected._
## mart.review_article_display_patch_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 25
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `sort_key` |  |  |
| `activity_sort_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `sort_key` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `activity_sort_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `display_identity` | `VARCHAR` |  |  | 0 |
| `base_generation` | `BIGINT` |  |  | 0 |
| `patch_watermark` | `BIGINT` |  |  | 0 |
| `article_title` | `VARCHAR` |  |  | 0 |
| `article_external_id` | `VARCHAR` |  |  | 0 |
| `journal_title` | `VARCHAR` |  |  | 0 |
| `url` | `VARCHAR` |  |  | 0 |
| `publication_year` | `INTEGER` |  |  | 0 |
| `tombstone` | `BOOLEAN` |  |  | 0 |
| `patch_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `article_created_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `source_metadata` | `JSON` |  |  | 0 |
| `article_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `arxiv_id` | `VARCHAR` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_llm_status_patch_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 14
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `review_config_hash` | `VARCHAR` |  |  | 0 |
| `list_mode_key` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `prompt_id` | `VARCHAR` |  |  | 0 |
| `prompt_config_hash` | `VARCHAR` |  |  | 0 |
| `base_generation` | `BIGINT` |  |  | 0 |
| `patch_watermark` | `BIGINT` |  |  | 0 |
| `llm_status_key` | `VARCHAR` |  |  | 0 |
| `answered_original` | `VARCHAR` |  |  | 0 |
| `answered_original_as_array` | `VARCHAR[]` |  |  | 0 |
| `latest_llm_created_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `tombstone` | `BOOLEAN` |  |  | 0 |
| `patch_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_human_status_patch_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 12
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `list_mode_key` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `prompt_id` | `VARCHAR` |  |  | 0 |
| `prompt_config_hash` | `VARCHAR` |  |  | 0 |
| `base_generation` | `BIGINT` |  |  | 0 |
| `patch_watermark` | `BIGINT` |  |  | 0 |
| `human_status_key` | `VARCHAR` |  |  | 0 |
| `human_answered_value` | `VARCHAR` |  |  | 0 |
| `latest_human_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `tombstone` | `BOOLEAN` |  |  | 0 |
| `patch_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_queue_patch_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 10
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `sort_key` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `queue_kind` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `sort_key` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `queue_identity` | `VARCHAR` |  |  | 0 |
| `base_generation` | `BIGINT` |  |  | 0 |
| `patch_watermark` | `BIGINT` |  |  | 0 |
| `priority_bucket` | `INTEGER` |  |  | 0 |
| `tombstone` | `BOOLEAN` |  |  | 0 |
| `patch_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_article_filter_posting_patch_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 11
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `sort_key` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `list_mode_key` | `VARCHAR` |  |  | 0 |
| `filter_kind` | `VARCHAR` |  |  | 0 |
| `filter_value` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `sort_key` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `posting_identity` | `VARCHAR` |  |  | 0 |
| `base_generation` | `BIGINT` |  |  | 0 |
| `patch_watermark` | `BIGINT` |  |  | 0 |
| `tombstone` | `BOOLEAN` |  |  | 0 |
| `patch_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_article_filter_posting_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 244758
- Columns: 10
- Indexes observed: 1
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `filter_kind`, `filter_value`, `list_mode_key`, `article_id`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `sort_key` | 1970-01-01 02:00:00+02 | 2026-07-20 07:31:57.841361+02 |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 244758 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 244758 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 244758 | 2 |
| `list_mode_key` | `VARCHAR` | 0 | 244758 | 4 |
| `filter_kind` | `VARCHAR` | 0 | 244758 | 5 |
| `filter_value` | `VARCHAR` | 0 | 244758 | 27 |
| `article_id` | `VARCHAR` | 0 | 244758 | 17875 |
| `sort_key` | `TIMESTAMP WITH TIME ZONE` | 0 | 244758 | 306 |
| `posting_identity` | `VARCHAR` | 0 | 244758 | 70 |
| `posting_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 244758 | 162 |

_No JSON/payload size proxies collected._
## mart.review_article_judgment_detail_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 262976
- Columns: 15
- Indexes observed: 2
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `list_mode_key`, `article_id`, `payload_kind`, `prompt_id`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 262976 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 262976 | 1 |
| `snapshot_id` | `VARCHAR` | 0 | 262976 | 1 |
| `list_mode_key` | `VARCHAR` | 0 | 262976 | 3 |
| `payload_kind` | `VARCHAR` | 0 | 262976 | 2 |
| `article_id` | `VARCHAR` | 0 | 262976 | 17875 |
| `prompt_id` | `VARCHAR` | 0 | 262976 | 6 |
| `prompt_order` | `INTEGER` | 0 | 262976 | 7 |
| `judgment_id` | `VARCHAR` | 225408 | 37568 | 19021 |
| `model_id` | `VARCHAR` | 262976 | 0 | 0 |
| `answered_original` | `VARCHAR` | 254588 | 8388 | 2 |
| `answered_original_as_array` | `VARCHAR[]` | 254588 | 8388 | 2 |
| `judgment_payload_json` | `JSON` | 0 | 262976 | 19043 |
| `placeholder_kind` | `VARCHAR` | 37568 | 225408 | 1 |
| `detail_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 262976 | 10 |

| Size proxy | Value |
| --- | --- |
| `judgment_payload_json_stringBytes` | 910386526 |
## mart.review_article_count_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 32
- Columns: 12
- Indexes observed: 2
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `list_mode_key`, `count_kind`, `filter_key`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 32 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 32 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 32 | 2 |
| `list_mode_key` | `VARCHAR` | 0 | 32 | 4 |
| `summary_identity` | `VARCHAR` | 0 | 32 | 4 |
| `count_kind` | `VARCHAR` | 0 | 32 | 4 |
| `summary_definition_version` | `VARCHAR` | 0 | 32 | 4 |
| `filter_key` | `VARCHAR` | 0 | 32 | 10 |
| `count_value` | `BIGINT` | 8 | 24 | 1 |
| `availability` | `VARCHAR` | 0 | 32 | 2 |
| `stale_reason` | `VARCHAR` | 24 | 8 | 1 |
| `count_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 32 | 2 |

_No JSON/payload size proxies collected._
## mart.review_filter_facet_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 6
- Columns: 14
- Indexes observed: 2
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `summary_identity`, `facet_kind`, `facet_key`, `facet_value`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 6 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 6 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 6 | 2 |
| `prompt_id` | `VARCHAR` | 2 | 4 | 3 |
| `summary_identity` | `VARCHAR` | 0 | 6 | 3 |
| `facet_kind` | `VARCHAR` | 0 | 6 | 2 |
| `facet_key` | `VARCHAR` | 0 | 6 | 3 |
| `facet_value` | `VARCHAR` | 0 | 6 | 3 |
| `answer_id` | `INTEGER` | 6 | 0 | 0 |
| `answer_value` | `VARCHAR` | 0 | 6 | 3 |
| `summary_definition_version` | `VARCHAR` | 0 | 6 | 3 |
| `count_value` | `BIGINT` | 0 | 6 | 2 |
| `availability` | `VARCHAR` | 0 | 6 | 1 |
| `facet_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 6 | 2 |

_No JSON/payload size proxies collected._
## mart.review_filter_option_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 39
- Columns: 16
- Indexes observed: 2
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `search_identity`, `filter_kind`, `facet_key`, `option_value_key`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 39 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 39 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 39 | 2 |
| `filter_kind` | `VARCHAR` | 0 | 39 | 2 |
| `prompt_id` | `VARCHAR` | 17 | 22 | 6 |
| `search_identity` | `VARCHAR` | 0 | 39 | 1 |
| `filter_option_identity` | `VARCHAR` | 0 | 39 | 2 |
| `option_value_key` | `VARCHAR` | 0 | 39 | 35 |
| `facet_key` | `VARCHAR` | 0 | 39 | 5 |
| `facet_value` | `VARCHAR` | 0 | 39 | 6 |
| `answer_id` | `INTEGER` | 39 | 0 | 0 |
| `numeric_min` | `DOUBLE` | 39 | 0 | 0 |
| `numeric_max` | `DOUBLE` | 39 | 0 | 0 |
| `option_payload_json` | `JSON` | 0 | 39 | 24 |
| `count_value` | `BIGINT` | 0 | 39 | 29 |
| `option_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 39 | 6 |

| Size proxy | Value |
| --- | --- |
| `option_payload_json_stringBytes` | 2929 |
## mart.review_filter_posting_stats_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 72
- Columns: 10
- Indexes observed: 0
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `filter_kind`, `filter_value`, `list_mode_key`
- Duplicate key count: 0

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 72 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 72 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 72 | 2 |
| `list_mode_key` | `VARCHAR` | 0 | 72 | 4 |
| `filter_kind` | `VARCHAR` | 0 | 72 | 5 |
| `filter_value` | `VARCHAR` | 0 | 72 | 27 |
| `posting_identity` | `VARCHAR` | 0 | 72 | 70 |
| `cardinality` | `BIGINT` | 0 | 72 | 27 |
| `selectivity` | `DOUBLE` | 0 | 72 | 25 |
| `stats_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 72 | 1 |

_No JSON/payload size proxies collected._
## mart.review_title_search_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 229174
- Columns: 9
- Indexes observed: 1
- Duplicate key columns: `project_id`, `search_identity`, `project_scope_identity`, `snapshot_id`, `token`, `article_id`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `activity_sort_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 229174 | 1 |
| `snapshot_id` | `VARCHAR` | 0 | 229174 | 2 |
| `article_id` | `VARCHAR` | 0 | 229174 | 7718 |
| `activity_sort_at` | `TIMESTAMP WITH TIME ZONE` | 229174 | 0 | 0 |
| `search_identity` | `VARCHAR` | 0 | 229174 | 1 |
| `project_scope_identity` | `VARCHAR` | 0 | 229174 | 1 |
| `token` | `VARCHAR` | 0 | 229174 | 12197 |
| `title_prefix` | `VARCHAR` | 0 | 229174 | 8444 |
| `search_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 229174 | 249 |

_No JSON/payload size proxies collected._
## mart.review_unassessed_queue_serving_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 10
- Indexes observed: 1
- Duplicate key columns: `project_id`, `review_config_hash`, `snapshot_id`, `queue_kind`, `priority_bucket`, `activity_sort_at`, `article_id`, `prompt_id`, `queue_identity`
- Duplicate key count: 0

| Timestamp column | Oldest | Newest |
| --- | --- | --- |
| `activity_sort_at` |  |  |

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `review_config_hash` | `VARCHAR` |  |  | 0 |
| `snapshot_id` | `VARCHAR` |  |  | 0 |
| `queue_kind` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `prompt_id` | `VARCHAR` |  |  | 0 |
| `activity_sort_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |
| `queue_identity` | `VARCHAR` |  |  | 0 |
| `priority_bucket` | `INTEGER` |  |  | 0 |
| `queue_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_article_summary_contribution_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 0
- Columns: 9
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` |  |  | 0 |
| `review_config_hash` | `VARCHAR` |  |  | 0 |
| `snapshot_id` | `VARCHAR` |  |  | 0 |
| `article_id` | `VARCHAR` |  |  | 0 |
| `component_kind` | `VARCHAR` |  |  | 0 |
| `summary_definition_version` | `VARCHAR` |  |  | 0 |
| `contribution_key` | `VARCHAR` |  |  | 0 |
| `contribution_value` | `BIGINT` |  |  | 0 |
| `contribution_updated_at` | `TIMESTAMP WITH TIME ZONE` |  |  | 0 |

_No JSON/payload size proxies collected._
## mart.review_article_summary_rebuild_partial_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 320969
- Columns: 22
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 320969 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 320969 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 320969 | 2 |
| `list_mode_key` | `VARCHAR` | 40031 | 280938 | 4 |
| `prompt_id` | `VARCHAR` | 309982 | 10987 | 6 |
| `request_id` | `VARCHAR` | 0 | 320969 | 9 |
| `chunk_id` | `VARCHAR` | 0 | 320969 | 12413 |
| `serving_key` | `VARCHAR` | 0 | 320969 | 54 |
| `summary_kind` | `VARCHAR` | 0 | 320969 | 1 |
| `summary_identity` | `VARCHAR` | 0 | 320969 | 9 |
| `count_kind` | `VARCHAR` | 40031 | 280938 | 6 |
| `summary_definition_version` | `VARCHAR` | 0 | 320969 | 10 |
| `filter_key` | `VARCHAR` | 40031 | 280938 | 11 |
| `facet_kind` | `VARCHAR` | 280938 | 40031 | 2 |
| `facet_key` | `VARCHAR` | 280938 | 40031 | 3 |
| `facet_value` | `VARCHAR` | 280938 | 40031 | 4 |
| `answer_id` | `INTEGER` | 320969 | 0 | 0 |
| `answer_value` | `VARCHAR` | 280938 | 40031 | 4 |

_No JSON/payload size proxies collected._
## mart.review_article_summary_contribution_rebuild_partial_v4

- Row count scope: `project_id = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'`
- Rows: 4257474
- Columns: 11
- Indexes observed: 1
- Duplicate key columns: not probed
- Duplicate key count: 

_No timestamp columns from the evidence allowlist were present._

| Column | Type | Nulls | Non-nulls | Approx distinct |
| --- | --- | --- | --- | --- |
| `project_id` | `VARCHAR` | 0 | 4257474 | 1 |
| `review_config_hash` | `VARCHAR` | 0 | 4257474 | 2 |
| `snapshot_id` | `VARCHAR` | 0 | 4257474 | 2 |
| `article_id` | `VARCHAR` | 0 | 4257474 | 17875 |
| `request_id` | `VARCHAR` | 0 | 4257474 | 9 |
| `chunk_id` | `VARCHAR` | 0 | 4257474 | 12413 |
| `component_kind` | `VARCHAR` | 0 | 4257474 | 1 |
| `summary_definition_version` | `VARCHAR` | 0 | 4257474 | 1 |
| `contribution_key` | `VARCHAR` | 0 | 4257474 | 87 |
| `contribution_value` | `BIGINT` | 0 | 4257474 | 1 |
| `contribution_updated_at` | `TIMESTAMP WITH TIME ZONE` | 0 | 4257474 | 28712 |

_No JSON/payload size proxies collected._
