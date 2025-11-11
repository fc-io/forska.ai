import {desc, eq, inArray, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  importRoute as importRouteTable,
  judgments,
  judgmentsJobs,
  models,
  projectRouteLink,
  projects,
  prompts,
  projectPrompts,
} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsBoth} from './projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesReviewsHuman} from './projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts'
import {projectsRoutesGetArticlesReviewsHumanFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts'
import {projectsRoutesGetArticlesReviewsUnassessed} from './projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts'
import {projectsRoutesGetArticlesWithJudgments} from './projectsRoutes/projectsRoutesGetArticlesWithJudgments.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesWithJudgments)
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsBoth)
  .use(projectsRoutesGetArticlesReviewsHuman)
  .use(projectsRoutesGetArticlesReviewsUnassessed)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesGetArticlesReviewsHumanFilters)
  .use(projectsRoutesPostArticleReviewDetails)
  .get('/api/projects-without-jobs', async () => {
    const db = getDatabase()
    const rows = await db
      .select({id: projects.id, name: projects.name, description: projects.description})
      .from(projects)
      .leftJoin(judgmentsJobs, eq(judgmentsJobs.projectId, projects.id))
      .where(isNull(judgmentsJobs.id))
      .orderBy(desc(projects.createdAt))

    return {data: rows}
  })
  .get('/api/projects', async () => {
    const db = getDatabase()
    const projectsList = await db.select().from(projects).orderBy(desc(projects.createdAt))
    return {data: projectsList}
  })
  .get('/api/projects/:id', async ({params}) => {
    const db = getDatabase()
    const [project] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)

    if (!project) {
      throw new Error('Project not found')
    }

    const projectPromptsList = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        transformedText: prompts.transformedText,
        promptHeading: prompts.promptHeading,
        order: projectPrompts.order,
        archived: projectPrompts.archived,
        type: prompts.type,
      })
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(eq(projectPrompts.projectId, params.id))
      .orderBy(projectPrompts.order)

    // Check if any judgments exist for these prompts
    let hasJudgedArticles = false
    if (projectPromptsList.length > 0) {
      const promptIds = projectPromptsList.map((p) => {
        return p.id
      })
      const existingJudgments = await db
        .select({id: judgments.id})
        .from(judgments)
        .where(inArray(judgments.promptId, promptIds))
        .limit(1)

      hasJudgedArticles = existingJudgments.length > 0
    }

    // Fetch selected model for this project
    const [projectModel] = await db
      .select({
        id: models.id,
        name: models.name,
        provider: models.provider,
        modelName: models.modelName,
        baseURL: models.baseURL,
        version: models.version,
      })
      .from(models)
      .where(eq(models.id, project.modelId))
      .limit(1)

    // Fetch linked import routes for this project via projectRouteLink
    const linkedImportRoutes = await db
      .select({route: importRouteTable.route})
      .from(projectRouteLink)
      .innerJoin(importRouteTable, eq(projectRouteLink.importRouteId, importRouteTable.id))
      .where(eq(projectRouteLink.projectId, params.id))

    const importRoutes = linkedImportRoutes.map((r) => {
      return r.route
    })

    return {data: {project, prompts: projectPromptsList, hasJudgedArticles, model: projectModel ?? null, importRoutes}}
  })
  .post(
    '/api/projects',
    async ({body}) => {
      const db = getDatabase()

      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [validModel] = await db.select({id: models.id}).from(models).where(eq(models.id, body.modelId)).limit(1)

      if (!validModel) {
        throw new Error('Selected model does not exist')
      }

      // Create project
      const [newProject] = await db
        .insert(projects)
        .values({
          name: body.name,
          description: body.description || null,
          ownerId: body.ownerId,
          modelId: body.modelId,
          useTitle: body.useTitle ?? true,
          useAbstract: body.useAbstract ?? true,
          useFulltext: body.useFulltext ?? false,
          dateFrom,
          dateTo,
        })
        .returning()

      // Create prompts associations if provided (global immutable prompts; upsert by hash incl metadata)
      if (newProject && body.prompts && body.prompts.length > 0) {
        for (let index = 0; index < body.prompts.length; index++) {
          const prompt = body.prompts[index] as string | {content: string; promptHeading?: string; type?: string; order: number}
          const content = typeof prompt === 'string' ? prompt : prompt.content
          const heading = typeof prompt === 'object' ? prompt.promptHeading || null : null
          const typeVal = typeof prompt === 'object' ? prompt.type || null : null
          const orderVal = typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index

          // Find existing prompt by DB-computed content hash (includes metadata)
          const existingByHash = await db
            .execute<{id: string}>(
              sql`SELECT id FROM "prompts" WHERE content_hash = compute_prompt_content_hash(${content}, ${null}, ${heading}, ${typeVal}) LIMIT 1`,
            )
            .then((res) => res.rows)

          const promptId = existingByHash[0]?.id
            ? existingByHash[0]!.id
            : (
                await db
                  .insert(prompts)
                  .values({originalText: content, transformedText: null, promptHeading: heading, type: typeVal})
                  .returning({id: prompts.id})
              )[0]!.id

          await db.insert(projectPrompts).values({
            projectId: newProject.id,
            promptId,
            order: orderVal,
            archived: false,
          })
        }
      }

      // Link selected import routes to the project
      if (newProject && body.importRoutes && body.importRoutes.length > 0) {
        const selectedRoutes = Array.from(
          new Set(
            body.importRoutes.filter((r) => {
              return typeof r === 'string' && r.trim() !== ''
            }),
          ),
        )

        if (selectedRoutes.length > 0) {
          const routeRows = await db
            .select({id: importRouteTable.id, route: importRouteTable.route})
            .from(importRouteTable)
            .where(inArray(importRouteTable.route, selectedRoutes))

          if (routeRows.length !== selectedRoutes.length) {
            throw new Error('One or more selected import routes are invalid')
          }

          await db.insert(projectRouteLink).values(
            routeRows.map((r) => {
              return {projectId: newProject.id, importRouteId: r.id}
            }),
          )
        }
      }

      // Linking datasources to projects removed

      return {data: newProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        ownerId: t.String(),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Union([
            t.Array(t.String()),
            t.Array(
              t.Object({
                content: t.String(),
                promptHeading: t.Optional(t.String()),
                type: t.Optional(t.String()),
                order: t.Number(),
              }),
            ),
          ]),
        ),
      }),
    },
  )
  .patch(
    '/api/projects/:id',
    async ({params, body}) => {
      const db = getDatabase()

      const updateData: Partial<typeof projects.$inferInsert> = {updatedAt: new Date()}
      if (body.name !== undefined) updateData.name = body.name
      if (body.description !== undefined) updateData.description = body.description

      const [updatedProject] = await db.update(projects).set(updateData).where(eq(projects.id, params.id)).returning()

      if (!updatedProject) {
        throw new Error('Project not found')
      }

      return {data: updatedProject}
    },
    {body: t.Object({name: t.Optional(t.String()), description: t.Optional(t.Union([t.String(), t.Null()]))})},
  )
  .patch(
    '/api/projects/:id/edit',
    async ({params, body}) => {
      const db = getDatabase()

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      // Start a transaction to ensure data consistency
      const result = await db.transaction(async (tx) => {
        // Update project details
        const updateData: Partial<typeof projects.$inferInsert> = {updatedAt: new Date()}
        if (body.name !== undefined) updateData.name = body.name
        if (body.description !== undefined) updateData.description = body.description
        if (parsedDateFrom !== undefined) updateData.dateFrom = parsedDateFrom
        if (parsedDateTo !== undefined) updateData.dateTo = parsedDateTo
        if (body.modelId !== undefined) {
          const [validModel] = await tx.select({id: models.id}).from(models).where(eq(models.id, body.modelId)).limit(1)
          if (!validModel) {
            throw new Error('Selected model does not exist')
          }
          updateData.modelId = body.modelId
        }
        if (body.useTitle !== undefined) updateData.useTitle = body.useTitle
        if (body.useAbstract !== undefined) updateData.useAbstract = body.useAbstract
        if (body.useFulltext !== undefined) updateData.useFulltext = body.useFulltext

        const [updatedProject] = await tx.update(projects).set(updateData).where(eq(projects.id, params.id)).returning()

        if (!updatedProject) {
          throw new Error('Project not found')
        }

        // Handle prompts updates against associations (immutable prompts)
        if (body.prompts !== undefined) {
          // Existing associations
          const existing = await tx
            .select({
              id: projectPrompts.id,
              promptId: projectPrompts.promptId,
            })
            .from(projectPrompts)
            .where(eq(projectPrompts.projectId, params.id))

          const existingPromptIds = new Set(existing.map((p) => p.promptId))
          const receivedOriginalIds = new Set(
            body.prompts
              .filter((p) => {
                return p.originalId
              })
              .map((p) => p.originalId!),
          )

          // Delete associations removed by client
          const toDeleteAssoc = existing.filter((e) => {
            return !receivedOriginalIds.has(e.promptId)
          })
          if (toDeleteAssoc.length > 0) {
            await tx
              .delete(projectPrompts)
              .where(
                sql`${projectPrompts.projectId} = ${params.id} AND ${projectPrompts.promptId} = ANY(ARRAY[${sql.join(
                  toDeleteAssoc.map((e) => sql`${e.promptId}::uuid`),
                  sql`,`,
                )}] )`,
              )
          }

          // Upsert associations and prompt rows
          for (const p of body.prompts) {
            const heading = p.promptHeading || null
            const typeVal = p.type || null
            const orderVal = p.order
            let targetPromptId: string
            if (p.originalId) {
              // Block attempts to edit immutable metadata for existing prompts via app
              if (p.promptHeading !== undefined || p.type !== undefined) {
                throw new Error('Editing prompt metadata is not allowed; prompts are global and immutable')
              }
              // If text unchanged, keep existing prompt id
              const [existingPrompt] = await tx.select().from(prompts).where(eq(prompts.id, p.originalId)).limit(1)
              const existingByHash = await tx
                .execute<{id: string}>(
                  sql`SELECT id FROM "prompts" WHERE content_hash = compute_prompt_content_hash(${p.originalText}, ${null}, ${existingPrompt?.promptHeading ?? null}, ${existingPrompt?.type ?? null}) LIMIT 1`,
                )
                .then((res) => res.rows)
              if (existingPrompt && existingByHash[0]?.id === existingPrompt.id) {
                targetPromptId = existingPrompt.id
              } else {
                const found = await tx
                  .execute<{id: string}>(
                    sql`SELECT id FROM "prompts" WHERE content_hash = compute_prompt_content_hash(${p.originalText}, ${null}, ${heading}, ${typeVal}) LIMIT 1`,
                  )
                  .then((res) => res.rows)
                targetPromptId = found[0]?.id
                  ? found[0].id
                  : (
                      await tx
                        .insert(prompts)
                        .values({originalText: p.originalText, transformedText: null, promptHeading: heading, type: typeVal})
                        .returning({id: prompts.id})
                    )[0]!.id
              }
              // Ensure association points to target prompt and metadata is updated
              await tx
                .update(projectPrompts)
                .set({promptId: targetPromptId, order: orderVal, updatedAt: new Date()})
                .where(sql`${projectPrompts.projectId} = ${params.id} AND ${projectPrompts.promptId} = ${p.originalId}`)
            } else {
              const found = await tx
                .execute<{id: string}>(
                  sql`SELECT id FROM "prompts" WHERE content_hash = compute_prompt_content_hash(${p.originalText}, ${null}, ${heading}, ${typeVal}) LIMIT 1`,
                )
                .then((res) => res.rows)
              targetPromptId = found[0]?.id
                ? found[0].id
                : (
                    await tx
                      .insert(prompts)
                      .values({originalText: p.originalText, transformedText: null, promptHeading: heading, type: typeVal})
                      .returning({id: prompts.id})
                  )[0]!.id

              await tx.insert(projectPrompts).values({
                projectId: params.id,
                promptId: targetPromptId,
                order: orderVal,
                archived: false,
              })
            }
          }
        }

        // Update import route links if provided
        if (body.importRoutes !== undefined) {
          const selectedRoutes = Array.from(
            new Set(
              body.importRoutes.filter((r) => {
                return typeof r === 'string' && r.trim() !== ''
              }),
            ),
          )

          // Clear existing links then (re)insert selected
          await tx.delete(projectRouteLink).where(eq(projectRouteLink.projectId, params.id))

          if (selectedRoutes.length > 0) {
            const routeRows = await tx
              .select({id: importRouteTable.id, route: importRouteTable.route})
              .from(importRouteTable)
              .where(inArray(importRouteTable.route, selectedRoutes))

            if (routeRows.length !== selectedRoutes.length) {
              throw new Error('One or more selected import routes are invalid')
            }

            await tx.insert(projectRouteLink).values(
              routeRows.map((r) => {
                return {projectId: params.id, importRouteId: r.id}
              }),
            )
          }
        }

        // Fetch updated prompts
        const updatedPrompts = await tx
          .select({
            id: prompts.id,
            originalText: prompts.originalText,
            transformedText: prompts.transformedText,
            promptHeading: prompts.promptHeading,
            order: projectPrompts.order,
            archived: projectPrompts.archived,
            type: prompts.type,
          })
          .from(projectPrompts)
          .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
          .where(eq(projectPrompts.projectId, params.id))
          .orderBy(projectPrompts.order)

        return {project: updatedProject, prompts: updatedPrompts}
      })

      return {data: result}
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        modelId: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Array(
            t.Object({
              originalId: t.Optional(t.String()),
              originalText: t.String(),
              promptHeading: t.Optional(t.String()),
              type: t.Optional(t.String()),
              order: t.Number(),
            }),
          ),
        ),
      }),
    },
  )
  .delete('/api/projects/:id', async ({params}) => {
    const db = getDatabase()

    const result = await db.delete(projects).where(eq(projects.id, params.id)).returning()

    if (result.length === 0) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
