import type {
  ComparisonProjectServingStatus,
  HumanJudgmentMode,
  ProjectPromptCriteriaDisposition,
} from '../db/schemaTypes.ts'
import type {
  ComparisonProjectDifferenceColumn,
  ComparisonProjectDifferenceFilter,
} from '../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../utils/comparisonProjectRowFilter.ts'
import {apiClient} from './apiClient.ts'

export type CreateComparisonProjectInput = {
  name: string
  description?: string | null
  modelIds?: string[]
  compareWithHumans?: boolean
  allowConflictResolution?: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  importRoutes?: string[]
  sourceProjectIds?: string[]
  promptSelections?: Array<{promptId: string; order: number}>
}

export type CreateComparisonProjectFromProjectInput = {
  name: string
  description?: string | null
  compareWithHumans?: boolean
  allowConflictResolution?: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  sourceProjectId: string
  sourceProjectIds?: string[]
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
  allowConflictResolution: boolean
  humanJudgmentMode: HumanJudgmentMode
  summarySourceProjectId: string | null
  updatedAt: Date | string
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  selectedModelIds: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  sourceProjectIds: string[]
  sourceProjects: ComparisonProjectLinkedSourceProject[]
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
  allowConflictResolution: boolean
  humanJudgmentMode?: HumanJudgmentMode
  summarySourceProjectId?: string | null
  modelIds?: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  importRoutes?: string[]
  sourceProjectIds?: string[]
  promptSelections: Array<{promptId: string; order: number}>
}

export type ComparisonProjectJudgmentsColumn = ComparisonProjectDifferenceColumn & {
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
}

export type ComparisonProjectContentVariant = {key: string; label: string}

export type ComparisonProjectServingProgressPhase =
  | 'cleanup'
  | 'prompt_cells'
  | 'promoting'
  | 'queued'
  | 'ready'
  | 'rollups'
  | 'summary_cells'

export type ComparisonProjectServingProgress = {
  completedAt: Date | string | null
  failedAt: Date | string | null
  generation: number | null
  lastError: string | null
  lastProgressedAt: Date | string | null
  phase: ComparisonProjectServingProgressPhase | null
  phaseStartedAt: Date | string | null
  stagedArticleCount: number
  stagedCellCount: number
  stagedFilterMemberCount: number
  stagedFilterStatsCount: number
  startedAt: Date | string | null
}

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

export type ComparisonProjectLinkedSourceProject = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
}

export type ComparisonProjectJudgmentsMetadata = {
  id: string
  name: string
  description: string | null
  activeGeneration: number | null
  compareWithHumans: boolean
  allowConflictResolution: boolean
  humanJudgmentMode: HumanJudgmentMode
  isServingReady: boolean
  servingProgress: ComparisonProjectServingProgress
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | string | null
  summarySourceProjectId: string | null
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  sourceProjects: ComparisonProjectLinkedSourceProject[]
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
    type: string | null
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
  articleExternalId: string | null
  articleTitle: string | null
  articleSummary: string | null
  articleCreatedAt: Date | string | null
  canonicalArticleId: string
  cells: Record<string, string | null>
  hasConflict: boolean
  conflictResolution: {articleId: string; label: string; value: string} | null
}

export type ComparisonProjectJudgmentsPage = {
  activeGeneration: number | null
  data: ComparisonProjectJudgmentsRow[]
  isServingReady: boolean
  page: number
  limit: number
  nextCursor: string | null
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | string | null
  totalCount: number | null
  totalPages: number | null
}
export type ComparisonProjectJudgmentsCount = {
  activeGeneration: number | null
  isServingReady: boolean
  limit: number
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | string | null
  totalCount: number
  totalPages: number
}
export type ComparisonProjectStatsComparisonKind =
  | 'primary-vs-human'
  | 'human-vs-llm'
  | 'llm-vs-llm'
  | 'llm-vs-conflict-resolution'
  | 'human-vs-conflict-resolution'
export type ComparisonProjectStatsComparison = {
  columnInfo: string | null
  id: string
  kind: ComparisonProjectStatsComparisonKind
  label: string
  leftColumnId: string
  rightColumnId: string
  cohensKappa: number | null
  conflictCount: number
  overlapCount: number
  sensitivity: number | null
  specificity: number | null
  trueConflictCount: number
}
export type ComparisonProjectStats = {
  activeGeneration: number | null
  comparisons: ComparisonProjectStatsComparison[]
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | string | null
}
export type ComparisonProjectRowsRequestFilters = {
  rowFilter?: ComparisonProjectRowFilter
  differenceFilter?: ComparisonProjectDifferenceFilter
}
export type ComparisonProjectJudgmentsPageRequest = ComparisonProjectRowsRequestFilters & {
  cursor?: string | null
  limit: string
  page?: string
}
export type ComparisonProjectJudgmentsCountRequest = ComparisonProjectRowsRequestFilters & {limit: string}
export type ComparisonProjectExportRequest = ComparisonProjectRowsRequestFilters

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
  limit: number,
  rowFilter?: ComparisonProjectRowFilter,
  differenceFilter?: ComparisonProjectDifferenceFilter,
  cursor?: string | null,
) => {
  const body: ComparisonProjectJudgmentsPageRequest = {cursor, limit: String(limit), rowFilter, differenceFilter}
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).judgments.post(body)

  return getResponseData<ComparisonProjectJudgmentsPage>(response, 'Failed to fetch comparison project judgments')
}

export const fetchComparisonProjectJudgmentsCount = async (
  comparisonProjectId: string,
  limit: number,
  rowFilter?: ComparisonProjectRowFilter,
  differenceFilter?: ComparisonProjectDifferenceFilter,
) => {
  const body: ComparisonProjectJudgmentsCountRequest = {limit: String(limit), rowFilter, differenceFilter}
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).judgments.count.post(body)

  return getResponseData<ComparisonProjectJudgmentsCount>(response, 'Failed to fetch comparison project judgment count')
}

export const fetchComparisonProjectStats = async (comparisonProjectId: string) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId}).stats.get()

  return getResponseData<ComparisonProjectStats>(response, 'Failed to fetch comparison project stats')
}

export const setComparisonProjectConflictResolution = async (
  comparisonProjectId: string,
  input: {articleId: string; value: string},
) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId})['conflict-resolution'].post(
    input,
  )

  return getResponseData<{articleId: string; label: string; value: string}>(
    response,
    'Failed to save conflict resolution',
  )
}

export const resetComparisonProjectConflictResolution = async (
  comparisonProjectId: string,
  input: {articleId: string},
) => {
  const response = await apiClient.api['comparison-projects']({id: comparisonProjectId})[
    'conflict-resolution'
  ].reset.post(input)

  return getResponseData<{articleId: string}>(response, 'Failed to reset conflict resolution')
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
