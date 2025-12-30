ALTER TABLE "llm_status" ALTER COLUMN "poll_ms" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "llm_status" ALTER COLUMN "poll_ms" SET DEFAULT 2000;