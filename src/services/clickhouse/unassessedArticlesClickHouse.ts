/**
 * ClickHouse-based unassessed articles queries.
 *
 * Uses `forska.judgments` (S3Queue/Parquet) for consistency with articlesReviewsClickHouse.ts.
 * Scope is determined via PostgreSQL metadata (project_articles, import routes).
 */
import {and, eq} from 'drizzle-orm'

import {importRoute, projectArticles, projectPrompts, projectRouteLink, projects} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'

type UnassessedCountParams = {
  projectId: string
  projectModelId: string
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  importRouteIds: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type UnassessedArticlesParams = UnassessedCountParams & {limit: number; offset: number; search?: string}

type PaginationCursor = {lastDate: Date; lastArticleId: string}

type UnassessedPairsParams = {
  projectId: string
  jobId: string
  numberOfPromptsToGet: number
  cursor: PaginationCursor | null
}

type UnassessedPairsResult = {promptEntries: PromptQueueEntry[]; nextCursor: PaginationCursor | null}

type UnassessedArticleRow = {
  id: string
  articleId: string | null
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
}

type PromptQueueEntry = {articleId: string; promptId: string}

type ProjectMetadata = {
  promptIds: string[]
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  routeTexts: string[]
  curatedArticleIds: string[]
}

const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''").replace(/\\/g, '\\\\')
}

const formatDateForClickHouse = (date: Date): string => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`
}

/**
 * Fetches project metadata from PostgreSQL for ClickHouse queries.
 * This mirrors the approach in articlesReviewsClickHouse.ts for consistency.
 */
const fetchProjectMetadataForUnassessed = async (projectId: string): Promise<ProjectMetadata | null> => {
  const db = getDatabase()

  const [projectPromptRows, projectBoundsResult, projectImportRouteTexts, curatedArticleRows] = await Promise.all([
    db
      .select({promptId: projectPrompts.promptId})
      .from(projectPrompts)
      .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true))),

    db
      .select({
        dateFrom: projects.dateFrom,
        dateTo: projects.dateTo,
        modelId: projects.modelId,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),

    db
      .select({route: importRoute.route})
      .from(projectRouteLink)
      .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
      .where(eq(projectRouteLink.projectId, projectId)),

    db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, projectId)),
  ])

  const bounds = projectBoundsResult[0]
  if (!bounds) return null

  return {
    promptIds: projectPromptRows.map((r) => {
      return r.promptId
    }),
    modelId: bounds.modelId,
    useTitle: bounds.useTitle ?? true,
    useAbstract: bounds.useAbstract ?? true,
    useFulltext: bounds.useFulltext ?? false,
    useFulltextNoImages: bounds.useFulltextNoImages ?? false,
    dateFrom: bounds.dateFrom,
    dateTo: bounds.dateTo,
    routeTexts: projectImportRouteTexts.map((r) => {
      return r.route
    }),
    curatedArticleIds: curatedArticleRows.map((r) => {
      return r.articleId
    }),
  }
}

/**
 * Builds WHERE conditions for filtering judgments.
 * Matches the approach in articlesReviewsClickHouse.ts.
 */
const buildJudgmentFilters = (
  promptIds: string[],
  modelId: string,
  useTitle: boolean,
  useAbstract: boolean,
  useFulltext: boolean,
  useFulltextNoImages: boolean,
): string[] => {
  const filters: string[] = []

  const promptIdsQuoted = promptIds
    .map((id) => {
      return `'${escapeClickHouseString(id)}'`
    })
    .join(', ')
  filters.push(`promptId IN (${promptIdsQuoted})`)

  filters.push(`modelId = '${escapeClickHouseString(modelId)}'`)

  filters.push(`useTitle = ${useTitle}`)
  filters.push(`useAbstract = ${useAbstract}`)
  filters.push(`useFulltext = ${useFulltext}`)
  filters.push(`useFulltextNoImages = ${useFulltextNoImages}`)

  filters.push(`deletedAt IS NULL`)

  return filters
}

/**
 * Builds scope filter for articles in project.
 * Uses same approach as articlesReviewsClickHouse.ts: curatedArticleIds OR import routes.
 */
const buildScopeFilter = (curatedArticleIds: string[], routeTexts: string[]): string | null => {
  const scopeParts: string[] = []

  if (curatedArticleIds.length > 0) {
    const curatedIdsQuoted = curatedArticleIds
      .map((id) => {
        return `'${escapeClickHouseString(id)}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }

  if (routeTexts.length > 0) {
    const routesQuoted = routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }

  return scopeParts.length > 0 ? `(${scopeParts.join(' OR ')})` : null
}

/**
 * Builds date filter conditions.
 */
const buildDateFilters = (
  projectDateFrom: Date | null | undefined,
  projectDateTo: Date | null | undefined,
): string[] => {
  const filters: string[] = []
  if (projectDateFrom) {
    filters.push(`articleCreatedAt >= toDateTime64('${formatDateForClickHouse(projectDateFrom)}', 3)`)
  }
  if (projectDateTo) {
    filters.push(`articleCreatedAt <= toDateTime64('${formatDateForClickHouse(projectDateTo)}', 3)`)
  }
  return filters
}

export const getUnassessedCountFromClickHouse = async (params: UnassessedCountParams): Promise<number> => {
  const client = getClickhouseClient()
  const {
    projectId,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
  } = params

  console.time('ch:unassessed_count')

  const metadata = await fetchProjectMetadataForUnassessed(projectId)

  if (!metadata || metadata.promptIds.length === 0) {
    console.timeEnd('ch:unassessed_count')
    console.log('[CH] No metadata or 0 enabled prompts - returning 0')
    return 0
  }

  const hasScope = metadata.curatedArticleIds.length > 0 || metadata.routeTexts.length > 0
  if (!hasScope) {
    console.timeEnd('ch:unassessed_count')
    console.log('[CH] No scope defined - returning 0')
    return 0
  }

  const judgmentFilters = buildJudgmentFilters(
    metadata.promptIds,
    projectModelId,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
  )
  const scopeFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
  const dateFilters = buildDateFilters(projectDateFrom, projectDateTo)

  const allFilters = [...judgmentFilters, scopeFilter, ...dateFilters].filter(Boolean)
  const whereClause = allFilters.join(' AND ')

  // Query: Find articles that are in scope but NOT fully assessed
  // Step 1: Get all articles in scope (from judgments table - articles that have at least one judgment)
  // Step 2: Get assessed articles (those with ALL prompts answered)
  // Step 3: Count scope articles minus assessed articles

  // But we also need articles with NO judgments at all - those won't appear in the judgments table.
  // So we need to count scoped articles from forska.articles and subtract assessed count.

  // First, count total scoped articles (forska.articles uses snake_case columns)
  const scopedArticlesFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
    ?.replace(/articleId/g, 'id')
    .replace(/articleImportRoute/g, 'import_route')
  const scopedDateFilters = dateFilters.map((f) => {
    return f.replace('articleCreatedAt', 'article_created_at')
  })

  const scopedWhereClause = [scopedArticlesFilter, ...scopedDateFilters].filter(Boolean).join(' AND ')

  const totalScopedQuery = `
    SELECT COUNT(DISTINCT id) as total
    FROM forska.articles
    WHERE ${scopedWhereClause}
  `

  // Count assessed articles (those with ALL prompts)
  const assessedQuery = `
    SELECT COUNT(*) as assessed
    FROM (
      SELECT articleId
      FROM judgments
      WHERE ${whereClause}
      GROUP BY articleId
      HAVING COUNT(DISTINCT promptId) = ${metadata.promptIds.length}
    ) subquery
  `

  const [totalResult, assessedResult] = await Promise.all([
    client.query({query: totalScopedQuery, format: 'JSONEachRow'}),
    client.query({query: assessedQuery, format: 'JSONEachRow'}),
  ])

  const totalData = await totalResult.json<{total: string}>()
  const assessedData = await assessedResult.json<{assessed: string}>()

  const total = parseInt(totalData[0]?.total ?? '0', 10)
  const assessed = parseInt(assessedData[0]?.assessed ?? '0', 10)
  const unassessed = Math.max(0, total - assessed)

  console.timeEnd('ch:unassessed_count')
  console.log(`[CH] Unassessed count: ${unassessed} (total: ${total}, assessed: ${assessed})`)
  return unassessed
}

export const getUnassessedArticlesFromClickHouse = async (
  params: UnassessedArticlesParams,
): Promise<{articles: UnassessedArticleRow[]; totalCount: number}> => {
  const client = getClickhouseClient()
  const {
    projectId,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
    limit,
    offset,
    search,
  } = params

  console.time('ch:unassessed_articles')

  const metadata = await fetchProjectMetadataForUnassessed(projectId)

  if (!metadata || metadata.promptIds.length === 0) {
    console.timeEnd('ch:unassessed_articles')
    console.log('[CH] No metadata or 0 enabled prompts - returning empty')
    return {articles: [], totalCount: 0}
  }

  const hasScope = metadata.curatedArticleIds.length > 0 || metadata.routeTexts.length > 0
  if (!hasScope) {
    console.timeEnd('ch:unassessed_articles')
    console.log('[CH] No scope defined - returning empty')
    return {articles: [], totalCount: 0}
  }

  const judgmentFilters = buildJudgmentFilters(
    metadata.promptIds,
    projectModelId,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
  )
  const scopeFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
  const dateFilters = buildDateFilters(projectDateFrom, projectDateTo)

  const allFilters = [...judgmentFilters, scopeFilter, ...dateFilters].filter(Boolean)
  const whereClause = allFilters.join(' AND ')

  // Build scope filters for forska.articles (uses snake_case)
  const scopedArticlesFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
    ?.replace(/articleId/g, 'id')
    .replace(/articleImportRoute/g, 'import_route')
  const scopedDateFilters = dateFilters.map((f) => {
    return f.replace('articleCreatedAt', 'article_created_at')
  })
  const searchFilter = search?.trim() ? `article_title ILIKE '%${escapeClickHouseString(search.trim())}%'` : null

  const scopedWhereClause = [scopedArticlesFilter, ...scopedDateFilters, searchFilter].filter(Boolean).join(' AND ')

  // Get assessed article IDs
  const assessedSubquery = `
    SELECT articleId
    FROM judgments
    WHERE ${whereClause}
    GROUP BY articleId
    HAVING COUNT(DISTINCT promptId) = ${metadata.promptIds.length}
  `

  // Count unassessed
  const countQuery = `
    SELECT COUNT(*) as total_count
    FROM forska.articles a
    WHERE ${scopedWhereClause}
      AND a.id NOT IN (${assessedSubquery})
  `

  // Get unassessed articles
  const articlesQuery = `
    SELECT
      a.id,
      a.article_id,
      a.article_title,
      a.article_created_at,
      a.article_updated_at
    FROM forska.articles a
    WHERE ${scopedWhereClause}
      AND a.id NOT IN (${assessedSubquery})
    ORDER BY COALESCE(a.article_updated_at, a.article_created_at, a.created_at) DESC, a.id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `

  const [countResult, articlesResult] = await Promise.all([
    client.query({query: countQuery, format: 'JSONEachRow'}),
    client.query({query: articlesQuery, format: 'JSONEachRow'}),
  ])

  const countData = await countResult.json<{total_count: string}>()
  const articlesData = await articlesResult.json<{
    id: string
    article_id: string | null
    article_title: string
    article_created_at: string | null
    article_updated_at: string | null
  }>()

  console.timeEnd('ch:unassessed_articles')

  const totalCount = parseInt(countData[0]?.total_count ?? '0', 10)
  const articles: UnassessedArticleRow[] = articlesData.map((row) => {
    return {
      id: row.id,
      articleId: row.article_id,
      articleTitle: row.article_title,
      articleCreatedAt: row.article_created_at ? new Date(row.article_created_at) : null,
      articleUpdatedAt: row.article_updated_at ? new Date(row.article_updated_at) : null,
    }
  })

  console.log(`[CH] Found ${articles.length} unassessed articles (total: ${totalCount})`)
  return {articles, totalCount}
}

const buildCursorCondition = (cursor: PaginationCursor | null): string => {
  if (!cursor) return ''
  const cursorDateStr = formatDateForClickHouse(cursor.lastDate)
  const cursorArticleId = escapeClickHouseString(cursor.lastArticleId)
  return `
      AND (COALESCE(a.article_updated_at, a.article_created_at, a.created_at), a.id)
          < (toDateTime64('${cursorDateStr}', 3), '${cursorArticleId}')`
}

const extractNextCursor = (data: Array<{article_id: string; sort_date: string}>): PaginationCursor | null => {
  const lastRow = data[data.length - 1]
  return lastRow ? {lastDate: new Date(lastRow.sort_date), lastArticleId: lastRow.article_id} : null
}

export const getUnassessedPairsFromClickHouse = async (
  params: UnassessedPairsParams,
): Promise<UnassessedPairsResult> => {
  const {projectId, numberOfPromptsToGet, cursor} = params
  const client = getClickhouseClient()

  console.time('ch:unassessed_pairs')

  const metadata = await fetchProjectMetadataForUnassessed(projectId)

  if (!metadata) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] Project not found - returning empty')
    return {promptEntries: [], nextCursor: null}
  }

  if (metadata.promptIds.length === 0) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] 0 enabled prompts - returning empty')
    return {promptEntries: [], nextCursor: null}
  }

  if (!metadata.modelId) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] No modelId - returning empty')
    return {promptEntries: [], nextCursor: null}
  }

  const hasScope = metadata.curatedArticleIds.length > 0 || metadata.routeTexts.length > 0
  if (!hasScope) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] No scope defined - returning empty')
    return {promptEntries: [], nextCursor: null}
  }

  const judgmentFilters = buildJudgmentFilters(
    metadata.promptIds,
    metadata.modelId,
    metadata.useTitle,
    metadata.useAbstract,
    metadata.useFulltext,
    metadata.useFulltextNoImages,
  )
  const scopeFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
  const dateFilters = buildDateFilters(metadata.dateFrom, metadata.dateTo)

  const judgmentWhereClause = [...judgmentFilters, scopeFilter].filter(Boolean).join(' AND ')

  // Build scope filters for forska.articles
  const scopedArticlesFilter = buildScopeFilter(metadata.curatedArticleIds, metadata.routeTexts)
    ?.replace(/articleId/g, 'id')
    .replace(/articleImportRoute/g, 'import_route')
  const scopedDateFilters = dateFilters.map((f) => {
    return f.replace('articleCreatedAt', 'article_created_at')
  })
  const scopedWhereClause = [scopedArticlesFilter, ...scopedDateFilters].filter(Boolean).join(' AND ')

  const cursorCondition = buildCursorCondition(cursor)

  const promptIdsQuoted = metadata.promptIds
    .map((id) => {
      return `'${escapeClickHouseString(id)}'`
    })
    .join(', ')

  // Get assessed article-prompt pairs
  const assessedPairsSubquery = `
    SELECT articleId, promptId
    FROM judgments
    WHERE ${judgmentWhereClause}
  `

  // Get unassessed pairs: all (article, prompt) combinations minus assessed pairs
  const query = `
    SELECT
      a.id AS article_id,
      p.promptId AS prompt_id,
      COALESCE(a.article_updated_at, a.article_created_at, a.created_at) AS sort_date
    FROM forska.articles a
    CROSS JOIN (
      SELECT arrayJoin([${promptIdsQuoted}]) AS promptId
    ) p
    WHERE ${scopedWhereClause}
      AND (a.id, p.promptId) NOT IN (${assessedPairsSubquery})
      ${cursorCondition}
    ORDER BY sort_date DESC, a.id DESC
    LIMIT ${numberOfPromptsToGet}
  `

  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{article_id: string; prompt_id: string; sort_date: string}>()
  console.timeEnd('ch:unassessed_pairs')

  const promptEntries: PromptQueueEntry[] = data.map((row) => {
    return {articleId: row.article_id, promptId: row.prompt_id}
  })
  const nextCursor = extractNextCursor(data)

  console.log(`[CH] Found ${promptEntries.length} unassessed pairs`)
  return {promptEntries, nextCursor}
}
