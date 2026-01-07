CREATE TYPE "public"."judgments_jobs_prompts_skip_reason_enum" AS ENUM('no_fulltext', 'conversion_failed');--> statement-breakpoint
ALTER TYPE "public"."judgments_jobs_prompts_status_enum" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" ADD COLUMN "skip_reason" "judgments_jobs_prompts_skip_reason_enum";