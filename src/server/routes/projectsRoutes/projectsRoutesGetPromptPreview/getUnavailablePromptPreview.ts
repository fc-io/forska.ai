import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {ReviewServingFreshnessState} from '../../../reviewServing/reviewServingContracts.ts'
import type {ReviewServingReaderResult} from '../../../reviewServing/reviewServingReader.ts'
import type {PromptPreviewServingRow} from './promptPreviewServingRow.ts'

export const getUnavailablePromptPreview = (input: {
  articleId: string | null
  articleTitle?: string | null
  detail?: string | null
  diagnostics?: ReviewServingReaderResult<PromptPreviewServingRow>['diagnostics'] | null
  reason:
    | 'full_text_not_ready'
    | 'model_context_window_missing'
    | 'no_articles'
    | 'no_fulltext'
    | ReviewServingFreshnessState
  systemPrompt: string
  systemPromptVariant: SystemPromptVariant
}) => {
  return {
    data: {
      articleId: input.articleId,
      articleTitle: input.articleTitle ?? null,
      detail: input.detail ?? null,
      diagnostics: input.diagnostics ?? null,
      previewText: null,
      reason: input.reason,
      status: 'unavailable' as const,
      systemPrompt: input.systemPrompt,
      systemPromptVariant: input.systemPromptVariant,
      userPrompt: null,
    },
  }
}
