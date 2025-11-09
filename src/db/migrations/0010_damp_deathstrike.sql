DROP TABLE "vllm_status" CASCADE;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "worker_urls" text[];