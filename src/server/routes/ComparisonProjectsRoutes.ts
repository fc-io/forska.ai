import {Elysia, t} from 'elysia'

import type {ComparisonProjectServingStatus} from '../../db/schemaTypes.ts'
import {
  getComparisonProjectArticleCategoryFiltersLabel,
  getNormalizedComparisonProjectArticleCategoryFilters,
} from '../../utils/comparisonProjectArticleCategoryFilter.ts'
import {getOrderedComparisonProjectColumns} from '../../utils/comparisonProjectColumnOrder.ts'
import {
  comparisonProjectConflictResolutionCommentMaxLength,
  getNormalizedComparisonProjectConflictComment,
} from '../../utils/comparisonProjectConflictResolutionComment.ts'
import {
  getComparisonProjectDifferenceFiltersLabel,
  getNormalizedComparisonProjectDifferenceFilters,
} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {getComparisonProjectRowFiltersLabel} from '../../utils/comparisonProjectRowFilter.ts'
import {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type ComparisonJudgmentContextSummary,
  getComparisonJudgmentContextId,
  getComparisonJudgmentContextsByIds,
  getValidatedComparisonJudgmentContext,
  isComparisonJudgmentContextId,
  upsertComparisonJudgmentContext,
} from '../services/comparisonJudgmentContext.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {csvUtf8Bom, getCsvDownloadHeaders} from '../utils/csvResponse.ts'
import {type DuckdbWorkloadContext, getMaintenanceDuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {HttpError} from '../utils/httpError.ts'
import {rejectLegacyFullTextNoImagesBody} from '../utils/rejectLegacyFullTextNoImagesBody.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {SimplePdfDocument} from '../utils/simplePdf.ts'
import {
  type ComparisonProjectConflictComment,
  comparisonProjectConflictCommentTable,
  getComparisonProjectConflictCommentImportWrites,
  getValidatedComparisonProjectConflictComment,
  replaceComparisonProjectConflictComment,
  writeComparisonProjectConflictCommentImportChanges,
} from './comparisonProjectsRoutes/comparisonProjectConflictComment.ts'
import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  type ComparisonProjectConflictResolutionTransferJudgmentContextV2,
  type ComparisonProjectConflictResolutionTransferSourceRow,
  createComparisonProjectConflictResolutionTransferArtifact,
  getComparisonProjectConflictResolutionTransferFilename,
  getComparisonProjectConflictResolutionTransferRows,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionFileTransfer.ts'
import {
  type ComparisonProjectConflictResolutionImportCommentChange,
  type ComparisonProjectConflictResolutionImportMode,
  type ComparisonProjectConflictResolutionImportSourceQueryRow,
  type ComparisonProjectConflictResolutionImportSourceRow,
  type ComparisonProjectConflictResolutionImportSummary,
  getComparisonProjectConflictResolutionImportCommitResult,
  getComparisonProjectConflictResolutionImportPlan,
  getComparisonProjectConflictResolutionImportSourcesSql,
  getComparisonProjectConflictResolutionImportSourceValue,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts'
import {
  type ComparisonProjectConflictResolutionImportCandidate,
  getComparisonProjectConflictResolutionImportCandidateSourceRow,
  getComparisonProjectConflictResolutionImportResolutionCandidates,
  getComparisonProjectConflictResolutionImportSourceRowsById,
  getConflictResolutionImportCommentChanges,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionImportCandidates.ts'
import {
  type ComparisonProjectConflictResolutionPdfImportBody,
  getComparisonProjectConflictResolutionPdfImportRequest,
  validateConflictResolutionImportAnalyzeTarget,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionImportRequests.ts'
import {getConflictResolutionImportRejectedError} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionImportValidation.ts'
import {
  getComparisonProjectConflictResolutionOptionByValue,
  getComparisonProjectConflictResolutionOptions,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionOptions.ts'
import {pdfConflictResolutionNotSetValue} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionPdfImport.ts'
import {
  comparisonProjectConflictResolutionInsertColumnsSql,
  type ComparisonProjectConflictResolutionProvenanceFilter,
  type ComparisonProjectConflictResolutionWriteProvenance,
  getComparisonProjectConflictResolutionInsertValuesSql,
  getComparisonProjectConflictResolutionProvenance,
  getComparisonProjectConflictResolutionProvenanceMatchesCurrent,
  getComparisonProjectConflictResolutionReviewer,
  getImportedReviewerDisplayName,
  getTransferReviewerDisplayNames,
  getTransferReviewerUserId,
  getUpsertTransferReviewersSql,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionProvenance.ts'
import {
  getConflictResolutionSaveDiagnostic,
  getConflictResolutionSaveErrorDiagnostic,
  getConflictResolutionSaveMemorySnapshot,
  getConflictResolutionSaveRuntimeDiagnostic,
  logConflictResolutionSavePhase,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionSaveDiagnostics.ts'
import {
  getComparisonProjectConflictResolutionScopedTargetRow,
  getComparisonProjectConflictResolutionServingTargetRow,
  getComparisonProjectConflictResolutionTargetRow,
} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionTargetRows.ts'
import {
  comparisonProjectFilterSelectionBodySchema,
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
  getRequestedComparisonProjectJudgmentFilters,
} from './comparisonProjectsRoutes/comparisonProjectJudgmentFilters.ts'
import {
  type ComparisonProjectConflictResolutionFilter,
  type ComparisonProjectJudgmentRow,
  forEachComparisonProjectServingJudgmentArticleIdBatch,
  forEachComparisonProjectServingJudgmentRowBatch,
  getComparisonProjectColumnId,
  getComparisonProjectContentKey,
  getComparisonProjectServingJudgmentRowsPage,
} from './comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'
import {
  insertComparisonProjectPromptLinks,
  insertComparisonProjectRouteLinks,
  insertComparisonProjectSourceProjectLinks,
} from './comparisonProjectsRoutes/comparisonProjectLinkInserts.ts'
import {
  checkpointComparisonProjectMutation,
  scheduleComparisonProjectConflictResolutionCheckpoint,
} from './comparisonProjectsRoutes/comparisonProjectMutationCheckpoint.ts'
import {
  getComparisonProjectRecord,
  getComparisonProjectRecordValue,
  updateComparisonProjectTx,
} from './comparisonProjectsRoutes/comparisonProjectRecord.ts'
import {
  comparisonProjectConflictResolutionTable,
  comparisonProjectImportRouteTable,
  comparisonProjectJudgmentArticleBatchSize,
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
  summaryPromptId,
} from './comparisonProjectsRoutes/comparisonProjectRouteConstants.ts'
import {
  appDatabaseService,
  comparisonProjectServingGenerationService,
} from './comparisonProjectsRoutes/comparisonProjectRouteServices.ts'
import type {
  AppQueryRunner,
  AppTx,
  ComparisonProjectConflictResolution,
  ComparisonProjectConflictResolutionOption,
  ComparisonProjectConflictResolutionTargetRow,
  ComparisonProjectLlmRow,
  ComparisonProjectRecordRow,
  CreateComparisonProjectFromProjectContext,
  CreateComparisonProjectFromProjectSelectionBody,
  PromptSelection,
} from './comparisonProjectsRoutes/comparisonProjectRouteTypes.ts'
import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectScope,
  ComparisonProjectSourceSummaryPromptConfig,
} from './comparisonProjectsRoutes/comparisonProjectScopeTypes.ts'
import {
  getSummarySourceProjectId,
  getValidatedComparisonSourceProjectIds,
  getValidatedModelIds,
} from './comparisonProjectsRoutes/comparisonProjectSelectionValidation.ts'
import {
  markComparisonProjectServingStaleAndQueueRebuild,
  queueComparisonProjectServingRebuild,
} from './comparisonProjectsRoutes/comparisonProjectServingRebuildQueue.ts'
import {
  assertComparisonProjectSourceProjectIdsShareFullTextStrategy,
  getComparisonProjectBodySourceProjectIds,
} from './comparisonProjectsRoutes/comparisonProjectSourceFullTextStrategy.ts'
import {getBooleanLiteral, getInClause} from './comparisonProjectsRoutes/comparisonProjectSqlClauses.ts'
import {
  type ComparisonProjectAdditionalStats,
  type ComparisonProjectStatsCategoryBreakdown,
  type ComparisonProjectStatsComparison,
  type ComparisonProjectStatsConflictResolutionProvenance,
  getComparisonProjectStatsWithCategoryBreakdowns,
} from './comparisonProjectsRoutes/comparisonProjectStats.ts'
import {
  getRequestedPositiveInteger,
  getUniqueStringValues,
} from './comparisonProjectsRoutes/comparisonProjectValueHelpers.ts'
import {createComparisonProjectRecord} from './comparisonProjectsRoutes/createComparisonProjectRecord.ts'
import {getComparisonProjectConflictResolutionImportProvenanceResolver} from './comparisonProjectsRoutes/getComparisonProjectConflictResolutionImportProvenanceResolver.ts'
import {getComparisonProjectEditFormData} from './comparisonProjectsRoutes/getComparisonProjectEditFormData.ts'
import {getComparisonProjectJudgmentsCount} from './comparisonProjectsRoutes/getComparisonProjectJudgmentsCount.ts'
import {getComparisonProjectLlmRows} from './comparisonProjectsRoutes/getComparisonProjectLlmRows.ts'
import {getComparisonProjectRowsWithConflictResolutions} from './comparisonProjectsRoutes/getComparisonProjectRowsWithConflictResolutions.ts'
import {getComparisonProjectScope} from './comparisonProjectsRoutes/getComparisonProjectScope.ts'
import {getComparisonProjectsList} from './comparisonProjectsRoutes/getComparisonProjectsList.ts'
import {getComparisonProjectSources} from './comparisonProjectsRoutes/getComparisonProjectSources.ts'
import {getConflictResolutionArtifactImportAnalysis} from './comparisonProjectsRoutes/getConflictResolutionArtifactImportAnalysis.ts'
import {getConflictResolutionImportPlanResult} from './comparisonProjectsRoutes/getConflictResolutionImportPlanResult.ts'
import {getConflictResolutionImportSummary} from './comparisonProjectsRoutes/getConflictResolutionImportSummary.ts'
import {getCreateComparisonProjectFromProjectContext} from './comparisonProjectsRoutes/getCreateComparisonProjectFromProjectContext.ts'
import {getCreateFromProjectImportScope} from './comparisonProjectsRoutes/getCreateFromProjectImportScope.ts'
import {getIsSummaryMode} from './comparisonProjectsRoutes/getIsSummaryMode.ts'
import {getPdfImportAnalyzeResult} from './comparisonProjectsRoutes/getPdfImportAnalyzeResult.ts'
import {getPdfUndecidedImportAnalysis} from './comparisonProjectsRoutes/getPdfUndecidedImportAnalysis.ts'
import {getValidatedComparisonPromptSelections} from './comparisonProjectsRoutes/getValidatedComparisonPromptSelections.ts'
import {insertComparisonProjectConflictResolutionImportCandidates} from './comparisonProjectsRoutes/insertComparisonProjectConflictResolutionImportCandidates.ts'
import {validateConflictResolutionImportSources} from './comparisonProjectsRoutes/validateConflictResolutionImportSources.ts'

const comparisonProjectMetadataWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'comparisonProjects.detail.metadata',
  workloadClass: 'foreground-metadata',
}

const comparisonJudgmentContextLookupLimit = 100

type ComparisonProjectStatsConflictResolutionProvenanceScope = {
  applied: boolean
  reason: 'no-active-context' | null
  requested: ComparisonProjectStatsConflictResolutionProvenance
}
type ComparisonProjectStatsResponse = {
  activeGeneration: number | null
  additionalProjectStats: ComparisonProjectAdditionalStats
  categoryBreakdowns: ComparisonProjectStatsCategoryBreakdown[]
  comparisons: ComparisonProjectStatsComparison[]
  conflictResolutionProvenance: ComparisonProjectStatsConflictResolutionProvenance
  conflictResolutionProvenanceScope: ComparisonProjectStatsConflictResolutionProvenanceScope
  judgmentContextId: string | null
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | null
}

type ComparisonProjectConflictResolutionExportQueryRow = Omit<
  ComparisonProjectConflictResolutionTransferSourceRow,
  'resolutionLabel' | 'resolutionMode' | 'resolutionValue'
> & {answerValue: string | null; promptId: string | null}
type ComparisonProjectExportRow = ComparisonProjectJudgmentRow & {
  conflictComment?: ComparisonProjectConflictComment | null
  conflictResolution?: ComparisonProjectConflictResolution | null
}
type ComparisonProjectExportFormat = 'csv' | 'pdf'

type ComparisonProjectPdfAssessmentDetail = {answer: string; explanation: string; label: string; quotes: string}
type ComparisonProjectPdfSummaryJudgment = {
  answer: string
  contentLabel: string | null
  details: ComparisonProjectPdfAssessmentDetail[]
  sourceLabel: string
}

const comparisonProjectRoutesLoadedAt = new Date()
const pendingComparisonProjectServingRecoveryIds = new Set<string>()

const getComparisonProjectJudgmentsCursor = (params: {cursor?: string | null; limit: number; page: number}) => {
  return params.cursor ?? (params.page > 1 ? String((params.page - 1) * params.limit - 1) : null)
}

const queueUnavailableComparisonProjectServingRebuild = (
  comparisonProject: Pick<
    ComparisonProjectScope,
    'activeGeneration' | 'archived' | 'id' | 'servingProgress' | 'servingStatus'
  >,
) => {
  if (comparisonProject.archived) {
    return
  }

  const latestProgressedAt =
    comparisonProject.servingProgress.lastProgressedAt ?? comparisonProject.servingProgress.startedAt
  const isMissingWithoutStartedBuild =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.activeGeneration === null
    && comparisonProject.servingProgress.generation === null
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isStaleWithoutStartedBuild =
    comparisonProject.servingStatus === 'stale'
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isRefreshingFromPreviousRouteLoad =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.servingProgress.generation !== null
    && latestProgressedAt !== null
    && latestProgressedAt < comparisonProjectRoutesLoadedAt
  const isFailedFromPreviousRouteLoad =
    comparisonProject.servingStatus === 'failed'
    && comparisonProject.servingProgress.failedAt !== null
    && comparisonProject.servingProgress.failedAt < comparisonProjectRoutesLoadedAt

  if (
    !isMissingWithoutStartedBuild
    && !isStaleWithoutStartedBuild
    && !isRefreshingFromPreviousRouteLoad
    && !isFailedFromPreviousRouteLoad
  ) {
    return
  }

  if (pendingComparisonProjectServingRecoveryIds.has(comparisonProject.id)) {
    return
  }

  pendingComparisonProjectServingRecoveryIds.add(comparisonProject.id)
  void queueComparisonProjectServingRebuild(comparisonProject.id).finally(() => {
    pendingComparisonProjectServingRecoveryIds.delete(comparisonProject.id)
  })
}

type ComparisonProjectConflictResolutionSavedRow = {
  articleId: string
  replacedExistingResolution: boolean
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  setAt?: unknown
}

const getComparisonProjectServingGenerationTxDependencies = (tx: AppTx) => {
  return {
    queryJson: tx.queryJson,
    transaction: <T>(operation: (runner: Pick<AppTx, 'queryJson' | 'run'>) => Promise<T>) => {
      return operation(tx)
    },
  }
}

const purgeArchivedComparisonProjectTx = async (tx: AppTx, comparisonProjectId: string) => {
  const comparisonProject = await getComparisonProjectRecord(tx, comparisonProjectId)

  if (!comparisonProject) {
    return null
  }

  if (!comparisonProject.archived) {
    throw new HttpError(409, 'Comparison project must be archived before it can be permanently deleted')
  }

  try {
    await comparisonProjectServingGenerationService.cleanupComparisonProjectServing(
      comparisonProjectId,
      getComparisonProjectServingGenerationTxDependencies(tx),
    )
  } catch (error) {
    throw new HttpError(500, 'Failed to clean up comparison project serving data before permanent delete', {
      cause: error,
    })
  }

  await tx.run(`
    DELETE FROM app.comparison_project_serving_generation
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectConflictCommentTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectPromptTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectImportRouteTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectSourceProjectTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  const [deletedComparisonProject] = await tx.queryJson<{id: string}>(`
    DELETE FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
      AND archived = TRUE
    RETURNING id
  `)

  if (!deletedComparisonProject) {
    throw new Error('Failed to delete archived comparison project')
  }

  return comparisonProject
}

const getComparisonProjectResolutionCount = async (
  comparisonProjectId: string,
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const [row] = await queryRunner.queryJson<{resolutionCount: unknown}>(`
    SELECT COUNT(*) AS resolutionCount
    FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)

  return Number(row?.resolutionCount ?? 0)
}

const getComparisonProjectConflictResolutionImportSources = async () => {
  const rows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionImportSourceQueryRow>(
    getComparisonProjectConflictResolutionImportSourcesSql({
      comparisonProjectConflictResolutionTable,
      comparisonProjectTable,
    }),
  )

  return rows.map(getComparisonProjectConflictResolutionImportSourceValue)
}

const getPdfConflictResolutionImportReviewerId = (instanceId: string) => {
  const normalizedInstanceId = instanceId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_')

  return `pdf-import:${normalizedInstanceId || crypto.randomUUID()}`
}

const getOrCreatePdfConflictResolutionImportReviewer = async (params: {displayName?: string | null; tx: AppTx}) => {
  const reviewerId = getPdfConflictResolutionImportReviewerId(crypto.randomUUID())
  const reviewerName = getImportedReviewerDisplayName(params.displayName) ?? 'Unnamed reviewer'
  const [reviewer] = await params.tx.queryJson<{id: string; name: string}>(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id, unpaywall_email)
    VALUES (
      ${getSqlLiteral(reviewerId)},
      ${getSqlLiteral(reviewerName)},
      ${getSqlLiteral(`${reviewerId}@pdf-import.forska.local`)},
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      updated_at = now()
    RETURNING id, name
  `)

  if (!reviewer) {
    throw new Error('Failed to create PDF import reviewer')
  }

  return reviewer
}

const getEmptyConflictResolutionImportSummary = (): ComparisonProjectConflictResolutionImportSummary => {
  return {
    deduped: 0,
    scanned: 0,
    matched: 0,
    imported: 0,
    skipped: 0,
    skippedAmbiguousTarget: 0,
    skippedConflictingIdentifiers: 0,
    skippedConflicting: 0,
    skippedExistingTargetResolution: 0,
    skippedInvalidValue: 0,
    skippedNoTargetMatch: 0,
    skippedNoUsableKey: 0,
    skippedNotConflicting: 0,
    skippedUnsupportedMode: 0,
    sameValue: 0,
    overwriteCandidates: 0,
    warnings: [],
  }
}

const getComparisonProjectConflictResolutionSourceReviewer = (
  sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null,
) => {
  return {
    displayName: sourceRow?.sourceProvenance?.reviewerDisplayName ?? null,
    userId: sourceRow?.sourceProvenance?.reviewerUserId ?? null,
  }
}

const getComparisonProjectConflictResolutionTransferReviewer = (
  sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null,
) => {
  const displayName = sourceRow?.sourceProvenance?.reviewerDisplayName?.trim() || null

  return {displayName, userId: displayName ? getTransferReviewerUserId(displayName) : null}
}

const clearComparisonProjectConflictResolutionImportCandidates = async (params: {
  candidates: ReturnType<typeof getComparisonProjectConflictResolutionImportPlan>['candidates']
  comparisonProjectId: string
  tx: AppTx
}) => {
  const targetArticleIds = getUniqueStringValues(
    params.candidates.map((candidate) => {
      return candidate.targetArticleId
    }),
  )

  if (targetArticleIds.length === 0) {
    return 0
  }

  const deletedRows = await params.tx.queryJson<{articleId: string}>(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article_id IN (${getQuotedStringList(targetArticleIds).join(', ')})
    RETURNING article_id AS articleId
  `)

  return deletedRows.length
}

const previewComparisonProjectConflictResolutionImport = async (params: {
  importMode?: ComparisonProjectConflictResolutionImportMode
  promptSelections: PromptSelection[]
  scope: ComparisonProjectScope
  sourceComparisonProjectIds: string[]
  tx: AppQueryRunner
}) => {
  const {plan, sourceRows} = await getConflictResolutionImportPlanResult(params)

  return getConflictResolutionImportSummary({
    importedCount: plan.candidates.length,
    plan,
    scannedCount: sourceRows.length,
  })
}

const importComparisonProjectConflictResolutions = async (params: {
  comparisonProjectId: string
  importMode?: ComparisonProjectConflictResolutionImportMode
  promptSelections: PromptSelection[]
  scope: ComparisonProjectScope
  sourceComparisonProjectIds: string[]
  tx: AppTx
}) => {
  const {plan, sourceRows} = await getConflictResolutionImportPlanResult(params)

  const importedCount = await insertComparisonProjectConflictResolutionImportCandidates({
    candidates: plan.candidates,
    comparisonProjectId: params.comparisonProjectId,
    getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
      origin: 'project-import',
      reviewer: getComparisonProjectConflictResolutionSourceReviewer,
      sourceRows,
    }),
    tx: params.tx,
  })
  await writeComparisonProjectConflictCommentImportChanges({
    commentChanges: await getConflictResolutionImportCommentChanges({
      comparisonProjectId: params.comparisonProjectId,
      overwriteMode: 'skip-existing',
      plan,
      tx: params.tx,
    }),
    comparisonProjectId: params.comparisonProjectId,
    tx: params.tx,
  })

  return getConflictResolutionImportSummary({importedCount, plan, scannedCount: sourceRows.length})
}

const getComparisonProjectConflictResolutionImportPreview = async (
  body: CreateComparisonProjectFromProjectSelectionBody & {
    conflictResolutionImportSourceComparisonProjectIds?: string[]
  },
) => {
  const context = await getCreateComparisonProjectFromProjectContext(body)
  const sourceComparisonProjectIds = getUniqueStringValues(
    body.conflictResolutionImportSourceComparisonProjectIds ?? [],
  )

  if (sourceComparisonProjectIds.length === 0) {
    return getEmptyConflictResolutionImportSummary()
  }

  if (context.humanJudgmentMode !== 'summary' || !body.compareWithHumans || !body.allowConflictResolution) {
    throw getConflictResolutionImportRejectedError(
      'Conflict resolution imports require summary mode and allow conflict resolution to be enabled',
    )
  }

  await validateConflictResolutionImportSources(appDatabaseService, sourceComparisonProjectIds)

  return previewComparisonProjectConflictResolutionImport({
    importMode: body.conflictResolutionImportMode,
    promptSelections: context.sourcePromptSelections,
    scope: await getCreateFromProjectImportScope({
      createdComparisonProject: getCreateFromProjectPreviewComparisonProject({body, context}),
      promptSelections: context.sourcePromptSelections,
      selectedImportRoutes: context.selectedImportRoutes,
      selectedSourceProjectIds: context.selectedSourceProjectIds,
      selectedSourceProjects: context.selectedSourceProjects,
      summarySourceProjectId: context.summarySourceProjectId,
      tx: appDatabaseService,
    }),
    sourceComparisonProjectIds,
    tx: appDatabaseService,
  })
}

const analyzeComparisonProjectConflictResolutionImport = async (scope: ComparisonProjectScope, body: unknown) => {
  const {analyzeResult} = await getConflictResolutionArtifactImportAnalysis({body, scope, tx: appDatabaseService})

  return analyzeResult
}

const analyzeComparisonProjectConflictResolutionPdfImport = async (
  scope: ComparisonProjectScope,
  body: ComparisonProjectConflictResolutionPdfImportBody,
) => {
  validateConflictResolutionImportAnalyzeTarget(scope)

  const {artifact, importMode, overwriteMode, parsedImport, pdfUndecidedMode, pdfWarnings, reviewer} =
    await getComparisonProjectConflictResolutionPdfImportRequest(scope, body)
  const {analyzeResult} = await getConflictResolutionArtifactImportAnalysis({
    body: {artifact, importMode, overwriteMode},
    scope,
    tx: appDatabaseService,
  })

  return getPdfImportAnalyzeResult({
    analyzeResult,
    importMode,
    parsedImport,
    pdfUndecidedMode,
    pdfWarnings,
    reviewer,
    scope,
    tx: appDatabaseService,
  })
}

const getComparisonProjectConflictResolutionImportCandidateSourceRows = (params: {
  candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
}) => {
  const sourceRowsById = getComparisonProjectConflictResolutionImportSourceRowsById(params.sourceRows)

  return params.candidates
    .map((candidate) => {
      return getComparisonProjectConflictResolutionImportCandidateSourceRow(candidate, sourceRowsById)
    })
    .filter((sourceRow): sourceRow is ComparisonProjectConflictResolutionImportSourceRow => {
      return sourceRow !== null
    })
}

const upsertComparisonProjectConflictResolutionTransferReviewers = async (params: {
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  tx: AppTx
}) => {
  const displayNames = getTransferReviewerDisplayNames(
    params.sourceRows.map((sourceRow) => {
      return sourceRow.sourceProvenance?.reviewerDisplayName
    }),
  )

  if (displayNames.length > 0) {
    await params.tx.run(getUpsertTransferReviewersSql(displayNames))
  }
}

const getComparisonProjectConflictResolutionTransferJudgmentContexts = (
  artifact: ComparisonProjectConflictResolutionTransferArtifact,
) => {
  return (artifact.judgmentContexts ?? [])
    .map((entry) => {
      const context = getValidatedComparisonJudgmentContext(entry.context)

      return context && getComparisonJudgmentContextId(context) === entry.id ? context : null
    })
    .filter((context): context is NonNullable<typeof context> => {
      return context !== null
    })
}

const upsertComparisonProjectConflictResolutionTransferJudgmentContexts = async (params: {
  artifact: ComparisonProjectConflictResolutionTransferArtifact
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  tx: AppTx
}) => {
  const usedContextIds = new Set(
    params.sourceRows.map((sourceRow) => {
      return sourceRow.sourceProvenance?.judgmentContextId ?? ''
    }),
  )
  const contexts = getComparisonProjectConflictResolutionTransferJudgmentContexts(params.artifact).filter((context) => {
    return usedContextIds.has(getComparisonJudgmentContextId(context))
  })

  await contexts.reduce<Promise<unknown>>((promise, context) => {
    return promise.then(() => {
      return upsertComparisonJudgmentContext(params.tx, context)
    })
  }, Promise.resolve())
}

const commitComparisonProjectConflictResolutionImport = async (scope: ComparisonProjectScope, body: unknown) => {
  return appDatabaseService.transaction(async (tx) => {
    const {analyzeResult, artifact, commentChanges, plan, sourceRows} =
      await getConflictResolutionArtifactImportAnalysis({body, scope, tx})
    const candidateSourceRows = getComparisonProjectConflictResolutionImportCandidateSourceRows({
      candidates: plan.candidates,
      sourceRows,
    })

    await upsertComparisonProjectConflictResolutionTransferReviewers({sourceRows: candidateSourceRows, tx})
    await upsertComparisonProjectConflictResolutionTransferJudgmentContexts({
      artifact,
      sourceRows: candidateSourceRows,
      tx,
    })
    const inserted = await insertComparisonProjectConflictResolutionImportCandidates({
      candidates: plan.candidates,
      comparisonProjectId: scope.id,
      getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
        origin: 'file-import',
        reviewer: getComparisonProjectConflictResolutionTransferReviewer,
        sourceRows,
      }),
      tx,
    })
    await writeComparisonProjectConflictCommentImportChanges({commentChanges, comparisonProjectId: scope.id, tx})

    return getComparisonProjectConflictResolutionImportCommitResult({analyzeResult, inserted})
  })
}

const getPdfImportCommentChanges = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
  reviewer: {id: string; name: string} | null,
) => {
  return commentChanges.map((commentChange) => {
    return {...commentChange, authorDisplayName: reviewer?.name ?? null, authorUserId: reviewer?.id ?? null}
  })
}

const commitComparisonProjectConflictResolutionPdfImport = async (
  scope: ComparisonProjectScope,
  body: ComparisonProjectConflictResolutionPdfImportBody,
) => {
  return appDatabaseService.transaction(async (tx) => {
    const {artifact, importMode, overwriteMode, parsedImport, pdfUndecidedMode, pdfWarnings, reviewer} =
      await getComparisonProjectConflictResolutionPdfImportRequest(scope, body)
    const {analyzeResult, commentChanges, plan, sourceRows} = await getConflictResolutionArtifactImportAnalysis({
      body: {artifact, importMode, overwriteMode},
      scope,
      tx,
    })
    const pdfAnalyzeResult = await getPdfImportAnalyzeResult({
      analyzeResult,
      importMode,
      parsedImport,
      pdfUndecidedMode,
      pdfWarnings,
      reviewer,
      scope,
      tx,
    })
    const importedReviewer =
      getComparisonProjectConflictResolutionImportResolutionCandidates(plan.candidates).length === 0
      && getComparisonProjectConflictCommentImportWrites(commentChanges).length === 0
        ? null
        : await getOrCreatePdfConflictResolutionImportReviewer({displayName: reviewer.displayName, tx})
    const pdfJudgmentContextId = isComparisonJudgmentContextId(parsedImport.source.judgmentContextId)
      ? parsedImport.source.judgmentContextId
      : null
    const inserted = await insertComparisonProjectConflictResolutionImportCandidates({
      candidates: plan.candidates,
      comparisonProjectId: scope.id,
      getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
        judgmentContextId: () => {
          return pdfJudgmentContextId
        },
        origin: 'pdf-import',
        reviewer: () => {
          return {displayName: importedReviewer?.name ?? null, userId: importedReviewer?.id ?? null}
        },
        sourceRows,
      }),
      tx,
    })
    await writeComparisonProjectConflictCommentImportChanges({
      commentChanges: getPdfImportCommentChanges(commentChanges, importedReviewer),
      comparisonProjectId: scope.id,
      tx,
    })
    const cleared =
      pdfUndecidedMode === 'clear' && parsedImport.undecidedRows.length > 0
        ? await clearComparisonProjectConflictResolutionImportCandidates({
            candidates: (await getPdfUndecidedImportAnalysis({importMode, parsedImport, scope, tx})).plan.candidates,
            comparisonProjectId: scope.id,
            tx,
          })
        : 0

    return getComparisonProjectConflictResolutionImportCommitResult({
      analyzeResult: pdfAnalyzeResult,
      inserted,
      cleared,
    })
  })
}

const getCreateFromProjectPreviewComparisonProject = (params: {
  body: CreateComparisonProjectFromProjectSelectionBody
  context: CreateComparisonProjectFromProjectContext
}): ReturnType<typeof getComparisonProjectRecordValue> => {
  const now = new Date(0)

  return {
    id: 'comparison-project-conflict-resolution-import-preview',
    name: 'Conflict resolution import preview',
    description: null,
    modelIds: params.context.selectedModelIds,
    compareWithHumans: params.body.compareWithHumans ?? false,
    allowConflictResolution: params.body.allowConflictResolution ?? false,
    humanJudgmentMode: params.context.humanJudgmentMode,
    summarySourceProjectId: params.context.summarySourceProjectId,
    useTitle: params.context.sourceProject.useTitle,
    useAbstract: params.context.sourceProject.useAbstract,
    useFulltext: params.context.sourceProject.useFulltext,
    useFulltextNoImages: params.context.sourceProject.useFulltextNoImages,
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
}

const getComparisonProjectConflictResolutionFilterValueLabel = (
  scope: ComparisonProjectScope,
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilter,
) => {
  return conflictResolutionFilter === 'not-set'
    ? 'Not set'
    : (getComparisonProjectConflictResolutionOptionByValue(scope).get(conflictResolutionFilter)?.label
        ?? conflictResolutionFilter)
}

const getComparisonProjectConflictResolutionFiltersLabel = (
  scope: ComparisonProjectScope,
  conflictResolutionFilters: readonly ComparisonProjectConflictResolutionFilter[],
) => {
  return conflictResolutionFilters.length === 0
    ? 'Conflict resolution: All'
    : `Conflict resolution: ${conflictResolutionFilters
        .map((conflictResolutionFilter) => {
          return getComparisonProjectConflictResolutionFilterValueLabel(scope, conflictResolutionFilter)
        })
        .join(' + ')}`
}

const getValidatedComparisonProjectConflictResolutionOption = (scope: ComparisonProjectScope, value: string) => {
  const option = getComparisonProjectConflictResolutionOptionByValue(scope).get(value)

  if (!option) {
    throw new HttpError(
      400,
      getIsSummaryMode(scope)
        ? 'Conflict resolution answer must be one of the summary prompt options'
        : 'Conflict resolution prompt must belong to the comparison project',
    )
  }

  return option
}

const getComparisonProjectConflictResolutionUiProvenance = (
  scope: Pick<ComparisonProjectScope, 'activeGeneration' | 'judgmentContextId'>,
  reviewer: {id: string; name: string},
): ComparisonProjectConflictResolutionWriteProvenance => {
  return {
    judgmentContextId: scope.judgmentContextId,
    origin: 'ui',
    originRef: null,
    reviewerDisplayName: reviewer.name,
    reviewerUserId: reviewer.id,
    servingGeneration: scope.activeGeneration,
  }
}

const getSavedComparisonProjectConflictResolution = (params: {
  option: ComparisonProjectConflictResolutionOption
  resolutionRow: ComparisonProjectConflictResolutionSavedRow
  reviewer: {id: string; name: string}
  scope: Pick<ComparisonProjectScope, 'activeGeneration' | 'judgmentContextId'>
}): ComparisonProjectConflictResolution => {
  const provenance = getComparisonProjectConflictResolutionUiProvenance(params.scope, params.reviewer)
  const provenanceRow = {
    judgmentContextId: provenance.judgmentContextId,
    origin: provenance.origin,
    reviewerDisplayName: params.resolutionRow.reviewerDisplayName ?? provenance.reviewerDisplayName,
    reviewerUserId: params.resolutionRow.reviewerUserId ?? provenance.reviewerUserId,
    servingGeneration: provenance.servingGeneration,
    setAt: params.resolutionRow.setAt ?? new Date(),
  }

  return {
    articleId: params.resolutionRow.articleId,
    label: params.option.label,
    provenance: getComparisonProjectConflictResolutionProvenance(provenanceRow),
    provenanceMatchesCurrent: getComparisonProjectConflictResolutionProvenanceMatchesCurrent(
      provenance.judgmentContextId,
      params.scope.judgmentContextId,
    ),
    reviewer: getComparisonProjectConflictResolutionReviewer(provenanceRow),
    reviewerDisplayName: provenanceRow.reviewerDisplayName,
    reviewerUserId: provenanceRow.reviewerUserId,
    setAt: getDateValue(provenanceRow.setAt),
    value: params.option.value,
  }
}

const setComparisonProjectConflictResolution = async (params: {
  articleId: string
  value: string
  scope: ComparisonProjectScope
}) => {
  const startedAt = Date.now()
  const baseDiagnostic = {
    activeGeneration: params.scope.activeGeneration,
    articleId: params.articleId,
    comparisonProjectId: params.scope.id,
    isSummaryMode: getIsSummaryMode(params.scope),
    requestedValue: params.value,
  }
  let phase = 'target-validation'
  let targetRow: ComparisonProjectConflictResolutionTargetRow | null = null

  console.info(
    '[comparison-projects] conflict-resolution save started',
    getConflictResolutionSaveDiagnostic(baseDiagnostic),
  )

  try {
    logConflictResolutionSavePhase('target-validation:start', baseDiagnostic)
    targetRow = await getComparisonProjectConflictResolutionTargetRow(params.scope, params.articleId)
    logConflictResolutionSavePhase('target-validation:complete', baseDiagnostic, {
      articleCategory: targetRow.articleCategory,
      hasConflict: targetRow.hasConflict,
    })
    phase = 'option-validation'
    logConflictResolutionSavePhase('option-validation:start', baseDiagnostic)
    const option = getValidatedComparisonProjectConflictResolutionOption(params.scope, params.value)
    const isSummaryMode = getIsSummaryMode(params.scope)
    logConflictResolutionSavePhase('option-validation:complete', baseDiagnostic, {resolvedValue: option.value})
    phase = 'reviewer-load'
    logConflictResolutionSavePhase('reviewer-load:start', baseDiagnostic)
    const reviewer = await getUserConfigQueryService().getOrCreateUserConfig()
    logConflictResolutionSavePhase('reviewer-load:complete', baseDiagnostic, {reviewerUserId: reviewer.id})
    phase = 'resolution-replace'
    logConflictResolutionSavePhase('resolution-replace:start', baseDiagnostic, {reviewerUserId: reviewer.id})
    const resolutionRow = await appDatabaseService.transaction<ComparisonProjectConflictResolutionSavedRow>(
      async (tx): Promise<ComparisonProjectConflictResolutionSavedRow> => {
        const deletedRows = await tx.queryJson<{articleId: string}>(
          `
          DELETE FROM ${comparisonProjectConflictResolutionTable}
          WHERE comparison_project_id = ${getSqlLiteral(params.scope.id)}
            AND article_id = ${getSqlLiteral(params.articleId)}
          RETURNING article_id AS articleId
        `,
        )
        const [insertedRow] = await tx.queryJson<{
          articleId: string
          reviewerDisplayName: string | null
          reviewerUserId: string | null
          setAt?: unknown
        }>(`
          INSERT INTO ${comparisonProjectConflictResolutionTable} (${comparisonProjectConflictResolutionInsertColumnsSql})
          VALUES ${getComparisonProjectConflictResolutionInsertValuesSql({
            answerValue: isSummaryMode ? option.value : null,
            articleId: params.articleId,
            comparisonProjectId: params.scope.id,
            id: crypto.randomUUID(),
            promptId: isSummaryMode ? null : option.value,
            provenance: getComparisonProjectConflictResolutionUiProvenance(params.scope, reviewer),
          })}
          RETURNING
            article_id AS articleId,
            reviewer_user_id AS reviewerUserId,
            reviewer_display_name AS reviewerDisplayName,
            updated_at AS setAt
        `)

        if (!insertedRow) {
          throw new Error('Failed to save conflict resolution')
        }

        return {...insertedRow, replacedExistingResolution: deletedRows.length > 0}
      },
      getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictResolution.replace'),
    )

    if (!resolutionRow) {
      throw new Error('Failed to save conflict resolution')
    }
    logConflictResolutionSavePhase('resolution-replace:complete', baseDiagnostic, {
      replacedExistingResolution: resolutionRow.replacedExistingResolution,
      returnedArticleId: resolutionRow.articleId,
      reviewerUserId: reviewer.id,
    })

    console.info('[comparison-projects] conflict-resolution save completed', {
      ...baseDiagnostic,
      articleCategory: targetRow.articleCategory,
      durationMs: Date.now() - startedAt,
      hasConflict: targetRow.hasConflict,
      memory: getConflictResolutionSaveMemorySnapshot(),
      resolvedValue: option.value,
      reviewerUserId: reviewer.id,
      runtime: getConflictResolutionSaveRuntimeDiagnostic(),
    })

    return getSavedComparisonProjectConflictResolution({option, resolutionRow, reviewer, scope: params.scope})
  } catch (error) {
    console.error('[comparison-projects] conflict-resolution save failed', {
      ...baseDiagnostic,
      articleCategory: targetRow?.articleCategory ?? null,
      durationMs: Date.now() - startedAt,
      error: getConflictResolutionSaveErrorDiagnostic(error),
      hasConflict: targetRow?.hasConflict ?? null,
      memory: getConflictResolutionSaveMemorySnapshot(),
      phase,
      runtime: getConflictResolutionSaveRuntimeDiagnostic(),
    })
    throw error
  }
}

const resetComparisonProjectConflictResolution = async (params: {articleId: string; scope: ComparisonProjectScope}) => {
  await getComparisonProjectConflictResolutionTargetRow(params.scope, params.articleId)

  await appDatabaseService.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.scope.id)}
      AND article_id = ${getSqlLiteral(params.articleId)}
  `)

  return {articleId: params.articleId}
}

const getComparisonProjectConflictCommentTargetRow = async (scope: ComparisonProjectScope, articleId: string) => {
  if (!scope.allowConflictResolution) {
    throw new HttpError(400, 'Conflict resolution is not enabled for this comparison project')
  }

  const targetRow =
    scope.activeGeneration === null
      ? await getComparisonProjectConflictResolutionScopedTargetRow(scope, articleId)
      : await getComparisonProjectConflictResolutionServingTargetRow(scope, articleId)

  if (!targetRow) {
    throw new HttpError(400, 'Conflict comments are only available for articles in this comparison project')
  }

  return targetRow
}

const setComparisonProjectConflictComment = async (params: {
  articleId: string
  comment: string | null
  scope: ComparisonProjectScope
}) => {
  const comment = getValidatedComparisonProjectConflictComment(params.comment)

  await getComparisonProjectConflictCommentTargetRow(params.scope, params.articleId)

  const author = comment === null ? null : await getUserConfigQueryService().getOrCreateUserConfig()
  const conflictComment = await appDatabaseService.transaction(async (tx) => {
    return replaceComparisonProjectConflictComment({
      articleId: params.articleId,
      author,
      comment,
      comparisonProjectId: params.scope.id,
      tx,
    })
  }, getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictComment.save'))

  return {articleId: params.articleId, conflictComment}
}

const getComparisonProjectConflictResolutionExportResolutionValue = (
  scope: ComparisonProjectScope,
  row: ComparisonProjectConflictResolutionExportQueryRow,
) => {
  return getIsSummaryMode(scope) ? row.answerValue : row.promptId
}

const getComparisonProjectConflictResolutionExportSourceRow = (
  scope: ComparisonProjectScope,
  optionByValue: Map<string, ComparisonProjectConflictResolutionOption>,
  row: ComparisonProjectConflictResolutionExportQueryRow,
): ComparisonProjectConflictResolutionTransferSourceRow => {
  const resolutionValue =
    row.sourceResolutionId === null
      ? null
      : (getComparisonProjectConflictResolutionExportResolutionValue(scope, row) ?? '')
  const option = resolutionValue === null ? undefined : optionByValue.get(resolutionValue)

  return {
    ...row,
    resolutionLabel: option?.label ?? resolutionValue,
    resolutionMode: getIsSummaryMode(scope) ? 'summary' : 'prompt',
    resolutionValue,
  }
}

const getComparisonProjectConflictResolutionExportSourceRows = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
): Promise<ComparisonProjectConflictResolutionTransferSourceRow[]> => {
  if (scope.activeGeneration === null) {
    throw new HttpError(409, 'Conflict resolution export requires an active comparison serving generation')
  }

  const optionByValue = getComparisonProjectConflictResolutionOptionByValue(scope)
  const comparisonProjectLiteral = getSqlLiteral(scope.id)
  const activeGenerationLiteral = getSqlLiteral(scope.activeGeneration)
  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    scope.columns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const sourceRows: ComparisonProjectConflictResolutionTransferSourceRow[] = []
  const appendSourceRowsForArticleIds = async (articleIds: string[]) => {
    if (articleIds.length === 0) {
      return
    }

    const rows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionExportQueryRow>(`
    WITH batch_resolution AS (
      SELECT *
      FROM ${comparisonProjectConflictResolutionTable} cr
      WHERE cr.comparison_project_id = ${comparisonProjectLiteral}
        AND cr.article_id IN (${getInClause(articleIds)})
    ),
    batch_comment AS (
      SELECT id, article_id, comment, created_at
      FROM ${comparisonProjectConflictCommentTable}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND article_id IN (${getInClause(articleIds)})
      QUALIFY ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY updated_at DESC, id DESC) = 1
    ),
    batch_row AS (
      SELECT
        batch_resolution.id AS resolution_id,
        batch_comment.id AS comment_id,
        COALESCE(batch_resolution.article_id, batch_comment.article_id) AS article_id,
        batch_resolution.prompt_id,
        batch_resolution.answer_value,
        batch_resolution.reviewer_user_id,
        batch_resolution.reviewer_display_name,
        batch_resolution.judgment_context_id,
        batch_resolution.updated_at,
        batch_resolution.origin,
        COALESCE(batch_resolution.created_at, batch_comment.created_at) AS sort_created_at,
        batch_comment.comment
      FROM batch_resolution
      FULL OUTER JOIN batch_comment ON batch_comment.article_id = batch_resolution.article_id
    )
    SELECT
      br.resolution_id AS sourceResolutionId,
      br.article_id AS sourceArticleRowId,
      a.article_external_id AS externalArticleId,
      a.article_title AS title,
      a.doi AS doi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.biorxiv_id AS biorxivId,
      a.medrxiv_id AS medrxivId,
      a.url AS url,
      ai.source_identifier_id AS sourceIdentifierId,
      ai.kind AS identifierKind,
      ai.normalized_value AS identifierNormalizedValue,
      ai.source AS identifierSource,
      ai.is_primary AS identifierIsPrimary,
      br.prompt_id AS promptId,
      br.answer_value AS answerValue,
      COALESCE(NULLIF(TRIM(br.reviewer_display_name), ''), NULLIF(TRIM(reviewer.name), '')) AS provenanceReviewerDisplayName,
      br.judgment_context_id AS provenanceContextId,
      br.updated_at AS provenanceSetAt,
      br.origin AS provenanceOrigin,
      br.comment AS comment
    FROM batch_row br
    LEFT JOIN app.user_config reviewer ON reviewer.id = br.reviewer_user_id
    INNER JOIN mart.comparison_article_serving a
      ON a.comparison_project_id = ${comparisonProjectLiteral}
     AND a.generation = ${activeGenerationLiteral}
     AND a.article_id = br.article_id
    LEFT JOIN mart.comparison_article_identifier_serving ai
      ON ai.comparison_project_id = a.comparison_project_id
     AND ai.generation = a.generation
     AND ai.article_id = a.article_id
    ORDER BY
      br.sort_created_at ASC,
      COALESCE(br.resolution_id, br.comment_id) ASC,
      ai.is_primary DESC,
      ai.kind ASC,
      ai.normalized_value ASC,
      ai.source_identifier_id ASC
  `)

    sourceRows.push(
      ...rows.map((row) => {
        return getComparisonProjectConflictResolutionExportSourceRow(scope, optionByValue, row)
      }),
    )
  }

  await forEachComparisonProjectServingJudgmentArticleIdBatch({
    comparisonProjectId: scope.id,
    articleCategoryFilter: filters.articleCategoryFilters,
    conflictResolutionFilter: filters.conflictResolutionFilters,
    conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
    currentJudgmentContextId: scope.judgmentContextId,
    differenceFilter: normalizedDifferenceFilters,
    limit: comparisonProjectJudgmentArticleBatchSize,
    onArticleIds: appendSourceRowsForArticleIds,
    queryRunner: appDatabaseService,
    rowFilter: filters.rowFilters,
    searchText: filters.searchText,
  })

  return sourceRows
}

const getComparisonProjectConflictResolutionExportJudgmentContexts = async (
  sourceRows: readonly ComparisonProjectConflictResolutionTransferSourceRow[],
): Promise<ComparisonProjectConflictResolutionTransferJudgmentContextV2[]> => {
  const summaries = await getComparisonJudgmentContextsByIds(
    appDatabaseService,
    getUniqueStringValues(
      sourceRows.map((sourceRow) => {
        return sourceRow.provenanceContextId ?? ''
      }),
    ),
  )

  return summaries.map((summary) => {
    return {context: summary.context, id: summary.id}
  })
}

const getComparisonProjectConflictResolutionExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const exportedAt = new Date()
  const sourceRows = await getComparisonProjectConflictResolutionExportSourceRows(scope, filters)
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt,
    judgmentContexts: await getComparisonProjectConflictResolutionExportJudgmentContexts(sourceRows),
    source: {
      comparisonProjectId: scope.id,
      comparisonProjectName: scope.name,
      comparisonProjectDescription: scope.description,
    },
    rows: getComparisonProjectConflictResolutionTransferRows(sourceRows),
  })
  const filename = getComparisonProjectConflictResolutionTransferFilename(scope.id)

  return new Response(JSON.stringify(artifact), {
    headers: {'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': 'application/json'},
  })
}

const escapeComparisonProjectCsvValue = (value: string) => {
  return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

const getComparisonProjectCsvLine = (values: string[]) => {
  return `${values.map(escapeComparisonProjectCsvValue).join(',')}\n`
}

const getComparisonProjectExportDateValue = (value: Date | string | null) => {
  return value ? new Date(value).toISOString() : ''
}

const getComparisonProjectExportCellValue = (value: string | null | undefined) => {
  return (value ?? '')
    .split(/\r\n|\n|\r/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })
    .join('; ')
}

const getComparisonProjectPdfQuotesValue = (value: unknown) => {
  const quotesValue = getJsonValue(value)

  return Array.isArray(quotesValue)
    ? quotesValue
        .map((quote) => {
          return typeof quote === 'string' ? quote : JSON.stringify(quote)
        })
        .join('; ')
    : typeof quotesValue === 'string'
      ? quotesValue
      : quotesValue === null || quotesValue === undefined
        ? ''
        : JSON.stringify(quotesValue)
}

const getComparisonProjectExportColumnHeader = (column: ComparisonProjectJudgmentsColumn) => {
  const answerSourceLabel = column.kind === 'human' ? 'Human answer' : `LLM - ${column.modelLabel}`

  return [column.sourceProjectName, column.promptLabel, answerSourceLabel, column.contentLabel]
    .map((part) => {
      return part?.trim() ?? ''
    })
    .filter((part) => {
      return part !== ''
    })
    .join(' - ')
}

const getComparisonProjectExportHeaders = (
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    'Title',
    'Abstract/Summary',
    'Date added',
    ...(includeConflictResolution ? ['Conflict Handling', 'Conflict comment'] : []),
    ...columns.map((column) => {
      return getComparisonProjectExportColumnHeader(column)
    }),
  ]
}

const getComparisonProjectExportConflictResolutionValue = (row: ComparisonProjectExportRow) => {
  return row.conflictResolution?.label ?? (row.hasConflict ? '' : 'No conflict')
}

const getComparisonProjectExportRowValues = (
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    row.articleTitle?.trim() || 'Untitled',
    row.articleSummary ?? '',
    getComparisonProjectExportDateValue(row.articleCreatedAt),
    ...(includeConflictResolution
      ? [getComparisonProjectExportConflictResolutionValue(row), row.conflictComment?.comment ?? '']
      : []),
    ...columns.map((column) => {
      return getComparisonProjectExportCellValue(row.cells[column.id])
    }),
  ]
}

const enqueueComparisonProjectExportRows = (
  controller: ReadableStreamDefaultController<string>,
  rows: ComparisonProjectExportRow[],
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  rows.reduce((count, row) => {
    controller.enqueue(
      getComparisonProjectCsvLine(getComparisonProjectExportRowValues(row, columns, includeConflictResolution)),
    )
    return count + 1
  }, 0)
}

const getComparisonProjectExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_comparison_export_${new Date().toISOString().slice(0, 10)}.csv`
}

const getComparisonProjectPdfExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_comparison_export_${new Date().toISOString().slice(0, 10)}.pdf`
}

const getComparisonProjectExportResponse = (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const orderedColumns = getOrderedComparisonProjectColumns(scope.columns, scope.prompts)
  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    orderedColumns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const includeConflictResolution = scope.allowConflictResolution
  const headers = getComparisonProjectExportHeaders(orderedColumns, includeConflictResolution)
  const filename = getComparisonProjectExportFilename(scope)
  const responseHeaders = getCsvDownloadHeaders(filename)
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        controller.enqueue(csvUtf8Bom + getComparisonProjectCsvLine(headers))

        if (!scope.archived && scope.prompts.length > 0 && orderedColumns.length > 0) {
          await forEachComparisonProjectServingJudgmentRowBatch({
            comparisonProjectId: scope.id,
            articleCategoryFilter: filters.articleCategoryFilters,
            conflictResolutionFilter: filters.conflictResolutionFilters,
            conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
            currentJudgmentContextId: scope.judgmentContextId,
            differenceFilter: normalizedDifferenceFilters,
            limit: comparisonProjectJudgmentArticleBatchSize,
            onRows: async (rows) => {
              const exportRows = includeConflictResolution
                ? await getComparisonProjectRowsWithConflictResolutions(scope, rows)
                : rows
              enqueueComparisonProjectExportRows(controller, exportRows, orderedColumns, includeConflictResolution)
            },
            queryRunner: appDatabaseService,
            rowFilter: filters.rowFilters,
            searchText: filters.searchText,
          })
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(stream, {headers: responseHeaders})
}

const comparisonProjectConflictResolutionProvenanceFilterLabels = {
  current: 'Resolved under the current prompts',
  outdated: 'Resolved under older prompts',
  unknown: 'Prompts unknown',
} satisfies Record<ComparisonProjectConflictResolutionProvenanceFilter, string>

const getComparisonProjectConflictResolutionProvenanceFiltersLabel = (
  filters: readonly ComparisonProjectConflictResolutionProvenanceFilter[],
) => {
  return filters.length === 0
    ? null
    : `Resolution prompts: ${filters
        .map((filter) => {
          return comparisonProjectConflictResolutionProvenanceFilterLabels[filter]
        })
        .join(', ')}`
}

const getComparisonProjectPdfHeaderFilters = (params: {
  filters: ComparisonProjectJudgmentFilters
  scope: ComparisonProjectScope
}) => {
  const rowFilterLabel = getComparisonProjectRowFiltersLabel(params.filters.rowFilters, getIsSummaryMode(params.scope))
  const differenceFilterLabel = getComparisonProjectDifferenceFiltersLabel(params.filters.differenceFilters)
  const conflictResolutionLabel = getComparisonProjectConflictResolutionFiltersLabel(
    params.scope,
    params.filters.conflictResolutionFilters,
  )
  const conflictResolutionProvenanceLabel = getComparisonProjectConflictResolutionProvenanceFiltersLabel(
    params.filters.conflictResolutionProvenanceFilters,
  )
  const articleCategoryLabel = getComparisonProjectArticleCategoryFiltersLabel(
    getNormalizedComparisonProjectArticleCategoryFilters(params.filters.articleCategoryFilters),
  )
  const searchLabel = params.filters.searchText === '' ? null : `Search: "${params.filters.searchText}"`

  return [
    rowFilterLabel,
    differenceFilterLabel,
    conflictResolutionLabel,
    conflictResolutionProvenanceLabel,
    articleCategoryLabel,
    searchLabel,
  ]
    .filter((label) => {
      return label !== null
    })
    .join(' | ')
}

const getComparisonProjectPdfResolutionOptions = (scope: ComparisonProjectScope) => {
  const options = getComparisonProjectConflictResolutionOptions(scope)

  const resolutionOptions =
    options.length > 0
      ? options
      : [
          {label: 'Include / Yes', value: 'yes'},
          {label: 'Exclude / No', value: 'no'},
          {label: 'Maybe / Unsure', value: 'maybe'},
        ]

  return [{label: 'Undecided', value: pdfConflictResolutionNotSetValue}, ...resolutionOptions]
}

const getComparisonProjectPdfExportedAtLabel = (date = new Date()) => {
  const pad = (value: number) => {
    return String(value).padStart(2, '0')
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

const getComparisonProjectPdfFieldNamePart = (value: string) => {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

const getComparisonProjectPdfMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const addComparisonProjectPdfHiddenMetadata = (pdf: SimplePdfDocument, fieldName: string, value: unknown) => {
  pdf.addTextField({fieldName, hidden: true, value: getComparisonProjectPdfMetadataValue(value)})
}

const comparisonProjectPdfFrontPageFontSizes = {body: 10, heading: 11, title: 18} as const
const comparisonProjectPdfReviewerNameHelperText =
  'Enter the name that should be attached to imported conflict resolutions and comments.\nOptional, but helps distinguish different reviewers.'

const getComparisonProjectPdfArticleFieldPrefix = (scope: ComparisonProjectScope, row: ComparisonProjectExportRow) => {
  return [
    'comparison',
    getComparisonProjectPdfFieldNamePart(scope.id),
    'article',
    getComparisonProjectPdfFieldNamePart(row.canonicalArticleId),
  ].join('.')
}

const addComparisonProjectPdfFrontPage = (params: {
  exportFilters: string
  exportedAt: string
  pdf: SimplePdfDocument
  scope: ComparisonProjectScope
  totalCount: number
}) => {
  const {exportFilters, exportedAt, pdf, scope, totalCount} = params
  const documentId = crypto.randomUUID()

  addComparisonProjectPdfHiddenMetadata(pdf, 'forska.import.format', {
    documentId,
    format: 'forska.comparisonProject.pdfConflictResolutionImport',
    github: 'https://github.com/fc-io/forska.ai',
    version: 1,
  })
  addComparisonProjectPdfHiddenMetadata(pdf, 'forska.import.comparisonProject', {
    allowConflictResolution: scope.allowConflictResolution,
    comparisonProjectId: scope.id,
    comparisonProjectName: scope.name,
    exportedAt,
    filters: exportFilters,
    humanJudgmentMode: scope.humanJudgmentMode,
    judgmentContextId: scope.judgmentContextId,
    totalCount,
  })

  const frontPageFontSizes = comparisonProjectPdfFrontPageFontSizes

  pdf.addText('forska.ai conflict resolutions review', {font: 'bold', fontSize: frontPageFontSizes.title, gapAfter: 10})
  pdf.addText('Project', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addText(scope.name, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Comparison project ID: ${scope.id}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Exported: ${exportedAt}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Export number of articles: ${totalCount}`, {fontSize: frontPageFontSizes.body})
  pdf.addText(`Filters: ${exportFilters}`, {fontSize: frontPageFontSizes.body, gapAfter: 12})
  pdf.addText('Offline review', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addText(
    "Use this PDF to assess review conflicts offline. Fill in or change the conflict resolution radio buttons and comments for the articles you've reviewed. This PDF can then be imported into a forska.ai project to compare results.",
    {fontSize: frontPageFontSizes.body, gapAfter: 12},
  )
  pdf.addTextField({
    fieldName: 'forska.reviewer.displayName',
    fontSize: frontPageFontSizes.body,
    label: 'Your name:',
    value: '',
    width: 320,
    gapAfter: 18,
  })
  pdf.addText(comparisonProjectPdfReviewerNameHelperText, {fontSize: frontPageFontSizes.body, gapAfter: 26})
  pdf.addText('Terminology', {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 4})
  pdf.addDefinitionRow(
    'Review conflict',
    'An article where AIs, or an AI and human reviewers, do not agree whether a study should be included.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'Conflict resolution',
    'Your final choice for the inclusion of an article after reviewing the disagreement.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'Summary judgment',
    'The overall include/exclude choice for the study after considering the individual criteria.',
    {fontSize: frontPageFontSizes.body, gapAfter: 8},
  )
  pdf.addDefinitionRow(
    'LLM assessment',
    'The model-generated answer and reasoning that can be compared with the human judgment.',
    {fontSize: frontPageFontSizes.body, gapAfter: 12},
  )
  pdf.addText('For more information about forska.ai, visit https://github.com/fc-io/forska.ai.', {
    fontSize: frontPageFontSizes.body,
  })
}

const getComparisonProjectPdfPromptOverviewPrompts = (scope: ComparisonProjectScope) => {
  return getIsSummaryMode(scope) && scope.sourceProjectSummaryPrompts.length > 0
    ? scope.sourceProjectSummaryPrompts
    : scope.prompts
}

const addComparisonProjectPdfPromptOverviewPage = (pdf: SimplePdfDocument, scope: ComparisonProjectScope) => {
  const prompts = getComparisonProjectPdfPromptOverviewPrompts(scope)

  if (prompts.length === 0) {
    return
  }

  const frontPageFontSizes = comparisonProjectPdfFrontPageFontSizes

  pdf.addPage()
  pdf.addText('Prompts in this review', {font: 'bold', fontSize: frontPageFontSizes.title, gapAfter: 10})

  prompts.forEach((prompt) => {
    const heading = prompt.promptHeading?.trim()
    const title = heading ? `${prompt.order + 1}. ${heading}` : `${prompt.order + 1}. ${prompt.promptLabel}`
    const validOptions = prompt.type ? `Valid options: ${prompt.type}` : null

    pdf.ensureSpace(80)
    pdf.addText(title, {font: 'bold', fontSize: frontPageFontSizes.heading, gapAfter: 3})

    if (validOptions) {
      pdf.addText(validOptions, {fontSize: frontPageFontSizes.body, gapAfter: 4})
    }

    pdf.addText('Prompt:', {font: 'bold', fontSize: frontPageFontSizes.body, gapAfter: 2})
    pdf.addText(prompt.originalText, {fontSize: frontPageFontSizes.body, gapAfter: prompt.transformedText ? 5 : 12})

    if (prompt.transformedText) {
      pdf.addText('Transformed Text', {font: 'bold', fontSize: frontPageFontSizes.body, gapAfter: 2})
      pdf.addText(prompt.transformedText, {fontSize: frontPageFontSizes.body, gapAfter: 12})
    }
  })
}

const getComparisonProjectPdfExportedComment = (row: ComparisonProjectExportRow) => {
  return getNormalizedComparisonProjectConflictComment(row.conflictComment?.comment)
}

const addComparisonProjectPdfResolutionRadios = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  if (!row.hasConflict && !row.conflictResolution) {
    return
  }

  pdf.addText(getIsSummaryMode(scope) ? 'Include this study?' : 'Choose resolution', {fontSize: 10, gapAfter: 4})
  pdf.addRadioRow(
    [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'resolution'].join('.'),
    null,
    getComparisonProjectPdfResolutionOptions(scope).map((option) => {
      return {label: option.label, value: option.value, fontSize: 10, gapAfter: 3}
    }),
  )
  pdf.addGap(6)
}

const addComparisonProjectPdfConflictResolution = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  if (!scope.allowConflictResolution || (!row.hasConflict && !row.conflictResolution && !row.conflictComment)) {
    return
  }

  pdf.addPanel({title: 'Conflict resolution'}, () => {
    pdf.addInlineText(
      [
        {text: 'Current resolution: '},
        {font: 'bold', text: row.conflictResolution?.label ?? 'Not set'},
        ...(row.hasConflict ? [] : [{text: ' (no current conflict)'}]),
      ],
      {fontSize: 10, gapAfter: 6},
    )
    addComparisonProjectPdfResolutionRadios(pdf, scope, row)
    pdf.addTextField({
      fieldName: [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'comment'].join('.'),
      fontSize: 10,
      gapAfter: 0,
      label: 'Comment (optional)',
      lines: 4,
      maxLength: comparisonProjectConflictResolutionCommentMaxLength,
      multiline: true,
      value: getComparisonProjectPdfExportedComment(row) ?? '',
    })
  })
}

const addComparisonProjectPdfRowImportMetadata = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  addComparisonProjectPdfHiddenMetadata(
    pdf,
    [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'metadata'].join('.'),
    {
      articleExternalId: row.articleExternalId,
      articleTitle: row.articleTitle,
      canonicalArticleId: row.canonicalArticleId,
      comparisonProjectId: scope.id,
      currentResolutionValue: row.conflictResolution?.value ?? null,
      exportedComment: getComparisonProjectPdfExportedComment(row),
      hasConflict: row.hasConflict,
    },
  )
}

const addComparisonProjectPdfLabeledValue = (
  pdf: SimplePdfDocument,
  label: string,
  value: string | null | undefined,
  indent: number,
) => {
  const normalizedValue = getComparisonProjectExportCellValue(value)

  if (normalizedValue) {
    pdf.addText(`${label}: ${normalizedValue}`, {fontSize: 10, indent})
  }
}

const getComparisonProjectPdfAssessmentDetail = (
  prompt: ComparisonProjectSourceSummaryPromptConfig,
  row: ComparisonProjectLlmRow,
): ComparisonProjectPdfAssessmentDetail => {
  return {
    answer: getComparisonProjectExportCellValue(row.answeredOriginal) || 'Not answered',
    explanation: getComparisonProjectExportCellValue(row.explanation),
    label: prompt.promptLabel,
    quotes: getComparisonProjectPdfQuotesValue(row.quotes),
  }
}

const addComparisonProjectPdfAssessmentDetail = (
  pdf: SimplePdfDocument,
  detail: ComparisonProjectPdfAssessmentDetail,
) => {
  pdf.ensureSpace(38)
  pdf.addText(detail.label, {font: 'bold', fontSize: 10, indent: 24})
  pdf.addText(`Answer: ${detail.answer}`, {fontSize: 10, indent: 36})
  addComparisonProjectPdfLabeledValue(pdf, 'Explanation', detail.explanation, 36)
  addComparisonProjectPdfLabeledValue(pdf, 'Quotes', detail.quotes, 36)
}

const getComparisonProjectPdfAssessmentDetails = (params: {
  column: ComparisonProjectJudgmentsColumn
  componentRows: readonly ComparisonProjectLlmRow[]
  scope: ComparisonProjectScope
}) => {
  if (params.column.kind !== 'llm' || params.column.promptId !== summaryPromptId || !getIsSummaryMode(params.scope)) {
    return []
  }

  return params.scope.sourceProjectSummaryPrompts
    .filter((prompt) => {
      return params.column.sourceProjectId === null || prompt.sourceProjectId === params.column.sourceProjectId
    })
    .flatMap<ComparisonProjectPdfAssessmentDetail>((prompt) => {
      return params.componentRows
        .filter((row) => {
          return (
            row.promptId === prompt.id
            && getComparisonProjectColumnId(
              'llm',
              summaryPromptId,
              row.modelId,
              getComparisonProjectContentKey(row),
              params.column.sourceProjectId,
            ) === params.column.id
          )
        })
        .map((row) => {
          return getComparisonProjectPdfAssessmentDetail(prompt, row)
        })
    })
}

const getComparisonProjectPdfSummaryJudgments = (params: {
  columns: readonly ComparisonProjectJudgmentsColumn[]
  componentRows: readonly ComparisonProjectLlmRow[]
  row: ComparisonProjectExportRow
  scope: ComparisonProjectScope
}) => {
  return params.columns.flatMap<ComparisonProjectPdfSummaryJudgment>((column) => {
    const details = getComparisonProjectPdfAssessmentDetails({
      column,
      componentRows: params.componentRows,
      scope: params.scope,
    })

    if (details.length === 0) {
      return []
    }

    return [
      {
        answer: getComparisonProjectExportCellValue(params.row.cells[column.id]) || 'Not answered',
        contentLabel: column.kind === 'llm' ? column.contentLabel : null,
        details,
        sourceLabel: column.kind === 'human' ? 'Human judgment' : `LLM judgment: ${column.modelLabel}`,
      },
    ]
  })
}

const addComparisonProjectPdfLlmAssessmentSection = (
  pdf: SimplePdfDocument,
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
  scope: ComparisonProjectScope,
  componentRows: readonly ComparisonProjectLlmRow[],
) => {
  const summaryJudgments = getComparisonProjectPdfSummaryJudgments({columns, componentRows, row, scope})

  if (summaryJudgments.length === 0) {
    return
  }

  pdf.addPanel({title: 'LLM assessment'}, () => {
    summaryJudgments.forEach((summaryJudgment) => {
      pdf.ensureSpace(30)
      pdf.addText(summaryJudgment.sourceLabel, {font: 'bold', fontSize: 10})

      summaryJudgment.details.forEach((detail) => {
        addComparisonProjectPdfAssessmentDetail(pdf, detail)
      })
      pdf.addGap(5)
    })
  })
}

const addComparisonProjectPdfSummaryJudgmentSection = (
  pdf: SimplePdfDocument,
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
) => {
  pdf.addPanel({title: 'Summary judgment'}, () => {
    const columnsByPrompt = columns.reduce<Map<string, ComparisonProjectJudgmentsColumn[]>>((columnMap, column) => {
      const promptColumns = columnMap.get(column.promptId) ?? []
      promptColumns.push(column)
      columnMap.set(column.promptId, promptColumns)
      return columnMap
    }, new Map<string, ComparisonProjectJudgmentsColumn[]>())

    Array.from(columnsByPrompt.entries()).forEach(([, promptColumns]) => {
      pdf.addText('Include this study?', {font: 'bold', fontSize: 10, gapAfter: 4})

      promptColumns.forEach((column) => {
        const answer = getComparisonProjectExportCellValue(row.cells[column.id]) || 'Not answered'
        const sourceLabel = column.kind === 'human' ? 'Human judgment' : `LLM judgment: ${column.modelLabel}`

        pdf.ensureSpace(30)
        pdf.addText(sourceLabel, {font: 'bold', fontSize: 10})
        pdf.addText(`Answer: ${answer}`, {fontSize: 10, indent: 12})

        pdf.addGap(5)
      })
      pdf.addGap(8)
    })
  })
}

const addComparisonProjectPdfExportRow = (params: {
  columns: readonly ComparisonProjectJudgmentsColumn[]
  componentRows: readonly ComparisonProjectLlmRow[]
  exportFilters: string
  index: number
  pdf: SimplePdfDocument
  row: ComparisonProjectExportRow
  scope: ComparisonProjectScope
  totalCount: number
}) => {
  const {columns, componentRows, exportFilters, index, pdf, row, scope, totalCount} = params

  pdf.addPage()
  addComparisonProjectPdfRowImportMetadata(pdf, scope, row)

  pdf.addText(`Project: ${scope.name}`, {fontSize: 8})
  pdf.addText(`Filters: ${exportFilters}`, {fontSize: 8})
  pdf.addText(`Exported: ${getComparisonProjectPdfExportedAtLabel()}`, {fontSize: 8, gapAfter: 12})
  pdf.addText(
    `Article ${index + 1} of ${totalCount} | Article ID: ${row.articleExternalId ?? row.canonicalArticleId}`,
    {fontSize: 8, gapAfter: 10},
  )
  pdf.addText(row.articleTitle?.trim() || 'Untitled', {font: 'bold', fontSize: 15, gapAfter: 10})
  pdf.addText('Abstract / Summary', {font: 'bold', fontSize: 11, gapAfter: 4})
  pdf.addText(row.articleSummary?.trim() || 'No abstract or summary available.', {fontSize: 10, gapAfter: 12})
  addComparisonProjectPdfConflictResolution(pdf, scope, row)
  addComparisonProjectPdfSummaryJudgmentSection(pdf, row, columns)
  addComparisonProjectPdfLlmAssessmentSection(pdf, row, columns, scope, componentRows)
}

const getComparisonProjectPdfExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const orderedColumns = getOrderedComparisonProjectColumns(scope.columns, scope.prompts)
  const normalizedFilters: ComparisonProjectJudgmentFilters = {
    ...filters,
    differenceFilters: getNormalizedComparisonProjectDifferenceFilters(
      filters.differenceFilters,
      orderedColumns,
      getComparisonProjectDifferenceFilterAvailability(scope),
    ),
  }
  const filename = getComparisonProjectPdfExportFilename(scope)
  const pdf = new SimplePdfDocument()
  const totalCountResult = await getComparisonProjectJudgmentsCount(
    scope,
    comparisonProjectJudgmentArticleBatchSize,
    normalizedFilters,
  )
  const exportFilters = getComparisonProjectPdfHeaderFilters({filters: normalizedFilters, scope})
  const exportedAt = getComparisonProjectPdfExportedAtLabel()
  let rowIndex = 0

  addComparisonProjectPdfFrontPage({exportFilters, exportedAt, pdf, scope, totalCount: totalCountResult.totalCount})
  addComparisonProjectPdfPromptOverviewPage(pdf, scope)

  if (!scope.archived && scope.prompts.length > 0 && orderedColumns.length > 0) {
    await forEachComparisonProjectServingJudgmentRowBatch({
      comparisonProjectId: scope.id,
      articleCategoryFilter: normalizedFilters.articleCategoryFilters,
      conflictResolutionFilter: normalizedFilters.conflictResolutionFilters,
      conflictResolutionProvenanceFilter: normalizedFilters.conflictResolutionProvenanceFilters,
      currentJudgmentContextId: scope.judgmentContextId,
      differenceFilter: normalizedFilters.differenceFilters,
      limit: comparisonProjectJudgmentArticleBatchSize,
      onRows: async (rows) => {
        const exportRows = scope.allowConflictResolution
          ? await getComparisonProjectRowsWithConflictResolutions(scope, rows)
          : rows
        const componentRows =
          getIsSummaryMode(scope) && scope.sourceProjectSummaryPrompts.length > 0
            ? await getComparisonProjectLlmRows(
                scope,
                rows.map((row) => {
                  return row.canonicalArticleId
                }),
              )
            : []
        const componentRowsByArticle = componentRows.reduce<Map<string, ComparisonProjectLlmRow[]>>((rowMap, row) => {
          const articleRows = rowMap.get(row.articleId) ?? []
          rowMap.set(row.articleId, [...articleRows, row])
          return rowMap
        }, new Map<string, ComparisonProjectLlmRow[]>())

        exportRows.forEach((row) => {
          addComparisonProjectPdfExportRow({
            columns: orderedColumns,
            componentRows: componentRowsByArticle.get(row.canonicalArticleId) ?? [],
            exportFilters,
            index: rowIndex,
            pdf,
            row,
            scope,
            totalCount: totalCountResult.totalCount,
          })
          rowIndex += 1
        })
      },
      queryRunner: appDatabaseService,
      rowFilter: normalizedFilters.rowFilters,
      searchText: normalizedFilters.searchText,
    })
  }

  if (rowIndex === 0) {
    pdf.addPage()
    pdf.addText(`Project: ${scope.name}`, {fontSize: 8})
    pdf.addText(`Filters: ${exportFilters}`, {fontSize: 8, gapAfter: 12})
    pdf.addText('No rows matched the selected export filters.', {font: 'bold', fontSize: 12})
  }

  return new Response(pdf.toBuffer(), {
    headers: {'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': 'application/pdf'},
  })
}

const getComparisonProjectFormattedExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
  format: ComparisonProjectExportFormat,
) => {
  return format === 'pdf'
    ? getComparisonProjectPdfExportResponse(scope, filters)
    : getComparisonProjectExportResponse(scope, filters)
}

const getComparisonProjectJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  cursor: string | null,
  filters: ComparisonProjectJudgmentFilters,
) => {
  if (scope.archived || scope.prompts.length === 0 || scope.columns.length === 0) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  if (scope.activeGeneration === null) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    scope.columns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const pageResult = await getComparisonProjectServingJudgmentRowsPage({
    comparisonProjectId: scope.id,
    articleCategoryFilter: filters.articleCategoryFilters,
    conflictResolutionFilter: filters.conflictResolutionFilters,
    conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
    currentJudgmentContextId: scope.judgmentContextId,
    cursor,
    differenceFilter: normalizedDifferenceFilters,
    limit,
    queryRunner: appDatabaseService,
    rowFilter: filters.rowFilters,
    searchText: filters.searchText,
  })
  const rowsWithConflictResolutions = await getComparisonProjectRowsWithConflictResolutions(scope, pageResult.rows)

  return {
    activeGeneration: scope.activeGeneration,
    data: rowsWithConflictResolutions,
    isServingReady: scope.isServingReady,
    limit,
    nextCursor: pageResult.nextCursor,
    page,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
    totalCount: null,
    totalPages: null,
  }
}

const getComparisonProjectStatsConflictResolutionProvenanceScope = (
  requested: ComparisonProjectStatsConflictResolutionProvenance,
  judgmentContextId: string | null,
): ComparisonProjectStatsConflictResolutionProvenanceScope => {
  return requested === 'current' && judgmentContextId === null
    ? {applied: false, reason: 'no-active-context', requested}
    : {applied: true, reason: null, requested}
}

const getComparisonProjectStatsResponse = async (
  scope: ComparisonProjectScope,
  conflictResolutionProvenance: ComparisonProjectStatsConflictResolutionProvenance = 'all',
): Promise<ComparisonProjectStatsResponse> => {
  const conflictResolutionProvenanceScope = getComparisonProjectStatsConflictResolutionProvenanceScope(
    conflictResolutionProvenance,
    scope.judgmentContextId,
  )

  if (scope.archived) {
    return {
      activeGeneration: scope.activeGeneration,
      additionalProjectStats: {conflictResolutionAnswerComparisons: [], resolvedTruthComparisons: []},
      categoryBreakdowns: [],
      comparisons: [],
      conflictResolutionProvenance,
      conflictResolutionProvenanceScope,
      judgmentContextId: scope.judgmentContextId,
      isServingReady: scope.isServingReady,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
    }
  }

  const statsParams = {
    allowConflictResolution: scope.allowConflictResolution,
    columns: scope.columns,
    comparisonProjectId: scope.id,
    conflictResolutionProvenance: conflictResolutionProvenanceScope.applied ? conflictResolutionProvenance : 'all',
    currentJudgmentContextId: scope.judgmentContextId,
    generation: scope.activeGeneration,
    isSummaryMode: getIsSummaryMode(scope),
    primaryModelId: scope.modelIds?.[0] ?? null,
    primarySourceProjectId: scope.summarySourceProjectId ?? scope.sourceProjectIds[0] ?? null,
    queryRunner: appDatabaseService,
  }
  const stats = await getComparisonProjectStatsWithCategoryBreakdowns(statsParams)

  return {
    activeGeneration: scope.activeGeneration,
    additionalProjectStats: stats.additionalProjectStats,
    categoryBreakdowns: stats.categoryBreakdowns,
    comparisons: stats.comparisons,
    conflictResolutionProvenance,
    conflictResolutionProvenanceScope,
    judgmentContextId: scope.judgmentContextId,
    isServingReady: scope.isServingReady,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
  }
}

const deleteComparisonProjectLinkRows = async (tx: AppTx, tableName: string, comparisonProjectId: string) => {
  await tx.run(`
    DELETE FROM ${tableName}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
}

const hasSameStringArrayValue = (left: string[] | null, right: string[] | null) => {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

const getDuckdbStringArrayValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string'
    })
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue === '[]') {
    return []
  }

  if (!trimmedValue.startsWith('[') || !trimmedValue.endsWith(']')) {
    return null
  }

  return trimmedValue
    .slice(1, -1)
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part !== ''
    })
}

const updateComparisonProjectWithRelinkedLinks = async (params: {
  comparisonProjectId: string
  importRoutes?: string[]
  setParts: string[]
  sourceProjectIds?: string[]
  promptSelections: PromptSelection[]
}): Promise<ComparisonProjectRecordRow | null> => {
  return appDatabaseService.transaction(async (tx) => {
    const updatedComparisonProjectRecord = await updateComparisonProjectTx(tx, {
      comparisonProjectId: params.comparisonProjectId,
      setParts: params.setParts,
    })

    if (!updatedComparisonProjectRecord) {
      throw new Error('Comparison project not found')
    }

    await deleteComparisonProjectLinkRows(tx, comparisonProjectPromptTable, params.comparisonProjectId)
    await insertComparisonProjectPromptLinks(tx, params.comparisonProjectId, params.promptSelections)

    if (params.importRoutes !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectImportRouteTable, params.comparisonProjectId)
      await insertComparisonProjectRouteLinks(tx, params.comparisonProjectId, params.importRoutes)
    }

    if (params.sourceProjectIds !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectSourceProjectTable, params.comparisonProjectId)
      await insertComparisonProjectSourceProjectLinks(tx, params.comparisonProjectId, params.sourceProjectIds)
    }

    return updatedComparisonProjectRecord
  }) as Promise<ComparisonProjectRecordRow | null>
}

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/comparison-projects', async () => {
    const data = await getComparisonProjectsList(false)

    return {data}
  })
  .get('/api/comparison-projects/archived', async () => {
    const data = await getComparisonProjectsList(true)

    return {data}
  })
  .get('/api/comparison-projects/sources', async () => {
    const data = await getComparisonProjectSources()

    return {data}
  })
  .post(
    '/api/comparison-projects/judgment-contexts',
    async (context) => {
      const data = await getComparisonJudgmentContextsByIds(appDatabaseService, context.body.ids)

      return {data}
    },
    {
      body: t.Object({
        ids: t.Array(t.String({pattern: '^[0-9a-f]{64}$'}), {maxItems: comparisonJudgmentContextLookupLimit}),
      }),
    },
  )
  .get('/api/comparison-projects/conflict-resolution-import-sources', async () => {
    const data = await getComparisonProjectConflictResolutionImportSources()

    return {data}
  })
  .post(
    '/api/comparison-projects/conflict-resolution-import-preview',
    async (context) => {
      const {body} = context
      const data = await getComparisonProjectConflictResolutionImportPreview(body)

      return {data}
    },
    {
      body: t.Object({
        compareWithHumans: t.Optional(t.Boolean()),
        allowConflictResolution: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        sourceProjectId: t.String(),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        conflictResolutionImportMode: t.Optional(t.Union([t.Literal('conflicting-only'), t.Literal('all-matched')])),
        conflictResolutionImportSourceComparisonProjectIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .post(
    '/api/comparison-projects/from-project',
    async (context) => {
      const {body} = context
      const fromProjectContext = await getCreateComparisonProjectFromProjectContext(body)
      const conflictResolutionImportSourceComparisonProjectIds = getUniqueStringValues(
        body.conflictResolutionImportSourceComparisonProjectIds ?? [],
      )
      const hasConflictResolutionImportSources = conflictResolutionImportSourceComparisonProjectIds.length > 0

      if (
        hasConflictResolutionImportSources
        && (fromProjectContext.humanJudgmentMode !== 'summary'
          || !body.compareWithHumans
          || !body.allowConflictResolution)
      ) {
        throw getConflictResolutionImportRejectedError(
          'Conflict resolution imports require summary mode and allow conflict resolution to be enabled',
        )
      }
      const createResult = (await appDatabaseService.transaction(async (tx) => {
        await validateConflictResolutionImportSources(tx, conflictResolutionImportSourceComparisonProjectIds)

        const createdComparisonProject = await createComparisonProjectRecord(tx, {
          name: body.name,
          description: body.description,
          modelIds: fromProjectContext.selectedModelIds,
          compareWithHumans: body.compareWithHumans,
          allowConflictResolution: body.allowConflictResolution,
          humanJudgmentMode: fromProjectContext.humanJudgmentMode,
          summarySourceProjectId: fromProjectContext.summarySourceProjectId,
          useTitle: fromProjectContext.sourceProject.useTitle,
          useAbstract: fromProjectContext.sourceProject.useAbstract,
          useFulltext: fromProjectContext.sourceProject.useFulltext,
          useFulltextNoImages: fromProjectContext.sourceProject.useFulltextNoImages,
          importRoutes: fromProjectContext.selectedImportRoutes,
          sourceProjectIds:
            fromProjectContext.humanJudgmentMode === 'summary'
              ? fromProjectContext.selectedSourceProjectIds
              : [fromProjectContext.sourceProject.id],
          promptSelections: fromProjectContext.sourcePromptSelections,
          validateModelIds: false,
        })
        const conflictResolutionImportSummary = hasConflictResolutionImportSources
          ? await importComparisonProjectConflictResolutions({
              comparisonProjectId: createdComparisonProject.id,
              importMode: body.conflictResolutionImportMode,
              promptSelections: fromProjectContext.sourcePromptSelections,
              scope: await getCreateFromProjectImportScope({
                createdComparisonProject,
                promptSelections: fromProjectContext.sourcePromptSelections,
                selectedImportRoutes: fromProjectContext.selectedImportRoutes,
                selectedSourceProjectIds: fromProjectContext.selectedSourceProjectIds,
                selectedSourceProjects: fromProjectContext.selectedSourceProjects,
                summarySourceProjectId: fromProjectContext.summarySourceProjectId,
                tx,
              }),
              sourceComparisonProjectIds: conflictResolutionImportSourceComparisonProjectIds,
              tx,
            })
          : null

        return {createdComparisonProject, conflictResolutionImportSummary}
      })) as {
        createdComparisonProject: Awaited<ReturnType<typeof createComparisonProjectRecord>>
        conflictResolutionImportSummary: ComparisonProjectConflictResolutionImportSummary | null
      }
      const createdComparisonProject = createResult.createdComparisonProject
      await checkpointComparisonProjectMutation()
      await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

      return createResult.conflictResolutionImportSummary
        ? {
            data: createdComparisonProject,
            conflictResolutionImportSummary: createResult.conflictResolutionImportSummary,
          }
        : {data: createdComparisonProject}
    },
    {
      transform: rejectLegacyFullTextNoImagesBody,
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Optional(t.Boolean()),
        allowConflictResolution: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        sourceProjectId: t.String(),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        conflictResolutionImportMode: t.Optional(t.Union([t.Literal('conflicting-only'), t.Literal('all-matched')])),
        conflictResolutionImportSourceComparisonProjectIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/api/comparison-projects/:id/edit', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectEditFormData(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  })
  .get(
    '/api/comparison-projects/:id/stats',
    async (context) => {
      const {params, query, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await getComparisonProjectStatsResponse(scope, query.conflictResolutionProvenance ?? 'all')

      return {data}
    },
    {query: t.Object({conflictResolutionProvenance: t.Optional(t.Union([t.Literal('all'), t.Literal('current')]))})},
  )
  .get('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const detail: {
      data: ComparisonProjectScope
      judgmentContext: ComparisonJudgmentContextSummary | null
      resolutionCount: number
    } | null = await appDatabaseService.transaction(async (tx) => {
      const data = await getComparisonProjectScope(params.id, tx)

      if (!data) {
        return null
      }

      const resolutionCount = await getComparisonProjectResolutionCount(params.id, tx)
      const [judgmentContext = null] = data.judgmentContextId
        ? await getComparisonJudgmentContextsByIds(tx, [data.judgmentContextId])
        : []

      return {data, judgmentContext, resolutionCount}
    }, comparisonProjectMetadataWorkloadContext)

    if (!detail) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const {data, judgmentContext, resolutionCount} = detail

    queueUnavailableComparisonProjectServingRebuild(data)

    return {data: {...data, judgmentContext, resolutionCount}}
  })
  .post(
    '/api/comparison-projects/:id/judgments',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedPage = getRequestedPositiveInteger(body.page, 1)
      const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
      const page = Math.max(parsedPage, 1)
      const limit = Math.min(Math.max(parsedLimit, 1), 100)
      const cursor = getComparisonProjectJudgmentsCursor({cursor: body.cursor, limit, page})
      const filters = getRequestedComparisonProjectJudgmentFilters(data, body)
      const judgmentsPage = await getComparisonProjectJudgmentsPage(data, page, limit, cursor, filters)

      return {data: judgmentsPage}
    },
    {
      body: t.Object({
        page: t.Optional(t.Union([t.String(), t.Number()])),
        limit: t.Union([t.String(), t.Number()]),
        cursor: t.Optional(t.Nullable(t.String())),
        search: t.Optional(t.String()),
        rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        showOnlyModelDifferences: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/judgments/count',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
      const limit = Math.min(Math.max(parsedLimit, 1), 100)
      const countResult = await getComparisonProjectJudgmentsCount(
        data,
        limit,
        getRequestedComparisonProjectJudgmentFilters(data, body),
      )

      return {data: countResult}
    },
    {
      body: t.Object({
        limit: t.Union([t.String(), t.Number()]),
        search: t.Optional(t.String()),
        rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolution',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const checkpointDiagnostic = {
        activeGeneration: scope.activeGeneration,
        articleId: body.articleId,
        comparisonProjectId: scope.id,
        isSummaryMode: getIsSummaryMode(scope),
        requestedValue: body.value,
      }
      const data = await setComparisonProjectConflictResolution({articleId: body.articleId, value: body.value, scope})
      scheduleComparisonProjectConflictResolutionCheckpoint(checkpointDiagnostic)
      logConflictResolutionSavePhase('deferred-checkpoint:scheduled', checkpointDiagnostic)

      return {data}
    },
    {body: t.Object({articleId: t.String(), value: t.String()})},
  )
  .post(
    '/api/comparison-projects/:id/conflict-comment',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await setComparisonProjectConflictComment({articleId: body.articleId, comment: body.comment, scope})
      scheduleComparisonProjectConflictResolutionCheckpoint({
        activeGeneration: scope.activeGeneration,
        articleId: body.articleId,
        comparisonProjectId: scope.id,
        isSummaryMode: getIsSummaryMode(scope),
        requestedValue: 'comment',
      })

      return {data}
    },
    {body: t.Object({articleId: t.String(), comment: t.Union([t.String(), t.Null()])})},
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolution/reset',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await resetComparisonProjectConflictResolution({articleId: body.articleId, scope})
      scheduleComparisonProjectConflictResolutionCheckpoint()

      return {data}
    },
    {body: t.Object({articleId: t.String()})},
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolutions/export',
    async (context) => {
      const {params, body, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      if (scope.activeGeneration === null) {
        set.status = 409
        return {data: null, error: 'Conflict resolution export requires an active comparison serving generation'}
      }

      return getComparisonProjectConflictResolutionExportResponse(
        scope,
        getRequestedComparisonProjectJudgmentFilters(scope, body),
      )
    },
    {
      body: t.Object({
        rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        search: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolutions/import/analyze',
    async (context) => {
      const {params, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await analyzeComparisonProjectConflictResolutionImport(scope, context.body)

      return {data}
    },
    {body: t.Any()},
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolutions/import/pdf/analyze',
    async (context) => {
      const {params, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await analyzeComparisonProjectConflictResolutionPdfImport(scope, context.body)

      return {data}
    },
    {
      body: t.Object({
        file: t.File(),
        importMode: t.Optional(t.String()),
        overwriteMode: t.Optional(t.String()),
        pdfUndecidedMode: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolutions/import/commit',
    async (context) => {
      const {params, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await commitComparisonProjectConflictResolutionImport(scope, context.body)
      await checkpointComparisonProjectMutation()

      return {data}
    },
    {body: t.Any()},
  )
  .post(
    '/api/comparison-projects/:id/conflict-resolutions/import/pdf/commit',
    async (context) => {
      const {params, set} = context
      const scope = await getComparisonProjectScope(params.id)

      if (!scope) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const data = await commitComparisonProjectConflictResolutionPdfImport(scope, context.body)
      await checkpointComparisonProjectMutation()

      return {data}
    },
    {
      body: t.Object({
        file: t.File(),
        importMode: t.Optional(t.String()),
        overwriteMode: t.Optional(t.String()),
        pdfUndecidedMode: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/comparison-projects/:id/export',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const format: ComparisonProjectExportFormat = body.format === 'pdf' ? 'pdf' : 'csv'

      return getComparisonProjectFormattedExportResponse(
        data,
        getRequestedComparisonProjectJudgmentFilters(data, body),
        format,
      )
    },
    {
      body: t.Object({
        rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
        format: t.Optional(t.Union([t.Literal('csv'), t.Literal('pdf')])),
        search: t.Optional(t.String()),
        differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      }),
    },
  )
  .post(
    '/api/comparison-projects',
    async (context) => {
      const {body} = context
      await assertComparisonProjectSourceProjectIdsShareFullTextStrategy(
        appDatabaseService,
        getComparisonProjectBodySourceProjectIds(body),
      )
      const createdComparisonProject = await appDatabaseService.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, body)
      })
      await checkpointComparisonProjectMutation()
      await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

      return {data: createdComparisonProject}
    },
    {
      transform: rejectLegacyFullTextNoImagesBody,
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        allowConflictResolution: t.Optional(t.Boolean()),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/comparison-projects/:id',
    async (context) => {
      const {params, body, set} = context
      const existingComparisonProject = await getComparisonProjectEditFormData(params.id)

      if (!existingComparisonProject) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const useTitle = body.useTitle
      const useAbstract = body.useAbstract
      const useFulltext = body.useFulltext
      const useFulltextNoImages = existingComparisonProject.useFulltextNoImages

      if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
        throw new Error('Select at least one article content option to compare')
      }

      const validatedModelIds = await getValidatedModelIds(
        appDatabaseService,
        getUniqueStringValues(body.modelIds ?? []),
      )
      const [existingModelIdsRow] = await appDatabaseService.queryJson<{modelIds: unknown}>(`
        SELECT model_ids AS modelIds
        FROM ${comparisonProjectTable}
        WHERE id = ${getSqlLiteral(params.id)}
        LIMIT 1
      `)
      const existingModelIds = getDuckdbStringArrayValue(existingModelIdsRow?.modelIds)
      const humanJudgmentMode = body.humanJudgmentMode ?? existingComparisonProject.humanJudgmentMode
      const summarySourceProjectId =
        humanJudgmentMode === 'summary'
          ? getSummarySourceProjectId(body.summarySourceProjectId ?? existingComparisonProject.summarySourceProjectId)
          : null
      const validatedPromptSelections = await getValidatedComparisonPromptSelections(appDatabaseService, {
        compareWithHumans: body.compareWithHumans,
        humanJudgmentMode,
        promptSelections: body.promptSelections,
        summarySourceProjectId,
      })
      const uniqueImportRoutes =
        body.importRoutes === undefined ? undefined : getUniqueStringValues(body.importRoutes ?? [])
      const validatedSourceProjectIds =
        body.sourceProjectIds === undefined
          ? undefined
          : await getValidatedComparisonSourceProjectIds(appDatabaseService, body.sourceProjectIds ?? [])

      if (
        validatedSourceProjectIds !== undefined
        && !hasSameStringArrayValue(
          [...validatedSourceProjectIds].sort(),
          [...existingComparisonProject.sourceProjectIds].sort(),
        )
      ) {
        await assertComparisonProjectSourceProjectIdsShareFullTextStrategy(
          appDatabaseService,
          getComparisonProjectBodySourceProjectIds({
            humanJudgmentMode,
            sourceProjectIds: validatedSourceProjectIds,
            summarySourceProjectId,
          }),
        )
      }
      const baseSetParts = [
        `name = ${getSqlLiteral(body.name)}`,
        `description = ${getSqlLiteral(body.description?.trim() || null)}`,
        `compare_with_humans = ${getBooleanLiteral(body.compareWithHumans)}`,
        `allow_conflict_resolution = ${getBooleanLiteral(body.allowConflictResolution)}`,
        `human_judgment_mode = ${getSqlLiteral(humanJudgmentMode)}`,
        `summary_source_project_id = ${getSqlLiteral(summarySourceProjectId)}`,
        `use_title = ${getBooleanLiteral(useTitle)}`,
        `use_abstract = ${getBooleanLiteral(useAbstract)}`,
        `use_fulltext = ${getBooleanLiteral(useFulltext)}`,
        `use_fulltext_no_images = ${getBooleanLiteral(useFulltextNoImages)}`,
        `updated_at = current_timestamp`,
      ]
      const hasModelIdsChange = !hasSameStringArrayValue(validatedModelIds, existingModelIds)
      const setParts = hasModelIdsChange
        ? [...baseSetParts, `model_ids = ${getSqlLiteral(validatedModelIds)}`]
        : baseSetParts

      const updatedComparisonProjectRow = await updateComparisonProjectWithRelinkedLinks({
        comparisonProjectId: params.id,
        importRoutes: uniqueImportRoutes,
        setParts,
        sourceProjectIds: validatedSourceProjectIds,
        promptSelections: validatedPromptSelections,
      })

      if (!updatedComparisonProjectRow) {
        throw new Error('Comparison project not found')
      }

      await checkpointComparisonProjectMutation()
      await markComparisonProjectServingStaleAndQueueRebuild(params.id)

      return {data: getComparisonProjectRecordValue(updatedComparisonProjectRow)}
    },
    {
      transform: rejectLegacyFullTextNoImagesBody,
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Boolean(),
        allowConflictResolution: t.Boolean(),
        humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
        summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
        sourceProjectIds: t.Optional(t.Array(t.String())),
        promptSelections: t.Array(t.Object({promptId: t.String(), order: t.Number()})),
      }),
    },
  )
  .delete('/api/comparison-projects/:id/purge', async (context) => {
    const {params, set} = context
    const purgedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return purgeArchivedComparisonProjectTx(tx, params.id)
    })

    if (!purgedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  })
  .delete('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const archivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })
    })

    if (!archivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  })
  .post('/api/comparison-projects/:id/unarchive', async (context) => {
    const {params, set} = context
    const unarchivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = FALSE', 'updated_at = current_timestamp'],
      })
    })

    if (!unarchivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  })
