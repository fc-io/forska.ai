ALTER TABLE "judgments" ALTER COLUMN "answered_original" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "judgments" ALTER COLUMN "answered_transformed" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "judgments" ALTER COLUMN "answered_transformed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "token_use" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
DROP TYPE "public"."answered_state";