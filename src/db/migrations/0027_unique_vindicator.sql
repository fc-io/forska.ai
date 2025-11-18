ALTER TABLE "judgments" ALTER COLUMN "confidence_original" SET DEFAULT 50;--> statement-breakpoint
ALTER TABLE "judgments" ALTER COLUMN "quotes" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "answered_original_as_array" text[];