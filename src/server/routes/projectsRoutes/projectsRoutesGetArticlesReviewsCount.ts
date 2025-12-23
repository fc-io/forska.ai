import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {importRoute, projectArticles, projectPrompts, projectRouteLink, projects, prompts} from '../../../db/schema'
import {
  buildInClause,
  escapeSqlString,
  getJudgmentsParquetPath,
  queryDuckDB,
} from '../../../services/duckdb/duckdbQuery'
import {getDatabase} from '../../utils/getDatabase'

/**
 * Count endpoint for articles reviews using DuckDB.
 *
 * Uses DuckDB to query Parquet files for fast aggregation:
 * - Columnar storage = only reads needed columns
 * - Vectorized execution = processes data in batches
 * - Parallel aggregation = uses all CPU cores
 */
export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async ({body}) => {
    const startTime = Date.now()
    console.log('🦆 Count via DuckDB starting...')

    try {
      const db = getDatabase()

      // Get project's enabled prompt IDs, modelId, and date bounds
      const [projectPromptRows, projectRow] = await Promise.all([
        db
          .select({id: prompts.id})
          .from(projectPrompts)
          .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
          .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true))),
        db
          .select({modelId: projects.modelId, dateFrom: projects.dateFrom, dateTo: projects.dateTo})
          .from(projects)
          .where(eq(projects.id, body.projectId))
          .limit(1),
      ])

      if (projectPromptRows.length === 0 || !projectRow[0]) {
        return {totalCount: 0, totalPages: 0}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })
      const projectModelId = projectRow[0].modelId
      const projectDateFrom = projectRow[0].dateFrom
      const projectDateTo = projectRow[0].dateTo

      // Get import route TEXTS for this project
      const importRouteRows = await db
        .select({route: importRoute.route})
        .from(projectRouteLink)
        .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
        .where(eq(projectRouteLink.projectId, body.projectId))

      const routeTexts = importRouteRows.map((r) => {
        return r.route
      })

      // Get curated article IDs
      const curatedRows = await db
        .select({articleId: projectArticles.articleId})
        .from(projectArticles)
        .where(eq(projectArticles.projectId, body.projectId))

      const curatedArticleIds = curatedRows.map((r) => {
        return r.articleId
      })

      // Build the DuckDB SQL query
      const parquetPath = getJudgmentsParquetPath()

      // Build WHERE clauses
      const whereClauses: string[] = [
        `"promptId" IN (${buildInClause(promptIds)})`,
        `"modelId" = '${escapeSqlString(projectModelId)}'`,
        `"deletedAt" IS NULL`,
      ]

      // Date filters - combine project bounds with request params (use most restrictive)
      const requestFrom = body.from ? new Date(`${body.from}T00:00:00Z`) : null
      const requestTo = body.to ? new Date(`${body.to}T23:59:59Z`) : null

      // Effective from: use the later of project.dateFrom and request.from
      const effectiveFrom =
        projectDateFrom && requestFrom
          ? projectDateFrom > requestFrom
            ? projectDateFrom
            : requestFrom
          : (projectDateFrom ?? requestFrom)

      // Effective to: use the earlier of project.dateTo and request.to
      const effectiveTo =
        projectDateTo && requestTo
          ? projectDateTo < requestTo
            ? projectDateTo
            : requestTo
          : (projectDateTo ?? requestTo)

      if (effectiveFrom) {
        const fromStr = effectiveFrom.toISOString().replace('T', ' ').substring(0, 23)
        whereClauses.push(`"articleCreatedAt" >= '${fromStr}'::TIMESTAMP`)
      }
      if (effectiveTo) {
        const toStr = effectiveTo.toISOString().replace('T', ' ').substring(0, 23)
        whereClauses.push(`"articleCreatedAt" <= '${toStr}'::TIMESTAMP`)
      }

      // Search filter
      if (body.search) {
        whereClauses.push(`"articleTitle" ILIKE '%${escapeSqlString(body.search)}%'`)
      }

      // Scope filter (import routes OR curated articles)
      const hasImportRoutes = routeTexts.length > 0
      const hasCuratedArticles = curatedArticleIds.length > 0

      // CRITICAL: If no scope is defined, return 0 (don't count all articles!)
      if (!hasImportRoutes && !hasCuratedArticles) {
        console.log('🦆 No scope defined (no import routes or curated articles), returning 0')
        return {totalCount: 0, totalPages: 0}
      }

      const scopeParts: string[] = []

      if (hasImportRoutes) {
        scopeParts.push(`"articleImportRoute" IN (${buildInClause(routeTexts)})`)
      }

      if (hasCuratedArticles) {
        scopeParts.push(`"articleId" IN (${buildInClause(curatedArticleIds)})`)
      }

      whereClauses.push(`(${scopeParts.join(' OR ')})`)

      // Build answer filter HAVING clauses
      const havingClauses: string[] = []
      for (const [promptId, values] of Object.entries(body.prompts)) {
        if (Array.isArray(values) && values.length > 0) {
          // Check if any judgment for this prompt has one of the filtered values
          havingClauses.push(
            `SUM(CASE WHEN "promptId" = '${escapeSqlString(promptId)}' AND "answeredOriginal" IN (${buildInClause(values)}) THEN 1 ELSE 0 END) > 0`,
          )
        }
      }

      const whereClause = whereClauses.join(' AND ')
      const havingClause = havingClauses.length > 0 ? `HAVING ${havingClauses.join(' AND ')}` : ''

      // Count distinct articles matching all criteria
      const sql = `
SELECT COUNT(*) as "totalCount"
FROM (
  SELECT "articleId"
  FROM read_parquet('${parquetPath}')
  WHERE ${whereClause}
  GROUP BY "articleId"
  ${havingClause}
) subquery;
`

      console.log('🦆 DuckDB SQL:', sql.trim().substring(0, 500) + '...')

      const result = await queryDuckDB<{totalCount: number}>(sql)

      if (result.error) {
        console.error('DuckDB count failed:', result.error)
        return {totalCount: 0, totalPages: 0, error: result.error}
      }

      const totalCount = result.data[0]?.totalCount ?? 0
      const limit = parseInt(body.limit, 10) || 100
      const totalPages = Math.ceil(totalCount / limit)

      const elapsed = Date.now() - startTime
      console.log(`🦆 Count complete: ${totalCount.toLocaleString()} articles in ${elapsed}ms`)

      return {totalCount, totalPages}
    } catch (error) {
      console.error('Count endpoint error:', error)
      return {totalCount: 0, totalPages: 0, error: error instanceof Error ? error.message : 'Unknown error'}
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
