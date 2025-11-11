ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompts_content_hash_idx" ON "prompts" ("content_hash");
--> statement-breakpoint

-- Functions for normalization and hashing
CREATE OR REPLACE FUNCTION public.normalize_text_for_hash(t text) RETURNS text AS $$
BEGIN
  IF t IS NULL THEN
    RETURN '';
  END IF;
  RETURN regexp_replace(trim(replace(replace(t, E'\r\n', E'\n'), E'\r', E'\n')), E'\s+$', '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compute_prompt_content_hash(orig text, trans text) RETURNS text AS $$
BEGIN
  RETURN md5(normalize_text_for_hash(orig) || '|' || normalize_text_for_hash(COALESCE(trans, '')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- Immutability trigger: prevent updates to prompt text
CREATE OR REPLACE FUNCTION public.prevent_prompt_text_update() RETURNS trigger AS $$
BEGIN
  IF NEW."original_text" IS DISTINCT FROM OLD."original_text" OR NEW."transformed_text" IS DISTINCT FROM OLD."transformed_text" THEN
    RAISE EXCEPTION 'Prompts are immutable: text fields cannot be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "prompts_prevent_text_update" ON "prompts";
--> statement-breakpoint
CREATE TRIGGER "prompts_prevent_text_update" BEFORE UPDATE ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.prevent_prompt_text_update();
--> statement-breakpoint

-- Insert trigger: ensure hash is set for new rows
CREATE OR REPLACE FUNCTION public.set_prompt_hash_on_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."content_hash" IS NULL THEN
    NEW."content_hash" = compute_prompt_content_hash(NEW."original_text", NEW."transformed_text");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "prompts_set_hash_on_insert" ON "prompts";
--> statement-breakpoint
CREATE TRIGGER "prompts_set_hash_on_insert" BEFORE INSERT ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.set_prompt_hash_on_insert();

