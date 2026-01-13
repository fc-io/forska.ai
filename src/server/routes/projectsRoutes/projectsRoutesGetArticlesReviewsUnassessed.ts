import {and, desc, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsUnassessed = new Elysia().post(
  '/api/articlesreviewsunassessed',
  async ({body}) => {
    try {
      const db = getDatabase()

      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''
      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null

      const projectPromptRows = await db
        .select({id: prompts.id})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, body.projectId), eq(projectPrompts.enabled, true)))

      if (projectPromptRows.length === 0) {
        return {data: [], totalCount: 0, page, limit, totalPages: 0}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      // Always enforce the project's date range, modelId, content settings, and capture bounds
      const [projectBounds] = await db
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
        .where(eq(projects.id, body.projectId))
        .limit(1)

      const scopedProjectArticles = db
        .select({articleId: projectArticles.articleId})
        .from(projectArticles)
        .where(eq(projectArticles.projectId, body.projectId))

      const scopedImportRouteArticles = db
        .select({articleId: articleRouteLink.articleId})
        .from(projectRouteLink)
        .innerJoin(articleRouteLink, eq(articleRouteLink.importRouteId, projectRouteLink.importRouteId))
        .where(eq(projectRouteLink.projectId, body.projectId))

      const scopedArticles = scopedProjectArticles.union(scopedImportRouteArticles).as('scoped_articles')

      // Optional UI + project time bounds and search
      const whereParts: Array<ReturnType<typeof sql>> = []
      if (projectBounds?.dateFrom) whereParts.push(gte(articles.articleCreatedAt, projectBounds.dateFrom))
      if (projectBounds?.dateTo) whereParts.push(lte(articles.articleCreatedAt, projectBounds.dateTo))
      if (fromDate) whereParts.push(gte(articles.articleCreatedAt, fromDate))
      if (toDate) whereParts.push(lte(articles.articleCreatedAt, toDate))
      if (searchTitle) whereParts.push(sql`${articles.articleTitle} ILIKE ${'%' + searchTitle + '%'}`)
      const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : (whereParts[0] ?? sql`TRUE`)

      // Select articles that are NOT fully assessed by LLM for all project prompts
      // Strategy: LEFT JOIN judgments filtered to this project's promptIds, modelId, and content settings
      // and HAVING count(distinct prompt_id) < total prompts
      // Build judgment join conditions: articleId match, promptId in project prompts, modelId, and content settings match
      const judgmentJoinConditions = projectBounds?.modelId
        ? and(
            eq(judgments.articleId, articles.id),
            inArray(judgments.promptId, promptIds),
            eq(judgments.modelId, projectBounds.modelId),
            eq(judgments.useTitle, projectBounds.useTitle ?? true),
            eq(judgments.useAbstract, projectBounds.useAbstract ?? true),
            eq(judgments.useFulltext, projectBounds.useFulltext ?? false),
            eq(judgments.useFulltextNoImages, projectBounds.useFulltextNoImages ?? false),
          )
        : and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, promptIds))

      const groupedBase = db
        .select({id: articles.id})
        .from(scopedArticles)
        .innerJoin(articles, eq(scopedArticles.articleId, articles.id))
        .leftJoin(judgments, judgmentJoinConditions)
        .where(combinedWhereCondition)
        .groupBy(articles.id)
        .having(sql`COUNT(DISTINCT ${judgments.promptId}) < ${promptIds.length}`)
        .as('grouped_unassessed')

      const [{count: totalCount = 0} = {count: 0}] = await db
        .select({count: sql<number>`COUNT(*)`.as('count')})
        .from(groupedBase)

      const pageBase = db
        .select({id: groupedBase.id})
        .from(groupedBase)
        .innerJoin(articles, eq(groupedBase.id, articles.id))
        .orderBy(desc(articles.articleCreatedAt))
        .limit(limit)
        .offset(offset)
        .as('page_unassessed')

      const unassessedArticles = await db
        .select({article: articles})
        .from(articles)
        .innerJoin(pageBase, eq(pageBase.id, articles.id))
        .orderBy(desc(articles.articleCreatedAt))

      const result = unassessedArticles.map(({article}) => {
        return {...article, judgments: []}
      })

      return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
    } catch (error) {
      console.error('Error fetching unassessed articles:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch unassessed articles')
    }
  },
  {
    body: t.Object({
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
