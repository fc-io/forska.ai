import {and, desc, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  judgmentsHuman,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsBoth = new Elysia().post(
  '/api/articlesreviewsboth',
  async ({body}) => {
    const db = getDatabase()

    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)
    const offset = (page - 1) * limit

    const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
    const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
    const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

    // Get prompts for project (ordered)
    const projectPromptRows = await db
      .select({id: prompts.id, order: projectPrompts.order})
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))
      .orderBy(projectPrompts.order)
    if (projectPromptRows.length === 0) {
      return {data: [], totalCount: 0, page, limit, totalPages: 0}
    }

    const promptIds = projectPromptRows.map((p) => {
      return p.id
    })

    // Fully assessed by a single human for ALL prompts in this project
    const promptIdsSqlArray = sql.join(
      promptIds.map((id) => {
        return sql`${id}::uuid`
      }),
      sql`,`,
    )
    const fullyAssessedByHumanExists = sql`EXISTS (
      SELECT 1
      FROM ${judgmentsHuman} jh
      WHERE jh."article_id" = ${articles.id}
        AND jh."project_id" = ${body.projectId}::uuid
        AND jh."prompt_id" = ANY(ARRAY[${promptIdsSqlArray}])
        AND jh."answer" IS NOT NULL
      GROUP BY jh."article_id", jh."user"
      HAVING COUNT(DISTINCT jh."prompt_id") = ${promptIds.length}
    )`

    // Prompt-specific filters for LLM judgments (answered_original)
    const promptFilters = Object.entries(body.prompts || {}).map(([key, values]) => {
      return [key, Array.isArray(values) ? values : [String(values)]] as const
    })

    const filterConditions: Array<ReturnType<typeof sql>> = []

    for (const [promptId, answeredValues] of promptFilters) {
      const answeredValsArray = sql.join(
        answeredValues.map((v) => {
          return sql`${v}`
        }),
        sql`,`,
      )
      const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`
      const subquery = db
        .select({exists: sql`1`})
        .from(judgments)
        .where(
          and(
            eq(judgments.articleId, articles.id),
            eq(judgments.promptId, promptId),
            sql`(${normalized}) && ARRAY[${answeredValsArray}]::text[]`,
          ),
        )
        .limit(1)

      filterConditions.push(sql`EXISTS (${subquery})`)
    }

    // Always scope to project's configured import routes and project date bounds
    const [projectBounds] = await db
      .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
      .from(projects)
      .where(eq(projects.id, body.projectId))
      .limit(1)

    const projectImportRoutes = await db
      .select({importRouteId: projectRouteLink.importRouteId})
      .from(projectRouteLink)
      .where(eq(projectRouteLink.projectId, body.projectId))

    const routeIdArray =
      projectImportRoutes.length > 0
        ? sql.join(
            projectImportRoutes.map((r) => {
              return sql`${r.importRouteId}::uuid`
            }),
            sql`,`,
          )
        : null

    const hasMatchingImportRoute =
      routeIdArray !== null
        ? sql`EXISTS (
            SELECT 1 FROM ${articleRouteLink} arl
            WHERE arl."article_id" = ${articles.id}
              AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
          )`
        : null
    const hasProjectArticle = sql`EXISTS (
      SELECT 1 FROM ${projectArticles} pa
      WHERE pa."article_id" = ${articles.id}
        AND pa."project_id" = ${body.projectId}::uuid
    )`

    const whereParts: Array<ReturnType<typeof sql>> = [
      fullyAssessedByHumanExists,
      hasMatchingImportRoute ? or(hasMatchingImportRoute, hasProjectArticle) : hasProjectArticle,
    ]
    if (filterConditions.length > 0) whereParts.push(...filterConditions)
    if (projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
    if (projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
    if (fromDate) whereParts.push(gte(articles.articleCreatedAt, fromDate))
    if (toDate) whereParts.push(lte(articles.articleCreatedAt, toDate))
    if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)

    const combinedWhere = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

    // Count articles that have LLM judgments for ALL prompts AND satisfy human condition
    const countQuery = await db
      .select({count: sql<number>`COUNT(DISTINCT ${articles.id})`.as('count')})
      .from(articles)
      .where(combinedWhere)
      .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .groupBy(articles.id)
      .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)

    const totalCount = countQuery.length

    // Fetch paginated list
    const articlesWithBoth = await db
      .select({
        article: articles,
        judgmentCount: sql<number>`(
          ${db
            .select({count: sql`COUNT(DISTINCT ${judgments.promptId})`})
            .from(judgments)
            .where(and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))}
        )`.as('judgment_count'),
      })
      .from(articles)
      .where(combinedWhere)
      .having(sql`COUNT(DISTINCT ${judgments.promptId}) = ${promptIds.length}`)
      .innerJoin(judgments, and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds)))
      .groupBy(articles.id)
      .orderBy(desc(articles.articleCreatedAt))
      .limit(limit)
      .offset(offset)

    const articleIds = articlesWithBoth.map((a) => {
      return a.article.id
    })

    const allLlMJudgments =
      articleIds.length > 0
        ? await db
            .select()
            .from(judgments)
            .where(and(inArray(judgments.articleId, articleIds), inArray(judgments.promptId, promptIds)))
        : []

    const judgmentsByArticle = allLlMJudgments.reduce(
      (acc, j) => {
        const arr = acc[j.articleId] ?? []
        return {...acc, [j.articleId]: [...arr, j]}
      },
      {} as Record<string, typeof allLlMJudgments>,
    )

    // Build prompt order map for consistent ordering of judgments per article
    const promptOrderMap = projectPromptRows.reduce(
      (acc, p, idx) => {
        const ord = p.order ?? idx
        return {...acc, [p.id]: ord}
      },
      {} as Record<string, number>,
    )

    // Fetch human answers for qualifying humans: users who answered ALL prompts for the project on that article
    // Strategy: fetch all human rows with non-null answers, then in code select users per article who have
    // answers for all prompts, and aggregate answers per prompt for those qualifying users.
    type HumanRow = {articleId: string; userId: string; promptId: string; answer: string | null; updatedAt: Date | null}

    const humanRows: HumanRow[] =
      articleIds.length > 0
        ? await db
            .select({
              articleId: judgmentsHuman.articleId,
              userId: judgmentsHuman.user,
              promptId: judgmentsHuman.promptId,
              answer: judgmentsHuman.answer,
              updatedAt: judgmentsHuman.updatedAt,
            })
            .from(judgmentsHuman)
            .where(
              and(
                inArray(judgmentsHuman.articleId, articleIds),
                eq(judgmentsHuman.projectId, body.projectId),
                inArray(judgmentsHuman.promptId, promptIds),
                // Only consider non-null answers when determining qualified humans
                sql`${judgmentsHuman.answer} IS NOT NULL`,
              ),
            )
        : []

    // Deduplicate by latest updatedAt for (articleId, userId, promptId)
    const latestByArticleUserPrompt = humanRows.reduce((acc, row) => {
      const key = `${row.articleId}::${row.userId}::${row.promptId}`
      const existing = acc.get(key)
      if (!existing || (row.updatedAt?.getTime() || 0) > (existing.updatedAt?.getTime() || 0)) {
        acc.set(key, row)
      }
      return acc
    }, new Map<string, HumanRow>())

    // Group rows by (articleId, userId) and retain only users who covered ALL prompts
    const rowsByArticleUser = new Map<string, Map<string, HumanRow[]>>()
    for (const row of latestByArticleUserPrompt.values()) {
      const byUser = rowsByArticleUser.get(row.articleId) || new Map<string, HumanRow[]>()
      const arr = byUser.get(row.userId) || []
      arr.push(row)
      byUser.set(row.userId, arr)
      rowsByArticleUser.set(row.articleId, byUser)
    }

    // For each article, collect human answers per prompt from qualifying users
    const humanAnswersByArticlePrompt: Record<string, Record<string, string[]>> = {}
    for (const articleId of articleIds) {
      const byUser = rowsByArticleUser.get(articleId)
      if (!byUser) continue

      // Users who have answered all prompts (non-null answers) for this project
      const qualifyingUsers: string[] = []
      for (const [userId, rows] of byUser.entries()) {
        const covered = new Set(
          rows.map((r) => {
            return r.promptId
          }),
        )
        if (covered.size === promptIds.length) {
          qualifyingUsers.push(userId)
        }
      }

      if (qualifyingUsers.length === 0) continue

      // Initialize prompt map
      const promptMap: Record<string, string[]> = {}
      for (const pid of promptIds) promptMap[pid] = []

      for (const userId of qualifyingUsers) {
        const rows = byUser.get(userId) || []
        for (const r of rows) {
          if (r.answer !== null && r.answer !== undefined) {
            const bucket = promptMap[r.promptId]
            if (bucket) bucket.push(r.answer)
          }
        }
      }

      humanAnswersByArticlePrompt[articleId] = promptMap
    }

    const result = articlesWithBoth.map(({article}) => {
      const unsorted = judgmentsByArticle[article.id] || []
      const sorted = [...unsorted].sort((a, b) => {
        const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
        const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
        return ao - bo
      })
      return {...article, judgments: sorted, humanAnswersByPrompt: humanAnswersByArticlePrompt[article.id] || undefined}
    })

    return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
