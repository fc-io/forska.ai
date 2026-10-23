import type {ProjectPromptCriteriaDisposition} from '../../../../db/schemaTypes.ts'
import type {PromptConfigReviewServingField} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import type {ProjectFullTextRow} from '../projectFullTextSettings.ts'

export type ProjectEditPromptPayload = {
  archived?: boolean
  enabled?: boolean
  order: number
  originalId?: string
  originalText: string
  promptHeading?: string
  type?: string
}

export type ExistingProjectPromptAssociation = {
  archived: boolean
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
  enabled: boolean
  id: string
  order: number | null
  originProjectId: string | null
  promptId: string
}

export type ResolvedProjectPromptEdit = {
  archived: boolean | undefined
  changedPromptConfigFields: PromptConfigReviewServingField[]
  currentAssociation: ExistingProjectPromptAssociation | undefined
  enabled: boolean | undefined
  order: number
  originalId: string | undefined
  shouldDeleteOriginalAssociation: boolean
  targetPromptId: string
}

export type ChangedProjectPromptLink = {
  newPromptId: string | null
  oldPromptId: string
  projectPromptId: string
  reason: 'removed' | 'replaced'
}

export type ProjectPromptLlmCleanupSummary = {
  keptSharedLlmJudgments: number
  skippedComparisonPromptReferencedJudgments: number
  softDeletedLlmJudgments: number
}

export type ProjectPromptCleanupSummary = ProjectPromptLlmCleanupSummary & {
  changedPromptLinks: ChangedProjectPromptLink[]
  deletedHumanPromptAnswers: number
}

export type ProjectEditJudgmentJob = {
  id: string
  lastImportCompletedAt: unknown
  lastImportStartedAt: unknown
  status: string
  storageState: string
}

export type ProjectEditCurrentProject = {
  dateFrom: unknown
  dateTo: unknown
  description: string | null
  humanJudgmentMode: 'prompt' | 'summary' | null
  id: string
  modelId: string
  name: string
  systemPromptVariant: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
} & ProjectFullTextRow

export type ExistingProjectPromptComparisonRow = ExistingProjectPromptAssociation & {
  order: number | null
  originalText: string
  promptHeading: string | null
  type: string | null
}
