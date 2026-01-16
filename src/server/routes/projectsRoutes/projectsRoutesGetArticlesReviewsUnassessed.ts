import {desc, eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, projectRouteLink, projects} from '../../../db/schema.ts'
import {getUnassessedArticlesFromClickHouse} from '../../../services/clickhouse/unassessedArticlesClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviewsUnassessed = new Elysia().post(
  '/api/articlesreviewsunassessed',
  async ({body}) => {
    const db = getDatabase()

    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)
    const offset = (page - 1) * limit
    const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''
    const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
    const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null

    const [[projectBounds], projectImportRoutes] = await Promise.all([
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
        .where(eq(projects.id, body.projectId))
        .limit(1),
      db
        .select({importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(eq(projectRouteLink.projectId, body.projectId)),
    ])

    if (!projectBounds?.modelId) {
      return {data: [], totalCount: 0, page, limit, totalPages: 0}
    }

    const effectiveFromDate = (() => {
      if (projectBounds.dateFrom && fromDate) {
        return projectBounds.dateFrom > fromDate ? projectBounds.dateFrom : fromDate
      }
      return projectBounds.dateFrom ?? fromDate
    })()

    const effectiveToDate = (() => {
      if (projectBounds.dateTo && toDate) {
        return projectBounds.dateTo < toDate ? projectBounds.dateTo : toDate
      }
      return projectBounds.dateTo ?? toDate
    })()

    const importRouteIds = projectImportRoutes.map((r) => {
      return r.importRouteId
    })

    const {articles: unassessedFromCH, totalCount} = await getUnassessedArticlesFromClickHouse({
      projectId: body.projectId,
      projectModelId: projectBounds.modelId,
      projectDateFrom: effectiveFromDate,
      projectDateTo: effectiveToDate,
      importRouteIds,
      useTitle: projectBounds.useTitle ?? true,
      useAbstract: projectBounds.useAbstract ?? true,
      useFulltext: projectBounds.useFulltext ?? false,
      useFulltextNoImages: projectBounds.useFulltextNoImages ?? false,
      limit,
      offset,
      search: searchTitle || undefined,
    })

    if (unassessedFromCH.length === 0) {
      return {data: [], totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
    }

    const articleIds = unassessedFromCH.map((a) => {
      return a.id
    })

    const fullArticles = await db
      .select()
      .from(articles)
      .where(inArray(articles.id, articleIds))
      .orderBy(desc(articles.articleCreatedAt))

    const articleOrder = new Map(
      articleIds.map((id, idx) => {
        return [id, idx]
      }),
    )
    const sortedArticles = fullArticles.sort((a, b) => {
      const aOrder = articleOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const bOrder = articleOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })

    const result = sortedArticles.map((article) => {
      return {...article, judgments: []}
    })

    return {data: result, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
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
