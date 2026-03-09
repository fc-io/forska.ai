import {apiClient} from './apiClient.ts'

export type CreateComparisonProjectInput = {
  name: string
  description?: string | null
  ownerId: string
  modelIds?: string[]
  compareWithHumans?: boolean
  dateFrom?: string | null
  dateTo?: string | null
  useTitle?: boolean
  useAbstract?: boolean
  useFulltext?: boolean
  useFulltextNoImages?: boolean
  importRoutes?: string[]
  promptSelections?: Array<{promptId: string; order: number}>
}

export type ComparisonProjectJudgmentsColumn = {
  id: string
  kind: 'llm' | 'human'
  promptId: string
  promptLabel: string
  modelId: string | null
  modelLabel: string
}

export type ComparisonProjectJudgmentsMetadata = {
  id: string
  name: string
  description: string | null
  compareWithHumans: boolean
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | string | null
  dateTo: Date | string | null
  archived: boolean
  createdAt: Date | string
  prompts: Array<{id: string; promptHeading: string | null; promptLabel: string; order: number}>
  models: Array<{id: string; name: string}>
  columns: ComparisonProjectJudgmentsColumn[]
}

export type ComparisonProjectJudgmentsRow = {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | string | null
  cells: Record<string, string | null>
}

export type ComparisonProjectJudgmentsPage = {
  data: ComparisonProjectJudgmentsRow[]
  totalCount: number
  page: number
  limit: number
  totalPages: number
}

const getResponseData = <T>(response: {data?: {data?: T | null} | null; error?: unknown}, errorMessage: string) => {
  if (response.error || !response.data?.data) {
    console.error(errorMessage, response.error)
    throw new Error(errorMessage)
  }

  return response.data.data
}

export const fetchComparisonProjects = async () => {
  const response = await apiClient.api['comparison-projects'].get()

  if (response.error) {
    console.error('Error fetching comparison projects:', response.error)
    throw new Error('Failed to fetch comparison projects')
  }

  return response.data?.data ?? []
}

export const fetchArchivedComparisonProjects = async () => {
  const response = await apiClient.api['comparison-projects'].archived.get()

  if (response.error) {
    console.error('Error fetching archived comparison projects:', response.error)
    throw new Error('Failed to fetch archived comparison projects')
  }

  return response.data?.data ?? []
}

export const createComparisonProject = async (input: CreateComparisonProjectInput) => {
  const response = await apiClient.api['comparison-projects'].post(input)

  return getResponseData(response, 'Failed to create comparison project')
}

export const fetchComparisonProjectJudgmentsMetadata = async (comparisonProjectId: string) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).get()

  return getResponseData<ComparisonProjectJudgmentsMetadata>(response, 'Failed to fetch comparison project')
}

export const fetchComparisonProjectJudgmentsPage = async (
  comparisonProjectId: string,
  page: number,
  limit: number,
  hideSparseRows?: boolean,
  showOnlyFullyAnsweredPrompts?: boolean,
  showOnlyModelDifferences?: boolean,
) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).judgments.post({
    page: String(page),
    limit: String(limit),
    hideSparseRows,
    showOnlyFullyAnsweredPrompts,
    showOnlyModelDifferences,
  })

  return getResponseData<ComparisonProjectJudgmentsPage>(response, 'Failed to fetch comparison project judgments')
}

export const archiveComparisonProject = async (comparisonProjectId: string): Promise<void> => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).delete()

  if (response.error || !response.data?.success) {
    console.error('Error archiving comparison project:', response.error)
    throw new Error('Failed to archive comparison project')
  }
}

export const unarchiveComparisonProject = async (comparisonProjectId: string): Promise<void> => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).unarchive.post()

  if (response.error || !response.data?.success) {
    console.error('Error unarchiving comparison project:', response.error)
    throw new Error('Failed to unarchive comparison project')
  }
}
