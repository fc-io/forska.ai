import type {ProjectPromptRow} from './articleReviewDetailTypes.ts'

export const getPromptRowFromServingDetail = (row: {
  prompt_criteria_disposition?: 'include' | 'exclude' | 'combined' | null
  prompt_heading?: string | null
  prompt_id?: string
  prompt_original_text?: string | null
  prompt_order?: number | null
  prompt_type?: string | null
}): ProjectPromptRow => {
  const promptId = row.prompt_id ?? ''

  return {
    criteriaDisposition: row.prompt_criteria_disposition ?? null,
    enabled: true,
    id: promptId,
    order: row.prompt_order ?? null,
    originalText: row.prompt_original_text ?? '',
    originProjectId: null,
    promptHeading: row.prompt_heading ?? null,
    type: row.prompt_type ?? null,
  }
}
