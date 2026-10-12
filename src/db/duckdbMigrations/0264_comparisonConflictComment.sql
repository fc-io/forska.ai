CREATE TABLE IF NOT EXISTS app.comparison_project_conflict_comment (
  id VARCHAR PRIMARY KEY,
  comparison_project_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  comment VARCHAR NOT NULL,
  author_user_id VARCHAR,
  author_display_name VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

INSERT INTO app.comparison_project_conflict_comment (
  id,
  comparison_project_id,
  article_id,
  comment,
  author_user_id,
  author_display_name,
  created_at,
  updated_at
)
SELECT
  CAST(uuid() AS VARCHAR),
  cr.comparison_project_id,
  cr.article_id,
  cr.comment,
  cr.reviewer_user_id,
  cr.reviewer_display_name,
  COALESCE(cr.comment_updated_at, cr.updated_at, current_timestamp),
  COALESCE(cr.comment_updated_at, cr.updated_at, current_timestamp)
FROM app.comparison_project_conflict_resolution cr
WHERE cr.comment IS NOT NULL
  AND cr.comment <> ''
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY cr.comparison_project_id, cr.article_id
  ORDER BY
    cr.comment_updated_at DESC NULLS LAST,
    cr.updated_at DESC NULLS LAST,
    cr.id DESC
) = 1;

ALTER TABLE app.comparison_project_conflict_resolution DROP COLUMN IF EXISTS comment;
ALTER TABLE app.comparison_project_conflict_resolution DROP COLUMN IF EXISTS comment_updated_at;
