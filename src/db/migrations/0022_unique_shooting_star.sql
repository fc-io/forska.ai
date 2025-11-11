DROP INDEX "prompts_content_hash_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_content_hash_unique" ON "prompts" USING btree ("content_hash");