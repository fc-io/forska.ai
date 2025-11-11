-- Drop legacy prompts columns now that associations are in place
DROP INDEX IF EXISTS "prompts_project_idx";
--> statement-breakpoint

ALTER TABLE "prompts"
  DROP COLUMN IF EXISTS "project_id",
  DROP COLUMN IF EXISTS "order",
  DROP COLUMN IF EXISTS "archived";
