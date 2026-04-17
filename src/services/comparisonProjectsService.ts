import type {HumanJudgmentMode, ProjectPromptCriteriaDisposition} from '../db/schemaTypes.ts'
import type {
  ComparisonProjectDifferenceColumn,
  ComparisonProjectDifferenceFilter,
} from '../utils/comparisonProjectDifferenceFilter.ts'
import {apiClient} from './apiClient.ts'

export type CreateComparisonProjectInput = {
  name: string
  description?: string | null
  modelIds?: string[]
  compareWithHumans?: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  importRoutes?: string[]
  promptSelections?: Array<{promptId: string; order: number}>
}

export type CreateComparisonProjectFromProjectInput = {
  name: string
  description?: string | null
  compareWithHumans?: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  sourceProjectId: string
}

export type ComparisonProjectSource = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  isSummaryCapable: boolean
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: Array<{
    id: string
    promptHeading: string | null
    order: number
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>
  importRoutes: Array<{route: string; name: string | null}>
}

export type ComparisonProjectEditFormData = {
  id: string
  name: string
  description: string | null
  compareWithHumans: boolean
  humanJudgmentMode: HumanJudgmentMode
  summarySourceProjectId: string | null
  updatedAt: Date | string
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  selectedModelIds: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  promptSelections: Array<{promptId: string; order: number}>
  availablePrompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    type: string | null
    createdAt: Date | string
    archived: boolean
  }>
}

export type UpdateComparisonProjectInput = {
  name: string
  description?: string | null
  compareWithHumans: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  modelIds?: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  promptSelections: Array<{promptId: string; order: number}>
}

export type ComparisonProjectJudgmentsColumn = ComparisonProjectDifferenceColumn & {
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
}

export type ComparisonProjectContentVariant = {key: string; label: string}

export type ComparisonProjectSummarySourceProject = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export type ComparisonProjectJudgmentsMetadata = {
  id: string
  name: string
  description: string | null
  compareWithHumans: boolean
  humanJudgmentMode: HumanJudgmentMode
  summarySourceProjectId: string | null
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  archived: boolean
  createdAt: Date | string
  importRouteIds: string[]
  contentVariants: ComparisonProjectContentVariant[]
  prompts: Array<{
    id: string
    promptHeading: string | null
    promptLabel: string
    order: number
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  }>
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

export const fetchComparisonProjectSources = async () => {
  const response = await apiClient.api['comparison-projects'].sources.get()

  return getResponseData<ComparisonProjectSource[]>(response, 'Failed to fetch comparison project sources')
}

export const createComparisonProjectFromProject = async (input: CreateComparisonProjectFromProjectInput) => {
  const response = await apiClient.api['comparison-projects']['from-project'].post(input)

  return getResponseData(response, 'Failed to create comparison project from project')
}

export const fetchComparisonProjectJudgmentsMetadata = async (comparisonProjectId: string) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).get()

  return getResponseData<ComparisonProjectJudgmentsMetadata>(response, 'Failed to fetch comparison project')
}

export const fetchComparisonProjectEditFormData = async (comparisonProjectId: string) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).edit.get()

  return getResponseData<ComparisonProjectEditFormData>(response, 'Failed to fetch comparison project edit data')
}

export const fetchComparisonProjectJudgmentsPage = async (
  comparisonProjectId: string,
  page: number,
  limit: number,
  hideSparseRows?: boolean,
  showOnlyFullyAnsweredPrompts?: boolean,
  differenceFilter?: ComparisonProjectDifferenceFilter,
) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).judgments.post({
    page: String(page),
    limit: String(limit),
    hideSparseRows,
    showOnlyFullyAnsweredPrompts,
    differenceFilter,
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

export const updateComparisonProject = async (comparisonProjectId: string, input: UpdateComparisonProjectInput) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).patch(input)

  return getResponseData(response, 'Failed to update comparison project')
}
