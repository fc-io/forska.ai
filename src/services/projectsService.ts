import type {QueryClient} from '@tanstack/solid-query'

import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse.ts'

export type ProjectAccess = {id: string; name: string; archived: boolean}

export const fetchProjects = async () => {
  const response = await apiClient.api.projects.get()

  if (response.error) {
    console.error('Error fetching projects:', response.error)
    throw new Error('Failed to fetch projects')
  }

  return response.data?.data ?? []
}

export const fetchArchivedProjects = async () => {
  const response = await apiClient.api.projects.archived.get()

  if (response.error) {
    console.error('Error fetching archived projects:', response.error)
    throw new Error('Failed to fetch archived projects')
  }

  return response.data?.data ?? []
}

const invalidateProjectsQueries = async (queryClient: QueryClient): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({queryKey: ['projects']}),
    queryClient.invalidateQueries({queryKey: ['projects', 'archived']}),
  ])
}

export const archiveProject = async (queryClient: QueryClient, projectId: string): Promise<void> => {
  const response = await apiClient.api.projects({id: projectId}).delete()

  if (response.error || !response.data?.success) {
    console.error('Error archiving project:', response.error)
    throw new Error('Failed to archive project')
  }

  await invalidateProjectsQueries(queryClient)
}

export const unarchiveProject = async (queryClient: QueryClient, projectId: string): Promise<void> => {
  const response = await apiClient.api.projects({id: projectId}).unarchive.post()

  if (response.error || !response.data?.success) {
    console.error('Error unarchiving project:', response.error)
    throw new Error('Failed to unarchive project')
  }

  await invalidateProjectsQueries(queryClient)
}

export const deleteArchivedProjects = async (queryClient: QueryClient, projectIds: string[]): Promise<void> => {
  const response = await apiClient.api.projects['delete-archived'].post({projectIds})
  const result = handleApiResponse(response, 'Failed to delete archived projects')

  if (!result.success) {
    throw new Error('Failed to delete archived projects')
  }

  await invalidateProjectsQueries(queryClient)
}

export const createProject = async (
  name: string,
  description: string | null,
  modelId: string,
  promptTexts: string[],
) => {
  try {
    const response = await apiClient.api.projects.post({
      name,
      description: description || undefined,
      modelId,
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
    const response = await apiClient.api.projects({id: projectId}).patch(updates)

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

export const fetchProjectAccess = async (projectId: string): Promise<ProjectAccess> => {
  try {
    const response = await apiClient.api.projects({id: projectId}).access.get()

    return handleApiResponse<{data: ProjectAccess}>(response, 'Failed to fetch project access').data
  } catch (err) {
    console.error('Error fetching project access:', err)
    throw err
  }
}

export const cloneProject = async (projectId: string) => {
  try {
    const response = await apiClient.api.projects({id: projectId}).clone.post()

    if (response.error || !response.data?.data) {
      console.error('Error cloning project:', response.error)
      throw new Error('Failed to clone project')
    }

    return response.data.data
  } catch (err) {
    console.error('Error cloning project:', err)
    throw err
  }
}
