import {getClickhouseClient} from './clickhouseClient.ts'

type ClickhouseEngineRow = {engine?: string}

const REPLACING_ENGINE = 'ReplacingMergeTree'

const createArticlesTableQuery = `
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
    original_data Nullable(String),
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9)
  ) ENGINE = ReplacingMergeTree(_peerdb_version)
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (id)
`

const createJudgmentsRawTableQuery = `
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
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9),
    INDEX idx_judgments_raw_id id TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = ReplacingMergeTree(_peerdb_version)
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (article_id, prompt_id, model_id, id)
`

const createJudgmentsTableQuery = `
  CREATE TABLE IF NOT EXISTS forska.judgments (
    id String,
    createdAt DateTime64(3, 'UTC'),
    updatedAt DateTime64(3, 'UTC'),
    articleId String,
    articleTitle String,
    articleCreatedAt Nullable(DateTime64(6, 'UTC')),
    articleUpdatedAt Nullable(DateTime64(6, 'UTC')),
    articleCreatedYear Nullable(Int32),
    articleUpdatedYear Nullable(Int32),
    articleImportRoute Nullable(String),
    articleImportedBy Nullable(String),
    promptId String,
    modelId String,
    useTitle Bool DEFAULT true,
    useAbstract Bool DEFAULT true,
    useFulltext Bool DEFAULT false,
    useFulltextNoImages Bool DEFAULT false,
    answeredOriginal Nullable(String),
    answeredOriginalAsArray Array(Nullable(String)) DEFAULT [],
    explanation Nullable(String),
    quotes Nullable(String),
    _peerdb_version Int64,
    _peerdb_is_deleted Int8 DEFAULT 0,
    _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9),
    INDEX idx_judgments_id id TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = ReplacingMergeTree(_peerdb_version)
  PARTITION BY toYYYYMM(createdAt)
  ORDER BY (articleId, promptId, modelId, id)
`

const createJudgmentsMaterializedViewQuery = `
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

const getLegacyTableName = (table: string) => {
  const suffix = String(Date.now())
  return `${table}_legacy_${suffix}`
}

const buildPeerdbVersionExpr = (updatedAtExpr: string) => {
  return `toInt64(toUnixTimestamp64Milli(${updatedAtExpr}))`
}

const toNullableString = (valueExpr: string) => {
  return `if(isNull(${valueExpr}), NULL, toString(${valueExpr}))`
}

const migrateArticlesToReplacingMergeTree = async (): Promise<void> => {
  const legacyName = getLegacyTableName('articles')
  const peerdbVersionExpr = buildPeerdbVersionExpr('legacy.updated_at')

  await runClickhouseCommands([
    `RENAME TABLE forska.articles TO forska.${legacyName}`,
    createArticlesTableQuery,
    `
      INSERT INTO forska.articles (
        id,
        created_at,
        updated_at,
        article_title,
        article_authors,
        article_created_at,
        article_updated_at,
        article_id,
        article_summary,
        article_version,
        arxiv_id,
        doi,
        pubmed_id,
        url,
        content_hash,
        import_route,
        imported_by,
        publication_status,
        full_text,
        full_text_source,
        full_text_original_format,
        full_text_pdf,
        full_text_fetched_at,
        full_text_assets,
        openalex_id,
        biorxiv_id,
        medrxiv_id,
        full_text_conversion_status,
        full_text_conversion_error,
        full_text_conversion_attempts,
        full_text_char_count,
        full_text_html,
        full_text_pdf_uploaded_by,
        original_data,
        _peerdb_version,
        _peerdb_is_deleted
      )
      SELECT
        toString(legacy.id) AS id,
        legacy.created_at,
        legacy.updated_at,
        legacy.article_title,
        legacy.article_authors,
        legacy.article_created_at,
        legacy.article_updated_at,
        ${toNullableString('legacy.article_id')} AS article_id,
        legacy.article_summary,
        legacy.article_version,
        legacy.arxiv_id,
        legacy.doi,
        legacy.pubmed_id,
        legacy.url,
        legacy.content_hash,
        legacy.import_route,
        legacy.imported_by,
        legacy.publication_status,
        legacy.full_text,
        legacy.full_text_source,
        legacy.full_text_original_format,
        legacy.full_text_pdf,
        legacy.full_text_fetched_at,
        legacy.full_text_assets,
        legacy.openalex_id,
        legacy.biorxiv_id,
        legacy.medrxiv_id,
        legacy.full_text_conversion_status,
        legacy.full_text_conversion_error,
        legacy.full_text_conversion_attempts,
        legacy.full_text_char_count,
        legacy.full_text_html,
        legacy.full_text_pdf_uploaded_by,
        legacy.original_data,
        ${peerdbVersionExpr} AS _peerdb_version,
        0 AS _peerdb_is_deleted
      FROM forska.${legacyName} legacy
    `,
  ])
}

const migrateJudgmentsRawToReplacingMergeTree = async (): Promise<void> => {
  const legacyName = getLegacyTableName('judgments_raw')
  const peerdbVersionExpr = buildPeerdbVersionExpr('legacy.updated_at')

  await runClickhouseCommands([
    `RENAME TABLE forska.judgments_raw TO forska.${legacyName}`,
    createJudgmentsRawTableQuery,
    `
      INSERT INTO forska.judgments_raw (
        id,
        created_at,
        updated_at,
        deleted_at,
        article_id,
        model_id,
        prompt_id,
        project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original,
        explanation,
        quotes,
        snapshot_project_id,
        snapshot_project_model_name,
        _peerdb_version,
        _peerdb_is_deleted
      )
      SELECT
        toString(legacy.id) AS id,
        legacy.created_at,
        legacy.updated_at,
        legacy.deleted_at,
        toString(legacy.article_id) AS article_id,
        toString(legacy.model_id) AS model_id,
        toString(legacy.prompt_id) AS prompt_id,
        ${toNullableString('legacy.project_id')} AS project_id,
        legacy.use_title,
        legacy.use_abstract,
        legacy.use_fulltext,
        legacy.use_fulltext_no_images,
        legacy.is_answered,
        legacy.answered_original,
        legacy.answered_original_as_array,
        legacy.confidence_original,
        legacy.explanation,
        legacy.quotes,
        ${toNullableString('legacy.snapshot_project_id')} AS snapshot_project_id,
        legacy.snapshot_project_model_name,
        ${peerdbVersionExpr} AS _peerdb_version,
        0 AS _peerdb_is_deleted
      FROM forska.${legacyName} legacy
    `,
  ])
}

const shouldMigrateEngine = (engine: string | null) => {
  return engine !== null && engine !== REPLACING_ENGINE
}

export const ensureClickhouseSchema = async (): Promise<void> => {
  const client = getClickhouseClient()

  await client.command({query: 'CREATE DATABASE IF NOT EXISTS forska'})

  const [articlesEngine, judgmentsRawEngine, judgmentsEngine] = await Promise.all([
    getClickhouseTableEngine('forska', 'articles'),
    getClickhouseTableEngine('forska', 'judgments_raw'),
    getClickhouseTableEngine('forska', 'judgments'),
  ])

  if (shouldMigrateEngine(articlesEngine)) {
    await migrateArticlesToReplacingMergeTree()
  }

  if (shouldMigrateEngine(judgmentsRawEngine)) {
    await migrateJudgmentsRawToReplacingMergeTree()
  }

  await client.command({query: createArticlesTableQuery})
  await client.command({query: createJudgmentsRawTableQuery})

  await runClickhouseCommands([
    'ALTER TABLE forska.articles ADD COLUMN IF NOT EXISTS _peerdb_version Int64',
    'ALTER TABLE forska.articles ADD COLUMN IF NOT EXISTS _peerdb_is_deleted Int8 DEFAULT 0',
    "ALTER TABLE forska.articles ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9)",
    'ALTER TABLE forska.judgments_raw ADD COLUMN IF NOT EXISTS _peerdb_version Int64',
    'ALTER TABLE forska.judgments_raw ADD COLUMN IF NOT EXISTS _peerdb_is_deleted Int8 DEFAULT 0',
    "ALTER TABLE forska.judgments_raw ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9)",
  ])

  const shouldReplaceJudgmentsView = judgmentsEngine === 'View'
  const shouldDropJudgmentsMaterializedView = judgmentsEngine === null || judgmentsEngine === 'View'
  const hasJudgmentsNameConflict =
    judgmentsEngine !== null && judgmentsEngine !== 'View' && judgmentsEngine !== REPLACING_ENGINE

  if (hasJudgmentsNameConflict) {
    console.error(
      `[CH] Expected forska.judgments to be ${REPLACING_ENGINE} or a VIEW, found engine=${judgmentsEngine}. Rename/drop it and re-run setup.`,
    )
  }

  await (hasJudgmentsNameConflict
    ? Promise.reject(new Error('ClickHouse schema conflict: forska.judgments'))
    : runClickhouseCommands([
        ...(shouldDropJudgmentsMaterializedView ? ['DROP TABLE IF EXISTS forska.judgments_mv'] : []),
        ...(shouldReplaceJudgmentsView ? ['DROP VIEW IF EXISTS forska.judgments'] : []),
        createJudgmentsTableQuery,
        'ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS _peerdb_version Int64',
        'ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS _peerdb_is_deleted Int8 DEFAULT 0',
        "ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS _peerdb_synced_at DateTime64(9, 'UTC') DEFAULT now64(9)",
        createJudgmentsMaterializedViewQuery,
      ]))

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
