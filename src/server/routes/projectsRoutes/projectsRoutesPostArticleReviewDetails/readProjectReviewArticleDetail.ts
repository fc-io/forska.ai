import {readReviewServingRows} from '../../../reviewServing/reviewServingReader.ts'
import type {ServingArticleDetailRow} from './articleReviewDetailTypes.ts'

export const readProjectReviewArticleDetail = async (input: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  return readReviewServingRows<ServingArticleDetailRow>({
    articleId: input.articleId,
    contractKey: 'review.detail.row',
    estimatedResultRows: 1,
    limit: 1,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    searchMode: 'none',
  })
}
