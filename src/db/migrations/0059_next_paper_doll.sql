-- Add content flag columns
ALTER TABLE "judgments" ADD COLUMN "use_title" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "use_abstract" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "use_fulltext" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "judgments" ADD COLUMN "use_fulltext_no_images" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Deduplicate existing rows: soft-delete duplicates, keep the most recent by created_at.
-- For each (article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
-- group with multiple non-deleted rows, we keep only the one with the MAX(created_at)
-- and soft-delete the rest by setting deleted_at = now().
UPDATE "judgments" AS j
SET "deleted_at" = now()
FROM (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
        ORDER BY created_at DESC
      ) AS rn
    FROM "judgments"
    WHERE deleted_at IS NULL
  ) ranked
  WHERE rn > 1
) dups
WHERE j.id = dups.id;--> statement-breakpoint

-- Now create the unique partial index (only on non-deleted rows)
CREATE UNIQUE INDEX "judgments_article_prompt_model_content_unique" ON "judgments" USING btree ("article_id","prompt_id","model_id","use_title","use_abstract","use_fulltext","use_fulltext_no_images") WHERE "judgments"."deleted_at" IS NULL;