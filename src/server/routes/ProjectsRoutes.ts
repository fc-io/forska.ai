import {desc, eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, projects, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesWithJudgments} from './projectsRoutes/projectsRoutesGetArticlesWithJudgments.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesWithJudgments)
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesPostArticleReviewDetails)
  .get('/api/projects', async () => {
    const db = getDatabase()
    const projectsList = await db
      .select()
      .from(projects)
      .orderBy(desc(projects.createdAt))
    return {data: projectsList}
  })
  .get('/api/projects/:id', async ({params}) => {
    const db = getDatabase()
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, params.id))
      .limit(1)

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

    return {data: {project, prompts: projectPrompts, hasJudgedArticles}}
  })
  .post(
    '/api/projects',
    async ({body}) => {
      const db = getDatabase()

      // Create project
      const [newProject] = await db
        .insert(projects)
        .values({
          name: body.name,
          description: body.description || null,
          ownerId: body.ownerId,
        })
        .returning()

      // Create prompts if provided
      if (newProject && body.prompts && body.prompts.length > 0) {
        await db.insert(prompts).values(
          body.prompts.map(
            (
              prompt:
                | string
                | {
                    content: string
                    promptHeading?: string
                    type?: string
                    order: number
                  },
              index: number,
            ) => {
              return {
                projectId: newProject.id,
                originalText:
                  typeof prompt === 'string' ? prompt : prompt.content,
                promptHeading:
                  typeof prompt === 'object'
                    ? prompt.promptHeading || null
                    : null,
                type: typeof prompt === 'object' ? prompt.type || null : null,
                order:
                  typeof prompt === 'object' && prompt.order !== undefined
                    ? prompt.order
                    : index,
              }
            },
          ),
        )
      }

      return {data: newProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        ownerId: t.String(),
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

      const updateData: Partial<typeof projects.$inferInsert> = {
        updatedAt: new Date(),
      }
      if (body.name !== undefined) updateData.name = body.name
      if (body.description !== undefined)
        updateData.description = body.description

      const [updatedProject] = await db
        .update(projects)
        .set(updateData)
        .where(eq(projects.id, params.id))
        .returning()

      if (!updatedProject) {
        throw new Error('Project not found')
      }

      return {data: updatedProject}
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .patch(
    '/api/projects/:id/edit',
    async ({params, body}) => {
      const db = getDatabase()

      // Start a transaction to ensure data consistency
      const result = await db.transaction(async (tx) => {
        // Update project details
        const updateData: Partial<typeof projects.$inferInsert> = {
          updatedAt: new Date(),
        }
        if (body.name !== undefined) updateData.name = body.name
        if (body.description !== undefined)
          updateData.description = body.description

        const [updatedProject] = await tx
          .update(projects)
          .set(updateData)
          .where(eq(projects.id, params.id))
          .returning()

        if (!updatedProject) {
          throw new Error('Project not found')
        }

        // Handle prompts updates
        if (body.prompts !== undefined) {
          // Get existing prompts
          const existingPrompts = await tx
            .select()
            .from(prompts)
            .where(eq(prompts.projectId, params.id))

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

    const result = await db
      .delete(projects)
      .where(eq(projects.id, params.id))
      .returning()

    if (result.length === 0) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
