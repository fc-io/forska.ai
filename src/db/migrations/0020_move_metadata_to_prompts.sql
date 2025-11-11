-- Ensure prompts has global metadata columns
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "prompt_heading" text;
--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "type" text;
--> statement-breakpoint

-- Migrate metadata from project_prompts to prompts when present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_prompts' AND column_name = 'prompt_heading'
  ) THEN
    -- Select most frequent non-null heading per prompt_id
    WITH ranked AS (
      SELECT prompt_id, prompt_heading, cnt,
             ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY cnt DESC, prompt_heading ASC) AS rn
      FROM (
        SELECT prompt_id, prompt_heading, COUNT(*) AS cnt
        FROM project_prompts
        WHERE prompt_heading IS NOT NULL AND prompt_heading <> ''
        GROUP BY prompt_id, prompt_heading
      ) t
    )
    UPDATE prompts p
    SET prompt_heading = r.prompt_heading
    FROM ranked r
    WHERE r.rn = 1 AND p.id = r.prompt_id AND (p.prompt_heading IS NULL OR p.prompt_heading = '');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_prompts' AND column_name = 'type'
  ) THEN
    -- Select most frequent non-null type per prompt_id
    WITH ranked AS (
      SELECT prompt_id, type, cnt,
             ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY cnt DESC, type ASC) AS rn
      FROM (
        SELECT prompt_id, type, COUNT(*) AS cnt
        FROM project_prompts
        WHERE type IS NOT NULL AND type <> ''
        GROUP BY prompt_id, type
      ) t
    )
    UPDATE prompts p
    SET type = r.type
    FROM ranked r
    WHERE r.rn = 1 AND p.id = r.prompt_id AND (p.type IS NULL OR p.type = '');
  END IF;
END $$;
--> statement-breakpoint

-- Drop any old immutability trigger on project_prompts if it exists
DROP TRIGGER IF EXISTS "project_prompts_prevent_heading_type_update" ON "project_prompts";
--> statement-breakpoint

-- Drop metadata columns from project_prompts if present
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
--> statement-breakpoint

-- Ensure immutability on prompts metadata
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

