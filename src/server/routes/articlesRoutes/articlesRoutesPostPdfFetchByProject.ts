import {randomUUID} from 'node:crypto'

import type {Context} from 'elysia'

import {createReviewBulkOperationJob} from '../../reviewServing/reviewBulkOperationService.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getEarlierDateFilter, getLaterDateFilter} from './articlesRoutesPostPdfFetchByProject/dateFilters.ts'
import {getPdfDetailPendingResponse, isPdfSelectionDetailReady} from './pdfSelectionDetailReadiness.ts'

export const articlesRoutesPostPdfFetchByProject = async ({
  body,
  set,
}: {
  body: {
    projectId: string
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
  const projectBounds = await getAppQueryService().getProjectReviewConfig(body.projectId)

  if (!projectBounds) {
    throw new Error('Project not found')
  }

  const reviewConfigHash = await getCurrentReviewConfigHash(body.projectId)
  const effectiveFrom = getLaterDateFilter(body.from, projectBounds.dateFrom)
  const effectiveTo = getEarlierDateFilter(body.to, projectBounds.dateTo)

  if (!(await isPdfSelectionDetailReady({projectId: body.projectId, reviewConfigHash}))) {
    set.status = 409
    return getPdfDetailPendingResponse()
  }

  const job = await createReviewBulkOperationJob({
    criteria: {
      concurrency: body.concurrency,
      forceRefetch: body.forceRefetch,
      from: effectiveFrom,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      operation: 'pdfFetch',
      requestId: randomUUID(),
      search: body.search,
      selectionScope: 'project',
      sourceProjectId: body.projectId,
      to: effectiveTo,
    },
    filters: {
      from: effectiveFrom,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      search: body.search,
      to: effectiveTo,
    },
    jobKind: 'review.pdf.selection',
    projectId: body.projectId,
    reviewConfigHash,
    searchMode: body.search ? 'tokenPrefix' : 'none',
    searchText: body.search,
    snapshot: {type: 'latest'},
  })

  set.status = 202
  return {success: true, job}
}
