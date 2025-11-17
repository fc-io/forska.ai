ALTER TABLE "articles" ADD COLUMN "openalex_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "articles_openalex_id_unique" ON "articles" USING btree ("openalex_id");