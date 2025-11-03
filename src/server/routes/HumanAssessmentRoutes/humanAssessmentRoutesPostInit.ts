import {and, desc, eq, gte, isNull, lte, sql} from 'drizzle-orm'

import {auth} from '../../../auth.ts'
import {articleRouteLink, articles, judgmentsHuman, projectRouteLink, projects, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type InitResponse = {
  project: {id: string; name: string}
  article: {id: string; articleTitle: string; articleSummary: string | null}
  prompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>
  judgmentsHuman: Array<{id: string; promptId: string}>
}

export const humanAssessmentRoutesPostInit = async ({
  body,
  request,
  set,
}: {
  body: {projectId: string}
  request: Request
  set: any
}) => {
  const db = getDatabase()
  const session = await auth.api.getSession({headers: request.headers})
  const sessionUserId = session?.user?.id ?? session?.session?.userId

  if (!sessionUserId) {
    set.status = 401
    return {data: null, error: 'You must be signed in to start a human assessment'}
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1)
  if (!project) {
    set.status = 404
    return {data: null, error: 'Project not found'}
  }

  const projectPrompts = await db
    .select({
      id: prompts.id,
      originalText: prompts.originalText,
      promptHeading: prompts.promptHeading,
      order: prompts.order,
      type: prompts.type,
    })
    .from(prompts)
    .where(eq(prompts.projectId, body.projectId))
    .orderBy(prompts.order)

  if (projectPrompts.length === 0) {
    set.status = 400
    return {data: null, error: 'Project has no prompts configured'}
  }

  const existingUnanswered = await db
    .select({id: judgmentsHuman.id, articleId: judgmentsHuman.articleId})
    .from(judgmentsHuman)
    .innerJoin(prompts, eq(prompts.id, judgmentsHuman.promptId))
    .where(
      and(
        eq(judgmentsHuman.projectId, body.projectId),
        eq(judgmentsHuman.user, sessionUserId),
        isNull(judgmentsHuman.answer),
        sql`${prompts.type} IS NULL OR ${prompts.type} NOT ILIKE '%null%'
            `,
      ),
    )
    .orderBy(desc(judgmentsHuman.createdAt))
    .limit(50)

  let targetArticleId: string | null = null
  if (existingUnanswered.length > 0) {
    targetArticleId = existingUnanswered[0]!.articleId
  }

  let articleRow: {id: string; articleTitle: string; articleSummary: string | null} | null = null

  if (!targetArticleId) {
    const projectImportRoutes = await db
      .select({importRouteId: projectRouteLink.importRouteId})
      .from(projectRouteLink)
      .where(eq(projectRouteLink.projectId, body.projectId))

    if (projectImportRoutes.length === 0) {
      set.status = 404
      return {data: null, error: 'Project has no linked import routes'}
    }

    const routeIdArray = sql.join(
      projectImportRoutes.map((r) => {
        return sql`${r.importRouteId}::uuid`
      }),
      sql`,`,
    )

    const hasMatchingImportRoute = sql`EXISTS (
          SELECT 1 FROM ${articleRouteLink} arl
          WHERE arl."article_id" = ${articles.id}
          AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
        )`

    const whereParts: Array<ReturnType<typeof sql>> = [hasMatchingImportRoute]
    if (project.dateFrom) {
      whereParts.push(gte(articles.articleCreatedAt, project.dateFrom))
    }
    if (project.dateTo) {
      whereParts.push(lte(articles.articleCreatedAt, project.dateTo))
    }

    const noExistingHumanJudgmentForUser = sql`NOT EXISTS (
          ${db
            .select({x: sql`1`})
            .from(judgmentsHuman)
            .where(
              and(
                eq(judgmentsHuman.user, sessionUserId),
                eq(judgmentsHuman.projectId, body.projectId),
                eq(judgmentsHuman.articleId, articles.id),
              ),
            )
            .limit(1)}
        )`
    whereParts.push(noExistingHumanJudgmentForUser)

    const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

    const [randomArticle] = await db
      .select({id: articles.id, articleTitle: articles.articleTitle, articleSummary: articles.articleSummary})
      .from(articles)
      .where(combinedWhereCondition)
      .orderBy(sql`RANDOM()`)
      .limit(1)

    if (!randomArticle) {
      set.status = 404
      return {data: null, error: 'No eligible articles found for this project'}
    }

    targetArticleId = randomArticle.id
    articleRow = randomArticle

    const insertValues = projectPrompts.map((p) => {
      return {
        articleId: targetArticleId!,
        user: sessionUserId,
        promptId: p.id,
        answer: null,
        comment: null,
        projectId: body.projectId,
      }
    })

    const inserted = await db
      .insert(judgmentsHuman)
      .values(insertValues)
      .returning({id: judgmentsHuman.id, promptId: judgmentsHuman.promptId})

    const response: InitResponse = {
      project: {id: project.id, name: project.name},
      article: articleRow,
      prompts: projectPrompts,
      judgmentsHuman: inserted,
    }

    return {data: response}
  }

  const targetId = targetArticleId
  const [article] = await db
    .select({id: articles.id, articleTitle: articles.articleTitle, articleSummary: articles.articleSummary})
    .from(articles)
    .where(eq(articles.id, targetId))
    .limit(1)

  articleRow = article ?? null

  const pendingForArticle = await db
    .select({id: judgmentsHuman.id, promptId: judgmentsHuman.promptId})
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, body.projectId),
        eq(judgmentsHuman.user, sessionUserId),
        eq(judgmentsHuman.articleId, targetId),
        isNull(judgmentsHuman.answer),
      ),
    )

  const response: InitResponse = {
    project: {id: project.id, name: project.name},
    article: articleRow!,
    prompts: projectPrompts,
    judgmentsHuman: pendingForArticle,
  }

  return {data: response}
}
