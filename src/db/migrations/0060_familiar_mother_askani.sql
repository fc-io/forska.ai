ALTER TABLE "prompts" ADD COLUMN "owner_id" text DEFAULT 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompts_owner_idx" ON "prompts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "prompts_archived_idx" ON "prompts" USING btree ("archived");