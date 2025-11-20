ALTER TABLE "judgments" ADD COLUMN "snapshot_project_id" uuid;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_owner_id" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_use_title" boolean;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_use_abstract" boolean;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_use_fulltext" boolean;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_model_name" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_project_provider" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_article_original_data" jsonb;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "snapshot_article_pdf_hash" text;