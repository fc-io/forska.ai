CREATE TABLE "pg_ch_sync_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"total_count" bigint DEFAULT 0 NOT NULL,
	"active_count" bigint DEFAULT 0 NOT NULL,
	"deleted_count" bigint DEFAULT 0 NOT NULL,
	"unique_count" bigint,
	"unique_count_at" timestamp with time zone,
	"watermark_cursor_col" text,
	"watermark_ts" text,
	"watermark_id" text,
	"max_cursor_at" text,
	"job_status" text DEFAULT 'idle' NOT NULL,
	"job_started_at" timestamp with time zone,
	"job_completed_at" timestamp with time zone,
	"job_error" text,
	"job_current_batch" integer,
	"job_rows_counted" bigint DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_full_count_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "pg_ch_sync_stats_job_status_idx" ON "pg_ch_sync_stats" USING btree ("job_status");--> statement-breakpoint
CREATE INDEX "pg_ch_sync_stats_last_updated_at_idx" ON "pg_ch_sync_stats" USING btree ("last_updated_at");--> statement-breakpoint
CREATE INDEX "articles_updated_id_idx" ON "articles" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "judgments_updated_id_deleted_idx" ON "judgments" USING btree ("updated_at","id","deleted_at");--> statement-breakpoint
CREATE INDEX "judgments_deleted_updated_idx" ON "judgments" USING btree ("deleted_at","updated_at") WHERE "judgments"."deleted_at" IS NOT NULL;