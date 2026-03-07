import {and, desc, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
import type {Context} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgmentsHuman,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {localUserId} from '../../../utils/localUser.ts'
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

export const humanAssessmentRoutesPostInit = async ({body, set}: {body: {projectId: string}; set: Context['set']}) => {
  const db = getDatabase()
  const sessionUserId = localUserId

  const [project] = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1)
  if (!project) {
    set.status = 404
    return {data: null, error: 'Project not found'}
  }
  console.log('project', project)

  const projectPromptRows = await db
    .select({
      id: prompts.id,
      originalText: prompts.originalText,
      promptHeading: prompts.promptHeading,
      order: projectPrompts.order,
      type: prompts.type,
    })
    .from(projectPrompts)
    .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
    .where(eq(projectPrompts.projectId, body.projectId))
    .orderBy(projectPrompts.order)
  console.log('projectPrompts', projectPromptRows.length)

  if (projectPromptRows.length === 0) {
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
        eq(judgmentsHuman.isAnswered, false),
      ),
    )
    .orderBy(desc(judgmentsHuman.createdAt))
    .limit(50)
  console.log('existingUnanswered', existingUnanswered.length)
  let targetArticleId: string | null = null
  const firstUnanswered = existingUnanswered[0]
  if (firstUnanswered) {
    targetArticleId = firstUnanswered.articleId
  }

  let articleRow: {id: string; articleTitle: string; articleSummary: string | null} | null = null

  if (!targetArticleId) {
    // Fetch import routes linked to this project
    const projectImportRoutes = await db
      .select({importRouteId: projectRouteLink.importRouteId})
      .from(projectRouteLink)
      .where(eq(projectRouteLink.projectId, body.projectId))

    // Fetch curated articles for this project
    const curatedArticleRows = await db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, body.projectId))

    const hasCuratedArticles = curatedArticleRows.length > 0
    const hasImportRoutes = projectImportRoutes.length > 0

    // Build article scope conditions
    const articleScopeConditions: Array<ReturnType<typeof sql>> = []

    if (hasImportRoutes) {
      // Use inArray for import routes - typically a small set
      const routeIds = projectImportRoutes.map((r) => {
        return r.importRouteId
      })
      articleScopeConditions.push(sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink}
        WHERE ${eq(articleRouteLink.articleId, articles.id)}
        AND ${inArray(articleRouteLink.importRouteId, routeIds)}
      )`)
    }

    if (hasCuratedArticles) {
      // For large curated article sets, use raw SQL with array literal to avoid parameter explosion
      // Drizzle's inArray would still expand each ID as a parameter
      const curatedIds = curatedArticleRows.map((r) => {
        return r.articleId
      })
      // Format as PostgreSQL array literal: '{uuid1,uuid2,...}'
      const arrayLiteral = `{${curatedIds.join(',')}}`
      articleScopeConditions.push(sql`${articles.id} = ANY(${sql.raw(`'${arrayLiteral}'`)}::uuid[])`)
    }

    // If no import routes and no curated articles, return no articles
    if (articleScopeConditions.length === 0) {
      set.status = 404
      return {data: null, error: 'No import routes AND no curated articles'}
    }

    // Combine article scope with OR (article is in import routes OR is curated)
    const articleScopeCondition =
      articleScopeConditions.length > 1 ? or(...articleScopeConditions) : articleScopeConditions[0]

    // We know articleScopeCondition is defined here because we checked length > 0 above
    if (!articleScopeCondition) {
      set.status = 404
      return {data: null, error: 'No articles left to judge'}
    }

    const whereParts: Array<ReturnType<typeof sql | typeof or>> = [articleScopeCondition]

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
      return {data: null, error: 'No articles left to judge'}
    }

    const articleId = randomArticle.id
    targetArticleId = articleId
    articleRow = randomArticle

    const insertValues = projectPromptRows.map((p) => {
      return {
        articleId,
        user: sessionUserId,
        promptId: p.id,
        isAnswered: false,
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
      prompts: projectPromptRows,
      judgmentsHuman: inserted,
    }

    return {data: response}
  }

  const targetId = targetArticleId
  if (!targetId) {
    set.status = 404
    return {data: null, error: 'No pending human assessments found'}
  }
  const [article] = await db
    .select({id: articles.id, articleTitle: articles.articleTitle, articleSummary: articles.articleSummary})
    .from(articles)
    .where(eq(articles.id, targetId))
    .limit(1)

  articleRow = article ?? null

  if (!articleRow) {
    set.status = 404
    return {data: null, error: 'Article not found'}
  }

  const pendingForArticle = await db
    .select({id: judgmentsHuman.id, promptId: judgmentsHuman.promptId})
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, body.projectId),
        eq(judgmentsHuman.user, sessionUserId),
        eq(judgmentsHuman.articleId, targetId),
        eq(judgmentsHuman.isAnswered, false),
      ),
    )

  const response: InitResponse = {
    project: {id: project.id, name: project.name},
    article: articleRow,
    prompts: projectPromptRows,
    judgmentsHuman: pendingForArticle,
  }

  return {data: response}
}
