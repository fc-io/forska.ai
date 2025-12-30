ALTER TABLE "judgments" DROP CONSTRAINT "judgments_review_id_reviews_id_fk";
--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "review_id";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "answered_transformed";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_updated_at";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_created_year";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_updated_year";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "article_imported_by";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_project_owner_id";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_project_use_title";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_project_use_abstract";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_project_use_fulltext";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_project_provider";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_article_original_data";--> statement-breakpoint
ALTER TABLE "judgments" DROP COLUMN "snapshot_article_pdf_hash";