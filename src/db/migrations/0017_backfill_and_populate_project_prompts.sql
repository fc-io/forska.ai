-- Backfill content_hash for existing prompts
UPDATE "prompts"
SET "content_hash" = compute_prompt_content_hash("original_text", "transformed_text")
WHERE "content_hash" IS NULL;
--> statement-breakpoint

-- Populate project_prompts from legacy prompt columns
INSERT INTO "project_prompts" ("project_id", "prompt_id", "order", "archived")
SELECT "project_id", "id", "order", COALESCE("archived", false)
FROM "prompts"
ON CONFLICT ("project_id", "prompt_id") DO NOTHING;
