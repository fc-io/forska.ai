CREATE TABLE IF NOT EXISTS "project_article_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_article_link_unique" ON "project_article_link" ("project_id", "article_id");
CREATE INDEX IF NOT EXISTS "project_article_link_project_idx" ON "project_article_link" ("project_id");
CREATE INDEX IF NOT EXISTS "project_article_link_article_idx" ON "project_article_link" ("article_id");
