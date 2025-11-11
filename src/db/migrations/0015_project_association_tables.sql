-- project_prompts association table (per-project prompt metadata)
CREATE TABLE IF NOT EXISTS "project_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "order" integer,
  "archived" boolean DEFAULT false NOT NULL,
  -- prompt_heading and type are global on prompts; not duplicated here
);
--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "project_prompts"
    ADD CONSTRAINT "project_prompts_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "project_prompts"
    ADD CONSTRAINT "project_prompts_prompt_id_prompts_id_fk"
    FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "project_prompts_unique" ON "project_prompts" ("project_id", "prompt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_prompts_project_idx" ON "project_prompts" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_prompts_prompt_idx" ON "project_prompts" ("prompt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_prompts_project_order_idx" ON "project_prompts" ("project_id", "order");
--> statement-breakpoint

-- project_articles association table (projects to curated articles)
CREATE TABLE IF NOT EXISTS "project_articles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "article_id" uuid NOT NULL
);
--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "project_articles"
    ADD CONSTRAINT "project_articles_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "project_articles"
    ADD CONSTRAINT "project_articles_article_id_articles_id_fk"
    FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "project_articles_unique" ON "project_articles" ("project_id", "article_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_articles_project_idx" ON "project_articles" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_articles_article_idx" ON "project_articles" ("article_id");
