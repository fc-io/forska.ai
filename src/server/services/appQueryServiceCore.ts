import {type ArticleSourceMetadata, getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {
  getScopedArticleCompatibilityValues,
  getScopedArticleExternalIdExpression,
  getScopedArticleImportJoinSql,
  getScopedArticleImportRouteExpression,
  getScopedArticleImportSelectionCteSql,
  getScopedArticleMetadataExpression,
  getScopedArticleOriginalDataExpression,
} from './scopedArticleReadAdapter.ts'

export type AppQueryDatabaseService = {queryJson: <T>(statement: string) => Promise<T[]>}

type ReviewHydrationRow = {
  id: string
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId: string | null
  canonicalArticleId: string | null
  importRoute: string | null
  url: string | null
  fullTextPDF: string | null
  fullTextFetchedAt: Date | null
  fullTextConversionStatus: string | null
  canonicalSourceMetadata: ArticleSourceMetadata | null
  scopedImportMetadata: unknown
  selectedExternalArticleId: string | null
  selectedImportRecordId: string | null
  selectedImportRouteId: string | null
  selectedSourceRecordKey: string | null
  sourceMetadata: ArticleSourceMetadata | null
}

type FullArticleRow = {
  id: string
  createdAt: Date | null
  updatedAt: Date | null
  articleTitle: string
  articleAuthors: string[] | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId: string | null
  canonicalArticleId: string | null
  articleSummary: string | null
  articleVersion: number | null
  arxivId: string | null
  biorxivId: string | null
  medrxivId: string | null
  doi: string | null
  pubmedId: string | null
  url: string | null
  fullTextFetchedAt: Date | null
  fullText: string | null
  fullTextHtml: string | null
  fullTextSource: string | null
  fullTextOriginalFormat: string | null
  fullTextPDF: string | null
  fullTextAssets: unknown
  fullTextConversionStatus: string | null
  fullTextConversionError: string | null
  fullTextConversionAttempts: number | null
  fullTextConversionModelId: string | null
  fullTextConversionMetadata: unknown
  fullTextCharCount: number | null
  contentHash: string | null
  importRoute: string | null
  originalData: unknown
  canonicalSourceMetadata: ArticleSourceMetadata | null
  scopedImportMetadata: unknown
  scopedRawPayload: unknown
  selectedExternalArticleId: string | null
  selectedImportRecordId: string | null
  selectedImportRouteId: string | null
  selectedSourceKind: string | null
  selectedSourceRecordKey: string | null
  sourceMetadata: ArticleSourceMetadata | null
  publicationStatus: string | null
}

type ProjectReviewConfig = {
  dateFrom: Date | null
  dateTo: Date | null
  humanJudgmentMode: 'prompt' | 'summary'
  importRouteIds: string[]
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ProjectPromptRow = {id: string; promptHeading: string | null; originalText: string; type: string | null}

type GetFullArticlesOptions = {includeFullText?: boolean; projectId?: string}

type GetReviewHydrationOptions = {projectId?: string}

const appTableColumnNameCache = new WeakMap<AppQueryDatabaseService, Map<string, Promise<Set<string>>>>()

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

const getQuotedStringList = (values: string[]) => {
  return values.map((value) => {
    return `'${escapeSqlString(value)}'`
  })
}

const getAppTableColumnNameCache = (database: AppQueryDatabaseService) => {
  const existing = appTableColumnNameCache.get(database)

  if (existing) {
    return existing
  }

  const next = new Map<string, Promise<Set<string>>>()

  appTableColumnNameCache.set(database, next)
  return next
}

const getAppTableColumnNames = async (database: AppQueryDatabaseService, tableName: string): Promise<Set<string>> => {
  const cache = getAppTableColumnNameCache(database)
  const existing = cache.get(tableName)

  if (existing) {
    return existing
  }

  const pending = database
    .queryJson<{columnName: string}>(
      `
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = '${escapeSqlString(tableName)}'
    `,
    )
    .then((rows) => {
      return new Set(
        rows.map((row) => {
          return row.columnName
        }),
      )
    })

  cache.set(tableName, pending)
  return pending
}

const getOptionalColumnSelect = ({
  alias,
  columnName,
  columnNames,
}: {
  alias: string
  columnName: string
  columnNames: Set<string>
}) => {
  return `${columnNames.has(columnName) ? columnName : 'NULL'} AS ${alias}`
}

const getDateValue = (value: unknown) => {
  const parsedDate =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
        ? new Date(typeof value === 'bigint' ? Number(value) : value)
        : null
  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null
}

const getJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return getJsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

const getScopedArticleReadSqlParts = (articleIds: string[], projectId: string | undefined) => {
  const scopedProjectId = typeof projectId === 'string' && projectId.trim() !== '' ? projectId.trim() : null
  const hasProjectScope = scopedProjectId !== null

  return {
    articleIdExpression: hasProjectScope ? getScopedArticleExternalIdExpression({articleAlias: 'a'}) : 'a.article_id',
    importRouteExpression: hasProjectScope
      ? getScopedArticleImportRouteExpression({articleAlias: 'a'})
      : 'a.import_route',
    joinClause: hasProjectScope ? getScopedArticleImportJoinSql({articleIdExpression: 'a.id'}) : '',
    metadataExpression: hasProjectScope ? getScopedArticleMetadataExpression({articleAlias: 'a'}) : 'a.source_metadata',
    originalDataExpression: hasProjectScope
      ? getScopedArticleOriginalDataExpression({articleAlias: 'a'})
      : 'a.original_data',
    scopedImportMetadataExpression: hasProjectScope ? 'scoped_import.import_metadata' : 'NULL',
    scopedRawPayloadExpression: hasProjectScope ? 'scoped_import.raw_payload' : 'NULL',
    selectedExternalArticleIdExpression: hasProjectScope ? 'scoped_import.external_article_id' : 'NULL',
    selectedImportRecordIdExpression: hasProjectScope ? 'scoped_import.id' : 'NULL',
    selectedImportRouteExpression: hasProjectScope ? 'scoped_import.import_route' : 'NULL',
    selectedImportRouteIdExpression: hasProjectScope ? 'scoped_import.import_route_id' : 'NULL',
    selectedSourceKindExpression: hasProjectScope ? 'scoped_import.source_kind' : 'NULL',
    selectedSourceRecordKeyExpression: hasProjectScope ? 'scoped_import.source_record_key' : 'NULL',
    withClause: hasProjectScope
      ? `WITH ${getScopedArticleImportSelectionCteSql({articleIds, projectIds: [scopedProjectId]})}`
      : '',
  }
}

const getReviewHydrationRows = (database: AppQueryDatabaseService) => {
  return async (articleIds: string[], options: GetReviewHydrationOptions = {}): Promise<ReviewHydrationRow[]> => {
    if (articleIds.length === 0) {
      return []
    }

    const readSql = getScopedArticleReadSqlParts(articleIds, options.projectId)
    const rows = await database.queryJson<{
      id: string
      articleTitle: string
      articleCreatedAt: unknown
      articleUpdatedAt: unknown
      articleId: string | null
      canonicalArticleId: string | null
      importRoute: string | null
      url: string | null
      fullTextPDF: string | null
      fullTextFetchedAt: unknown
      fullTextConversionStatus: string | null
      canonicalSourceMetadata: unknown
      scopedImportMetadata: unknown
      selectedExternalArticleId: string | null
      selectedImportRecordId: string | null
      selectedImportRouteId: string | null
      selectedImportRoute: string | null
      selectedSourceRecordKey: string | null
      sourceMetadata: unknown
    }>(`
      ${readSql.withClause}
      SELECT
        a.id,
        a.article_title AS articleTitle,
        a.article_created_at AS articleCreatedAt,
        a.article_updated_at AS articleUpdatedAt,
        ${readSql.articleIdExpression} AS articleId,
        a.article_id AS canonicalArticleId,
        ${readSql.importRouteExpression} AS importRoute,
        a.url,
        a.full_text_pdf AS fullTextPDF,
        a.full_text_fetched_at AS fullTextFetchedAt,
        a.full_text_conversion_status AS fullTextConversionStatus,
        a.source_metadata AS canonicalSourceMetadata,
        ${readSql.scopedImportMetadataExpression} AS scopedImportMetadata,
        ${readSql.selectedExternalArticleIdExpression} AS selectedExternalArticleId,
        ${readSql.selectedImportRecordIdExpression} AS selectedImportRecordId,
        ${readSql.selectedImportRouteIdExpression} AS selectedImportRouteId,
        ${readSql.selectedImportRouteExpression} AS selectedImportRoute,
        ${readSql.selectedSourceRecordKeyExpression} AS selectedSourceRecordKey,
        ${readSql.metadataExpression} AS sourceMetadata
      FROM app.article a
      ${readSql.joinClause}
      WHERE a.id IN (${getQuotedStringList(articleIds).join(', ')})
    `)

    return rows.map((row) => {
      const compatibilityValues = getScopedArticleCompatibilityValues({
        canonicalArticleId: row.canonicalArticleId,
        canonicalImportRoute: null,
        canonicalSourceMetadata: getJsonValue(row.canonicalSourceMetadata),
        scopedImportMetadata: getJsonValue(row.scopedImportMetadata),
        selectedExternalArticleId: row.selectedExternalArticleId,
        selectedImportRoute: row.selectedImportRoute,
      })

      return {
        id: row.id,
        articleTitle: row.articleTitle,
        articleCreatedAt: getDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDateValue(row.articleUpdatedAt),
        articleId: compatibilityValues.articleId,
        canonicalArticleId: row.canonicalArticleId,
        importRoute: row.importRoute,
        url: row.url,
        fullTextPDF: row.fullTextPDF,
        fullTextFetchedAt: getDateValue(row.fullTextFetchedAt),
        fullTextConversionStatus: row.fullTextConversionStatus,
        canonicalSourceMetadata: getArticleSourceMetadataValue(getJsonValue(row.canonicalSourceMetadata)),
        scopedImportMetadata: getJsonValue(row.scopedImportMetadata),
        selectedExternalArticleId: row.selectedExternalArticleId,
        selectedImportRecordId: row.selectedImportRecordId,
        selectedImportRouteId: row.selectedImportRouteId,
        selectedSourceRecordKey: row.selectedSourceRecordKey,
        sourceMetadata: getArticleSourceMetadataValue(compatibilityValues.sourceMetadata),
      }
    })
  }
}

const getFullArticlesByIds = (database: AppQueryDatabaseService) => {
  return async (
    articleIds: string[],
    {includeFullText = true, projectId}: GetFullArticlesOptions = {},
  ): Promise<FullArticleRow[]> => {
    if (articleIds.length === 0) {
      return []
    }

    const columnNames = await getAppTableColumnNames(database, 'article')
    const readSql = getScopedArticleReadSqlParts(articleIds, projectId)

    const rows = await database.queryJson<{
      id: string
      createdAt: unknown
      updatedAt: unknown
      articleTitle: string
      articleAuthors: unknown
      articleCreatedAt: unknown
      articleUpdatedAt: unknown
      articleId: string | null
      canonicalArticleId: string | null
      articleSummary: string | null
      articleVersion: number | null
      arxivId: string | null
      biorxivId: string | null
      medrxivId: string | null
      doi: string | null
      pubmedId: string | null
      url: string | null
      fullTextFetchedAt: unknown
      fullText: string | null
      fullTextHtml: string | null
      fullTextSource: string | null
      fullTextOriginalFormat: string | null
      fullTextPDF: string | null
      fullTextAssets: unknown
      fullTextConversionStatus: string | null
      fullTextConversionError: string | null
      fullTextConversionAttempts: number | null
      fullTextConversionModelId: string | null
      fullTextConversionMetadata: unknown
      fullTextCharCount: number | null
      contentHash: string | null
      importRoute: string | null
      originalData: unknown
      canonicalSourceMetadata: unknown
      scopedImportMetadata: unknown
      scopedRawPayload: unknown
      selectedExternalArticleId: string | null
      selectedImportRecordId: string | null
      selectedImportRouteId: string | null
      selectedImportRoute: string | null
      selectedSourceKind: string | null
      selectedSourceRecordKey: string | null
      sourceMetadata: unknown
      publicationStatus: string | null
    }>(`
      ${readSql.withClause}
      SELECT
        a.id,
        a.created_at AS createdAt,
        a.updated_at AS updatedAt,
        a.article_title AS articleTitle,
        TO_JSON(a.article_authors) AS articleAuthors,
        a.article_created_at AS articleCreatedAt,
        a.article_updated_at AS articleUpdatedAt,
        ${readSql.articleIdExpression} AS articleId,
        a.article_id AS canonicalArticleId,
        a.article_summary AS articleSummary,
        a.article_version AS articleVersion,
        a.arxiv_id AS arxivId,
        a.biorxiv_id AS biorxivId,
        a.medrxiv_id AS medrxivId,
        a.doi,
        a.pubmed_id AS pubmedId,
        a.url,
        a.full_text_fetched_at AS fullTextFetchedAt,
        ${includeFullText ? 'a.full_text' : 'NULL'} AS fullText,
        ${includeFullText ? 'a.full_text_html' : 'NULL'} AS fullTextHtml,
        a.full_text_source AS fullTextSource,
        a.full_text_original_format AS fullTextOriginalFormat,
        a.full_text_pdf AS fullTextPDF,
        TO_JSON(a.full_text_assets) AS fullTextAssets,
        a.full_text_conversion_status AS fullTextConversionStatus,
        a.full_text_conversion_error AS fullTextConversionError,
        a.full_text_conversion_attempts AS fullTextConversionAttempts,
        ${getOptionalColumnSelect({alias: 'fullTextConversionModelId', columnName: 'full_text_conversion_model_id', columnNames})},
        ${getOptionalColumnSelect({alias: 'fullTextConversionMetadata', columnName: 'full_text_conversion_metadata', columnNames})},
        a.full_text_char_count AS fullTextCharCount,
        a.content_hash AS contentHash,
        ${readSql.importRouteExpression} AS importRoute,
        ${readSql.originalDataExpression} AS originalData,
        a.source_metadata AS canonicalSourceMetadata,
        ${readSql.scopedImportMetadataExpression} AS scopedImportMetadata,
        ${readSql.scopedRawPayloadExpression} AS scopedRawPayload,
        ${readSql.selectedExternalArticleIdExpression} AS selectedExternalArticleId,
        ${readSql.selectedImportRecordIdExpression} AS selectedImportRecordId,
        ${readSql.selectedImportRouteIdExpression} AS selectedImportRouteId,
        ${readSql.selectedImportRouteExpression} AS selectedImportRoute,
        ${readSql.selectedSourceKindExpression} AS selectedSourceKind,
        ${readSql.selectedSourceRecordKeyExpression} AS selectedSourceRecordKey,
        ${readSql.metadataExpression} AS sourceMetadata,
        a.publication_status AS publicationStatus
      FROM app.article a
      ${readSql.joinClause}
      WHERE a.id IN (${getQuotedStringList(articleIds).join(', ')})
    `)

    return rows.map((row) => {
      const articleAuthors = getJsonValue(row.articleAuthors)
      const compatibilityValues = getScopedArticleCompatibilityValues({
        canonicalArticleId: row.canonicalArticleId,
        canonicalImportRoute: null,
        canonicalOriginalData: getJsonValue(row.originalData),
        canonicalSourceMetadata: getJsonValue(row.canonicalSourceMetadata),
        scopedImportMetadata: getJsonValue(row.scopedImportMetadata),
        scopedRawPayload: getJsonValue(row.scopedRawPayload),
        selectedExternalArticleId: row.selectedExternalArticleId,
        selectedImportRoute: row.selectedImportRoute,
      })

      return {
        id: row.id,
        createdAt: getDateValue(row.createdAt),
        updatedAt: getDateValue(row.updatedAt),
        articleTitle: row.articleTitle,
        articleAuthors: Array.isArray(articleAuthors)
          ? articleAuthors.filter((value): value is string => {
              return typeof value === 'string'
            })
          : null,
        articleCreatedAt: getDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDateValue(row.articleUpdatedAt),
        articleId: compatibilityValues.articleId,
        canonicalArticleId: row.canonicalArticleId,
        articleSummary: row.articleSummary,
        articleVersion: row.articleVersion,
        arxivId: row.arxivId,
        biorxivId: row.biorxivId,
        medrxivId: row.medrxivId,
        doi: row.doi,
        pubmedId: row.pubmedId,
        url: row.url,
        fullTextFetchedAt: getDateValue(row.fullTextFetchedAt),
        fullText: row.fullText,
        fullTextHtml: row.fullTextHtml,
        fullTextSource: row.fullTextSource,
        fullTextOriginalFormat: row.fullTextOriginalFormat,
        fullTextPDF: row.fullTextPDF,
        fullTextAssets: getJsonValue(row.fullTextAssets),
        fullTextConversionStatus: row.fullTextConversionStatus,
        fullTextConversionError: row.fullTextConversionError,
        fullTextConversionAttempts: row.fullTextConversionAttempts,
        fullTextConversionModelId: row.fullTextConversionModelId,
        fullTextConversionMetadata: getJsonValue(row.fullTextConversionMetadata),
        fullTextCharCount: row.fullTextCharCount,
        contentHash: row.contentHash,
        importRoute: row.importRoute,
        originalData: compatibilityValues.originalData,
        canonicalSourceMetadata: getArticleSourceMetadataValue(getJsonValue(row.canonicalSourceMetadata)),
        scopedImportMetadata: getJsonValue(row.scopedImportMetadata),
        scopedRawPayload: getJsonValue(row.scopedRawPayload),
        selectedExternalArticleId: row.selectedExternalArticleId,
        selectedImportRecordId: row.selectedImportRecordId,
        selectedImportRouteId: row.selectedImportRouteId,
        selectedSourceKind: row.selectedSourceKind,
        selectedSourceRecordKey: row.selectedSourceRecordKey,
        sourceMetadata: getArticleSourceMetadataValue(compatibilityValues.sourceMetadata),
        publicationStatus: row.publicationStatus,
      }
    })
  }
}

const getProjectReviewConfig = (database: AppQueryDatabaseService) => {
  return async (projectId: string): Promise<ProjectReviewConfig | null> => {
    const columnNames = await getAppTableColumnNames(database, 'project')
    const [projectRows, routeRows] = await Promise.all([
      database.queryJson<{
        dateFrom: unknown
        dateTo: unknown
        humanJudgmentMode: 'prompt' | 'summary' | null
        modelId: string | null
        useTitle: boolean | null
        useAbstract: boolean | null
        useFulltext: boolean | null
        useFulltextNoImages: boolean | null
      }>(`
        SELECT
          date_from AS dateFrom,
          date_to AS dateTo,
          ${getOptionalColumnSelect({alias: 'humanJudgmentMode', columnName: 'human_judgment_mode', columnNames})},
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages
        FROM app.project
        WHERE id = '${escapeSqlString(projectId)}'
        LIMIT 1
      `),
      database.queryJson<{importRouteId: string}>(`
        SELECT import_route_id AS importRouteId
        FROM app.project_import_route
        WHERE project_id = '${escapeSqlString(projectId)}'
      `),
    ])
    const [projectConfig] = projectRows

    return projectConfig
      ? {
          dateFrom: getDateValue(projectConfig.dateFrom),
          dateTo: getDateValue(projectConfig.dateTo),
          humanJudgmentMode: projectConfig.humanJudgmentMode ?? 'prompt',
          importRouteIds: routeRows.map((row) => {
            return row.importRouteId
          }),
          modelId: projectConfig.modelId,
          useTitle: projectConfig.useTitle ?? true,
          useAbstract: projectConfig.useAbstract ?? true,
          useFulltext: projectConfig.useFulltext ?? false,
          useFulltextNoImages: projectConfig.useFulltextNoImages ?? false,
        }
      : null
  }
}

const getProjectPromptRows = (database: AppQueryDatabaseService) => {
  return async (projectId: string): Promise<ProjectPromptRow[]> => {
    const rows = await database.queryJson<ProjectPromptRow>(`
      SELECT
        p.id AS id,
        p.prompt_heading AS promptHeading,
        p.original_text AS originalText,
        p.type AS type
      FROM app.project_prompt pp
      INNER JOIN app.prompt p ON p.id = pp.prompt_id
      WHERE pp.project_id = '${escapeSqlString(projectId)}'
        AND pp.enabled = TRUE
      ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC
    `)

    return rows
  }
}

export const createAppQueryService = (database: AppQueryDatabaseService) => {
  return {
    getFullArticlesByIds: getFullArticlesByIds(database),
    getProjectPromptRows: getProjectPromptRows(database),
    getProjectReviewConfig: getProjectReviewConfig(database),
    getReviewHydrationRows: getReviewHydrationRows(database),
  }
}

export type AppQueryService = ReturnType<typeof createAppQueryService>
