import {randomUUID} from 'node:crypto'

import type {Context} from 'elysia'

import {
  assertArticleIdOnlyBulkOperationCaps,
  createReviewBulkOperationJob,
} from '../../reviewServing/reviewBulkOperationService.ts'

export const articlesRoutesPostPdfFetchBulk = async ({
  body,
  set,
}: {
  body: {articleIds: string[]; concurrency?: number; forceRefetch?: boolean}
  set: Context['set']
}) => {
  assertArticleIdOnlyBulkOperationCaps(body.articleIds)

  const job = await createReviewBulkOperationJob({
    batchSize: body.concurrency,
    criteria: {
      articleIds: body.articleIds,
      concurrency: body.concurrency,
      forceRefetch: body.forceRefetch,
      operation: 'pdfFetch',
      requestId: randomUUID(),
    },
    filters: {},
    jobKind: 'review.pdf.selection',
    projectId: 'article-id-only',
    searchMode: 'none',
    searchText: null,
    snapshot: {type: 'latest'},
  })

  set.status = 202
  return {success: true, job}
}
