import {type ArticleSourceMetadata, getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'

type ReviewHydrationRow = {
  id: string
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId: string | null
  importRoute: string | null
  url: string | null
  fullTextPDF: string | null
  fullTextFetchedAt: Date | null
  fullTextConversionStatus: string | null
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
  fullTextCharCount: number | null
  contentHash: string | null
  importRoute: string | null
  sourceMetadata: ArticleSourceMetadata | null
  publicationStatus: string | null
}

type ProjectReviewConfig = {
  dateFrom: Date | null
  dateTo: Date | null
  importRouteIds: string[]
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ProjectPromptRow = {id: string; promptHeading: string | null; originalText: string; type: string | null}

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

const getQuotedStringList = (values: string[]) => {
  return values.map((value) => {
    return `'${escapeSqlString(value)}'`
  })
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

const getReviewHydrationRows = async (articleIds: string[]): Promise<ReviewHydrationRow[]> => {
  if (articleIds.length === 0) {
    return []
  }

  const rows = await getAppDatabaseService().queryJson<{
    id: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    articleId: string | null
    importRoute: string | null
    url: string | null
    fullTextPDF: string | null
    fullTextFetchedAt: unknown
    fullTextConversionStatus: string | null
    sourceMetadata: unknown
  }>(`
    SELECT
      id,
      article_title AS articleTitle,
      article_created_at AS articleCreatedAt,
      article_updated_at AS articleUpdatedAt,
      article_id AS articleId,
      import_route AS importRoute,
      url,
      full_text_pdf AS fullTextPDF,
      full_text_fetched_at AS fullTextFetchedAt,
      full_text_conversion_status AS fullTextConversionStatus,
      source_metadata AS sourceMetadata
    FROM app.article
    WHERE id IN (${getQuotedStringList(articleIds).join(', ')})
  `)

  return rows.map((row) => {
    return {
      id: row.id,
      articleTitle: row.articleTitle,
      articleCreatedAt: getDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDateValue(row.articleUpdatedAt),
      articleId: row.articleId,
      importRoute: row.importRoute,
      url: row.url,
      fullTextPDF: row.fullTextPDF,
      fullTextFetchedAt: getDateValue(row.fullTextFetchedAt),
      fullTextConversionStatus: row.fullTextConversionStatus,
      sourceMetadata: getArticleSourceMetadataValue(getJsonValue(row.sourceMetadata)),
    }
  })
}

const getFullArticlesByIds = async (articleIds: string[]): Promise<FullArticleRow[]> => {
  if (articleIds.length === 0) {
    return []
  }

  const rows = await getAppDatabaseService().queryJson<{
    id: string
    createdAt: unknown
    updatedAt: unknown
    articleTitle: string
    articleAuthors: unknown
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    articleId: string | null
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
    fullTextCharCount: number | null
    contentHash: string | null
    importRoute: string | null
    sourceMetadata: unknown
    publicationStatus: string | null
  }>(`
    SELECT
      id,
      created_at AS createdAt,
      updated_at AS updatedAt,
      article_title AS articleTitle,
      TO_JSON(article_authors) AS articleAuthors,
      article_created_at AS articleCreatedAt,
      article_updated_at AS articleUpdatedAt,
      article_id AS articleId,
      article_summary AS articleSummary,
      article_version AS articleVersion,
      arxiv_id AS arxivId,
      biorxiv_id AS biorxivId,
      medrxiv_id AS medrxivId,
      doi,
      pubmed_id AS pubmedId,
      url,
      full_text_fetched_at AS fullTextFetchedAt,
      full_text AS fullText,
      full_text_html AS fullTextHtml,
      full_text_source AS fullTextSource,
      full_text_original_format AS fullTextOriginalFormat,
      full_text_pdf AS fullTextPDF,
      TO_JSON(full_text_assets) AS fullTextAssets,
      full_text_conversion_status AS fullTextConversionStatus,
      full_text_conversion_error AS fullTextConversionError,
      full_text_conversion_attempts AS fullTextConversionAttempts,
      full_text_char_count AS fullTextCharCount,
      content_hash AS contentHash,
      import_route AS importRoute,
      source_metadata AS sourceMetadata,
      publication_status AS publicationStatus
    FROM app.article
    WHERE id IN (${getQuotedStringList(articleIds).join(', ')})
  `)

  return rows.map((row) => {
    const articleAuthors = getJsonValue(row.articleAuthors)

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
      articleId: row.articleId,
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
      fullTextCharCount: row.fullTextCharCount,
      contentHash: row.contentHash,
      importRoute: row.importRoute,
      sourceMetadata: getArticleSourceMetadataValue(getJsonValue(row.sourceMetadata)),
      publicationStatus: row.publicationStatus,
    }
  })
}

const getProjectReviewConfig = async (projectId: string): Promise<ProjectReviewConfig | null> => {
  const [projectRows, routeRows] = await Promise.all([
    getAppDatabaseService().queryJson<{
      dateFrom: unknown
      dateTo: unknown
      modelId: string | null
      useTitle: boolean | null
      useAbstract: boolean | null
      useFulltext: boolean | null
      useFulltextNoImages: boolean | null
    }>(`
      SELECT
        date_from AS dateFrom,
        date_to AS dateTo,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages
      FROM app.project
      WHERE id = '${escapeSqlString(projectId)}'
      LIMIT 1
    `),
    getAppDatabaseService().queryJson<{importRouteId: string}>(`
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

const getProjectPromptRows = async (projectId: string): Promise<ProjectPromptRow[]> => {
  const rows = await getAppDatabaseService().queryJson<ProjectPromptRow>(`
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

const appQueryService = {getFullArticlesByIds, getProjectPromptRows, getProjectReviewConfig, getReviewHydrationRows}

export const getAppQueryService = () => {
  return appQueryService
}
