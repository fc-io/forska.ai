import {desc, eq, inArray, notInArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, projects, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const projectsRoutes = new Elysia()
  .get('/api/projects', async () => {
    try {
      const db = getDatabase()
      const projectsList = await db
        .select()
        .from(projects)
        .orderBy(desc(projects.createdAt))
      return {data: projectsList}
    } catch (error) {
      console.error('Error fetching projects:', error)
      return {
        data: [] as (typeof projects.$inferSelect)[],
        error: 'Failed to fetch projects',
      }
    }
  })
  .get('/api/projects/:id', async ({params}) => {
    try {
      const db = getDatabase()
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, params.id))
        .limit(1)

      if (!project) {
        return {data: null, error: 'Project not found'}
      }

      const projectPrompts = await db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, params.id))
        .orderBy(prompts.order)

      return {data: {project, prompts: projectPrompts}}
    } catch (error) {
      console.error('Error fetching project:', error)
      return {data: null, error: 'Failed to fetch project'}
    }
  })
  .post(
    '/api/projects',
    async ({body}) => {
      try {
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
            body.prompts.map((promptText: string, index: number) => {
              return {
                projectId: newProject.id,
                originalText: promptText,
                order: index,
              }
            }),
          )
        }

        return {data: newProject}
      } catch (error) {
        console.error('Error creating project:', error)
        return {data: null, error: 'Failed to create project'}
      }
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        ownerId: t.String(),
        prompts: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .patch(
    '/api/projects/:id',
    async ({params, body}) => {
      try {
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
          return {data: null, error: 'Project not found'}
        }

        return {data: updatedProject}
      } catch (error) {
        console.error('Error updating project:', error)
        return {data: null, error: 'Failed to update project'}
      }
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
      try {
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
              if (
                prompt.originalId
                && existingPromptIds.has(prompt.originalId)
              ) {
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
      } catch (error) {
        console.error('Error updating project:', error)
        return {
          data: null,
          error:
            error instanceof Error ? error.message : 'Failed to update project',
        }
      }
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
    try {
      const db = getDatabase()

      const result = await db
        .delete(projects)
        .where(eq(projects.id, params.id))
        .returning()

      if (result.length === 0) {
        return {success: false, error: 'Project not found'}
      }

      return {success: true}
    } catch (error) {
      console.error('Error deleting project:', error)
      return {success: false, error: 'Failed to delete project'}
    }
  })
  .post(
    '/api/projects/judgables',
    async ({body}) => {
      try {
        const db = getDatabase()

        // Get project and its prompts
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, body.projectId))
          .limit(1)

        if (!project) {
          return {
            data: [] as (typeof articles.$inferSelect)[],
            error: 'Project not found',
          }
        }

        const projectPrompts = await db
          .select()
          .from(prompts)
          .where(eq(prompts.projectId, body.projectId))

        if (projectPrompts.length === 0) {
          // No prompts, return latest articles
          const latestArticles = await db
            .select()
            .from(articles)
            .orderBy(desc(articles.articleUpdatedAt))
            .limit(body.numberOfArticlesToGet)

          return {data: latestArticles}
        }

        // Get all judgments for all prompts in this project
        const allJudgments = await db
          .select({
            articleId: judgments.articleId,
            promptId: judgments.promptId,
          })
          .from(judgments)
          .where(
            inArray(
              judgments.promptId,
              projectPrompts.map((p) => {
                return p.id
              }),
            ),
          )

        // Find articles that have been judged by ALL prompts
        const articleJudgmentCounts = allJudgments.reduce(
          (acc, judgment) => {
            const articleId = judgment.articleId
            if (!acc[articleId]) {
              acc[articleId] = new Set()
            }
            acc[articleId].add(judgment.promptId)
            return acc
          },
          {} as Record<string, Set<string>>,
        )

        const fullyJudgedArticleIds = Object.entries(articleJudgmentCounts)
          .filter(([_, promptIds]) => {
            return promptIds.size === projectPrompts.length
          })
          .map(([articleId]) => {
            return articleId
          })

        // Get latest articles excluding those already judged by all prompts
        let query = db
          .select()
          .from(articles)
          .orderBy(desc(articles.articleUpdatedAt))
          .limit(body.numberOfArticlesToGet)

        if (fullyJudgedArticleIds.length > 0) {
          query = query.where(notInArray(articles.id, fullyJudgedArticleIds))
        }

        const articlesToJudge = await query

        return {data: articlesToJudge}
      } catch (error) {
        console.error('Error fetching articles to judge:', error)
        return {
          data: [] as (typeof articles.$inferSelect)[],
          error: 'Failed to fetch articles to judge',
        }
      }
    },
    {
      body: t.Object({
        numberOfArticlesToGet: t.Number(),
        projectId: t.String(),
      }),
    },
  )
