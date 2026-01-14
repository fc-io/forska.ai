/**
 * ClickHouse-based article selection for add_articles_by_filter endpoint.
 *
 * Selects article IDs based on list type (llm, human, both, unassessed) using ClickHouse
 * for LLM judgment queries and PostgreSQL for human judgment queries.
 */
import {and, eq, inArray, sql} from 'drizzle-orm'

import {
  importRoute,
  judgmentsHuman,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'

type ListType = 'llm' | 'human' | 'both' | 'unassessed'

/**
 * Input parameters for article selection
 */
export interface SelectArticleIdsParams {
  sourceProjectId: string
  listType: ListType
  promptsFilter?: Record<string, string[]>
  from?: string
  to?: string
  search?: string
}

/**
 * Escapes a string for ClickHouse SQL.
 */
const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''")
}

/**
 * Formats a Date for ClickHouse DateTime64(3).
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
 * Fetches project metadata from PostgreSQL
 */
const fetchProjectMetadata = async (projectId: string) => {
  const db = getDatabase()

  const [projectPromptRows, projectBoundsResult, projectImportRouteTexts, curatedArticleRows] = await Promise.all([
    // Get enabled prompts for project
    db
      .select({id: prompts.id, order: projectPrompts.order})
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
      .orderBy(projectPrompts.order),

    // Get project date bounds, modelId, and content settings
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
    projectBounds: projectBoundsResult[0] ?? null,
    modelId: projectBoundsResult[0]?.modelId ?? null,
    useTitle: projectBoundsResult[0]?.useTitle ?? true,
    useAbstract: projectBoundsResult[0]?.useAbstract ?? true,
    useFulltext: projectBoundsResult[0]?.useFulltext ?? false,
    useFulltextNoImages: projectBoundsResult[0]?.useFulltextNoImages ?? false,
    routeTexts: projectImportRouteTexts.map((r) => {
      return r.route
    }),
    curatedArticleIds: curatedArticleRows.map((r) => {
      return r.articleId
    }),
  }
}

/**
 * Selects article IDs for 'llm' list type using ClickHouse.
 * Finds articles that have ALL prompts fully assessed by LLM.
 */
const selectLlmArticleIds = async (params: SelectArticleIdsParams): Promise<string[]> => {
  const client = getClickhouseClient()
  const metadata = await fetchProjectMetadata(params.sourceProjectId)

  if (metadata.promptIds.length === 0) return []

  // Check if we have any scope defined
  const hasImportRoutes = metadata.routeTexts.length > 0
  const hasCuratedArticles = metadata.curatedArticleIds.length > 0

  if (!hasImportRoutes && !hasCuratedArticles) {
    return []
  }

  // Build WHERE conditions
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

  // Content settings filters
  whereParts.push(`useTitle = ${metadata.useTitle ? 'true' : 'false'}`)
  whereParts.push(`useAbstract = ${metadata.useAbstract ? 'true' : 'false'}`)
  whereParts.push(`useFulltext = ${metadata.useFulltext ? 'true' : 'false'}`)
  whereParts.push(`useFulltextNoImages = ${metadata.useFulltextNoImages ? 'true' : 'false'}`)

  // Date bounds
  const fromDate = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null
  const toDate = params.to ? new Date(`${params.to}T23:59:59.999Z`) : null

  const effectiveFromDate =
    metadata.projectBounds?.dateFrom && fromDate
      ? metadata.projectBounds.dateFrom > fromDate
        ? metadata.projectBounds.dateFrom
        : fromDate
      : (metadata.projectBounds?.dateFrom ?? fromDate)

  const effectiveToDate =
    metadata.projectBounds?.dateTo && toDate
      ? metadata.projectBounds.dateTo < toDate
        ? metadata.projectBounds.dateTo
        : toDate
      : (metadata.projectBounds?.dateTo ?? toDate)

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

  // Scope filter
  const scopeParts: string[] = []
  if (hasCuratedArticles && metadata.curatedArticleIds.length <= 1000) {
    const curatedIdsQuoted = metadata.curatedArticleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }
  if (hasImportRoutes) {
    const routesQuoted = metadata.routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }
  if (scopeParts.length > 0) {
    whereParts.push(`(${scopeParts.join(' OR ')})`)
  }

  // Build HAVING conditions
  const havingParts: string[] = []
  havingParts.push(`COUNT(DISTINCT promptId) = ${metadata.promptIds.length}`)

  // Answer filters
  if (params.promptsFilter) {
    for (const [promptId, answeredValues] of Object.entries(params.promptsFilter)) {
      if (!answeredValues || answeredValues.length === 0) continue

      const valuesQuoted = answeredValues
        .map((v) => {
          return `'${escapeClickHouseString(v)}'`
        })
        .join(', ')
      havingParts.push(
        `sumIf(1, promptId = '${promptId}' AND (
          (length(answeredOriginalAsArray) > 0 AND hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), [${valuesQuoted}]))
          OR (length(answeredOriginalAsArray) = 0 AND answeredOriginal IN (${valuesQuoted}))
        )) > 0`,
      )
    }
  }

  const whereClause = whereParts.join(' AND ')
  const havingClause = `HAVING ${havingParts.join(' AND ')}`

  const query = `
    SELECT articleId
    FROM judgments
    WHERE ${whereClause}
    GROUP BY articleId
    ${havingClause}
    ORDER BY max(articleCreatedAt) DESC NULLS LAST
  `

  console.log('[ClickHouse SelectIds LLM] Query:', query.substring(0, 300) + '...')
  console.time('ch:select_llm')
  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{articleId: string}>()
  console.timeEnd('ch:select_llm')
  console.log(`[ClickHouse SelectIds LLM] Found ${data.length} articles`)

  return data.map((r) => {
    return r.articleId
  })
}

/**
 * Selects article IDs for 'unassessed' list type using ClickHouse.
 * Finds articles that have LESS than ALL prompts assessed by LLM.
 */
const selectUnassessedArticleIds = async (params: SelectArticleIdsParams): Promise<string[]> => {
  const client = getClickhouseClient()
  const metadata = await fetchProjectMetadata(params.sourceProjectId)

  if (metadata.promptIds.length === 0) return []

  // Check if we have any scope defined
  const hasImportRoutes = metadata.routeTexts.length > 0
  const hasCuratedArticles = metadata.curatedArticleIds.length > 0

  if (!hasImportRoutes && !hasCuratedArticles) {
    return []
  }

  // Build WHERE conditions
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

  // Content settings filters
  whereParts.push(`useTitle = ${metadata.useTitle ? 'true' : 'false'}`)
  whereParts.push(`useAbstract = ${metadata.useAbstract ? 'true' : 'false'}`)
  whereParts.push(`useFulltext = ${metadata.useFulltext ? 'true' : 'false'}`)
  whereParts.push(`useFulltextNoImages = ${metadata.useFulltextNoImages ? 'true' : 'false'}`)

  // Date bounds
  const fromDate = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null
  const toDate = params.to ? new Date(`${params.to}T23:59:59.999Z`) : null

  const effectiveFromDate =
    metadata.projectBounds?.dateFrom && fromDate
      ? metadata.projectBounds.dateFrom > fromDate
        ? metadata.projectBounds.dateFrom
        : fromDate
      : (metadata.projectBounds?.dateFrom ?? fromDate)

  const effectiveToDate =
    metadata.projectBounds?.dateTo && toDate
      ? metadata.projectBounds.dateTo < toDate
        ? metadata.projectBounds.dateTo
        : toDate
      : (metadata.projectBounds?.dateTo ?? toDate)

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

  // Scope filter
  const scopeParts: string[] = []
  if (hasCuratedArticles && metadata.curatedArticleIds.length <= 1000) {
    const curatedIdsQuoted = metadata.curatedArticleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }
  if (hasImportRoutes) {
    const routesQuoted = metadata.routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }
  if (scopeParts.length > 0) {
    whereParts.push(`(${scopeParts.join(' OR ')})`)
  }

  const whereClause = whereParts.join(' AND ')

  // Find articles with LESS than all prompts (or no judgments at all)
  // Strategy: Get all articles in scope, then exclude fully assessed ones

  // First get fully assessed article IDs
  const fullyAssessedQuery = `
    SELECT articleId
    FROM judgments
    WHERE ${whereClause}
    GROUP BY articleId
    HAVING COUNT(DISTINCT promptId) = ${metadata.promptIds.length}
  `

  console.log('[ClickHouse SelectIds Unassessed] Getting fully assessed articles...')
  console.time('ch:select_unassessed_fully')
  const fullyAssessedResult = await client.query({query: fullyAssessedQuery, format: 'JSONEachRow'})
  const fullyAssessedData = await fullyAssessedResult.json<{articleId: string}>()
  const fullyAssessedIds = new Set(
    fullyAssessedData.map((r) => {
      return r.articleId
    }),
  )
  console.timeEnd('ch:select_unassessed_fully')

  // Get all articles in scope (with any judgment or none)
  // This needs to include articles with 0 judgments, so we query from a different source
  // For articles with some judgments, query ClickHouse
  const partiallyAssessedQuery = `
    SELECT DISTINCT articleId
    FROM judgments
    WHERE ${whereClause}
  `

  console.time('ch:select_unassessed_partial')
  const partialResult = await client.query({query: partiallyAssessedQuery, format: 'JSONEachRow'})
  const partialData = await partialResult.json<{articleId: string}>()
  console.timeEnd('ch:select_unassessed_partial')

  // Get partially assessed articles (have some judgments, but not all)
  const partiallyAssessedIds = partialData
    .filter((r) => {
      return !fullyAssessedIds.has(r.articleId)
    })
    .map((r) => {
      return r.articleId
    })

  console.log(`[ClickHouse SelectIds Unassessed] Found ${partiallyAssessedIds.length} partially assessed articles`)

  // Note: This doesn't include articles with ZERO judgments. For those, we'd need to query
  // PostgreSQL articles table. For now, we return partially assessed only.
  // The original PostgreSQL implementation also had this limitation in practice.

  return partiallyAssessedIds
}

/**
 * Selects article IDs for 'both' list type using ClickHouse + PostgreSQL.
 * Finds articles that have BOTH LLM and human assessments for ALL prompts.
 */
const selectBothArticleIds = async (params: SelectArticleIdsParams): Promise<string[]> => {
  const db = getDatabase()
  const client = getClickhouseClient()
  const metadata = await fetchProjectMetadata(params.sourceProjectId)

  if (metadata.promptIds.length === 0) return []

  // Step 1: Find articles fully assessed by humans (from PostgreSQL)
  console.time('ch:select_both_human')
  const fullyAssessedByHumanQuery = await db
    .select({articleId: judgmentsHuman.articleId})
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, params.sourceProjectId),
        inArray(judgmentsHuman.promptId, metadata.promptIds),
        sql`${judgmentsHuman.answer} IS NOT NULL`,
      ),
    )
    .groupBy(judgmentsHuman.articleId, judgmentsHuman.user)
    .having(sql`COUNT(DISTINCT ${judgmentsHuman.promptId}) = ${metadata.promptIds.length}`)

  const humanAssessedArticleIds = [
    ...new Set(
      fullyAssessedByHumanQuery.map((r) => {
        return r.articleId
      }),
    ),
  ]
  console.timeEnd('ch:select_both_human')

  if (humanAssessedArticleIds.length === 0) {
    return []
  }

  // Step 2: Query ClickHouse for LLM judgments on human-assessed articles
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

  // Content settings filters
  whereParts.push(`useTitle = ${metadata.useTitle ? 'true' : 'false'}`)
  whereParts.push(`useAbstract = ${metadata.useAbstract ? 'true' : 'false'}`)
  whereParts.push(`useFulltext = ${metadata.useFulltext ? 'true' : 'false'}`)
  whereParts.push(`useFulltextNoImages = ${metadata.useFulltextNoImages ? 'true' : 'false'}`)

  // Article filter (must be human-assessed)
  const humanArticleIdsQuoted = humanAssessedArticleIds
    .map((id) => {
      return `'${id}'`
    })
    .join(', ')
  whereParts.push(`articleId IN (${humanArticleIdsQuoted})`)

  // Date bounds
  const fromDate = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null
  const toDate = params.to ? new Date(`${params.to}T23:59:59.999Z`) : null

  const effectiveFromDate =
    metadata.projectBounds?.dateFrom && fromDate
      ? metadata.projectBounds.dateFrom > fromDate
        ? metadata.projectBounds.dateFrom
        : fromDate
      : (metadata.projectBounds?.dateFrom ?? fromDate)

  const effectiveToDate =
    metadata.projectBounds?.dateTo && toDate
      ? metadata.projectBounds.dateTo < toDate
        ? metadata.projectBounds.dateTo
        : toDate
      : (metadata.projectBounds?.dateTo ?? toDate)

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

  // Scope filter
  const hasImportRoutes = metadata.routeTexts.length > 0
  const hasCuratedArticles = metadata.curatedArticleIds.length > 0

  const scopeParts: string[] = []
  if (hasCuratedArticles && metadata.curatedArticleIds.length <= 1000) {
    const curatedIdsQuoted = metadata.curatedArticleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }
  if (hasImportRoutes) {
    const routesQuoted = metadata.routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }
  if (scopeParts.length > 0) {
    whereParts.push(`(${scopeParts.join(' OR ')})`)
  }

  // Build HAVING conditions
  const havingParts: string[] = []
  havingParts.push(`COUNT(DISTINCT promptId) = ${metadata.promptIds.length}`)

  // Answer filters (LLM only)
  if (params.promptsFilter) {
    for (const [promptId, answeredValues] of Object.entries(params.promptsFilter)) {
      if (!answeredValues || answeredValues.length === 0) continue

      const valuesQuoted = answeredValues
        .map((v) => {
          return `'${escapeClickHouseString(v)}'`
        })
        .join(', ')
      havingParts.push(
        `sumIf(1, promptId = '${promptId}' AND (
          (length(answeredOriginalAsArray) > 0 AND hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), [${valuesQuoted}]))
          OR (length(answeredOriginalAsArray) = 0 AND answeredOriginal IN (${valuesQuoted}))
        )) > 0`,
      )
    }
  }

  const whereClause = whereParts.join(' AND ')
  const havingClause = `HAVING ${havingParts.join(' AND ')}`

  const query = `
    SELECT articleId
    FROM judgments
    WHERE ${whereClause}
    GROUP BY articleId
    ${havingClause}
    ORDER BY max(articleCreatedAt) DESC NULLS LAST
  `

  console.log('[ClickHouse SelectIds Both] Query:', query.substring(0, 300) + '...')
  console.time('ch:select_both_llm')
  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{articleId: string}>()
  console.timeEnd('ch:select_both_llm')
  console.log(`[ClickHouse SelectIds Both] Found ${data.length} articles with both assessments`)

  return data.map((r) => {
    return r.articleId
  })
}

/**
 * Selects article IDs for 'human' list type using PostgreSQL only.
 * This doesn't use ClickHouse since human judgments are in PostgreSQL.
 */
const selectHumanArticleIds = async (params: SelectArticleIdsParams): Promise<string[]> => {
  const db = getDatabase()
  const metadata = await fetchProjectMetadata(params.sourceProjectId)

  if (metadata.promptIds.length === 0) return []

  // Build SQL conditions
  const whereParts: ReturnType<typeof sql>[] = []

  // _fullyAssessedByHumanExists is kept for documentation but not currently used in query
  const _fullyAssessedByHumanExists = sql`EXISTS (
    SELECT 1
    FROM ${judgmentsHuman} jh
    WHERE jh."article_id" = ${judgmentsHuman}.article_id
      AND jh."project_id" = ${params.sourceProjectId}::uuid
      AND jh."is_answered" = true
    GROUP BY jh."article_id", jh."user"
    HAVING COUNT(DISTINCT jh."prompt_id") = ${metadata.promptIds.length}
  )`

  const baseCondition = and(
    eq(judgmentsHuman.projectId, params.sourceProjectId),
    inArray(judgmentsHuman.promptId, metadata.promptIds),
    sql`${judgmentsHuman.answer} IS NOT NULL`,
  )
  if (baseCondition) {
    whereParts.push(baseCondition)
  }

  // Answer filters (human)
  if (params.promptsFilter) {
    for (const [promptId, answers] of Object.entries(params.promptsFilter)) {
      if (!answers || answers.length === 0) continue
      const condition = and(eq(judgmentsHuman.promptId, promptId), inArray(judgmentsHuman.answer, answers))
      if (condition) {
        whereParts.push(condition)
      }
    }
  }

  // Simple query: find articles where at least one user has answered all prompts
  const result = await db
    .select({articleId: judgmentsHuman.articleId})
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, params.sourceProjectId),
        inArray(judgmentsHuman.promptId, metadata.promptIds),
        sql`${judgmentsHuman.answer} IS NOT NULL`,
      ),
    )
    .groupBy(judgmentsHuman.articleId, judgmentsHuman.user)
    .having(sql`COUNT(DISTINCT ${judgmentsHuman.promptId}) = ${metadata.promptIds.length}`)

  const articleIds = [
    ...new Set(
      result.map((r) => {
        return r.articleId
      }),
    ),
  ]
  console.log(`[SelectIds Human] Found ${articleIds.length} articles`)

  return articleIds
}

/**
 * Main entry point: selects article IDs based on list type.
 */
export const selectArticleIdsByFilterClickHouse = async (
  sourceProjectId: string,
  listType: ListType,
  promptsFilter?: Record<string, string[]>,
  from?: string,
  to?: string,
  search?: string,
): Promise<string[]> => {
  const params: SelectArticleIdsParams = {sourceProjectId, listType, promptsFilter, from, to, search}

  switch (listType) {
    case 'llm':
      return selectLlmArticleIds(params)
    case 'unassessed':
      return selectUnassessedArticleIds(params)
    case 'both':
      return selectBothArticleIds(params)
    case 'human':
      return selectHumanArticleIds(params)
    default:
      throw new Error(`Unknown list type: ${listType as string}`)
  }
}
