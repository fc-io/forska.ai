import {desc, eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  importRoute as importRouteTable,
  judgments,
  models,
  projectRouteLink,
  projects,
  prompts,
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

    const projectPrompts = await db
      .select()
      .from(prompts)
      .where(eq(prompts.projectId, params.id))
      .orderBy(prompts.order)

    // Check if any judgments exist for these prompts
    let hasJudgedArticles = false
    if (projectPrompts.length > 0) {
      const promptIds = projectPrompts.map((p) => {
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

    return {data: {project, prompts: projectPrompts, hasJudgedArticles, model: projectModel ?? null, importRoutes}}
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

      // Create prompts if provided
      if (newProject && body.prompts && body.prompts.length > 0) {
        await db.insert(prompts).values(
          body.prompts.map(
            (
              prompt: string | {content: string; promptHeading?: string; type?: string; order: number},
              index: number,
            ) => {
              return {
                projectId: newProject.id,
                originalText: typeof prompt === 'string' ? prompt : prompt.content,
                promptHeading: typeof prompt === 'object' ? prompt.promptHeading || null : null,
                type: typeof prompt === 'object' ? prompt.type || null : null,
                order: typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index,
              }
            },
          ),
        )
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

        const [updatedProject] = await tx.update(projects).set(updateData).where(eq(projects.id, params.id)).returning()

        if (!updatedProject) {
          throw new Error('Project not found')
        }

        // Handle prompts updates
        if (body.prompts !== undefined) {
          // Get existing prompts
          const existingPrompts = await tx.select().from(prompts).where(eq(prompts.projectId, params.id))

          const existingPromptIds = new Set(
            existingPrompts.map((p) => {
              return p.id
            }),
          )
          const receivedPromptIds = new Set(
            body.prompts
              .filter((p) => {
                return p.originalId
              })
              .map((p) => {
                return p.originalId
              }),
          )

          // Delete prompts that are no longer in the list
          const promptsToDelete = existingPrompts
            .filter((p) => {
              return !receivedPromptIds.has(p.id)
            })
            .map((p) => {
              return p.id
            })

          for (const promptId of promptsToDelete) {
            await tx.delete(prompts).where(eq(prompts.id, promptId))
          }

          // Process each prompt
          for (const prompt of body.prompts) {
            if (prompt.originalId && existingPromptIds.has(prompt.originalId)) {
              // Update existing prompt
              await tx
                .update(prompts)
                .set({
                  originalText: prompt.originalText,
                  promptHeading: prompt.promptHeading || null,
                  type: prompt.type || null,
                  order: prompt.order,
                  updatedAt: new Date(),
                })
                .where(eq(prompts.id, prompt.originalId))
            } else if (!prompt.originalId && prompt.originalText) {
              // Create new prompt
              await tx
                .insert(prompts)
                .values({
                  projectId: params.id,
                  originalText: prompt.originalText,
                  promptHeading: prompt.promptHeading || null,
                  type: prompt.type || null,
                  order: prompt.order,
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
          .select()
          .from(prompts)
          .where(eq(prompts.projectId, params.id))
          .orderBy(prompts.order)

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
