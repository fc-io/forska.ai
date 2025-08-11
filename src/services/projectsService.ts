import {type} from 'arktype'

import {apiClient} from './apiClient.ts'

// Arktype schema for Project validation
export const projectSchema = type({
  id: 'string',
  name: 'string',
  description: 'string | null',
  ownerId: 'string',
  createdAt: 'Date',
  updatedAt: 'Date',
})

// Arktype schema for Prompt validation
export const promptSchema = type({
  id: 'string',
  originalText: 'string',
  transformedText: 'string | null',
  projectId: 'string',
  order: 'number | null',
  archived: 'boolean',
  createdAt: 'Date',
  updatedAt: 'Date',
  promptHeading: 'string | null',
})

const projectsArraySchema = type(projectSchema, '[]')
const promptsArraySchema = type(promptSchema, '[]')

// Schema for project with prompts
export const projectWithPromptsSchema = type({
  project: projectSchema,
  prompts: promptsArraySchema,
})

export type Project = typeof projectSchema.infer
export type Prompt = typeof promptSchema.infer
export type ProjectWithPrompts = typeof projectWithPromptsSchema.infer

export const fetchProjects = async (): Promise<Project[]> => {
  try {
    const response = await apiClient.api.projects.get()
    debugger
    if (response.error) {
      console.error('Error fetching projects:', response.error)
      throw new Error('Failed to fetch projects')
    }

    if (!response.data?.data) {
      return []
    }

    // Validate response using arktype
    const validation = projectsArraySchema(response.data.data)
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(
        `Invalid project data received from API: ${validation.summary}`,
      )
    }

    return validation
  } catch (err) {
    console.error('Error fetching projects:', err)
    throw err
  }
}

export const fetchProjectStats = async (): Promise<any[]> => {
  try {
    const response = await apiClient.api.projects.stats.get()

    if (response.error) {
      console.error('Error fetching project stats:', response.error)
      throw new Error('Failed to fetch project stats')
    }

    return response.data?.data || []
  } catch (err) {
    console.error('Error fetching project stats:', err)
    throw err
  }
}

export const deleteProject = async (projectId: string): Promise<void> => {
  try {
    const response = await apiClient.api.projects({id: projectId}).delete()

    if (response.error || !response.data?.success) {
      console.error('Error deleting project:', response.error)
      throw new Error('Failed to delete project')
    }
  } catch (err) {
    console.error('Error deleting project:', err)
    throw err
  }
}

export const createProject = async (
  name: string,
  description: string | null,
  ownerId: string,
  promptTexts: string[],
): Promise<Project> => {
  try {
    const response = await apiClient.api.projects.post({
      name,
      description: description || undefined,
      ownerId,
      prompts: promptTexts.length > 0 ? promptTexts : undefined,
    })

    if (response.error || !response.data?.data) {
      console.error('Error creating project:', response.error)
      throw new Error('Failed to create project')
    }

    // Validate and return the project
    const validation = projectSchema(response.data.data)
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(`Invalid project data created: ${validation.summary}`)
    }

    return validation
  } catch (err) {
    console.error('Error creating project:', err)
    throw err
  }
}

// updatePrompts functionality should be handled server-side
// This function was removed as part of moving to RPC architecture

export const updateProject = async (
  projectId: string,
  updates: Partial<{name: string; description: string | null}>,
): Promise<Project> => {
  try {
    const response = await apiClient.api
      .projects({id: projectId})
      .patch(updates)

    if (response.error || !response.data?.data) {
      console.error('Error updating project:', response.error)
      throw new Error('Project not found or update failed')
    }

    const validation = projectSchema(response.data.data)
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(
        `Invalid project data after update: ${validation.summary}`,
      )
    }

    return validation
  } catch (err) {
    console.error('Error updating project:', err)
    throw err
  }
}

export const fetchProjectWithPrompts = async (
  projectId: string,
): Promise<ProjectWithPrompts> => {
  try {
    const response = await apiClient.api.projects({id: projectId}).get()

    if (response.error || !response.data?.data) {
      console.error('Error fetching project:', response.error)
      throw new Error('Project not found')
    }

    // Validate the combined result
    const resultValidation = projectWithPromptsSchema(response.data.data)
    if (resultValidation instanceof type.errors) {
      console.error(
        'Project with prompts validation errors:',
        resultValidation.summary,
      )
      throw new Error(
        `Invalid project with prompts data: ${resultValidation.summary}`,
      )
    }

    return resultValidation
  } catch (err) {
    console.error('Error fetching project with prompts:', err)
    throw err
  }
}
