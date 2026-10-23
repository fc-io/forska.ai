import {randomUUID} from 'node:crypto'

import {type Context, t} from 'elysia'

import {createReviewBulkOperationJob} from '../../reviewServing/reviewBulkOperationService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {assertProjectIsActive} from '../projectsRoutes/projectAccessGuard.ts'
import {exportBatchSize} from './exportBatchSize.ts'
import {getProject} from './getProject.ts'
import {getExportPromptFilters} from './projectExportRoutesPostExport/getExportPromptFilters.ts'
import {getMissingExportSnapshotSourceProjectIds} from './projectExportRoutesPostExport/getMissingExportSnapshotSourceProjectIds.ts'
import {getPayloadPendingExportSourceProjectIds} from './projectExportRoutesPostExport/getPayloadPendingExportSourceProjectIds.ts'
import {getProjectReviewConfig} from './projectExportRoutesPostExport/getProjectReviewConfig.ts'
import {getSharedReviewConfigHash} from './projectExportRoutesPostExport/getSharedReviewConfigHash.ts'

const projectExportLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const exportPayloadBudgetBytes = 10_000_000

export const projectExportRoutesPostExportBodySchema = t.Object({
  promptIds: t.Array(t.String()),
  promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())}))),
  sourceProjectIds: t.Optional(t.Array(t.String())),
  articleIds: t.Optional(t.Array(t.String())),
  listType: t.Optional(t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')])),
  search: t.Optional(t.String()),
  snapshotId: t.Optional(t.String()),
  snapshotPinExpiresAt: t.Optional(t.String()),
  includeExplanation: t.Optional(t.Boolean()),
  includeQuotes: t.Optional(t.Boolean()),
  includeJournal: t.Optional(t.Boolean()),
  includeSummary: t.Optional(t.Boolean()),
  includeArticleId: t.Optional(t.Boolean()),
  includeArticleLink: t.Optional(t.Boolean()),
  includeArticleAuthors: t.Optional(t.Boolean()),
  includeArticleCreatedAt: t.Optional(t.Boolean()),
  includeArticleUpdatedAt: t.Optional(t.Boolean()),
  includePromptType: t.Optional(t.Boolean()),
  includePromptContent: t.Optional(t.Boolean()),
})

export const projectExportRoutesPostExport = async ({
  body,
  params,
  set,
}: {
  body: typeof projectExportRoutesPostExportBodySchema.static
  params: {id: string}
  set: Context['set']
}) => {
  const projectId = params.id
  const sourceProjectIds = body.sourceProjectIds ?? [projectId]

  await Promise.all(
    sourceProjectIds.map((sourceProjectId) => {
      return assertProjectIsActive(sourceProjectId)
    }),
  )

  const project = await getProject(projectId)

  if (!project) {
    throw new Error('Project not found')
  }

  const promptSelections = body.promptSelections ?? []
  const prompts = await getExportPromptFilters(projectId, promptSelections)
  const selectedMetadata = {
    includeArticleAuthors: body.includeArticleAuthors ?? false,
    includeArticleCreatedAt: body.includeArticleCreatedAt ?? false,
    includeArticleId: body.includeArticleId ?? false,
    includeArticleLink: body.includeArticleLink ?? false,
    includeArticleUpdatedAt: body.includeArticleUpdatedAt ?? false,
    includeJournal: body.includeJournal ?? false,
    includeSummary: body.includeSummary ?? false,
  }
  const promptOutput = {
    includeExplanation: body.includeExplanation ?? false,
    includePromptContent: body.includePromptContent ?? false,
    includePromptType: body.includePromptType ?? false,
    includeQuotes: body.includeQuotes ?? false,
    promptIds: body.promptIds,
    promptSelections,
  }
  const snapshot = body.snapshotId
    ? {expiresAt: body.snapshotPinExpiresAt, snapshotId: body.snapshotId, type: 'pinned' as const}
    : {type: 'latest' as const}
  const sourceProjectId = sourceProjectIds[0] ?? projectId
  const {reviewConfigHash: sharedReviewConfigHash, reviewConfigHashByProjectId} =
    await getSharedReviewConfigHash(sourceProjectIds)
  const listType = body.listType
  const requiresSharedReviewConfig = body.promptIds.length > 0 || Object.keys(prompts).length > 0
  const reviewConfig = body.promptIds.length > 0 ? await getProjectReviewConfig(sourceProjectId) : null
  const reviewConfigHash = sharedReviewConfigHash ?? reviewConfigHashByProjectId[sourceProjectId] ?? null
  const sourceProjectReviewConfigHashes = sharedReviewConfigHash ? undefined : reviewConfigHashByProjectId

  if (requiresSharedReviewConfig && sourceProjectIds.length > 1 && sharedReviewConfigHash === null) {
    set.status = 400
    return {error: 'Export sources must use the same review configuration', success: false}
  }

  const missingSnapshotSourceProjectIds = body.articleIds
    ? []
    : await getMissingExportSnapshotSourceProjectIds({
        reviewConfigHash,
        reviewConfigHashByProjectId,
        snapshot,
        sourceProjectIds,
      })

  if (missingSnapshotSourceProjectIds.length > 0) {
    set.status = 400
    return {
      error: `Export sources are missing a ready review serving snapshot: ${missingSnapshotSourceProjectIds.join(', ')}`,
      success: false,
    }
  }

  const payloadPendingSourceProjectIds = body.articleIds
    ? []
    : await getPayloadPendingExportSourceProjectIds({
        reviewConfigHash,
        reviewConfigHashByProjectId,
        snapshot,
        sourceProjectIds,
      })

  if (payloadPendingSourceProjectIds.length > 0) {
    set.status = 409
    return {
      availability: 'pending',
      detailReadiness: 'indexing',
      error: `Export details are still indexing for source projects: ${payloadPendingSourceProjectIds.join(', ')}`,
      success: false,
    }
  }

  const job = await createReviewBulkOperationJob({
    batchSize: exportBatchSize,
    criteria: {
      articleIds: body.articleIds,
      exportContract: {
        payloadBudgetBytes: exportPayloadBudgetBytes,
        promptOutput,
        projectionIdentity: 'review.export.selection',
        selectedMetadata,
        snapshotCursor: {mode: 'keyset', orderBy: ['article_id']},
      },
      listType,
      operation: 'export',
      prompts,
      reviewConfig,
      requestId: randomUUID(),
      search: body.search,
      selectionScope: listType ? undefined : 'project',
      sourceProjectId,
      sourceProjectIds,
      ...(sourceProjectReviewConfigHashes ? {sourceProjectReviewConfigHashes} : {}),
    },
    filters: {listType, prompts, search: body.search},
    jobKind: 'review.export.selection',
    projectId,
    reviewConfigHash,
    searchMode: body.search ? 'tokenPrefix' : 'none',
    searchText: body.search,
    snapshot,
  })

  projectExportLogger.force('project.export.job-created', 'Project export job created', 'log', {
    articleIdCount: body.articleIds?.length ?? null,
    jobId: job.jobId,
    listType: listType ?? 'project',
    projectId,
    promptCount: body.promptIds.length,
    promptFilterCount: promptSelections.length,
    sourceProjectIds,
  })

  set.status = 202

  return {
    downloadUrl: `/api/projects/${projectId}/export/${job.jobId}/download`,
    exportContract: {payloadBudgetBytes: exportPayloadBudgetBytes, promptOutput, selectedMetadata},
    job,
    success: true,
  }
}
