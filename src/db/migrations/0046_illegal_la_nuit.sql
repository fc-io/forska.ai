DROP INDEX "judgments_article_prompt_answered_idx";--> statement-breakpoint
DROP INDEX "judgments_prompt_article_answered_idx";--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_title" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_created_year" integer;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_updated_year" integer;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_import_route" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "article_imported_by" text;--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judgments_project_idx" ON "judgments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "judgments_deleted_at_idx" ON "judgments" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "judgments_prompt_article_created_idx" ON "judgments" USING btree ("prompt_id","article_created_at");--> statement-breakpoint
CREATE INDEX "judgments_prompt_import_route_idx" ON "judgments" USING btree ("prompt_id","article_import_route");