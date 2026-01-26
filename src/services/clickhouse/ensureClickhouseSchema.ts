import {getClickhouseClient} from './clickhouseClient.ts'

type ClickhouseEngineRow = {engine?: string}

const getClickhouseTableEngine = async (db: string, name: string): Promise<string | null> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `
      SELECT engine
      FROM system.tables
      WHERE database = {db:String} AND name = {name:String}
      LIMIT 1
    `,
    query_params: {db, name},
    format: 'JSONEachRow',
  })

  const rows = await result.json<ClickhouseEngineRow>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  const engine = firstRow?.engine
  return typeof engine === 'string' ? engine : null
}

const runClickhouseCommands = async (queries: string[]): Promise<void> => {
  const client = getClickhouseClient()
  await queries.reduce(async (prev, query) => {
    await prev
    await client.command({query})
  }, Promise.resolve())
}

export const ensureClickhouseSchema = async (): Promise<void> => {
  const client = getClickhouseClient()

  await client.command({query: 'CREATE DATABASE IF NOT EXISTS forska'})

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS forska.articles (
        id String,
        created_at DateTime64(6, 'UTC'),
        updated_at DateTime64(6, 'UTC'),
        article_title String,
        article_authors Array(Nullable(String)) DEFAULT [],
        article_created_at Nullable(DateTime64(6, 'UTC')),
        article_updated_at Nullable(DateTime64(6, 'UTC')),
        article_id Nullable(String),
        article_summary Nullable(String),
        article_version Nullable(Int32),
        arxiv_id Nullable(String),
        doi Nullable(String),
        pubmed_id Nullable(String),
        url Nullable(String),
        content_hash Nullable(String),
        import_route Nullable(String),
        imported_by Nullable(String),
        publication_status Nullable(String),
        full_text Nullable(String),
        full_text_source Nullable(String),
        full_text_original_format Nullable(String),
        full_text_pdf Nullable(String),
        full_text_fetched_at Nullable(DateTime64(6, 'UTC')),
        full_text_assets Nullable(String),
        openalex_id Nullable(String),
        biorxiv_id Nullable(String),
        medrxiv_id Nullable(String),
        full_text_conversion_status Nullable(String),
        full_text_conversion_error Nullable(String),
        full_text_conversion_attempts Nullable(Int32),
        full_text_char_count Nullable(Int32),
        full_text_html Nullable(String),
        full_text_pdf_uploaded_by Nullable(String),
        original_data Nullable(String)
      ) ENGINE = ReplacingMergeTree(updated_at)
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (id)
    `,
  })

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS forska.judgments_raw (
        id String,
        created_at DateTime64(3, 'UTC'),
        updated_at DateTime64(3, 'UTC'),
        deleted_at Nullable(DateTime64(3, 'UTC')),
        article_id String,
        model_id String,
        prompt_id String,
        project_id Nullable(String),
        use_title Bool DEFAULT true,
        use_abstract Bool DEFAULT true,
        use_fulltext Bool DEFAULT false,
        use_fulltext_no_images Bool DEFAULT false,
        is_answered Nullable(Bool),
        answered_original Nullable(String),
        answered_original_as_array Array(Nullable(String)) DEFAULT [],
        confidence_original Nullable(Int32),
        explanation Nullable(String),
        quotes Nullable(String),
        snapshot_project_id Nullable(String),
        snapshot_project_model_name Nullable(String),
        INDEX idx_judgments_raw_id id TYPE bloom_filter(0.01) GRANULARITY 1
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (article_id, prompt_id, model_id, id)
    `,
  })

  const judgmentsEngine = await getClickhouseTableEngine('forska', 'judgments')
  const hasJudgmentsNameConflict = judgmentsEngine !== null && judgmentsEngine !== 'View'

  const createJudgmentsViewQuery = `
    CREATE VIEW forska.judgments AS
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
      j.quotes
    FROM forska.judgments_raw j
    LEFT JOIN forska.articles a ON j.article_id = a.id
    WHERE j.deleted_at IS NULL
  `

  const judgmentViewQueries =
    judgmentsEngine === 'View'
      ? ['DROP VIEW IF EXISTS forska.judgments', createJudgmentsViewQuery]
      : [createJudgmentsViewQuery]

  if (hasJudgmentsNameConflict) {
    console.error(
      `[CH] Expected forska.judgments to be a VIEW, found engine=${judgmentsEngine}. Rename/drop it and re-run setup.`,
    )
  }

  await (hasJudgmentsNameConflict
    ? Promise.reject(new Error('ClickHouse schema conflict: forska.judgments'))
    : runClickhouseCommands(judgmentViewQueries))

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS forska.articles_stats (
        month UInt32,
        uniqueCount AggregateFunction(uniqCombined64, UInt64),
        maxUpdatedAt AggregateFunction(max, DateTime64(6, 'UTC'))
      ) ENGINE = AggregatingMergeTree()
      PARTITION BY month
      ORDER BY month
    `,
  })

  await client.command({
    query: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS forska.articles_stats_mv
      TO forska.articles_stats
      AS
      SELECT
        toYYYYMM(created_at) as month,
        uniqCombined64State(cityHash64(id)) as uniqueCount,
        maxState(updated_at) as maxUpdatedAt
      FROM forska.articles
      GROUP BY month
    `,
  })
}
