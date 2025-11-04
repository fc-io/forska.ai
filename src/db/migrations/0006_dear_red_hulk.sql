ALTER TABLE "articles" ADD COLUMN "full_text_source" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "full_text_original_format" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "full_text_assets" jsonb;