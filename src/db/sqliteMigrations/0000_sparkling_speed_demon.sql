CREATE TABLE `article_route_link` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`article_id` text NOT NULL,
	`import_route_id` text NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_route_id`) REFERENCES `import_route`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_route_link_unique` ON `article_route_link` (`article_id`,`import_route_id`);--> statement-breakpoint
CREATE INDEX `article_route_link_article_idx` ON `article_route_link` (`article_id`);--> statement-breakpoint
CREATE INDEX `article_route_link_route_idx` ON `article_route_link` (`import_route_id`);--> statement-breakpoint
CREATE INDEX `article_route_link_updated_idx` ON `article_route_link` (`updated_at`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`article_title` text NOT NULL,
	`article_authors` text,
	`article_created_at` integer,
	`article_updated_at` integer,
	`article_id` text,
	`article_summary` text,
	`article_version` integer,
	`arxiv_id` text,
	`openalex_id` text,
	`biorxiv_id` text,
	`medrxiv_id` text,
	`doi` text,
	`pubmed_id` text,
	`url` text,
	`full_text_fetched_at` integer,
	`full_text` text,
	`full_text_html` text,
	`full_text_source` text,
	`full_text_original_format` text,
	`full_text_pdf` text,
	`full_text_assets` text,
	`full_text_conversion_status` text,
	`full_text_conversion_error` text,
	`full_text_conversion_attempts` integer DEFAULT 0,
	`full_text_char_count` integer,
	`content_hash` text,
	`import_route` text,
	`original_data` text,
	`publication_status` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_article_id_unique` ON `articles` (`article_id`);--> statement-breakpoint
CREATE INDEX `articles_article_created_created_id_idx` ON `articles` (`article_created_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `articles_created_idx` ON `articles` (`created_at`);--> statement-breakpoint
CREATE INDEX `articles_article_updated_idx` ON `articles` (`article_updated_at`);--> statement-breakpoint
CREATE INDEX `articles_import_route_article_created_idx` ON `articles` (`import_route`,`article_created_at`);--> statement-breakpoint
CREATE INDEX `articles_updated_idx` ON `articles` (`updated_at`);--> statement-breakpoint
CREATE INDEX `articles_updated_id_idx` ON `articles` (`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `articles_openalex_id_unique` ON `articles` (`openalex_id`);--> statement-breakpoint
CREATE INDEX `articles_full_text_conversion_status_idx` ON `articles` (`full_text_conversion_status`);--> statement-breakpoint
CREATE TABLE `comparison_project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`model_ids` text,
	`compare_with_humans` integer DEFAULT false NOT NULL,
	`use_title` integer DEFAULT true NOT NULL,
	`use_abstract` integer DEFAULT true NOT NULL,
	`use_fulltext` integer DEFAULT false NOT NULL,
	`use_fulltext_no_images` integer DEFAULT false NOT NULL,
	`date_from` integer,
	`date_to` integer,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comparison_project_archived_idx` ON `comparison_project` (`archived`);--> statement-breakpoint
CREATE INDEX `comparison_project_created_idx` ON `comparison_project` (`created_at`);--> statement-breakpoint
CREATE TABLE `comparison_project_prompt` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`comparison_project_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`order` integer,
	FOREIGN KEY (`comparison_project_id`) REFERENCES `comparison_project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comparison_project_prompt_unique` ON `comparison_project_prompt` (`comparison_project_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `comparison_project_prompt_project_idx` ON `comparison_project_prompt` (`comparison_project_id`);--> statement-breakpoint
CREATE INDEX `comparison_project_prompt_prompt_idx` ON `comparison_project_prompt` (`prompt_id`);--> statement-breakpoint
CREATE INDEX `comparison_project_prompt_project_order_idx` ON `comparison_project_prompt` (`comparison_project_id`,`order`);--> statement-breakpoint
CREATE TABLE `comparison_project_route_link` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`comparison_project_id` text NOT NULL,
	`import_route_id` text NOT NULL,
	FOREIGN KEY (`comparison_project_id`) REFERENCES `comparison_project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_route_id`) REFERENCES `import_route`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comparison_project_route_link_unique` ON `comparison_project_route_link` (`comparison_project_id`,`import_route_id`);--> statement-breakpoint
CREATE INDEX `comparison_project_route_link_project_idx` ON `comparison_project_route_link` (`comparison_project_id`);--> statement-breakpoint
CREATE INDEX `comparison_project_route_link_route_idx` ON `comparison_project_route_link` (`import_route_id`);--> statement-breakpoint
CREATE TABLE `datasource` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`last_import_at` integer,
	`items_after_last_import` integer DEFAULT 0,
	`import_route` text,
	`cursor` text,
	`date_from` integer,
	`date_to` integer,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `datasource_route_link` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`datasource_id` text NOT NULL,
	`import_route_id` text NOT NULL,
	FOREIGN KEY (`datasource_id`) REFERENCES `datasource`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_route_id`) REFERENCES `import_route`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasource_route_link_unique` ON `datasource_route_link` (`datasource_id`,`import_route_id`);--> statement-breakpoint
CREATE INDEX `datasource_route_link_datasource_idx` ON `datasource_route_link` (`datasource_id`);--> statement-breakpoint
CREATE INDEX `datasource_route_link_route_idx` ON `datasource_route_link` (`import_route_id`);--> statement-breakpoint
CREATE TABLE `import_route` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`route` text NOT NULL,
	`name` text,
	`description` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_route_route_unique` ON `import_route` (`route`);--> statement-breakpoint
CREATE INDEX `import_route_active_idx` ON `import_route` (`active`);--> statement-breakpoint
CREATE TABLE `judgment_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`judgment_id` text NOT NULL,
	`assessment_is_correct` integer NOT NULL,
	`assessment_comment` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judgment_assessments_judgment_unique` ON `judgment_assessments` (`judgment_id`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`article_id` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`project_id` text,
	`use_title` integer DEFAULT true NOT NULL,
	`use_abstract` integer DEFAULT true NOT NULL,
	`use_fulltext` integer DEFAULT false NOT NULL,
	`use_fulltext_no_images` integer DEFAULT false NOT NULL,
	`chunking_strategy` text,
	`is_answered` integer DEFAULT false,
	`answered_original` text,
	`answered_original_as_array` text,
	`confidence_original` integer DEFAULT 50,
	`explanation` text,
	`quotes` text DEFAULT '[]' NOT NULL,
	`snapshot_project_id` text,
	`snapshot_project_model_name` text,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `judgments_article_prompt_idx` ON `judgments` (`article_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `judgments_prompt_article_idx` ON `judgments` (`prompt_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `judgments_article_prompt_model_idx` ON `judgments` (`article_id`,`prompt_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `judgments_article_prompt_model_content_idx` ON `judgments` (`article_id`,`prompt_id`,`model_id`,`use_title`,`use_abstract`,`use_fulltext`,`use_fulltext_no_images`);--> statement-breakpoint
CREATE INDEX `judgments_updated_idx` ON `judgments` (`updated_at`);--> statement-breakpoint
CREATE INDEX `judgments_updated_id_deleted_idx` ON `judgments` (`updated_at`,`id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `judgments_created_idx` ON `judgments` (`created_at`);--> statement-breakpoint
CREATE INDEX `judgments_project_idx` ON `judgments` (`project_id`);--> statement-breakpoint
CREATE INDEX `judgments_deleted_at_idx` ON `judgments` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `judgments_deleted_updated_idx` ON `judgments` (`deleted_at`,`updated_at`) WHERE "judgments"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `judgments_article_prompt_model_content_unique` ON `judgments` (`article_id`,`prompt_id`,`model_id`,`use_title`,`use_abstract`,`use_fulltext`,`use_fulltext_no_images`) WHERE "judgments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `judgments_human` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`article_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`is_answered` integer DEFAULT false NOT NULL,
	`answer` text,
	`comment` text,
	`project_id` text NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judgments_human_project_article_prompt_unique` ON `judgments_human` (`project_id`,`article_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `judgments_human_article_prompt_idx` ON `judgments_human` (`article_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `judgments_human_prompt_article_idx` ON `judgments_human` (`prompt_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `judgments_human_project_idx` ON `judgments_human` (`project_id`);--> statement-breakpoint
CREATE INDEX `judgments_human_prompt_article_answer_idx` ON `judgments_human` (`prompt_id`,`article_id`,`answer`);--> statement-breakpoint
CREATE INDEX `judgments_human_updated_idx` ON `judgments_human` (`updated_at`);--> statement-breakpoint
CREATE TABLE `judgments_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`error` text,
	`send_to_llm_batch_size` integer DEFAULT 5 NOT NULL,
	`send_to_llm_interval` integer DEFAULT 15 NOT NULL,
	`ch_cursor_last_date` integer,
	`ch_cursor_last_article_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgments_jobs_project_idx` ON `judgments_jobs` (`project_id`);--> statement-breakpoint
CREATE TABLE `judgments_jobs_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`job_id` text NOT NULL,
	`article_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`server_id` text,
	`sent_at` integer,
	`judged_at` integer,
	`status` text DEFAULT 'ready' NOT NULL,
	`skip_reason` text,
	FOREIGN KEY (`job_id`) REFERENCES `judgments_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgments_jobs_prompts_job_idx` ON `judgments_jobs_prompts` (`job_id`);--> statement-breakpoint
CREATE INDEX `judgments_jobs_prompts_job_status_idx` ON `judgments_jobs_prompts` (`job_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `judgments_jobs_prompts_article_prompt_job_unique` ON `judgments_jobs_prompts` (`article_id`,`prompt_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `llm_status` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`engine` text NOT NULL,
	`instance_id` text NOT NULL,
	`model_name` text NOT NULL,
	`engine_version` text,
	`gpu_type` text,
	`gpu_count` integer,
	`poll_ms` integer DEFAULT 2000 NOT NULL,
	`prompt_tokens_total` integer DEFAULT 0 NOT NULL,
	`generation_tokens_total` integer DEFAULT 0 NOT NULL,
	`num_requests_total` integer,
	`cached_tokens_total` integer,
	`num_retractions_count` integer,
	`num_queue_reqs` integer DEFAULT 0 NOT NULL,
	`num_running_reqs` integer DEFAULT 0 NOT NULL,
	`num_grammar_queue_reqs` integer,
	`num_running_reqs_offline_batch` integer,
	`num_prefill_prealloc_queue_reqs` integer,
	`num_prefill_inflight_queue_reqs` integer,
	`num_decode_prealloc_queue_reqs` integer,
	`num_decode_transfer_queue_reqs` integer,
	`gen_throughput` real,
	`token_usage` real,
	`utilization` real,
	`cache_hit_rate` real,
	`spec_accept_rate` real,
	`spec_accept_length` real,
	`is_cuda_graph` integer,
	`swa_token_usage` real,
	`mamba_usage` real,
	`pending_prealloc_token_usage` real,
	`kv_transfer_speed_gb_s` real,
	`kv_transfer_latency_ms` real,
	`kv_transfer_bootstrap_ms` real,
	`kv_transfer_alloc_ms` real,
	`prefill_tps` real,
	`gen_tps` real,
	`rps` real,
	`target_gen_tps` real,
	`target_prefill_tps` real,
	`in_flight` integer,
	`max_in_flight` integer,
	`last_action` text,
	`time_to_first_token_seconds` text,
	`e2e_request_latency_seconds` text,
	`inter_token_latency_seconds` text,
	`per_stage_req_latency_seconds` text,
	`queue_time_seconds` text
);
--> statement-breakpoint
CREATE INDEX `llm_status_ts_idx` ON `llm_status` (`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `llm_status_engine_instance_ts_idx` ON `llm_status` (`engine`,`instance_id`,`ts`);--> statement-breakpoint
CREATE INDEX `llm_status_model_ts_idx` ON `llm_status` (`model_name`,`ts`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`name` text NOT NULL,
	`provider` text,
	`base_url` text,
	`model_name` text,
	`version` text,
	`api_key_variable` text,
	`worker_urls` text
);
--> statement-breakpoint
CREATE TABLE `nvidia_smi` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`instance_id` text NOT NULL,
	`gpu_index` integer NOT NULL,
	`gpu_uuid` text,
	`gpu_name` text,
	`temperature_gpu` integer,
	`utilization_gpu` integer,
	`utilization_memory` integer,
	`memory_total_mib` integer,
	`memory_used_mib` integer,
	`power_draw_watts` real,
	`power_limit_watts` real,
	`fan_speed` integer,
	`pstate` text
);
--> statement-breakpoint
CREATE INDEX `nvidia_smi_ts_idx` ON `nvidia_smi` (`ts`);--> statement-breakpoint
CREATE INDEX `nvidia_smi_instance_ts_idx` ON `nvidia_smi` (`instance_id`,`ts`);--> statement-breakpoint
CREATE INDEX `nvidia_smi_gpu_uuid_ts_idx` ON `nvidia_smi` (`gpu_uuid`,`ts`);--> statement-breakpoint
CREATE TABLE `project_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`project_id` text NOT NULL,
	`imported_from_project_id` text,
	`article_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`imported_from_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_articles_unique` ON `project_articles` (`project_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `project_articles_project_idx` ON `project_articles` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_articles_article_idx` ON `project_articles` (`article_id`);--> statement-breakpoint
CREATE INDEX `project_articles_imported_from_project_idx` ON `project_articles` (`imported_from_project_id`);--> statement-breakpoint
CREATE TABLE `project_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`project_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`order` integer,
	`archived` integer DEFAULT false NOT NULL,
	`origin_project_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_prompts_unique` ON `project_prompts` (`project_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `project_prompts_project_idx` ON `project_prompts` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_prompts_prompt_idx` ON `project_prompts` (`prompt_id`);--> statement-breakpoint
CREATE INDEX `project_prompts_project_order_idx` ON `project_prompts` (`project_id`,`order`);--> statement-breakpoint
CREATE TABLE `project_route_link` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`project_id` text NOT NULL,
	`import_route_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_route_id`) REFERENCES `import_route`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_route_link_unique` ON `project_route_link` (`project_id`,`import_route_id`);--> statement-breakpoint
CREATE INDEX `project_route_link_project_idx` ON `project_route_link` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_route_link_route_idx` ON `project_route_link` (`import_route_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`engine` text,
	`model_id` text NOT NULL,
	`use_title` integer DEFAULT true NOT NULL,
	`use_abstract` integer DEFAULT true NOT NULL,
	`use_fulltext` integer DEFAULT false NOT NULL,
	`use_fulltext_no_images` integer DEFAULT false NOT NULL,
	`date_from` integer,
	`date_to` integer,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`original_text` text NOT NULL,
	`transformed_text` text,
	`archived` integer DEFAULT false NOT NULL,
	`prompt_heading` text,
	`type` text,
	`content_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_content_hash_unique` ON `prompts` (`content_hash`);--> statement-breakpoint
CREATE INDEX `prompts_archived_idx` ON `prompts` (`archived`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`project_id` text NOT NULL,
	`opened` integer DEFAULT false NOT NULL,
	`reviewed_title` integer DEFAULT false NOT NULL,
	`reviewed_title_comment` text,
	`reviewed_abstract` integer DEFAULT false NOT NULL,
	`reviewed_abstract_comment` text,
	`reviewed_intro` integer DEFAULT false NOT NULL,
	`reviewed_intro_comment` text,
	`reviewed_method` integer DEFAULT false NOT NULL,
	`reviewed_method_comment` text,
	`reviewed_results` integer DEFAULT false NOT NULL,
	`reviewed_results_comment` text,
	`reviewed_discussion` integer DEFAULT false NOT NULL,
	`reviewed_discussion_comment` text,
	`reviewed_conclusion` integer DEFAULT false NOT NULL,
	`reviewed_conclusion_comment` text,
	`reviewed_appendix` integer DEFAULT false NOT NULL,
	`reviewed_appendix_comment` text,
	`reviewed_other` integer DEFAULT false NOT NULL,
	`reviewed_other_comment` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_project_article_unique` ON `reviews` (`project_id`,`article_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`remote_id` text NOT NULL,
	`table_name` text NOT NULL,
	`last_synced_at` integer DEFAULT '"1970-01-01T00:00:00.000Z"' NOT NULL,
	PRIMARY KEY(`remote_id`, `table_name`)
);
--> statement-breakpoint
CREATE TABLE `token_use` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`judgments_job_id` text,
	`requests` integer NOT NULL,
	`total_prompt_tokens` integer NOT NULL,
	`total_completion_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration` integer,
	`gpu_nnodes` integer,
	`gpu_gpus_per_node` integer,
	`gpu_total_gpus` integer,
	`tp_size` integer,
	`dp_size` integer,
	`gpu_shape` text,
	`sglang_max_running_requests` integer,
	`sglang_model` text,
	`successful_requests` integer,
	`failed_requests` integer,
	`has_failed_requests` integer DEFAULT false NOT NULL,
	`failed_requests_details` text,
	`total_success_prompt_tokens` integer,
	`total_success_completion_tokens` integer,
	`total_success_tokens` integer,
	`total_failed_prompt_tokens` integer,
	`total_failed_completion_tokens` integer,
	`total_failed_tokens` integer,
	FOREIGN KEY (`judgments_job_id`) REFERENCES `judgments_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `token_use_job_created_idx` ON `token_use` (`judgments_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `token_use_updated_idx` ON `token_use` (`updated_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
