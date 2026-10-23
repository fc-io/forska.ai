import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {ComparisonProjectArticleCategoryFilter} from '../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import type {ComparisonProjectConflictResolutionFilter} from '../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import type {ComparisonProjectDifferenceFilter} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectFilterSelection} from '../../../../utils/comparisonProjectFilterSelection.ts'
import type {ComparisonProjectRowFilter} from '../../../../utils/comparisonProjectRowFilter.ts'
import type {ComparisonProjectConflictResolutionProvenanceFilter} from '../comparisonProjectConflictResolutionProvenance.ts'

export type ComparisonProjectScopedArticle = {
  id: string
  articleExternalId?: string | null
  articleTitle: string | null
  articleSummary: string | null
  articleCreatedAt: Date | null
  canonicalArticleId?: string
}

export type ComparisonProjectJudgmentLlmRow = {
  articleId: string
  createdAt: Date
  promptId: string
  modelId: string
  sourceProjectId: string | null
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  explanation?: string | null
  quotes?: unknown
  systemPromptVariant?: SystemPromptVariant | null
  fullTextStrategyId?: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata?: boolean | null
}

export type ComparisonProjectJudgmentHumanRow = {
  articleId: string
  promptId: string
  answer: string | null
  updatedAt: Date | null
}

export type ComparisonProjectJudgmentRow = {
  id: string
  articleExternalId: string | null
  articleTitle: string | null
  articleSummary: string | null
  articleCreatedAt: Date | null
  canonicalArticleId: string
  cells: Record<string, string | null>
  hasConflict: boolean
}

export type ComparisonProjectScopedArticleQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type ComparisonProjectServingMemberRow = {
  articleId: string
  generation: unknown
  rowSortArticleId: string | null
  rowSortCreatedAt: unknown
  rowSortTitle: string | null
}

export type ComparisonProjectServingArticleRow = {
  articleExternalId: string | null
  articleCreatedAt: unknown
  articleId: string
  articleSummary: string | null
  articleTitle: string | null
  canonicalArticleId: string
  hasConflict: boolean
}

export type ComparisonProjectServingCellRow = {articleId: string; columnId: string; displayAnswer: string | null}

export type ComparisonProjectArticleCategoryFilterSelection =
  ComparisonProjectFilterSelection<ComparisonProjectArticleCategoryFilter>
export type ComparisonProjectConflictResolutionFilterSelection =
  ComparisonProjectFilterSelection<ComparisonProjectConflictResolutionFilter>
export type ComparisonProjectDifferenceFilterSelection =
  ComparisonProjectFilterSelection<ComparisonProjectDifferenceFilter>
export type ComparisonProjectRowFilterSelection = ComparisonProjectFilterSelection<ComparisonProjectRowFilter>

export type ComparisonProjectServingConflictResolutionProvenanceParams = {
  conflictResolutionProvenanceFilter?: readonly ComparisonProjectConflictResolutionProvenanceFilter[]
  currentJudgmentContextId?: string | null
}
