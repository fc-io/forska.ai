ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "content_hash" text;

-- Backfill content_hash using normalized original_text
UPDATE "prompts"
SET "content_hash" = md5(lower(trim("original_text")))
WHERE "content_hash" IS NULL;

-- Ensure uniqueness per project for same content
CREATE UNIQUE INDEX IF NOT EXISTS "prompts_project_content_hash_unique" ON "prompts" ("project_id", "content_hash");

CREATE INDEX IF NOT EXISTS "prompts_content_hash_idx" ON "prompts" ("content_hash");
