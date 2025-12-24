/**
 * ClickHouse-based articles reviews query service.
 *
 * This is the ClickHouse equivalent of the PostgreSQL articlesReviewsQueryBuilder.ts
 * Queries the `judgments` table in ClickHouse which was populated via S3Queue from Parquet files.
 *
 * Key differences from PostgreSQL:
 * - Uses ClickHouse SQL dialect (hasAny for array intersections, etc.)
 * - GROUP BY and ORDER BY are fast due to columnar storage
 * - No need for progressive fetch - ClickHouse handles aggregation efficiently
 * - Uses temp tables for large curated article sets (>1000 IDs)
 */
import {and, eq} from 'drizzle-orm'

import {importRoute, projectArticles, projectPrompts, projectRouteLink, projects, prompts} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'

/**
 * Threshold for using temp tables instead of IN clause.
 * When curated articles exceed this count, we create a temp table to avoid query size limits.
 */
const CURATED_ARTICLES_TEMP_TABLE_THRESHOLD = 1000

/**
 * Batch size for inserting IDs into temp tables.
 */
const TEMP_TABLE_INSERT_BATCH_SIZE = 10000

/**
 * Input parameters for articles reviews query
 */
export interface ArticlesReviewsParams {
  projectId: string
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  /** Map of promptId -> array of required answer values */
  prompts?: Record<string, string[]>
}

/**
 * Judgment row from ClickHouse
 */
export interface ClickHouseJudgmentRow {
  id: string
  createdAt: string
  deletedAt: string | null
  articleId: string
  articleTitle: string
  articleCreatedAt: string | null
  articleUpdatedAt: string | null
  articleCreatedYear: number | null
  articleUpdatedYear: number | null
  articleImportRoute: string | null
  articleImportedBy: string | null
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  explanation: string | null
  quotes: string | null
}

/**
 * Article result with grouped judgments
 */
export interface ArticleReviewResult {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  judgments: ClickHouseJudgmentRow[]
  judgedPromptIds: string[]
  isFullyJudged: boolean
}

/**
 * Full response from articles reviews query
 */
export interface ArticlesReviewsResponse {
  data: ArticleReviewResult[]
  totalCount: number | null
  page: number
  limit: number
  totalPages: number | null
}

/**
 * Fetches project metadata from PostgreSQL (prompts, bounds, routes, curated articles)
 * This is needed because ClickHouse doesn't have these tables.
 */
const fetchProjectMetadataForClickHouse = async (projectId: string) => {
  const db = getDatabase()

  const [projectPromptRows, projectBoundsResult, projectImportRouteTexts, curatedArticleRows] = await Promise.all([
    // Get enabled prompts for project
    db
      .select({id: prompts.id, order: projectPrompts.order})
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
      .orderBy(projectPrompts.order),

    // Get project date bounds and modelId
    db
      .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo, modelId: projects.modelId})
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),

    // Get import routes as TEXT
    db
      .select({route: importRoute.route})
      .from(projectRouteLink)
      .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
      .where(eq(projectRouteLink.projectId, projectId)),

    // Get curated article IDs
    db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, projectId)),
  ])

  return {
    promptIds: projectPromptRows.map((p) => {
      return p.id
    }),
    promptOrderMap: projectPromptRows.reduce(
      (acc, p, idx) => {
        const ord = p.order ?? idx
        return {...acc, [p.id]: ord}
      },
      {} as Record<string, number>,
    ),
    projectBounds: projectBoundsResult[0] ?? null,
    modelId: projectBoundsResult[0]?.modelId ?? null,
    routeTexts: projectImportRouteTexts.map((r) => {
      return r.route
    }),
    curatedArticleIds: curatedArticleRows.map((r) => {
      return r.articleId
    }),
  }
}

/**
 * Escapes a string for ClickHouse SQL.
 * Replaces single quotes with escaped single quotes.
 */
const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''")
}

/**
 * Formats a Date for ClickHouse DateTime64(3).
 * ClickHouse doesn't accept the 'Z' suffix, so we format as 'YYYY-MM-DD HH:MM:SS.mmm'
 */
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
 * Creates a temporary table for curated article IDs and inserts the IDs.
 * Returns the table name for use in queries.
 */
const createCuratedArticlesTempTable = async (
  curatedArticleIds: string[],
): Promise<{tableName: string; cleanup: () => Promise<void>}> => {
  const client = getClickhouseClient()
  const tableName = `temp_curated_${Date.now()}_${Math.random().toString(36).substring(7)}`

  console.time('ch:temp_table_create')
  await client.command({query: `CREATE TABLE ${tableName} (articleId String) ENGINE = Memory`})
  console.timeEnd('ch:temp_table_create')

  // Insert in batches
  console.time('ch:temp_table_insert')
  for (let i = 0; i < curatedArticleIds.length; i += TEMP_TABLE_INSERT_BATCH_SIZE) {
    const batch = curatedArticleIds.slice(i, i + TEMP_TABLE_INSERT_BATCH_SIZE).map((id) => {
      return {articleId: id}
    })
    await client.insert({table: tableName, values: batch, format: 'JSONEachRow'})
  }
  console.timeEnd('ch:temp_table_insert')
  console.log(`[ClickHouse] Created temp table ${tableName} with ${curatedArticleIds.length} IDs`)

  const cleanup = async () => {
    try {
      await client.command({query: `DROP TABLE IF EXISTS ${tableName}`})
      console.log(`[ClickHouse] Dropped temp table ${tableName}`)
    } catch (error) {
      console.error(`[ClickHouse] Failed to drop temp table ${tableName}:`, error)
    }
  }

  return {tableName, cleanup}
}

/**
 * Queries articles reviews from ClickHouse.
 *
 * This query:
 * 1. Filters by promptId (project's enabled prompts)
 * 2. Filters by scope (import routes OR curated articles)
 * 3. Filters by date bounds
 * 4. Filters by search term (ILIKE on articleTitle)
 * 5. Groups by articleId
 * 6. Applies HAVING filters for answer values
 * 7. Orders by articleCreatedAt DESC
 * 8. Paginates with LIMIT/OFFSET
 *
 * For large curated article sets (>1000), uses a temp table with JOIN instead of IN clause.
 *
 * Expected performance: 1-5 seconds (vs ~50s in PostgreSQL)
 */
export const queryArticlesReviewsFromClickHouse = async (
  params: ArticlesReviewsParams,
): Promise<ArticlesReviewsResponse> => {
  const startTime = performance.now()
  const client = getClickhouseClient()

  // Fetch metadata from PostgreSQL
  console.time('ch:metadata')
  const metadata = await fetchProjectMetadataForClickHouse(params.projectId)
  console.timeEnd('ch:metadata')

  if (metadata.promptIds.length === 0) {
    return {data: [], totalCount: null, page: params.page, limit: params.limit, totalPages: null}
  }

  // Check if we have any scope defined (required!)
  const hasImportRoutes = metadata.routeTexts.length > 0
  const hasCuratedArticles = metadata.curatedArticleIds.length > 0

  if (!hasImportRoutes && !hasCuratedArticles) {
    console.log('[ClickHouse] No scope defined (no import routes or curated articles), returning empty')
    return {data: [], totalCount: null, page: params.page, limit: params.limit, totalPages: null}
  }

  // Log page/offset for debugging pagination issues
  const offset = (params.page - 1) * params.limit
  console.log(`[ClickHouse] Page ${params.page}, limit ${params.limit}, offset ${offset}`)
  console.log(
    `[ClickHouse] Scope: ${hasImportRoutes ? metadata.routeTexts.length + ' import routes' : 'no import routes'}, ${hasCuratedArticles ? metadata.curatedArticleIds.length + ' curated articles' : 'no curated articles'}`,
  )

  // Determine if we need a temp table for curated articles
  // Use temp table whenever curated articles exceed threshold, regardless of import routes
  // This prevents query size issues caused by large IN clauses
  const useCuratedTempTable = metadata.curatedArticleIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD

  let tempTableInfo: {tableName: string; cleanup: () => Promise<void>} | null = null

  try {
    // Create temp table if needed for curated articles
    if (useCuratedTempTable && hasCuratedArticles) {
      tempTableInfo = await createCuratedArticlesTempTable(metadata.curatedArticleIds)
    }

    // Build WHERE conditions
    const whereParts: string[] = []

    // Prompt filter - must be in project's enabled prompts
    const promptIdsQuoted = metadata.promptIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    whereParts.push(`promptId IN (${promptIdsQuoted})`)

    // Model filter - must match project's model
    if (metadata.modelId) {
      whereParts.push(`modelId = '${escapeClickHouseString(metadata.modelId)}'`)
    }

    // Date bounds
    const effectiveFromDate =
      metadata.projectBounds?.dateFrom && params.from
        ? metadata.projectBounds.dateFrom > new Date(`${params.from}T00:00:00.000Z`)
          ? metadata.projectBounds.dateFrom
          : new Date(`${params.from}T00:00:00.000Z`)
        : (metadata.projectBounds?.dateFrom ?? (params.from ? new Date(`${params.from}T00:00:00.000Z`) : null))

    const effectiveToDate =
      metadata.projectBounds?.dateTo && params.to
        ? metadata.projectBounds.dateTo < new Date(`${params.to}T23:59:59.999Z`)
          ? metadata.projectBounds.dateTo
          : new Date(`${params.to}T23:59:59.999Z`)
        : (metadata.projectBounds?.dateTo ?? (params.to ? new Date(`${params.to}T23:59:59.999Z`) : null))

    if (effectiveFromDate) {
      whereParts.push(`articleCreatedAt >= toDateTime64('${formatDateForClickHouse(effectiveFromDate)}', 3)`)
    }
    if (effectiveToDate) {
      whereParts.push(`articleCreatedAt <= toDateTime64('${formatDateForClickHouse(effectiveToDate)}', 3)`)
    }

    // Search filter
    if (params.search && params.search.trim()) {
      const searchEscaped = escapeClickHouseString(params.search.trim())
      whereParts.push(`articleTitle ILIKE '%${searchEscaped}%'`)
    }

    // Scope filter: import routes OR curated articles
    // Two approaches depending on curated article count:
    // 1. If curated articles are below threshold: use IN clauses for both
    // 2. If curated articles are above threshold: use LEFT JOIN on temp table for curated + OR with import routes

    const scopeParts: string[] = []

    // Import routes always use IN clause (they're usually small)
    if (hasImportRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
    }

    // Curated articles: IN clause if small, handled via JOIN if large
    if (hasCuratedArticles && !useCuratedTempTable) {
      // Small number of curated articles - use IN clause
      const curatedIdsQuoted = metadata.curatedArticleIds
        .map((id) => {
          return `'${id}'`
        })
        .join(', ')
      scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
    }

    // If using temp table for curated articles, we need a different query structure
    // We'll use a LEFT JOIN and check if the article is in the temp table OR matches import routes
    if (useCuratedTempTable && tempTableInfo) {
      // We'll use LEFT JOIN and add OR condition for temp table match
      // This is handled below in the FROM clause
      // Add condition here for temp table match
      scopeParts.push(`t.articleId IS NOT NULL`)
    }

    // If no scope parts at all (shouldn't happen due to early return), return empty
    if (scopeParts.length === 0 && !useCuratedTempTable) {
      return {data: [], totalCount: null, page: params.page, limit: params.limit, totalPages: null}
    }

    // Add scope filter to WHERE
    if (scopeParts.length > 0) {
      whereParts.push(`(${scopeParts.join(' OR ')})`)
    }

    // Build HAVING conditions for answer filters
    const havingParts: string[] = []

    if (params.prompts) {
      for (const [promptId, answeredValues] of Object.entries(params.prompts)) {
        if (!answeredValues || answeredValues.length === 0) continue

        const valuesQuoted = answeredValues
          .map((v) => {
            return `'${escapeClickHouseString(v)}'`
          })
          .join(', ')
        // Check if any judgment for this prompt has any of the required answers
        havingParts.push(
          `sumIf(1, promptId = '${promptId}' AND hasAny(answeredOriginalAsArray, [${valuesQuoted}])) > 0`,
        )
      }
    }

    // Build the query
    const whereClause = whereParts.join(' AND ')
    const havingClause = havingParts.length > 0 ? `HAVING ${havingParts.join(' AND ')}` : ''

    // Query to get article IDs with aggregated data
    // Note: We use different aliases (title_, created_, updated_) to avoid conflicts with WHERE clause
    // When using temp table for curated articles, we add a LEFT JOIN (to allow OR with import routes)
    const tempTableName = tempTableInfo?.tableName ?? ''
    const useTempTableJoin = useCuratedTempTable && tempTableInfo !== null
    const fromClause = useTempTableJoin
      ? `judgments j LEFT JOIN ${tempTableName} t ON j.articleId = t.articleId`
      : 'judgments'

    const columnPrefix = useTempTableJoin ? 'j.' : ''

    const articlesQuery = `
      SELECT
        ${columnPrefix}articleId,
        any(${columnPrefix}articleTitle) AS title_,
        max(${columnPrefix}articleCreatedAt) AS created_,
        max(${columnPrefix}articleUpdatedAt) AS updated_,
        groupArray(${columnPrefix}promptId) AS promptIds
      FROM ${fromClause}
      WHERE ${whereClause}
      GROUP BY ${columnPrefix}articleId
      ${havingClause}
      ORDER BY created_ DESC NULLS LAST, ${columnPrefix}articleId ASC
      LIMIT ${params.limit}
      OFFSET ${offset}
    `

    console.log('[ClickHouse] Articles query:', articlesQuery)
    console.time('ch:articles_query')

    const articlesResult = await client.query({query: articlesQuery, format: 'JSONEachRow'})

    const articlesData = await articlesResult.json<{
      articleId: string
      title_: string
      created_: string | null
      updated_: string | null
      promptIds: string[]
    }>()

    console.timeEnd('ch:articles_query')
    console.log(`[ClickHouse] Found ${articlesData.length} articles`)

    if (articlesData.length === 0) {
      return {data: [], totalCount: null, page: params.page, limit: params.limit, totalPages: null}
    }

    // Fetch full judgment data for these articles
    const articleIds = articlesData.map((a) => {
      return a.articleId
    })
    const articleIdsQuoted = articleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')

    // Fetch full judgment data for the paginated articles
    const judgmentsQuery = `
      SELECT
        id,
        createdAt,
        deletedAt,
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
        answeredOriginal,
        answeredOriginalAsArray,
        explanation,
        quotes
      FROM judgments
      WHERE articleId IN (${articleIdsQuoted})
        AND promptId IN (${promptIdsQuoted})
      ORDER BY articleId, createdAt DESC
    `

    console.time('ch:judgments_query')
    const judgmentsResult = await client.query({query: judgmentsQuery, format: 'JSONEachRow'})

    const judgmentsData = await judgmentsResult.json<ClickHouseJudgmentRow>()
    console.timeEnd('ch:judgments_query')
    console.log(`[ClickHouse] Fetched ${judgmentsData.length} judgments`)

    // Group judgments by articleId
    const judgmentsByArticle = new Map<string, ClickHouseJudgmentRow[]>()
    for (const j of judgmentsData) {
      const existing = judgmentsByArticle.get(j.articleId) ?? []
      existing.push(j)
      judgmentsByArticle.set(j.articleId, existing)
    }

    // Build final results, preserving the order from articlesData
    const results: ArticleReviewResult[] = articlesData.map((article) => {
      const judgments = judgmentsByArticle.get(article.articleId) ?? []

      // Sort judgments by prompt order
      const sortedJudgments = [...judgments].sort((a, b) => {
        const ao = metadata.promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
        const bo = metadata.promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
        return ao - bo
      })

      const judgedPromptIds = [
        ...new Set(
          sortedJudgments.map((j) => {
            return j.promptId
          }),
        ),
      ]
      const isFullyJudged = judgedPromptIds.length === metadata.promptIds.length

      return {
        id: article.articleId,
        articleTitle: article.title_,
        articleCreatedAt: article.created_ ? new Date(article.created_) : null,
        articleUpdatedAt: article.updated_ ? new Date(article.updated_) : null,
        judgments: sortedJudgments,
        judgedPromptIds,
        isFullyJudged,
      }
    })

    const elapsed = performance.now() - startTime
    console.log(`[ClickHouse] Total query time: ${elapsed.toFixed(0)}ms`)

    return {
      data: results,
      totalCount: null, // Count requires a separate query, not included here
      page: params.page,
      limit: params.limit,
      totalPages: null,
    }
  } finally {
    // Always clean up temp table
    if (tempTableInfo) {
      await tempTableInfo.cleanup()
    }
  }
}

/**
 * Count input parameters (subset of articles query params)
 */
export interface ArticlesReviewsCountParams {
  projectId: string
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  /** Map of promptId -> array of required answer values */
  prompts?: Record<string, string[]>
}

/**
 * Count response
 */
export interface ArticlesReviewsCountResponse {
  totalCount: number
  totalPages: number
  error?: string
}

/**
 * Counts articles matching the filters from ClickHouse.
 *
 * Uses the same filtering logic as queryArticlesReviewsFromClickHouse
 * but only returns the count for efficiency.
 *
 * Expected performance: 1-3 seconds for ~25M rows
 */
export const countArticlesReviewsFromClickHouse = async (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  const startTime = performance.now()
  const client = getClickhouseClient()

  try {
    // Fetch metadata from PostgreSQL
    console.time('ch:count:metadata')
    const metadata = await fetchProjectMetadataForClickHouse(params.projectId)
    console.timeEnd('ch:count:metadata')

    if (metadata.promptIds.length === 0) {
      return {totalCount: 0, totalPages: 0}
    }

    // Check if we have any scope defined
    const hasImportRoutes = metadata.routeTexts.length > 0
    const hasCuratedArticles = metadata.curatedArticleIds.length > 0

    if (!hasImportRoutes && !hasCuratedArticles) {
      console.log('[ClickHouse Count] No scope defined, returning 0')
      return {totalCount: 0, totalPages: 0}
    }

    // Determine if we need a temp table for curated articles
    // Use temp table whenever curated articles exceed threshold, regardless of import routes
    const useCuratedTempTable = metadata.curatedArticleIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD

    let tempTableInfo: {tableName: string; cleanup: () => Promise<void>} | null = null

    try {
      // Create temp table if needed for curated articles
      if (useCuratedTempTable && hasCuratedArticles) {
        tempTableInfo = await createCuratedArticlesTempTable(metadata.curatedArticleIds)
      }

      // Build WHERE conditions (same as articles query)
      const whereParts: string[] = []

      // Prompt filter
      const promptIdsQuoted = metadata.promptIds
        .map((id) => {
          return `'${id}'`
        })
        .join(', ')
      whereParts.push(`promptId IN (${promptIdsQuoted})`)

      // Model filter
      if (metadata.modelId) {
        whereParts.push(`modelId = '${escapeClickHouseString(metadata.modelId)}'`)
      }

      // Date bounds
      const effectiveFromDate =
        metadata.projectBounds?.dateFrom && params.from
          ? metadata.projectBounds.dateFrom > new Date(`${params.from}T00:00:00.000Z`)
            ? metadata.projectBounds.dateFrom
            : new Date(`${params.from}T00:00:00.000Z`)
          : (metadata.projectBounds?.dateFrom ?? (params.from ? new Date(`${params.from}T00:00:00.000Z`) : null))

      const effectiveToDate =
        metadata.projectBounds?.dateTo && params.to
          ? metadata.projectBounds.dateTo < new Date(`${params.to}T23:59:59.999Z`)
            ? metadata.projectBounds.dateTo
            : new Date(`${params.to}T23:59:59.999Z`)
          : (metadata.projectBounds?.dateTo ?? (params.to ? new Date(`${params.to}T23:59:59.999Z`) : null))

      if (effectiveFromDate) {
        whereParts.push(`articleCreatedAt >= toDateTime64('${formatDateForClickHouse(effectiveFromDate)}', 3)`)
      }
      if (effectiveToDate) {
        whereParts.push(`articleCreatedAt <= toDateTime64('${formatDateForClickHouse(effectiveToDate)}', 3)`)
      }

      // Search filter
      if (params.search && params.search.trim()) {
        const searchEscaped = escapeClickHouseString(params.search.trim())
        whereParts.push(`articleTitle ILIKE '%${searchEscaped}%'`)
      }

      // Scope filter: import routes OR curated articles
      // Same logic as articles query
      const scopeParts: string[] = []

      // Import routes always use IN clause
      if (hasImportRoutes) {
        const routesQuoted = metadata.routeTexts
          .map((r) => {
            return `'${escapeClickHouseString(r)}'`
          })
          .join(', ')
        scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
      }

      // Curated articles: IN clause if small, handled via JOIN if large
      if (hasCuratedArticles && !useCuratedTempTable) {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${id}'`
          })
          .join(', ')
        scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
      }

      // If using temp table for curated articles
      if (useCuratedTempTable && tempTableInfo) {
        scopeParts.push(`t.articleId IS NOT NULL`)
      }

      // Add scope filter to WHERE
      if (scopeParts.length > 0) {
        whereParts.push(`(${scopeParts.join(' OR ')})`)
      }

      // Build HAVING conditions for answer filters
      const havingParts: string[] = []

      if (params.prompts) {
        for (const [promptId, answeredValues] of Object.entries(params.prompts)) {
          if (!answeredValues || answeredValues.length === 0) continue

          const valuesQuoted = answeredValues
            .map((v) => {
              return `'${escapeClickHouseString(v)}'`
            })
            .join(', ')
          havingParts.push(
            `sumIf(1, promptId = '${promptId}' AND hasAny(answeredOriginalAsArray, [${valuesQuoted}])) > 0`,
          )
        }
      }

      // Build the count query
      const whereClause = whereParts.join(' AND ')
      const havingClause = havingParts.length > 0 ? `HAVING ${havingParts.join(' AND ')}` : ''

      const tempTableName = tempTableInfo?.tableName ?? ''
      const useTempTableJoin = useCuratedTempTable && tempTableInfo !== null
      const fromClause = useTempTableJoin
        ? `judgments j LEFT JOIN ${tempTableName} t ON j.articleId = t.articleId`
        : 'judgments'

      const columnPrefix = useTempTableJoin ? 'j.' : ''

      // Count distinct articles (using subquery)
      const countQuery = `
        SELECT COUNT(*) as totalCount
        FROM (
          SELECT ${columnPrefix}articleId
          FROM ${fromClause}
          WHERE ${whereClause}
          GROUP BY ${columnPrefix}articleId
          ${havingClause}
        ) subquery
      `

      console.log('[ClickHouse Count] Query:', countQuery.trim().substring(0, 500) + '...')
      console.time('ch:count:query')

      const result = await client.query({query: countQuery, format: 'JSONEachRow'})
      const data = await result.json<{totalCount: string}>()

      console.timeEnd('ch:count:query')

      const totalCount = parseInt(data[0]?.totalCount ?? '0', 10)
      const totalPages = Math.ceil(totalCount / params.limit)

      const elapsed = performance.now() - startTime
      console.log(`[ClickHouse Count] ${totalCount.toLocaleString()} articles in ${elapsed.toFixed(0)}ms`)

      return {totalCount, totalPages}
    } finally {
      // Always clean up temp table
      if (tempTableInfo) {
        await tempTableInfo.cleanup()
      }
    }
  } catch (error) {
    console.error('[ClickHouse Count] Error:', error)
    return {totalCount: 0, totalPages: 0, error: error instanceof Error ? error.message : 'Unknown error'}
  }
}
