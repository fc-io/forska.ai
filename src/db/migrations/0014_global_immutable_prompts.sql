-- Phase 1: New association tables and content hash
CREATE TABLE IF NOT EXISTS "project_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "prompt_heading" text,
  "order" integer,
  "archived" boolean DEFAULT false NOT NULL,
  "type" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_articles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "article_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_prompts" ADD CONSTRAINT "project_prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_prompts" ADD CONSTRAINT "project_prompts_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_articles" ADD CONSTRAINT "project_articles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "project_articles" ADD CONSTRAINT "project_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_prompts_unique" ON "project_prompts" ("project_id","prompt_id");
CREATE INDEX IF NOT EXISTS "project_prompts_project_idx" ON "project_prompts" ("project_id");
CREATE INDEX IF NOT EXISTS "project_prompts_prompt_idx" ON "project_prompts" ("prompt_id");
CREATE INDEX IF NOT EXISTS "project_prompts_project_order_idx" ON "project_prompts" ("project_id","order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_articles_unique" ON "project_articles" ("project_id","article_id");
CREATE INDEX IF NOT EXISTS "project_articles_project_idx" ON "project_articles" ("project_id");
CREATE INDEX IF NOT EXISTS "project_articles_article_idx" ON "project_articles" ("article_id");

-- Add content_hash to prompts
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "content_hash" text;
CREATE INDEX IF NOT EXISTS "prompts_content_hash_idx" ON "prompts" ("content_hash");

-- Phase 2: Backfill project_prompts from legacy columns if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='project_id') THEN
    INSERT INTO "project_prompts" ("project_id", "prompt_id", "order", "prompt_heading", "archived", "type")
    SELECT "project_id", "id", "order", "prompt_heading", COALESCE("archived", false), "type"
    FROM "prompts"
    ON CONFLICT ("project_id","prompt_id") DO NOTHING;
  END IF;
END $$;

-- Backfill content_hash using simple normalization and md5
CREATE OR REPLACE FUNCTION public.normalize_text_for_hash(t text) RETURNS text AS $$
BEGIN
  IF t IS NULL THEN
    RETURN '';
  END IF;
  -- normalize newlines and trim
  RETURN regexp_replace(trim(replace(replace(t, E'\r\n', E'\n'), E'\r', E'\n')), E'\s+$', '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.compute_prompt_content_hash(orig text, trans text) RETURNS text AS $$
BEGIN
  RETURN md5(normalize_text_for_hash(orig) || '|' || normalize_text_for_hash(COALESCE(trans, '')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "prompts"
SET "content_hash" = compute_prompt_content_hash("original_text", "transformed_text")
WHERE "content_hash" IS NULL;

-- Phase 3: Immutability and hash triggers
CREATE OR REPLACE FUNCTION public.prevent_prompt_text_update() RETURNS trigger AS $$
BEGIN
  IF NEW."original_text" IS DISTINCT FROM OLD."original_text" OR NEW."transformed_text" IS DISTINCT FROM OLD."transformed_text" THEN
    RAISE EXCEPTION 'Prompts are immutable: text fields cannot be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "prompts_prevent_text_update" ON "prompts";
CREATE TRIGGER "prompts_prevent_text_update" BEFORE UPDATE ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.prevent_prompt_text_update();

CREATE OR REPLACE FUNCTION public.set_prompt_hash_on_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."content_hash" IS NULL THEN
    NEW."content_hash" = compute_prompt_content_hash(NEW."original_text", NEW."transformed_text");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "prompts_set_hash_on_insert" ON "prompts";
CREATE TRIGGER "prompts_set_hash_on_insert" BEFORE INSERT ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.set_prompt_hash_on_insert();

-- Phase 4: Drop legacy columns on prompts
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_class t ON i.indrelid = t.oid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey) WHERE t.relname = 'prompts' AND a.attname = 'project_id') THEN
    DROP INDEX IF EXISTS "prompts_project_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='project_id') THEN
    ALTER TABLE "prompts" DROP COLUMN "project_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='prompt_heading') THEN
    ALTER TABLE "prompts" DROP COLUMN "prompt_heading";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='order') THEN
    ALTER TABLE "prompts" DROP COLUMN "order";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='archived') THEN
    ALTER TABLE "prompts" DROP COLUMN "archived";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompts' AND column_name='type') THEN
    ALTER TABLE "prompts" DROP COLUMN "type";
  END IF;
END $$;

-- Phase 5: Change FK behaviour to RESTRICT for judgments/judgments_human prompt_id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.constraint_column_usage WHERE table_name='judgments' AND constraint_name='judgments_prompt_id_prompts_id_fk') THEN
    ALTER TABLE "judgments" DROP CONSTRAINT "judgments_prompt_id_prompts_id_fk";
  END IF;
  ALTER TABLE "judgments" ADD CONSTRAINT "judgments_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.constraint_column_usage WHERE table_name='judgments_human' AND constraint_name='judgments_human_prompt_id_prompts_id_fk') THEN
    ALTER TABLE "judgments_human" DROP CONSTRAINT "judgments_human_prompt_id_prompts_id_fk";
  END IF;
  ALTER TABLE "judgments_human" ADD CONSTRAINT "judgments_human_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
END $$;

