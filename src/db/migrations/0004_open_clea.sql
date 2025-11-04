ALTER TABLE "judgments" ADD COLUMN "is_answered" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "judgments_human" ADD COLUMN "is_answered" boolean DEFAULT false NOT NULL;