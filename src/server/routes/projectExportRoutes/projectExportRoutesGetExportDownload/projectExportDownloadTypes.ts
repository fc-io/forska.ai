import type {
  ReviewServingExportArticleRow,
  ReviewServingExportSnapshotScope,
} from '../../../services/projectExportReviewServingExportArticleRepository.ts'

export type ExportContract = {
  promptOutput?: {
    includeExplanation?: boolean
    includePromptContent?: boolean
    includePromptType?: boolean
    includeQuotes?: boolean
    promptIds?: string[]
  }
  selectedMetadata?: Record<string, boolean | undefined>
}

export type ExportArticleRow = ReviewServingExportArticleRow
export type ExportJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  articleId: string
  explanation: string | null
  fullTextStrategyId: string | null
  promptId: string
  quotes: unknown
  useFulltextNoImages: boolean | null
}
export type ExportServingSnapshotScope = ReviewServingExportSnapshotScope
