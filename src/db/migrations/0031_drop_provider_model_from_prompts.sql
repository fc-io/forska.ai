-- Drop provider and model_name from prompts; hashes no longer include model/provider
ALTER TABLE "prompts" DROP COLUMN IF EXISTS "provider";
--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN IF EXISTS "model_name";
--> statement-breakpoint

-- No changes to content hash trigger; it already ignores provider/model (see 0022)


