import {and, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'

import {
  importRoute,
  judgments,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

/**
 * Input parameters for building the articles reviews query conditions
 */
export interface ArticlesReviewsQueryParams {
  projectId: string
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}

/**
 * Result from building the query conditions, containing all shared state
 * needed by both the data query and count query
 */
export interface ArticlesReviewsQueryContext {
  promptIds: string[]
  promptOrderMap: Record<string, number>
  combinedWhereCondition: ReturnType<typeof and>
  // undefined when no answer filters are applied (no HAVING needed)
  havingCondition: ReturnType<typeof and> | ReturnType<typeof sql> | undefined
}

/**
 * Fetches project metadata needed for query building (prompts, bounds, import routes)
 * Runs queries in parallel for better performance.
 */
export const fetchProjectMetadata = async (db: ReturnType<typeof getDatabase>, projectId: string) => {
  const [projectPromptRows, projectBoundsResult, projectImportRouteTexts] = await Promise.all([
    // Get enabled prompts for project
    db
      .select({id: prompts.id, order: projectPrompts.order})
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
      .orderBy(projectPrompts.order),

    // Get project date bounds
    db
      .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),

    // Get import routes as TEXT
    db
      .select({route: importRoute.route})
      .from(projectRouteLink)
      .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
      .where(eq(projectRouteLink.projectId, projectId)),
  ])

  return {
    projectPromptRows,
    projectBounds: projectBoundsResult[0] ?? null,
    routeTexts: projectImportRouteTexts.map((r) => {
      return r.route
    }),
  }
}

/**
 * Builds the WHERE and HAVING conditions for articles reviews queries.
 * This shared logic ensures both the main data query and count query
 * use identical filtering criteria.
 */
export const buildArticlesReviewsQueryContext = (
  params: ArticlesReviewsQueryParams,
  metadata: Awaited<ReturnType<typeof fetchProjectMetadata>>,
): ArticlesReviewsQueryContext | null => {
  const {projectPromptRows, projectBounds, routeTexts} = metadata

  if (projectPromptRows.length === 0) {
    return null
  }

  const promptIds = projectPromptRows.map((p) => {
    return p.id
  })
  const hasImportRoutes = routeTexts.length > 0

  // Parse dates
  const fromDate = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null
  const toDate = params.to ? new Date(`${params.to}T23:59:59.999Z`) : null
  const searchTitle = typeof params.search === 'string' ? params.search.trim() : ''

  // Parse prompt filters
  const promptFilters = Object.entries(params.prompts || {}).map(([key, values]) => {
    return [key, Array.isArray(values) ? values : [String(values)]] as const
  })

  // === BUILD WHERE CONDITIONS ===
  const whereParts: Array<ReturnType<typeof sql>> = [
    inArray(judgments.promptId, promptIds),
    // Note: deleted_at filter removed - soft deletes not currently used
  ]

  // Date filtering: use the most restrictive bounds
  const effectiveFromDate =
    projectBounds?.dateFrom && fromDate
      ? projectBounds.dateFrom > fromDate
        ? projectBounds.dateFrom
        : fromDate
      : (projectBounds?.dateFrom ?? fromDate)

  const effectiveToDate =
    projectBounds?.dateTo && toDate
      ? projectBounds.dateTo < toDate
        ? projectBounds.dateTo
        : toDate
      : (projectBounds?.dateTo ?? toDate)

  if (effectiveFromDate) {
    whereParts.push(gte(judgments.articleCreatedAt, effectiveFromDate))
  }
  if (effectiveToDate) {
    whereParts.push(lte(judgments.articleCreatedAt, effectiveToDate))
  }

  // Search filter
  if (searchTitle) {
    whereParts.push(sql`${judgments.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
  }

  // === SCOPE CONDITION ===
  const scopeConditions: Array<ReturnType<typeof sql>> = []

  // Import route match using denormalized articleImportRoute
  if (hasImportRoutes) {
    const routeTextsArray = sql.join(
      routeTexts.map((r) => {
        return sql`${r}`
      }),
      sql`,`,
    )
    scopeConditions.push(sql`${judgments.articleImportRoute} = ANY(ARRAY[${routeTextsArray}])`)
  }

  // Curated articles - use subquery
  scopeConditions.push(
    sql`${judgments.articleId} IN (
      SELECT pa."article_id" FROM ${projectArticles} pa
      WHERE pa."project_id" = ${params.projectId}::uuid
    )`,
  )

  // Combine scope with OR
  const scopeOr = scopeConditions.length > 1 ? or(...scopeConditions) : scopeConditions[0]
  if (scopeOr) {
    whereParts.push(scopeOr)
  }

  const combinedWhereCondition = and(...whereParts)

  // === HAVING CONDITIONS ===
  // Note: Removed COUNT(DISTINCT prompt_id) = N check to allow partially-judged articles.
  // The frontend will show judged status per prompt based on the judgments actually fetched.
  // Only answer filters (if any) are applied via HAVING.
  const havingParts: Array<ReturnType<typeof sql>> = []

  const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`

  for (const [promptId, answeredValues] of promptFilters) {
    if (answeredValues.length === 0) continue
    const answeredValsArray = sql.join(
      answeredValues.map((v) => {
        return sql`${v}`
      }),
      sql`,`,
    )
    havingParts.push(
      sql`SUM(CASE WHEN ${judgments.promptId} = ${promptId}::uuid AND (${normalized}) && ARRAY[${answeredValsArray}]::text[] THEN 1 ELSE 0 END) > 0`,
    )
  }

  // havingCondition is undefined if no answer filters are applied
  const havingCondition =
    havingParts.length > 0 ? (havingParts.length > 1 ? and(...havingParts) : havingParts[0]) : undefined

  // Build prompt order map
  const promptOrderMap = projectPromptRows.reduce(
    (acc, p, idx) => {
      const ord = p.order ?? idx
      return {...acc, [p.id]: ord}
    },
    {} as Record<string, number>,
  )

  return {combinedWhereCondition, havingCondition, promptIds, promptOrderMap}
}
