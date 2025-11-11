-- Make prompts.prompt_heading and prompts.type immutable (global metadata)
CREATE OR REPLACE FUNCTION public.prevent_prompt_metadata_update() RETURNS trigger AS $$
BEGIN
  IF NEW."prompt_heading" IS DISTINCT FROM OLD."prompt_heading" OR NEW."type" IS DISTINCT FROM OLD."type" THEN
    RAISE EXCEPTION 'Prompts metadata is immutable: prompt_heading/type cannot be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "prompts_prevent_metadata_update" ON "prompts";
--> statement-breakpoint
CREATE TRIGGER "prompts_prevent_metadata_update" BEFORE UPDATE ON "prompts"
FOR EACH ROW EXECUTE FUNCTION public.prevent_prompt_metadata_update();
