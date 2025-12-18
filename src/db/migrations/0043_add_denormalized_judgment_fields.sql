-- Add denormalized fields to judgments table for Parquet/ClickHouse compatibility
-- These fields match the DenormalizedJudgmentAnalytics schema in CLICK_PLAN.md

-- Soft delete support
ALTER TABLE "judgments" ADD COLUMN "deleted_at" timestamp with time zone;

-- Direct project reference (denormalized from the job/context)
ALTER TABLE "judgments" ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;

-- Denormalized article fields (copied from articles table at judgment creation time)
ALTER TABLE "judgments" ADD COLUMN "article_title" text;
ALTER TABLE "judgments" ADD COLUMN "article_year" integer;
ALTER TABLE "judgments" ADD COLUMN "article_import_route" text;

-- Add index for soft delete queries (regular index, Drizzle-compatible)
CREATE INDEX "judgments_deleted_at_idx" ON "judgments" ("deleted_at");

-- Add index for project lookups
CREATE INDEX "judgments_project_idx" ON "judgments" ("project_id");
