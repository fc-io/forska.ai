CREATE TABLE "sync_state" (
	"remote_id" text NOT NULL,
	"table_name" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT to_timestamp(0) NOT NULL,
	CONSTRAINT "sync_state_remote_id_table_name_pk" PRIMARY KEY("remote_id","table_name")
);
--> statement-breakpoint
CREATE INDEX "article_route_link_updated_idx" ON "article_route_link" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "articles_updated_idx" ON "articles" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "judgments_updated_idx" ON "judgments" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "judgments_human_updated_idx" ON "judgments_human" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "token_use_updated_idx" ON "token_use" USING btree ("updated_at");