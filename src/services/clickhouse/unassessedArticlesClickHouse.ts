/**
 * ClickHouse-based unassessed articles queries.
 *
 * Uses `forska.judgments` for consistency with articlesReviewsClickHouse.ts.
 * Scope is determined via PostgreSQL metadata (project_articles, import routes).
 * Uses temp tables for large curated article sets to avoid query size limits.
 */
import {and, eq} from 'drizzle-orm'

import {importRoute, projectArticles, projectPrompts, projectRouteLink, projects} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'
import {parseClickhouseDateTimeUtc} from './parseClickhouseDateTimeUtc.ts'

const CURATED_ARTICLES_TEMP_TABLE_THRESHOLD = 1000
const TEMP_TABLE_INSERT_BATCH_SIZE = 10000

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

type TempTableInfo = {tableName: string; cleanup: () => Promise<void>}

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

const createTempTable = async (curatedArticleIds: string[]): Promise<TempTableInfo> => {
  const client = getClickhouseClient()
  const tableName = `temp_unassessed_${Date.now()}_${Math.random().toString(36).substring(7)}`

  await client.command({query: `CREATE TABLE ${tableName} (articleId String) ENGINE = Memory`})

  for (let i = 0; i < curatedArticleIds.length; i += TEMP_TABLE_INSERT_BATCH_SIZE) {
    const batch = curatedArticleIds.slice(i, i + TEMP_TABLE_INSERT_BATCH_SIZE).map((id) => {
      return {articleId: id}
    })
    await client.insert({table: tableName, values: batch, format: 'JSONEachRow'})
  }

  console.log(`[CH] Created temp table ${tableName} with ${curatedArticleIds.length} IDs`)

  const cleanup = async () => {
    try {
      await client.command({query: `DROP TABLE IF EXISTS ${tableName}`})
    } catch (error) {
      console.error(`[CH] Failed to drop temp table ${tableName}:`, error)
    }
  }

  return {tableName, cleanup}
}

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

const buildJudgmentFilters = (
  promptIds: string[],
  modelId: string,
  useTitle: boolean,
  useAbstract: boolean,
  useFulltext: boolean,
  useFulltextNoImages: boolean,
): string[] => {
  const filters: string[] = []
  filters.push('_peerdb_is_deleted = 0')

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

  return filters
}

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

  const hasRoutes = metadata.routeTexts.length > 0
  const hasCurated = metadata.curatedArticleIds.length > 0
  if (!hasRoutes && !hasCurated) {
    console.timeEnd('ch:unassessed_count')
    console.log('[CH] No scope defined - returning 0')
    return 0
  }

  const useTempTable = hasCurated && metadata.curatedArticleIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD
  let tempTableInfo: TempTableInfo | null = null

  try {
    if (useTempTable) {
      tempTableInfo = await createTempTable(metadata.curatedArticleIds)
    }

    const judgmentFilters = buildJudgmentFilters(
      metadata.promptIds,
      projectModelId,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
    )
    const dateFilters = buildDateFilters(projectDateFrom, projectDateTo)

    // Build scope filter for judgments table (camelCase)
    const judgmentScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        judgmentScopeParts.push(`articleId IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        judgmentScopeParts.push(`articleId IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      judgmentScopeParts.push(`articleImportRoute IN (${routesQuoted})`)
    }
    const judgmentScopeFilter = `(${judgmentScopeParts.join(' OR ')})`

    const allJudgmentFilters = [...judgmentFilters, judgmentScopeFilter, ...dateFilters]
    const judgmentWhereClause = allJudgmentFilters.join(' AND ')

    // Build scope filter for forska.articles (snake_case)
    const articleScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        articleScopeParts.push(`id IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        articleScopeParts.push(`id IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      articleScopeParts.push(`import_route IN (${routesQuoted})`)
    }
    const articleScopeFilter = `(${articleScopeParts.join(' OR ')})`

    const articleDateFilters = dateFilters.map((f) => {
      return f.replace('articleCreatedAt', 'article_created_at')
    })
    const articleWhereClause = [articleScopeFilter, ...articleDateFilters].join(' AND ')

    const totalScopedQuery = `
      SELECT COUNT(DISTINCT id) as total
      FROM forska.articles FINAL
      WHERE _peerdb_is_deleted = 0 AND ${articleWhereClause}
    `

    const assessedQuery = `
      SELECT COUNT(*) as assessed
      FROM (
        SELECT articleId
        FROM judgments FINAL
        WHERE ${judgmentWhereClause}
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
  } finally {
    if (tempTableInfo) {
      await tempTableInfo.cleanup()
    }
  }
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

  const hasRoutes = metadata.routeTexts.length > 0
  const hasCurated = metadata.curatedArticleIds.length > 0
  if (!hasRoutes && !hasCurated) {
    console.timeEnd('ch:unassessed_articles')
    console.log('[CH] No scope defined - returning empty')
    return {articles: [], totalCount: 0}
  }

  const useTempTable = hasCurated && metadata.curatedArticleIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD
  let tempTableInfo: TempTableInfo | null = null

  try {
    if (useTempTable) {
      tempTableInfo = await createTempTable(metadata.curatedArticleIds)
    }

    const judgmentFilters = buildJudgmentFilters(
      metadata.promptIds,
      projectModelId,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
    )
    const dateFilters = buildDateFilters(projectDateFrom, projectDateTo)

    // Build scope filter for judgments table (camelCase)
    const judgmentScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        judgmentScopeParts.push(`articleId IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        judgmentScopeParts.push(`articleId IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      judgmentScopeParts.push(`articleImportRoute IN (${routesQuoted})`)
    }
    const judgmentScopeFilter = `(${judgmentScopeParts.join(' OR ')})`

    const allJudgmentFilters = [...judgmentFilters, judgmentScopeFilter, ...dateFilters]
    const judgmentWhereClause = allJudgmentFilters.join(' AND ')

    // Build scope filter for forska.articles (snake_case)
    const articleScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        articleScopeParts.push(`id IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        articleScopeParts.push(`id IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      articleScopeParts.push(`import_route IN (${routesQuoted})`)
    }
    const articleScopeFilter = `(${articleScopeParts.join(' OR ')})`

    const articleDateFilters = dateFilters.map((f) => {
      return f.replace('articleCreatedAt', 'article_created_at')
    })
    const searchFilter = search?.trim() ? `article_title ILIKE '%${escapeClickHouseString(search.trim())}%'` : null
    const articleWhereClause = [articleScopeFilter, ...articleDateFilters, searchFilter].filter(Boolean).join(' AND ')

    const assessedSubquery = `
      SELECT articleId
      FROM judgments FINAL
      WHERE ${judgmentWhereClause}
      GROUP BY articleId
      HAVING COUNT(DISTINCT promptId) = ${metadata.promptIds.length}
    `

    const countQuery = `
      SELECT COUNT(*) as total_count
      FROM forska.articles a FINAL
      WHERE a._peerdb_is_deleted = 0 AND ${articleWhereClause}
        AND a.id NOT IN (${assessedSubquery})
    `

    const articlesQuery = `
      SELECT
        a.id,
        a.article_id,
	        a.article_title,
	        a.article_created_at,
	        a.article_updated_at
	      FROM forska.articles a FINAL
	      WHERE a._peerdb_is_deleted = 0 AND ${articleWhereClause}
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
        articleCreatedAt: parseClickhouseDateTimeUtc(row.article_created_at),
        articleUpdatedAt: parseClickhouseDateTimeUtc(row.article_updated_at),
      }
    })

    console.log(`[CH] Found ${articles.length} unassessed articles (total: ${totalCount})`)
    return {articles, totalCount}
  } finally {
    if (tempTableInfo) {
      await tempTableInfo.cleanup()
    }
  }
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
  const lastDate = lastRow ? parseClickhouseDateTimeUtc(lastRow.sort_date) : null
  return lastRow && lastDate ? {lastDate, lastArticleId: lastRow.article_id} : null
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

  const hasRoutes = metadata.routeTexts.length > 0
  const hasCurated = metadata.curatedArticleIds.length > 0
  if (!hasRoutes && !hasCurated) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] No scope defined - returning empty')
    return {promptEntries: [], nextCursor: null}
  }

  const useTempTable = hasCurated && metadata.curatedArticleIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD
  let tempTableInfo: TempTableInfo | null = null

  try {
    if (useTempTable) {
      tempTableInfo = await createTempTable(metadata.curatedArticleIds)
    }

    const judgmentFilters = buildJudgmentFilters(
      metadata.promptIds,
      metadata.modelId,
      metadata.useTitle,
      metadata.useAbstract,
      metadata.useFulltext,
      metadata.useFulltextNoImages,
    )
    const dateFilters = buildDateFilters(metadata.dateFrom, metadata.dateTo)

    // Build scope filter for judgments table (camelCase)
    const judgmentScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        judgmentScopeParts.push(`articleId IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        judgmentScopeParts.push(`articleId IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      judgmentScopeParts.push(`articleImportRoute IN (${routesQuoted})`)
    }
    const judgmentScopeFilter = `(${judgmentScopeParts.join(' OR ')})`

    const judgmentWhereClause = [...judgmentFilters, judgmentScopeFilter].join(' AND ')

    // Build scope filter for forska.articles (snake_case)
    const articleScopeParts: string[] = []
    if (hasCurated) {
      if (useTempTable && tempTableInfo) {
        articleScopeParts.push(`id IN (SELECT articleId FROM ${tempTableInfo.tableName})`)
      } else {
        const curatedIdsQuoted = metadata.curatedArticleIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')
        articleScopeParts.push(`id IN (${curatedIdsQuoted})`)
      }
    }
    if (hasRoutes) {
      const routesQuoted = metadata.routeTexts
        .map((r) => {
          return `'${escapeClickHouseString(r)}'`
        })
        .join(', ')
      articleScopeParts.push(`import_route IN (${routesQuoted})`)
    }
    const articleScopeFilter = `(${articleScopeParts.join(' OR ')})`

    const articleDateFilters = dateFilters.map((f) => {
      return f.replace('articleCreatedAt', 'article_created_at')
    })
    const articleWhereClause = [articleScopeFilter, ...articleDateFilters].join(' AND ')

    const cursorCondition = buildCursorCondition(cursor)

    const promptIdsQuoted = metadata.promptIds
      .map((id) => {
        return `'${escapeClickHouseString(id)}'`
      })
      .join(', ')

    const assessedPairsSubquery = `
      SELECT articleId, promptId
      FROM judgments FINAL
      WHERE ${judgmentWhereClause}
    `

    const query = `
      SELECT
	        a.id AS article_id,
	        p.promptId AS prompt_id,
	        COALESCE(a.article_updated_at, a.article_created_at, a.created_at) AS sort_date
	      FROM forska.articles a FINAL
	      CROSS JOIN (
	        SELECT arrayJoin([${promptIdsQuoted}]) AS promptId
	      ) p
	      WHERE a._peerdb_is_deleted = 0 AND ${articleWhereClause}
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
  } finally {
    if (tempTableInfo) {
      await tempTableInfo.cleanup()
    }
  }
}
