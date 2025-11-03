import {type as arktype} from 'arktype'
import {and, desc, eq, gte, inArray, isNull, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../auth-schema'
import {auth} from '../../auth.ts'
import {articleRouteLink, articles, judgments, judgmentsHuman, projectRouteLink, projects, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

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

export const humanAssessmentRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/humanassessment/overview', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const db = getDatabase()

    const perProject = await db
      .select({
        projectId: judgmentsHuman.projectId,
        projectName: projects.name,
        count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
      })
      .from(judgmentsHuman)
      .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
      .where(sql`${judgmentsHuman.answer} IS NOT NULL`)
      .groupBy(judgmentsHuman.projectId, projects.name)
      .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

    const perUser = await db
      .select({
        userId: judgmentsHuman.user,
        userName: user.name,
        email: user.email,
        count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
      })
      .from(judgmentsHuman)
      .innerJoin(user, eq(user.id, judgmentsHuman.user))
      .where(sql`${judgmentsHuman.answer} IS NOT NULL`)
      .groupBy(judgmentsHuman.user, user.name, user.email)
      .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

    return {data: {projects: perProject, users: perUser}}
  })
  .get('/api/humanassessment/overview-both-projects', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const db = getDatabase()

    // Count distinct articles per project that are fully assessed by at least one human (all prompts answered)
    // AND also fully assessed by AI (judgments present for all prompts in the project)
    const bothPerProject = await db
      .select({
        projectId: judgmentsHuman.projectId,
        projectName: projects.name,
        count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
      })
      .from(judgmentsHuman)
      .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
      .where(
        and(
          // Exists a full human assessment set (same user) covering all prompts of the project
          sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."user" = ${judgmentsHuman.user}
              AND jh2."answer" IS NOT NULL
            GROUP BY jh2."project_id", jh2."article_id", jh2."user"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p WHERE p."project_id" = jh2."project_id"
            )
          )`,
          // Exists a full AI assessment set covering all prompts of the same project
          sql`EXISTS (
            SELECT 1
            FROM ${judgments} j
            INNER JOIN ${prompts} pr ON pr."id" = j."prompt_id"
            WHERE pr."project_id" = ${judgmentsHuman.projectId}
              AND j."article_id" = ${judgmentsHuman.articleId}
            GROUP BY j."article_id"
            HAVING COUNT(DISTINCT j."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p2 WHERE p2."project_id" = ${judgmentsHuman.projectId}
            )
          )`,
        ),
      )
      .groupBy(judgmentsHuman.projectId, projects.name)
      .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

    return {data: bothPerProject}
  })
  .get('/api/humanassessment/overview-both-users', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const db = getDatabase()

    // Count distinct articles per user where that user has fully answered all prompts in a project
    // AND those articles also have a full set of AI judgments for that project
    const bothPerUser = await db
      .select({
        userId: judgmentsHuman.user,
        userName: user.name,
        email: user.email,
        count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
      })
      .from(judgmentsHuman)
      .innerJoin(user, eq(user.id, judgmentsHuman.user))
      .where(
        and(
          // User has a complete human assessment for the article within the project
          sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."user" = ${judgmentsHuman.user}
              AND jh2."answer" IS NOT NULL
            GROUP BY jh2."project_id", jh2."article_id", jh2."user"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p WHERE p."project_id" = jh2."project_id"
            )
          )`,
          // AI has a complete assessment for the same article within the project
          sql`EXISTS (
            SELECT 1
            FROM ${judgments} j
            INNER JOIN ${prompts} pr ON pr."id" = j."prompt_id"
            WHERE pr."project_id" = ${judgmentsHuman.projectId}
              AND j."article_id" = ${judgmentsHuman.articleId}
            GROUP BY j."article_id"
            HAVING COUNT(DISTINCT j."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p2 WHERE p2."project_id" = ${judgmentsHuman.projectId}
            )
          )`,
        ),
      )
      .groupBy(judgmentsHuman.user, user.name, user.email)
      .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

    return {data: bothPerUser}
  })
  .post(
    '/api/humanassessment/init',
    async ({body, request, set}) => {
      const db = getDatabase()
      const session = await auth.api.getSession({headers: request.headers})
      const sessionUserId = session?.user?.id ?? session?.session?.userId

      if (!sessionUserId) {
        set.status = 401
        return {data: null, error: 'You must be signed in to start a human assessment'}
      }

      // Ensure project exists
      const [project] = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1)
      if (!project) {
        set.status = 404
        return {data: null, error: 'Project not found'}
      }

      // Get project prompts
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

      // Check for existing unanswered human judgments for this user in this project
      const existingUnanswered = await db
        .select({id: judgmentsHuman.id, articleId: judgmentsHuman.articleId})
        .from(judgmentsHuman)
        .where(
          and(
            eq(judgmentsHuman.projectId, body.projectId),
            eq(judgmentsHuman.user, sessionUserId),
            isNull(judgmentsHuman.answer),
          ),
        )
        .orderBy(desc(judgmentsHuman.createdAt))
        .limit(50)

      let targetArticleId: string | null = null
      if (existingUnanswered.length > 0) {
        // Use the most recent pending batch's article
        targetArticleId = existingUnanswered[0]!.articleId
      }

      let articleRow: {id: string; articleTitle: string; articleSummary: string | null} | null = null

      if (!targetArticleId) {
        // Need to create a fresh batch for a random article in the project (for this user)
        // Determine project's linked import routes
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

        // Exclude articles that already have any human judgments for this user in this project
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
          .orderBy(sql`RANDOM()`) // Postgres random selection
          .limit(1)

        if (!randomArticle) {
          set.status = 404
          return {data: null, error: 'No eligible articles found for this project'}
        }

        targetArticleId = randomArticle.id
        articleRow = randomArticle

        // Create one human judgment per prompt for this user, project, and article
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

      // If we have existing unanswered, restrict to the same article and return that set
      const targetId = targetArticleId
      // Fetch article details
      const [article] = await db
        .select({id: articles.id, articleTitle: articles.articleTitle, articleSummary: articles.articleSummary})
        .from(articles)
        .where(eq(articles.id, targetId))
        .limit(1)

      articleRow = article ?? null

      // Fetch all unanswered judgments for this user, project, and target article
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
    },
    {body: t.Object({projectId: t.String()})},
  )
  .post(
    '/api/humanassessment/submit',
    async ({body, request, set}) => {
      const db = getDatabase()
      const session = await auth.api.getSession({headers: request.headers})
      const sessionUserId = session?.user?.id ?? session?.session?.userId

      if (!sessionUserId) {
        set.status = 401
        return {data: null, error: 'You must be signed in to submit a human assessment'}
      }

      // Fetch all pending judgments for this user+project and derive the active article
      const pending = await db
        .select({
          id: judgmentsHuman.id,
          promptId: judgmentsHuman.promptId,
          articleId: judgmentsHuman.articleId,
          type: prompts.type,
        })
        .from(judgmentsHuman)
        .innerJoin(prompts, eq(judgmentsHuman.promptId, prompts.id))
        .where(
          and(
            eq(judgmentsHuman.projectId, body.projectId),
            eq(judgmentsHuman.user, sessionUserId),
            isNull(judgmentsHuman.answer),
          ),
        )

      if (pending.length === 0) {
        set.status = 400
        return {data: null, error: 'No pending human assessments for this project'}
      }

      const articleIds = Array.from(
        new Set(
          pending.map((p) => {
            return p.articleId
          }),
        ),
      )

      if (articleIds.length !== 1) {
        set.status = 400
        return {data: null, error: 'Multiple pending articles detected; please refresh and try again'}
      }

      const expectedIds = new Set(
        pending.map((p) => {
          return p.id
        }),
      )

      const submittedIds = new Set(
        body.answers.map((a) => {
          return a.judgmentHumanId
        }),
      )

      if (submittedIds.size !== expectedIds.size) {
        set.status = 400
        return {data: null, error: 'All prompts must be answered before submitting'}
      }

      const hasAllIds = Array.from(expectedIds).every((id) => {
        return submittedIds.has(id)
      })

      if (!hasAllIds) {
        set.status = 400
        return {data: null, error: 'Submission is missing answers for one or more prompts'}
      }

      const byId = body.answers.reduce<Record<string, {answer: string; comment?: string}>>((acc, a) => {
        const key = a.judgmentHumanId
        acc[key] = {answer: a.answer, comment: a.comment}
        return acc
      }, {})

      // ArkType validation against each prompt's declared type (default to 'string' when not set)
      for (const row of pending) {
        const submitted = byId[row.id]
        const value = submitted?.answer
        if (value == null || `${value}`.trim() === '') {
          set.status = 400
          return {data: null, error: 'All prompts must have a non-empty answer'}
        }
        const typeStr = row.type ?? 'string'
        const Type = arktype(typeStr)
        // Will throw if value does not conform — let error handler convert to response if needed
        try {
          Type.assert(value)
        } catch (e) {
          set.status = 400
          return {data: null, error: `Answer does not match required type for a prompt (${typeStr})`}
        }
      }

      const idsToUpdate = Array.from(submittedIds)

      await db.transaction(async (tx) => {
        const rows = await tx
          .select({id: judgmentsHuman.id})
          .from(judgmentsHuman)
          .where(
            and(
              inArray(judgmentsHuman.id, idsToUpdate),
              eq(judgmentsHuman.user, sessionUserId),
              eq(judgmentsHuman.projectId, body.projectId),
              isNull(judgmentsHuman.answer),
            ),
          )

        if (rows.length !== idsToUpdate.length) {
          throw new Error('One or more submitted answers could not be validated for update')
        }

        // Update each judgment answer
        for (const id of idsToUpdate) {
          const payload = byId[id]!
          await tx
            .update(judgmentsHuman)
            .set({answer: payload.answer, comment: payload.comment ?? null, updatedAt: new Date()})
            .where(
              and(
                eq(judgmentsHuman.id, id),
                eq(judgmentsHuman.user, sessionUserId),
                eq(judgmentsHuman.projectId, body.projectId),
              ),
            )
        }
      })

      return {data: {updated: idsToUpdate.length}}
    },
    {
      body: t.Object({
        projectId: t.String(),
        answers: t.Array(t.Object({judgmentHumanId: t.String(), answer: t.String(), comment: t.Optional(t.String())})),
      }),
    },
  )
