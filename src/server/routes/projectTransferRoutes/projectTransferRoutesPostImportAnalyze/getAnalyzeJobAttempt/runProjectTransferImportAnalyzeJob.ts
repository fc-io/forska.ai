import {analyzeProjectTransferImportPackage} from '../../../../services/projectTransfer/projectTransferAnalyze.ts'
import type {
  ProjectTransferPlanSummary,
  ProjectTransferProgressPayload,
  ProjectTransferUploadMetadataPayload,
} from '../../../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferPerformanceMetrics} from '../../../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {getProjectTransferCompletedOverallProgress} from '../../../../services/projectTransfer/projectTransferProgressWeights.ts'
import {
  getProjectTransferImportTempLayout,
  toProjectTransferSessionResponse,
} from '../../../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getProjectTransferProgressWithStaging} from '../../../../services/projectTransfer/projectTransferStaging.ts'
import {getAnalyzeProgress} from '../../getAnalyzeProgress.ts'
import {getImportAnalyzeNextState} from '../../getImportAnalyzeNextState.ts'
import {getUploadMetadataFromProgress} from '../../getUploadMetadataFromProgress.ts'
import {runProjectTransferImportWorkerHeartbeat} from '../../runProjectTransferImportWorkerHeartbeat.ts'
import {writeImportProgressArtifact} from '../../writeImportProgressArtifact.ts'
import {getAnalyzeStartOverallProgress} from '../getAnalyzeStartOverallProgress.ts'

const getImportPlanRowCount = (planSummary: ProjectTransferPlanSummary) => {
  return planSummary.packageCounts
    ? Object.values(planSummary.packageCounts).reduce((total, count) => {
        return total + count
      }, 0)
    : 0
}

const updateImportWorkerProgress = async ({
  ownerToken,
  progress,
  sessionId,
}: {
  ownerToken: string
  progress: ProjectTransferProgressPayload
  sessionId: string
}) => {
  const updated = await getProjectTransferSessionRepository().updateProjectTransferSessionProgress({
    expectedOwnerToken: ownerToken,
    now: new Date(progress.updatedAt ?? Date.now()),
    progress,
    sessionId,
  })

  if (updated === null) {
    throw new Error(`Project transfer import session ownership was lost: ${sessionId}`)
  }

  return updated
}

const getCompletedAnalyzeProgress = ({
  now,
  performanceMetrics,
  planSummary,
  staging,
  upload,
}: {
  now: Date
  performanceMetrics?: ProjectTransferPerformanceMetrics
  planSummary: ProjectTransferPlanSummary
  staging?: Awaited<ReturnType<typeof analyzeProjectTransferImportPackage>>['staging']
  upload: ProjectTransferUploadMetadataPayload | null
}) => {
  const rowCount = getImportPlanRowCount(planSummary)

  const progress = {
    ...getAnalyzeProgress({
      now,
      overall: getProjectTransferCompletedOverallProgress('analyze'),
      performanceMetrics,
      phase: 'analyze',
      status: 'completed',
      upload,
    }),
    completedRows: rowCount,
    rowCountProcessed: rowCount,
    rowCountTotal: rowCount,
    totalRows: rowCount,
    warningCount: planSummary.warningCount,
  }

  return staging === undefined ? progress : getProjectTransferProgressWithStaging({progress, publishedAt: now, staging})
}

export const runProjectTransferImportAnalyzeJob = async ({
  ownerToken,
  sessionId,
}: {
  ownerToken: string
  sessionId: string
}) => {
  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const upload =
    current === null ? null : getUploadMetadataFromProgress(toProjectTransferSessionResponse(current).progress)
  const analyzeStartedAt = new Date()
  const analyzingProgress = getAnalyzeProgress({
    now: analyzeStartedAt,
    overall: getAnalyzeStartOverallProgress(),
    phase: 'analyze',
    status: 'running',
    upload,
  })
  const analyzing = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'extracting',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'analyzing',
    now: analyzeStartedAt,
    progress: analyzingProgress,
    sessionId,
  })

  if (analyzing === null) {
    return null
  }

  const analysis = await runProjectTransferImportWorkerHeartbeat({
    operation: () => {
      return analyzeProjectTransferImportPackage({
        autoResolveDependencies: true,
        layout: getProjectTransferImportTempLayout(sessionId),
        onProgress: (progress) => {
          return writeImportProgressArtifact(sessionId, progress)
        },
        onSessionProgress: (progress) => {
          return updateImportWorkerProgress({ownerToken, progress, sessionId})
        },
        ownerToken,
        planRevision: analyzing.planRevision + 1,
        sessionId,
        uploadMetadata: upload,
      })
    },
    ownerToken,
    sessionId,
  })
  const completedAt = new Date()
  const completedProgress = getCompletedAnalyzeProgress({
    now: completedAt,
    performanceMetrics: analysis.analysis.performanceMetrics,
    planSummary: analysis.planSummary,
    staging: analysis.staging,
    upload,
  })

  const nextState = getImportAnalyzeNextState(analysis.planSummary)
  await writeImportProgressArtifact(sessionId, completedProgress)
  const planned = await repository.updateProjectTransferSessionPlanRevision({
    expectedOwnerToken: ownerToken,
    expectedPlanRevision: analyzing.planRevision,
    expectedStagingRevision: null,
    nextOwnerToken: null,
    nextState,
    now: completedAt,
    packageFingerprint: analysis.packageFingerprint,
    planSummary: analysis.planSummary,
    progress: completedProgress,
    sessionId,
  })

  return planned
}
