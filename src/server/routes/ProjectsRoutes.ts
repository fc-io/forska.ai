import {desc, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projects, projectStats, prompts} from '../../db/schema.ts'
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
      return {data: [], error: 'Failed to fetch projects'}
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
  .get('/api/projects/stats', async () => {
    try {
      const db = getDatabase()
      const stats = await db.select().from(projectStats)
      return {data: stats}
    } catch (error) {
      console.error('Error fetching project stats:', error)
      return {data: [], error: 'Failed to fetch project stats'}
    }
  })
