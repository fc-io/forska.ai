import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {
  ComparisonProjectRecord,
  HumanJudgmentMode,
  ProjectPromptCriteriaDisposition,
} from '../../../db/schemaTypes.ts'
import type {FullTextStrategyInputs} from '../../fullText/fullTextStrategy.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import type {ComparisonProjectConflictResolutionImportMode} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import type {
  ComparisonProjectConflictResolutionProvenance,
  ComparisonProjectConflictResolutionReviewer,
} from './comparisonProjectConflictResolutionProvenance.ts'
import type {ComparisonProjectJudgmentLlmRow} from './comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'

export type PromptSelection = {
  promptId: string
  order: number
  criteriaDisposition?: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey?: string | null
  criteriaSectionLabel?: string | null
}
type AppDatabaseService = ReturnType<typeof getAppDatabaseService>
export type AppTx = Parameters<AppDatabaseService['transaction']>[0] extends (runner: infer T) => Promise<unknown>
  ? T
  : never
export type AppQueryRunner = Pick<AppTx, 'queryJson'>

export type ComparisonProjectConflictResolutionPdfUndecidedMode = 'clear' | 'ignore'

export type ComparisonProjectLlmRow = ComparisonProjectJudgmentLlmRow

export type ComparisonProjectConflictResolution = {
  articleId: string
  label: string
  provenance: ComparisonProjectConflictResolutionProvenance | null
  provenanceMatchesCurrent: boolean | null
  reviewer: ComparisonProjectConflictResolutionReviewer | null
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  setAt: Date | null
  value: string
}
export type ComparisonProjectConflictResolutionTargetRow = {articleCategory: string | null; hasConflict: boolean}

export type ComparisonProjectConflictResolutionOption = {label: string; value: string}

export type ComparisonProjectSourcePrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  transformedText: string | null
  order: number
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}
export type ComparisonProjectSourceImportRoute = {route: string; name: string | null}
export type ComparisonProjectSource = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelMetadataJson?: unknown
  modelProvider?: string | null
  modelVersion?: string | null
  modelName: string
  humanJudgmentMode: HumanJudgmentMode
  isSummaryCapable: boolean
  summarySourceProjectId: string | null
  systemPromptVariant: SystemPromptVariant
  fullTextStrategyId: string
  fullTextStrategyInputs: FullTextStrategyInputs | null
  fullTextStrategyLabel: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  prompts: ComparisonProjectSourcePrompt[]
  importRoutes: ComparisonProjectSourceImportRoute[]
}

export type CreateComparisonProjectFromProjectSelectionBody = {
  allowConflictResolution?: boolean
  compareWithHumans?: boolean
  conflictResolutionImportMode?: ComparisonProjectConflictResolutionImportMode
  humanJudgmentMode?: HumanJudgmentMode
  sourceProjectId: string
  sourceProjectIds?: string[]
  summarySourceProjectId?: string | null
}
export type CreateComparisonProjectFromProjectContext = {
  humanJudgmentMode: HumanJudgmentMode
  selectedImportRoutes: string[]
  selectedModelIds: string[]
  selectedSourceProjectIds: string[]
  selectedSourceProjects: ComparisonProjectSource[]
  sourceProject: ComparisonProjectSource
  sourcePromptSelections: PromptSelection[]
  summarySourceProjectId: string | null
}

export type ComparisonProjectRecordRow = Omit<ComparisonProjectRecord, 'createdAt' | 'modelIds' | 'updatedAt'> & {
  createdAt: unknown
  modelIds: unknown
  updatedAt: unknown
}
