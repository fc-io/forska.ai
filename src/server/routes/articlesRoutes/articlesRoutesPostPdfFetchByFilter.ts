import {randomUUID} from 'node:crypto'

import type {Context} from 'elysia'

import {createReviewBulkOperationJob} from '../../reviewServing/reviewBulkOperationService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getPdfDetailPendingResponse, isPdfSelectionDetailReady} from './pdfSelectionDetailReadiness.ts'

export const articlesRoutesPostPdfFetchByFilter = async ({
  body,
  set,
}: {
  body: {
    sourceProjectId: string
    listType: 'llm' | 'human' | 'both' | 'unassessed'
    llmStatus?: 'complete' | 'both' | 'partial'
    prompts?: Record<string, string[]>
    hasDuplicateStudyRecords?: boolean
    hasStudyDecisionConflict?: boolean
    from?: string
    to?: string
    search?: string
    concurrency?: number
    forceRefetch?: boolean
  }
  set: Context['set']
}) => {
  const reviewConfigHash = await getCurrentReviewConfigHash(body.sourceProjectId)

  if (!(await isPdfSelectionDetailReady({projectId: body.sourceProjectId, reviewConfigHash}))) {
    set.status = 409
    return getPdfDetailPendingResponse()
  }

  const job = await createReviewBulkOperationJob({
    criteria: {
      concurrency: body.concurrency,
      forceRefetch: body.forceRefetch,
      from: body.from,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      listType: body.listType,
      llmStatus: body.llmStatus,
      operation: 'pdfFetch',
      prompts: body.prompts,
      requestId: randomUUID(),
      search: body.search,
      sourceProjectId: body.sourceProjectId,
      to: body.to,
    },
    filters: {
      from: body.from,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      listType: body.listType,
      llmStatus: body.llmStatus,
      prompts: body.prompts,
      search: body.search,
      to: body.to,
    },
    jobKind: 'review.pdf.selection',
    projectId: body.sourceProjectId,
    reviewConfigHash,
    searchMode: body.search ? 'tokenPrefix' : 'none',
    searchText: body.search,
    snapshot: {type: 'latest'},
  })

  set.status = 202
  return {success: true, job}
}
