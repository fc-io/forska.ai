CREATE TABLE "judgments_human" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_id" uuid NOT NULL,
	"user" text NOT NULL,
	"prompt_id" uuid NOT NULL,
	"answer" text,
	"comment" text,
	"project_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "judgments_human" ADD CONSTRAINT "judgments_human_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_human" ADD CONSTRAINT "judgments_human_user_user_id_fk" FOREIGN KEY ("user") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_human" ADD CONSTRAINT "judgments_human_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgments_human" ADD CONSTRAINT "judgments_human_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judgments_human_article_prompt_idx" ON "judgments_human" USING btree ("article_id","prompt_id");--> statement-breakpoint
CREATE INDEX "judgments_human_prompt_article_idx" ON "judgments_human" USING btree ("prompt_id","article_id");--> statement-breakpoint
CREATE INDEX "judgments_human_project_idx" ON "judgments_human" USING btree ("project_id");