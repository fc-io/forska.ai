import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const judgmentFactCreateSql = `
  CREATE TABLE mart.judgment_fact (
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
  )
`

const judgmentFactIndexSql = `
  CREATE INDEX idx_mart_judgment_fact_lookup
  ON mart.judgment_fact(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
`

const getCount = async (tableName: string) => {
  const [row] = await getAppDatabaseService().queryJson<{count: number | string}>(`SELECT COUNT(*) AS count FROM ${tableName}`)
  return Number(row?.count ?? 0)
}

const getDuplicateJudgmentIds = async () => {
  return getAppDatabaseService().queryJson<{judgmentId: string; rowCount: number | string}>(`
    SELECT judgment_id AS judgmentId, COUNT(*) AS rowCount
    FROM mart.judgment_fact
    GROUP BY judgment_id
    HAVING COUNT(*) > 1
    ORDER BY rowCount DESC, judgmentId ASC
  `)
}

const rebuildJudgmentFact = async () => {
  const tempTableName = `temp_judgment_fact_repair_${Date.now()}`

  await getAppDatabaseService().run(`
    CREATE TEMP TABLE ${tempTableName} AS
    SELECT *
    FROM mart.judgment_fact
  `)
  await getAppDatabaseService().run(`DROP TABLE mart.judgment_fact`)
  await getAppDatabaseService().run(judgmentFactCreateSql)
  await getAppDatabaseService().run(`
    INSERT INTO mart.judgment_fact (
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
    FROM ${tempTableName}
  `)
  await getAppDatabaseService().run(judgmentFactIndexSql)
  await getAppDatabaseService().run(`DROP TABLE ${tempTableName}`)
}

export const repairJudgmentFactTable = async () => {
  return withDuckdbMaintenanceAccess('repair judgment_fact table', async () => {
    const beforeCount = await getCount('mart.judgment_fact')
    const duplicateJudgmentIds = await getDuplicateJudgmentIds()

    await rebuildJudgmentFact()

    const afterCount = await getCount('mart.judgment_fact')
    const duplicatesAfter = await getDuplicateJudgmentIds()

    console.log(
      JSON.stringify({
        afterCount,
        beforeCount,
        duplicateJudgmentIds,
        duplicatesAfter,
        status: 'ok',
      }),
    )
  })
}

if (import.meta.main) {
  await repairJudgmentFactTable()
}
