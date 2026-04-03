import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

const createSql = `
CREATE TABLE mart.judgment_fact_rebuild (
  judgment_id VARCHAR PRIMARY KEY,
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  project_id VARCHAR,
  snapshot_project_id VARCHAR,
  snapshot_project_model_name VARCHAR,
  use_title BOOLEAN NOT NULL,
  use_abstract BOOLEAN NOT NULL,
  use_fulltext BOOLEAN NOT NULL,
  use_fulltext_no_images BOOLEAN NOT NULL,
  chunking_strategy VARCHAR,
  is_answered BOOLEAN NOT NULL,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  normalized_answers VARCHAR[],
  confidence_original INTEGER,
  explanation VARCHAR,
  quotes JSON,
  article_title VARCHAR NOT NULL,
  article_created_at TIMESTAMPTZ,
  article_updated_at TIMESTAMPTZ,
  article_import_route VARCHAR,
  article_publication_status VARCHAR,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`

const insertSql = `
INSERT INTO mart.judgment_fact_rebuild (
  judgment_id,
  article_id,
  prompt_id,
  model_id,
  project_id,
  snapshot_project_id,
  snapshot_project_model_name,
  use_title,
  use_abstract,
  use_fulltext,
  use_fulltext_no_images,
  chunking_strategy,
  is_answered,
  answered_original,
  answered_original_as_array,
  normalized_answers,
  confidence_original,
  explanation,
  quotes,
  article_title,
  article_created_at,
  article_updated_at,
  article_import_route,
  article_publication_status,
  created_at,
  updated_at
)
SELECT
  judgment.id,
  judgment.article_id,
  judgment.prompt_id,
  judgment.model_id,
  judgment.project_id,
  judgment.snapshot_project_id,
  judgment.snapshot_project_model_name,
  judgment.use_title,
  judgment.use_abstract,
  judgment.use_fulltext,
  judgment.use_fulltext_no_images,
  judgment.chunking_strategy,
  judgment.is_answered,
  NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') AS answered_original,
  judgment.answered_original_as_array,
  CASE
    WHEN judgment.answered_original_as_array IS NOT NULL AND ARRAY_LENGTH(judgment.answered_original_as_array) > 0
      THEN judgment.answered_original_as_array
    WHEN NULLIF(TRIM(COALESCE(judgment.answered_original, '')), '') IS NOT NULL
      THEN [TRIM(COALESCE(judgment.answered_original, ''))]
    ELSE NULL
  END AS normalized_answers,
  judgment.confidence_original,
  judgment.explanation,
  judgment.quotes,
  article.article_title,
  article.article_created_at,
  article.article_updated_at,
  article.import_route,
  article.publication_status,
  judgment.created_at,
  judgment.updated_at
FROM app.judgment judgment
INNER JOIN app.article article ON article.id = judgment.article_id
WHERE judgment.deleted_at IS NULL;
`

const indexSql = `
CREATE INDEX idx_mart_judgment_fact_lookup ON mart.judgment_fact(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images);
`

const database = getAppDatabaseService()
await database.run('DROP TABLE IF EXISTS mart.judgment_fact_rebuild;')
console.log('creating rebuild table')
await database.run(createSql)
console.log('loading rebuild table')
await database.run(insertSql)
console.log('swapping tables')
await database.run('DROP TABLE mart.judgment_fact;')
await database.run('ALTER TABLE mart.judgment_fact_rebuild RENAME TO judgment_fact;')
console.log('creating index')
await database.run(indexSql)
console.log('done')
