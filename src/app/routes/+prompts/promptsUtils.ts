import type {QueryClient} from '@tanstack/solid-query'

import {apiClient} from '../../../services/apiClient'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

export type PromptListItem = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: string | Date
  updatedAt: string | Date
  archived: boolean
}

type PromptsResponse = {data: PromptListItem[]}
type PromptUpdateResponse = {data: PromptListItem | null}

export const fetchActivePrompts = async (): Promise<PromptListItem[]> => {
  const response = await apiClient.api.prompts.get()
  const result = handleApiResponse<PromptsResponse>(response, 'Failed to load prompts')
  return result.data ?? []
}

export const fetchArchivedPrompts = async (): Promise<PromptListItem[]> => {
  const response = await apiClient.api.prompts.archived.get()
  const result = handleApiResponse<PromptsResponse>(response, 'Failed to load archived prompts')
  return result.data ?? []
}

const invalidatePromptsQueries = async (queryClient: QueryClient): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({queryKey: ['prompts']}),
    queryClient.invalidateQueries({queryKey: ['prompts', 'archived']}),
  ])
}

export const setPromptArchived = async (
  queryClient: QueryClient,
  promptId: string,
  archived: boolean,
): Promise<void> => {
  const response = await apiClient.api.prompts({id: promptId}).patch({archived})
  handleApiResponse<PromptUpdateResponse>(response, 'Failed to update prompt')
  await invalidatePromptsQueries(queryClient)
}

export const formatPromptTimestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export const getPromptDisplayText = (text: string): string => {
  return text.trim()
}

export const isPromptPreviewTruncated = (text: string, maxLength = 240): boolean => {
  return getPromptDisplayText(text).length > maxLength
}

export const getPromptPreview = (text: string, maxLength = 240): string => {
  const displayText = getPromptDisplayText(text)
  return displayText.length <= maxLength ? displayText : `${displayText.slice(0, Math.max(0, maxLength - 1))}…`
}
