ALTER TABLE "judgments_jobs" ADD COLUMN "ch_cursor_last_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "judgments_jobs" ADD COLUMN "ch_cursor_last_article_id" uuid;