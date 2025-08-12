import {apiClient} from './apiClient.ts'

export const fetchProjects = async () => {
  try {
    const response = await apiClient.api.projects.get()

    if (response.error) {
      console.error('Error fetching projects:', response.error)
      throw new Error('Failed to fetch projects')
    }

    if (!response.data?.data) {
      return []
    }

    return response.data.data
  } catch (err) {
    console.error('Error fetching projects:', err)
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
) => {
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

    return response.data.data
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
) => {
  try {
    const response = await apiClient.api
      .projects({id: projectId})
      .patch(updates)

    if (response.error || !response.data?.data) {
      console.error('Error updating project:', response.error)
      throw new Error('Project not found or update failed')
    }

    return response.data.data
  } catch (err) {
    console.error('Error updating project:', err)
    throw err
  }
}

export const fetchProjectWithPrompts = async (projectId: string) => {
  try {
    const response = await apiClient.api.projects({id: projectId}).get()

    if (response.error || !response.data?.data) {
      console.error('Error fetching project:', response.error)
      throw new Error('Project not found')
    }

    return response.data.data
  } catch (err) {
    console.error('Error fetching project with prompts:', err)
    throw err
  }
}
