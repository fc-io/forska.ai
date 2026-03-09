CREATE TABLE "comparison_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text NOT NULL,
	"model_ids" uuid[],
	"compare_with_humans" boolean DEFAULT false NOT NULL,
	"use_title" boolean DEFAULT true NOT NULL,
	"use_abstract" boolean DEFAULT true NOT NULL,
	"use_fulltext" boolean DEFAULT false NOT NULL,
	"use_fulltext_no_images" boolean DEFAULT false NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparison_project_prompt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"comparison_project_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"order" integer
);
--> statement-breakpoint
CREATE TABLE "comparison_project_route_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"comparison_project_id" uuid NOT NULL,
	"import_route_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comparison_project" ADD CONSTRAINT "comparison_project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_project_prompt" ADD CONSTRAINT "comparison_project_prompt_comparison_project_id_comparison_project_id_fk" FOREIGN KEY ("comparison_project_id") REFERENCES "public"."comparison_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_project_prompt" ADD CONSTRAINT "comparison_project_prompt_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_project_route_link" ADD CONSTRAINT "comparison_project_route_link_comparison_project_id_comparison_project_id_fk" FOREIGN KEY ("comparison_project_id") REFERENCES "public"."comparison_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_project_route_link" ADD CONSTRAINT "comparison_project_route_link_import_route_id_import_route_id_fk" FOREIGN KEY ("import_route_id") REFERENCES "public"."import_route"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comparison_project_owner_idx" ON "comparison_project" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "comparison_project_archived_idx" ON "comparison_project" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "comparison_project_created_idx" ON "comparison_project" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comparison_project_prompt_unique" ON "comparison_project_prompt" USING btree ("comparison_project_id","prompt_id");--> statement-breakpoint
CREATE INDEX "comparison_project_prompt_project_idx" ON "comparison_project_prompt" USING btree ("comparison_project_id");--> statement-breakpoint
CREATE INDEX "comparison_project_prompt_prompt_idx" ON "comparison_project_prompt" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "comparison_project_prompt_project_order_idx" ON "comparison_project_prompt" USING btree ("comparison_project_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "comparison_project_route_link_unique" ON "comparison_project_route_link" USING btree ("comparison_project_id","import_route_id");--> statement-breakpoint
CREATE INDEX "comparison_project_route_link_project_idx" ON "comparison_project_route_link" USING btree ("comparison_project_id");--> statement-breakpoint
CREATE INDEX "comparison_project_route_link_route_idx" ON "comparison_project_route_link" USING btree ("import_route_id");