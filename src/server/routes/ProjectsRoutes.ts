import {Elysia, t} from 'elysia'

import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchProjectStats,
  fetchProjectWithPrompts,
  updateProject,
} from '../../services/projectsService.ts'

export const projectsRoutes = new Elysia()
  .get('/api/projects', async () => {
    try {
      const projects = await fetchProjects()
      return {data: projects}
    } catch (error) {
      console.error('Error fetching projects:', error)
      return {data: [], error: 'Failed to fetch projects'}
    }
  })
  .get('/api/projects/:id', async ({params}) => {
    try {
      const projectWithPrompts = await fetchProjectWithPrompts(params.id)
      return {data: projectWithPrompts}
    } catch (error) {
      console.error('Error fetching project:', error)
      return {data: null, error: 'Failed to fetch project'}
    }
  })
  .post(
    '/api/projects',
    async ({body}) => {
      try {
        const project = await createProject(
          body.name,
          body.description || null,
          body.ownerId,
          body.prompts || [],
        )
        return {data: project}
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
        const project = await updateProject(params.id, body)
        return {data: project}
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
      await deleteProject(params.id)
      return {success: true}
    } catch (error) {
      console.error('Error deleting project:', error)
      return {success: false, error: 'Failed to delete project'}
    }
  })
  .get('/api/projects/stats', async () => {
    try {
      const stats = await fetchProjectStats()
      return {data: stats}
    } catch (error) {
      console.error('Error fetching project stats:', error)
      return {data: [], error: 'Failed to fetch project stats'}
    }
  })
