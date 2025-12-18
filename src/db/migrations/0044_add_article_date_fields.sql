-- Replace article_year with more comprehensive article date fields
-- These provide both precise timestamps and year integers for efficient filtering

-- Drop the old article_year column
ALTER TABLE "judgments" DROP COLUMN IF EXISTS "article_year";

-- Add full timestamp fields for precise date information
ALTER TABLE "judgments" ADD COLUMN "article_created_at" timestamp with time zone;
ALTER TABLE "judgments" ADD COLUMN "article_updated_at" timestamp with time zone;

-- Add year integer fields for efficient filtering/grouping in analytics
ALTER TABLE "judgments" ADD COLUMN "article_created_year" integer;
ALTER TABLE "judgments" ADD COLUMN "article_updated_year" integer;
