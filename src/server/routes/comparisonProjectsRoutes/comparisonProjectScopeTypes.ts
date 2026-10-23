import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {
  ComparisonProjectServingStatus,
  HumanJudgmentMode,
  ProjectPromptCriteriaDisposition,
} from '../../../db/schemaTypes.ts'
import type {ComparisonProjectDifferenceColumn} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectServingProgress} from '../../services/comparisonProjectServingRebuildService.ts'

export type ComparisonProjectContentFlags = {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
export type ComparisonProjectContentDimension = {
  fullTextStrategyId: string
  systemPromptVariant: SystemPromptVariant
  useMetadata: boolean
}
export type ComparisonProjectFullTextStrategyLabels = ReadonlyMap<string, string>
export type ComparisonProjectContentVariant = ComparisonProjectContentFlags
  & ComparisonProjectContentDimension & {key: string; label: string}
export type ComparisonProjectPromptConfig = {
  id: string
  originalText: string
  promptHeading: string | null
  promptLabel: string
  transformedText: string | null
  type: string | null
  order: number
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}
export type ComparisonProjectModelConfig = {
  id: string
  metadataJson: unknown
  name: string
  provider?: string | null
  version?: string | null
}
export type ComparisonProjectJudgmentsColumn = ComparisonProjectDifferenceColumn & {
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
}
export type ComparisonProjectSourceSummaryPromptConfig = ComparisonProjectPromptConfig & {sourceProjectId: string}

export type ComparisonProjectScope = {
  id: string
  name: string
  description: string | null
  activeGeneration: number | null
  judgmentContextId: string | null
  compareWithHumans: boolean
  allowConflictResolution: boolean
  humanJudgmentMode: HumanJudgmentMode
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingProgress: ComparisonProjectServingProgress
  servingUpdatedAt: Date | null
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  archived: boolean
  createdAt: Date
  modelIds: string[] | null
  sourceProjectIds: string[]
  useImportRoutesForScope: boolean
  summarySourceProject: ComparisonProjectSummarySourceProject | null
  sourceProjects: ComparisonProjectLinkedSourceProject[]
  contentVariants: ComparisonProjectContentVariant[]
  prompts: ComparisonProjectPromptConfig[]
  sourceProjectSummaryPrompts: ComparisonProjectSourceSummaryPromptConfig[]
  models: ComparisonProjectModelConfig[]
  importRouteIds: string[]
  columns: ComparisonProjectJudgmentsColumn[]
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
  useMetadata: boolean
}
export type ComparisonProjectLinkedSourceProject = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  systemPromptVariant: SystemPromptVariant
  useMetadata: boolean
  fullTextStrategyId: string
}
