import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {ServingHumanJudgmentDetailRow} from './articleReviewDetailTypes.ts'
import {detailReaderPageSize} from './detailReaderPageSize.ts'
import {getPromptRowFromServingDetail} from './getPromptRowFromServingDetail.ts'
import {readAllReviewServingRows} from './readAllReviewServingRows.ts'

const getServingDateValue = (value: unknown) => {
  return getDateValue(value) ?? null
}

export const getProjectReviewDetailHumanRows = async (params: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  return readAllReviewServingRows<ServingHumanJudgmentDetailRow>({
    allowStale: true,
    articleId: params.articleId,
    contractKey: 'review.detail.humanJudgments',
    limit: detailReaderPageSize,
    projectId: params.projectId,
    reviewConfigHash: params.reviewConfigHash,
    searchMode: 'none',
  })
}

export const getReviewDetailHumanRows = (rows: readonly ServingHumanJudgmentDetailRow[]) => {
  return rows
    .map((row) => {
      const promptId = row.prompt_id ?? ''
      const prompt = getPromptRowFromServingDetail(row)

      return {
        judgmentId: row.judgment_id ?? '',
        promptId,
        answer: row.answered_original ?? null,
        comment: row.human_comment ?? null,
        promptOriginalText: prompt.originalText || 'Overall human screening decision',
        promptOrder: promptId === 'summary' ? 0 : (row.prompt_order ?? prompt.order ?? null),
        updatedAt: getServingDateValue(row.detail_updated_at ?? row.judgment_created_at),
      }
    })
    .filter((row) => {
      return row.judgmentId.length > 0 && row.answer !== null && row.answer !== ''
    })
}
