ALTER TYPE "public"."judgments_jobs_articles_status_enum" RENAME TO "judgments_jobs_prompts_status_enum";--> statement-breakpoint
ALTER TABLE "judgments_jobs_articles" RENAME TO "judgments_jobs_prompts";--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" DROP CONSTRAINT "judgments_jobs_articles_job_id_judgments_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" DROP CONSTRAINT "judgments_jobs_articles_article_id_articles_id_fk";
--> statement-breakpoint
DROP INDEX "judgments_jobs_articles_job_idx";--> statement-breakpoint
DROP INDEX "judgments_jobs_articles_job_status_idx";--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" ADD COLUMN "prompt_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_job_id_judgments_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."judgments_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judgments_jobs_prompts_job_idx" ON "judgments_jobs_prompts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "judgments_jobs_prompts_job_status_idx" ON "judgments_jobs_prompts" USING btree ("job_id","status");