import {getClickhouseClient} from './clickhouseClient.ts'
import {ensureClickhouseSchema} from './ensureClickhouseSchema.ts'

type DerivedStats = {count: number}

type RebuildClickhouseJudgmentsDerivedTableResult = {
  startedAt: string
  finishedAt: string
  durationMs: number
  before: DerivedStats
  after: DerivedStats
}

const toNumber = (value: unknown): number => {
  return typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) || 0 : 0
}

const getJudgmentsDerivedStats = async (): Promise<DerivedStats> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count() as count FROM forska.judgments WHERE _peerdb_is_deleted = 0`,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{count: string | number}>()
  const row = Array.isArray(rows) ? rows[0] : rows
  return {count: toNumber(row?.count)}
}

const createJudgmentsDerivedMaterializedViewQuery = `
  CREATE MATERIALIZED VIEW IF NOT EXISTS forska.judgments_mv
  TO forska.judgments
  AS
  SELECT
    j.id,
    j.created_at AS createdAt,
    j.updated_at AS updatedAt,
    j.article_id AS articleId,
    COALESCE(a.article_title, '') AS articleTitle,
    a.article_created_at AS articleCreatedAt,
    a.article_updated_at AS articleUpdatedAt,
    if(isNull(a.article_created_at), NULL, toInt32(toYear(a.article_created_at))) AS articleCreatedYear,
    if(isNull(a.article_updated_at), NULL, toInt32(toYear(a.article_updated_at))) AS articleUpdatedYear,
    a.import_route AS articleImportRoute,
    a.imported_by AS articleImportedBy,
    j.prompt_id AS promptId,
    j.model_id AS modelId,
    j.use_title AS useTitle,
    j.use_abstract AS useAbstract,
    j.use_fulltext AS useFulltext,
    j.use_fulltext_no_images AS useFulltextNoImages,
    j.answered_original AS answeredOriginal,
    j.answered_original_as_array AS answeredOriginalAsArray,
    j.explanation,
    j.quotes,
    j._peerdb_version AS _peerdb_version,
    if(j._peerdb_is_deleted = 1 OR isNotNull(j.deleted_at), 1, 0) AS _peerdb_is_deleted
  FROM forska.judgments_raw j
  ANY LEFT JOIN (
    SELECT
      id,
      article_title,
      article_created_at,
      article_updated_at,
      import_route,
      imported_by
    FROM forska.articles
    WHERE _peerdb_is_deleted = 0
  ) a ON j.article_id = a.id
`

const insertIntoJudgmentsDerivedQuery = `
  INSERT INTO forska.judgments (
    id,
    createdAt,
    updatedAt,
    articleId,
    articleTitle,
    articleCreatedAt,
    articleUpdatedAt,
    articleCreatedYear,
    articleUpdatedYear,
    articleImportRoute,
    articleImportedBy,
    promptId,
    modelId,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
    answeredOriginal,
    answeredOriginalAsArray,
    explanation,
    quotes,
    _peerdb_version,
    _peerdb_is_deleted
  )
  SELECT
    j.id,
    j.created_at AS createdAt,
    j.updated_at AS updatedAt,
    j.article_id AS articleId,
    COALESCE(a.article_title, '') AS articleTitle,
    a.article_created_at AS articleCreatedAt,
    a.article_updated_at AS articleUpdatedAt,
    if(isNull(a.article_created_at), NULL, toInt32(toYear(a.article_created_at))) AS articleCreatedYear,
    if(isNull(a.article_updated_at), NULL, toInt32(toYear(a.article_updated_at))) AS articleUpdatedYear,
    a.import_route AS articleImportRoute,
    a.imported_by AS articleImportedBy,
    j.prompt_id AS promptId,
    j.model_id AS modelId,
    j.use_title AS useTitle,
    j.use_abstract AS useAbstract,
    j.use_fulltext AS useFulltext,
    j.use_fulltext_no_images AS useFulltextNoImages,
    j.answered_original AS answeredOriginal,
    j.answered_original_as_array AS answeredOriginalAsArray,
    j.explanation,
    j.quotes,
    j._peerdb_version AS _peerdb_version,
    if(j._peerdb_is_deleted = 1 OR isNotNull(j.deleted_at), 1, 0) AS _peerdb_is_deleted
  FROM forska.judgments_raw j
  ANY LEFT JOIN (
    SELECT
      id,
      article_title,
      article_created_at,
      article_updated_at,
      import_route,
      imported_by
    FROM forska.articles
    WHERE _peerdb_is_deleted = 0
  ) a ON j.article_id = a.id
`

const runClickhouseCommands = async (queries: string[]): Promise<void> => {
  const client = getClickhouseClient()
  return queries.reduce(async (prev, query) => {
    await prev
    await client.command({query})
  }, Promise.resolve())
}

export const rebuildClickhouseJudgmentsDerivedTable =
  async (): Promise<RebuildClickhouseJudgmentsDerivedTableResult> => {
    await ensureClickhouseSchema()
    const startedAt = new Date()
    const startedAtMs = Date.now()
    const before = await getJudgmentsDerivedStats()

    await runClickhouseCommands([
      'DROP TABLE IF EXISTS forska.judgments_mv',
      'TRUNCATE TABLE forska.judgments',
      insertIntoJudgmentsDerivedQuery,
      createJudgmentsDerivedMaterializedViewQuery,
    ])

    const after = await getJudgmentsDerivedStats()
    const finishedAt = new Date()

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      before,
      after,
    }
  }
