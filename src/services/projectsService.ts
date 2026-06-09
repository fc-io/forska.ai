import type {QueryClient} from '@tanstack/solid-query'

import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse.ts'

export type ProjectAccess = {
  archived: boolean
  humanJudgmentMode: 'prompt' | 'summary' | null
  id: string
  name: string
}

export type ProjectListItem = {
  archived: boolean
  createdAt: Date | string | null
  dateFrom: Date | string | null
  dateTo: Date | string | null
  description: string | null
  humanJudgmentMode: 'prompt' | 'summary' | null
  id: string
  modelId: string
  modelName: string | null
  modelProvider: string | null
  modelVersion: string | null
  name: string
  updatedAt: Date | string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ProjectPromptPreview = {
  articleId: string | null
  articleTitle: string | null
  previewText: string | null
  reason: 'conversion_failed' | 'no_articles' | 'no_fulltext' | 'transient_failure' | null
  status: 'ready' | 'unavailable'
  systemPrompt: string | null
  userPrompt: string | null
}

const getResponseData = <T>(
  response: {data?: T | {data: T} | null; error?: unknown; status?: number},
  errorMessage: string,
): T => {
  const result = handleApiResponse<T | {data: T}>(response, errorMessage)

  return typeof result === 'object' && result !== null && 'data' in result
    ? getResponseData<T>({data: result.data}, errorMessage)
    : result
}

const isProjectListItem = (value: unknown): value is ProjectListItem => {
  return (
    typeof value === 'object'
    && value !== null
    && 'archived' in value
    && typeof value.archived === 'boolean'
    && 'humanJudgmentMode' in value
    && (value.humanJudgmentMode === 'prompt'
      || value.humanJudgmentMode === 'summary'
      || value.humanJudgmentMode === null)
    && 'id' in value
    && typeof value.id === 'string'
    && 'modelId' in value
    && typeof value.modelId === 'string'
    && 'name' in value
    && typeof value.name === 'string'
    && 'useAbstract' in value
    && typeof value.useAbstract === 'boolean'
    && 'useFulltext' in value
    && typeof value.useFulltext === 'boolean'
    && 'useFulltextNoImages' in value
    && typeof value.useFulltextNoImages === 'boolean'
    && 'useTitle' in value
    && typeof value.useTitle === 'boolean'
  )
}

const getProjectsListResponseData = (
  response: {data?: unknown; error?: unknown; status?: number},
  errorMessage: string,
) => {
  const result = getResponseData<unknown>(response, errorMessage)

  if (typeof result === 'string' && result.trim().length > 0) {
    throw new Error(result)
  }

  if (!Array.isArray(result)) {
    throw new Error(`${errorMessage}: invalid project list response`)
  }

  if (
    result.some((project) => {
      return !isProjectListItem(project)
    })
  ) {
    throw new Error(`${errorMessage}: invalid project list response`)
  }

  return result as ProjectListItem[]
}

export const fetchProjects = async () => {
  const response = await apiClient.api.projects.get()

  return getProjectsListResponseData(response, 'Failed to fetch projects')
}

export const fetchArchivedProjects = async () => {
  const response = await apiClient.api.projects.archived.get()

  return getProjectsListResponseData(response, 'Failed to fetch archived projects')
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

    return getResponseData(response, 'Project not found')
  } catch (err) {
    console.error('Error fetching project with prompts:', err)
    throw err
  }
}

export const fetchProjectPromptPreview = async (projectId: string, promptId: string): Promise<ProjectPromptPreview> => {
  try {
    const response = await apiClient.api.projects({id: projectId}).prompts({promptId}).preview.get()

    return getResponseData(response, 'Failed to fetch project prompt preview')
  } catch (err) {
    console.error('Error fetching project prompt preview:', err)
    throw err
  }
}

export const fetchProjectAccess = async (projectId: string): Promise<ProjectAccess> => {
  try {
    const response = await apiClient.api.projects({id: projectId}).access.get()

    return getResponseData(response, 'Failed to fetch project access')
  } catch (err) {
    console.error('Error fetching project access:', err)
    throw err
  }
}

export const cloneProject = async (queryClient: QueryClient, projectId: string) => {
  try {
    const response = await apiClient.api.projects({id: projectId}).clone.post()

    if (response.error || !response.data?.data) {
      console.error('Error cloning project:', response.error)
      throw new Error('Failed to clone project')
    }

    await invalidateProjectsQueries(queryClient)

    return response.data.data
  } catch (err) {
    console.error('Error cloning project:', err)
    throw err
  }
}
