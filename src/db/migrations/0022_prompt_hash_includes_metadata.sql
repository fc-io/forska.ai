-- Update prompt content hash to include global metadata (prompt_heading, type)
-- Keep normalize_text_for_hash from earlier migration; create new 4-arg function

CREATE OR REPLACE FUNCTION public.compute_prompt_content_hash(orig text, trans text, heading text, type text) RETURNS text AS $$
BEGIN
  RETURN md5(
    normalize_text_for_hash(orig) || '|' ||
    normalize_text_for_hash(COALESCE(trans, '')) || '|' ||
    normalize_text_for_hash(COALESCE(heading, '')) || '|' ||
    normalize_text_for_hash(COALESCE(type, ''))
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- Update insert trigger to compute hash using metadata as well
CREATE OR REPLACE FUNCTION public.set_prompt_hash_on_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."content_hash" IS NULL THEN
    NEW."content_hash" = compute_prompt_content_hash(NEW."original_text", NEW."transformed_text", NEW."prompt_heading", NEW."type");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "prompts_set_hash_on_insert" ON "prompts";
--> statement-breakpoint
CREATE TRIGGER "prompts_set_hash_on_insert" BEFORE INSERT ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.set_prompt_hash_on_insert();
--> statement-breakpoint

-- Backfill: recompute content_hash to include metadata
UPDATE "prompts"
SET "content_hash" = compute_prompt_content_hash("original_text", "transformed_text", "prompt_heading", "type");
--> statement-breakpoint

-- Ensure project_prompts no longer has legacy metadata columns (safe if already dropped)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_prompts' AND column_name = 'prompt_heading'
  ) THEN
    ALTER TABLE "project_prompts" DROP COLUMN "prompt_heading";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_prompts' AND column_name = 'type'
  ) THEN
    ALTER TABLE "project_prompts" DROP COLUMN "type";
  END IF;
END $$;

