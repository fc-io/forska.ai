DROP INDEX IF EXISTS "judgments_prompt_article_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "judgments_prompt_import_route_idx";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_title";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_created_at";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_import_route";