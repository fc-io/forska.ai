ALTER TABLE "articles" ADD COLUMN "full_text_conversion_status" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "full_text_conversion_error" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "full_text_conversion_attempts" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "full_text_char_count" integer;