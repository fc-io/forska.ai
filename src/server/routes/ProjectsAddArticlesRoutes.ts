import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  judgmentsHuman,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'
import {getDatabase} from '../utils/getDatabase.ts'

type ListType = 'llm' | 'human' | 'both' | 'unassessed'

const getProjectPromptIds = async (projectId: string) => {
  const db = getDatabase()
  const rows = await db
    .select({id: prompts.id, order: projectPrompts.order})
    .from(projectPrompts)
    .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
    .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
    .orderBy(projectPrompts.order)
  return rows.map((r) => {
    return r.id
  })
}

const getProjectRouteIdSqlArray = async (projectId: string) => {
  const db = getDatabase()
  const routes = await db
    .select({importRouteId: projectRouteLink.importRouteId})
    .from(projectRouteLink)
    .where(eq(projectRouteLink.projectId, projectId))
  return sql.join(
    routes.map((r) => {
      return sql`${r.importRouteId}::uuid`
    }),
    sql`,`,
  )
}

const getProjectBounds = async (projectId: string) => {
  const db = getDatabase()
  const [row] = await db
    .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo, modelId: projects.modelId})
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row
}

const addOptionalBounds = (
  whereParts: Array<ReturnType<typeof sql>>,
  bounds?: {dateFrom: Date | null; dateTo: Date | null},
  uiFrom?: Date | null,
  uiTo?: Date | null,
  searchTitle?: string,
) => {
  if (bounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, bounds.dateFrom))
  if (bounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, bounds.dateTo))
  if (uiFrom) whereParts.push(gte(articles.articleCreatedAt, uiFrom))
  if (uiTo) whereParts.push(lte(articles.articleCreatedAt, uiTo))
  if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
  return whereParts
}

const selectArticleIdsByFilter = async (
  sourceProjectId: string,
  listType: ListType,
  promptsFilter?: Record<string, string[]>,
  from?: string,
  to?: string,
  search?: string,
) => {
  const db = getDatabase()
  const routeIdArray = await getProjectRouteIdSqlArray(sourceProjectId)
  const bounds = await getProjectBounds(sourceProjectId)
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : null
  const toDate = to ? new Date(`${to}T23:59:59.999Z`) : null
  const searchTitle = (search || '').trim()

  if (listType === 'unassessed') {
    const promptIds = await getProjectPromptIds(sourceProjectId)
    if (promptIds.length === 0) return []
    const whereParts: Array<ReturnType<typeof sql>> = [
      sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink} arl
        WHERE arl."article_id" = ${articles.id}
          AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
      )`,
    ]
    addOptionalBounds(whereParts, bounds, fromDate, toDate, searchTitle)
    const combined = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

    const grouped = await db
      .select({id: articles.id})
      .from(articles)
      .leftJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .where(combined)
      .groupBy(articles.id)
      .having(sql`COUNT(DISTINCT ${judgments.promptId}) < ${promptIds.length}`)
      .orderBy(desc(articles.articleCreatedAt))

    return grouped.map((r) => {
      return r.id
    })
  }

  const promptIds = await getProjectPromptIds(sourceProjectId)
  if (promptIds.length === 0) return []

  if (listType === 'human') {
    const fullyAssessedByHumanExists = sql`EXISTS (
      SELECT 1
      FROM ${judgmentsHuman} jh
      WHERE jh."article_id" = ${articles.id}
        AND jh."project_id" = ${sourceProjectId}::uuid
        AND jh."is_answered" = true
      GROUP BY jh."article_id", jh."user"
      HAVING COUNT(DISTINCT jh."prompt_id") = ${promptIds.length}
    )`

    const whereParts: Array<ReturnType<typeof sql>> = [
      fullyAssessedByHumanExists,
      sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink} arl
        WHERE arl."article_id" = ${articles.id}
          AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
      )`,
    ]

    const promptFilters = Object.entries(promptsFilter || {}).map(([key, values]) => {
      return [key, Array.isArray(values) ? values : [String(values)]] as const
    })
    for (const [promptId, answers] of promptFilters) {
      const sub = db
        .select({exists: sql`1`})
        .from(judgmentsHuman)
        .where(
          and(
            eq(judgmentsHuman.articleId, articles.id),
            eq(judgmentsHuman.promptId, promptId),
            inArray(judgmentsHuman.answer, answers),
          ),
        )
        .limit(1)
      whereParts.push(sql`EXISTS (${sub})`)
    }
    addOptionalBounds(whereParts, bounds, fromDate, toDate, searchTitle)
    const combined = whereParts.length > 1 ? and(...whereParts) : whereParts[0]
    const rows = await db
      .select({id: articles.id})
      .from(articles)
      .where(combined)
      .orderBy(desc(articles.articleCreatedAt))
    return rows.map((r) => {
      return r.id
    })
  }

  if (listType === 'llm') {
    const promptFilters = Object.entries(promptsFilter || {}).map(([key, values]) => {
      return [key, Array.isArray(values) ? values : [String(values)]] as const
    })

    const whereParts: Array<ReturnType<typeof sql>> = []
    addOptionalBounds(whereParts, bounds, fromDate, toDate, searchTitle)
    const baseWhere = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

    const havingParts: Array<ReturnType<typeof sql>> = [
      sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`,
    ]
    for (const [promptId, answeredValues] of promptFilters) {
      if (!answeredValues || answeredValues.length === 0) continue
      const answeredValsArray = sql.join(
        answeredValues.map((v) => {
          return sql`${v}`
        }),
        sql`,`,
      )
      havingParts.push(
        sql`SUM(CASE WHEN ${judgments.promptId} = ${promptId}::uuid AND ${judgments.answeredOriginal} = ANY(ARRAY[${answeredValsArray}]::text[]) THEN 1 ELSE 0 END) > 0`,
      )
    }

    const grouped = await db
      .select({id: articles.id})
      .from(articles)
      .innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id))
      .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .where(
        baseWhere
          ? and(baseWhere, sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`)
          : sql`${articleRouteLink.importRouteId} = ANY(ARRAY[${routeIdArray}])`,
      )
      .groupBy(articles.id)
      .having(havingParts.length > 1 ? and(...havingParts) : havingParts[0])
      .orderBy(desc(articles.articleCreatedAt))

    return grouped.map((r) => {
      return r.id
    })
  }

  // both
  const fullyAssessedByHumanExists = sql`EXISTS (
    SELECT 1
    FROM ${judgmentsHuman} jh
    WHERE jh."article_id" = ${articles.id}
      AND jh."answer" IS NOT NULL
    GROUP BY jh."article_id", jh."user"
    HAVING COUNT(DISTINCT jh."prompt_id") = ${promptIds.length}
  )`

  const filterConditions: Array<ReturnType<typeof sql>> = []
  const promptFilters = Object.entries(promptsFilter || {}).map(([key, values]) => {
    return [key, Array.isArray(values) ? values : [String(values)]] as const
  })
  for (const [promptId, answeredValues] of promptFilters) {
    const sub = db
      .select({exists: sql`1`})
      .from(judgments)
      .where(
        and(
          eq(judgments.articleId, articles.id),
          eq(judgments.promptId, promptId),
          inArray(judgments.answeredOriginal, answeredValues),
        ),
      )
      .limit(1)
    filterConditions.push(sql`EXISTS (${sub})`)
  }

  const whereParts: Array<ReturnType<typeof sql>> = [
    fullyAssessedByHumanExists,
    sql`EXISTS (
      SELECT 1 FROM ${articleRouteLink} arl
      WHERE arl."article_id" = ${articles.id}
        AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
    )`,
  ]
  if (filterConditions.length > 0) whereParts.push(...filterConditions)
  addOptionalBounds(whereParts, bounds, fromDate, toDate, searchTitle)
  const combinedWhere = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

  const rows = await db
    .select({id: articles.id})
    .from(articles)
    .where(combinedWhere)
    .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
    .groupBy(articles.id)
    .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
    .orderBy(desc(articles.articleCreatedAt))

  return rows.map((r) => {
    return r.id
  })
}

export const projectsAddArticlesRoutes = new Elysia()
  .post(
    '/api/projects/add_articles_by_filter',
    async ({body}) => {
      const articleIds = await selectArticleIdsByFilter(
        body.sourceProjectId,
        body.listType,
        body.prompts,
        body.from,
        body.to,
        body.search,
      )

      // Upsert associations + auto-link prompts
      const result = await insertArticlesIntoProject(body.targetProjectId, articleIds, body.sourceProjectId)

      console.log('[api/projects/add_articles_by_filter] applied', {
        targetProjectId: body.targetProjectId,
        sourceProjectId: body.sourceProjectId,
        listType: body.listType,
        filters: {from: body.from, to: body.to, search: body.search, prompts: body.prompts},
        selectionTotal: articleIds.length,
        ...result,
      })

      return {success: true, targetProjectId: body.targetProjectId, selectionTotal: articleIds.length, ...result}
    },
    {
      body: t.Object({
        targetProjectId: t.String(),
        sourceProjectId: t.String(),
        listType: t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')]),
        prompts: t.Optional(t.Record(t.String(), t.Array(t.String()))),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        search: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/projects/add_artilces_by_ids',
    async ({body}) => {
      const ids = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]
      const result = await insertArticlesIntoProject(body.targetProjectId, ids, body.sourceProjectId)

      console.log('[api/projects/add_artilces_by_ids] applied', {
        targetProjectId: body.targetProjectId,
        sourceProjectId: body.sourceProjectId,
        providedTotal: ids.length,
        ...result,
      })

      return {success: true, targetProjectId: body.targetProjectId, providedTotal: ids.length, ...result}
    },
    {
      body: t.Object({
        targetProjectId: t.String(),
        sourceProjectId: t.String(),
        articleIds: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )
