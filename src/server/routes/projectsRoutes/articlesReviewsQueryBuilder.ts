import {and, eq, gte, inArray, lte, or, type SQL, sql} from 'drizzle-orm'

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
 * Type alias for a judgment row from the database
 */
export type JudgmentRow = typeof judgments.$inferSelect

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
 * Answer filter for a specific prompt
 */
export interface AnswerFilter {
  promptId: string
  answeredValues: string[]
}

/**
 * Context for progressive fetch approach
 */
export interface ProgressiveFetchContext {
  promptIds: string[]
  promptOrderMap: Record<string, number>
  whereCondition: SQL
  answerFilters: AnswerFilter[]
}

/**
 * Result from building the query conditions (legacy - used by count endpoint)
 */
export interface ArticlesReviewsQueryContext {
  promptIds: string[]
  promptOrderMap: Record<string, number>
  combinedWhereCondition: ReturnType<typeof and>
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
 * Builds the WHERE condition for progressive fetch (no GROUP BY, no HAVING).
 * Answer filtering is done in memory after fetching batches.
 */
export const buildProgressiveFetchContext = (
  params: ArticlesReviewsQueryParams,
  metadata: Awaited<ReturnType<typeof fetchProjectMetadata>>,
): ProgressiveFetchContext | null => {
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

  // Parse prompt filters into answer filters for in-memory filtering
  const answerFilters: AnswerFilter[] = Object.entries(params.prompts || {})
    .filter(([, values]) => {
      return Array.isArray(values) && values.length > 0
    })
    .map(([promptId, values]) => {
      return {promptId, answeredValues: values}
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

  // Fallback to trivially-true condition (shouldn't happen since whereParts is never empty)
  const whereCondition: SQL = and(...whereParts) ?? sql`1=1`

  // Build prompt order map
  const promptOrderMap = projectPromptRows.reduce(
    (acc, p, idx) => {
      const ord = p.order ?? idx
      return {...acc, [p.id]: ord}
    },
    {} as Record<string, number>,
  )

  return {whereCondition, answerFilters, promptIds, promptOrderMap}
}

/**
 * Checks if an article's judgments pass all answer filters.
 * This is the in-memory equivalent of the HAVING clause.
 *
 * For each filter, checks if at least one judgment for that prompt
 * has an answer matching any of the required values.
 */
export const passesAnswerFilters = (judgmentsForArticle: JudgmentRow[], answerFilters: AnswerFilter[]): boolean => {
  // No filters = all articles pass
  if (answerFilters.length === 0) {
    return true
  }

  for (const filter of answerFilters) {
    // Find judgments for this prompt
    const promptJudgments = judgmentsForArticle.filter((j) => {
      return j.promptId === filter.promptId
    })

    if (promptJudgments.length === 0) {
      // No judgment for this prompt = doesn't pass
      return false
    }

    // Check if any judgment has a matching answer
    const hasMatchingAnswer = promptJudgments.some((j) => {
      // Get the answer value(s)
      const answerArray = j.answeredOriginalAsArray ?? (j.answeredOriginal ? [j.answeredOriginal] : [])

      // Check if any answer matches any of the required values
      return answerArray.some((answer) => {
        return filter.answeredValues.includes(answer)
      })
    })

    if (!hasMatchingAnswer) {
      return false
    }
  }

  return true
}

/**
 * Legacy: Builds the WHERE and HAVING conditions for articles reviews queries.
 * Used by the count endpoint which still uses GROUP BY.
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
