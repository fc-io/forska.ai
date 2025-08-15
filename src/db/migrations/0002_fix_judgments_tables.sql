-- Add reviewId column to judgments table
ALTER TABLE "judgments" ADD COLUMN "review_id" uuid;
--> statement-breakpoint

-- Add foreign key constraint for reviewId
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_review_id_reviews_id_fk" 
FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Drop foreign key constraints that reference judgements table
ALTER TABLE "judgement_assessments" DROP CONSTRAINT IF EXISTS "judgement_assessments_judgement_id_judgements_id_fk";
--> statement-breakpoint

-- Drop the judgements table
DROP TABLE IF EXISTS "judgements";
--> statement-breakpoint

-- Drop the judgement_assessments table (since we're renaming it)
DROP TABLE IF EXISTS "judgement_assessments";
--> statement-breakpoint

-- Create judgment_assessments table with proper reference to judgments
CREATE TABLE "judgment_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"judgment_id" uuid NOT NULL,
	"assessed_by" text NOT NULL,
	"assessment_is_correct" boolean NOT NULL,
	"assessment_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add foreign key constraints for judgment_assessments
ALTER TABLE "judgment_assessments" ADD CONSTRAINT "judgment_assessments_judgment_id_judgments_id_fk" 
FOREIGN KEY ("judgment_id") REFERENCES "public"."judgments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "judgment_assessments" ADD CONSTRAINT "judgment_assessments_assessed_by_user_id_fk" 
FOREIGN KEY ("assessed_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;