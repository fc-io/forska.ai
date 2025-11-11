-- Change prompt_id FKs to ON DELETE RESTRICT to prevent cross-project data loss
ALTER TABLE "judgments" DROP CONSTRAINT IF EXISTS "judgments_prompt_id_prompts_id_fk";
--> statement-breakpoint
ALTER TABLE "judgments"
  ADD CONSTRAINT "judgments_prompt_id_prompts_id_fk"
  FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "judgments_human" DROP CONSTRAINT IF EXISTS "judgments_human_prompt_id_prompts_id_fk";
--> statement-breakpoint
ALTER TABLE "judgments_human"
  ADD CONSTRAINT "judgments_human_prompt_id_prompts_id_fk"
  FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE restrict ON UPDATE no action;

