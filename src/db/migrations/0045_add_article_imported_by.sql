-- Add articleImportedBy field to judgments table
-- Denormalized from articles.imported_by for analytics queries

ALTER TABLE "judgments" ADD COLUMN "article_imported_by" text;
