ALTER TABLE "datasource" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "successful_requests" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "failed_requests" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "has_failed_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "failed_requests_details" jsonb;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_success_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_success_completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_success_tokens" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_failed_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_failed_completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "total_failed_tokens" integer;