ALTER TABLE "articles" ADD COLUMN "full_text" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "use_title" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "use_abstract" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "use_fulltext" boolean DEFAULT false NOT NULL;