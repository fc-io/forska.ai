-- Rename the status enum from articles to prompts
ALTER TYPE "public"."judgments_jobs_articles_status_enum" RENAME TO "judgments_jobs_prompts_status_enum";

-- Rename the table from judgments_jobs_articles to judgments_jobs_prompts
ALTER TABLE "judgments_jobs_articles" RENAME TO "judgments_jobs_prompts";

-- Clear existing data FIRST since the old rows don't have prompt_id values
-- This must happen before adding the FK constraint
DELETE FROM "judgments_jobs_prompts";

-- Add the prompt_id column (can be NOT NULL now since table is empty)
ALTER TABLE "judgments_jobs_prompts" ADD COLUMN "prompt_id" uuid NOT NULL;

-- Add foreign key constraint for prompt_id
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;

-- Rename the indexes
ALTER INDEX "judgments_jobs_articles_job_idx" RENAME TO "judgments_jobs_prompts_job_idx";
ALTER INDEX "judgments_jobs_articles_job_status_idx" RENAME TO "judgments_jobs_prompts_job_status_idx";

-- Rename the foreign key constraints (need to drop and recreate with new names)
ALTER TABLE "judgments_jobs_prompts" DROP CONSTRAINT "judgments_jobs_articles_job_id_judgments_jobs_id_fk";
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_job_id_judgments_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."judgments_jobs"(id) ON DELETE cascade ON UPDATE no action;

ALTER TABLE "judgments_jobs_prompts" DROP CONSTRAINT "judgments_jobs_articles_article_id_articles_id_fk";
ALTER TABLE "judgments_jobs_prompts" ADD CONSTRAINT "judgments_jobs_prompts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
