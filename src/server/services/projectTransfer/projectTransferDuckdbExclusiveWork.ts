import {
  type DuckdbExclusiveWorkInput,
  type DuckdbExclusiveWorkSnapshot,
  getActiveDuckdbExclusiveWorkSnapshot,
  hasActiveDuckdbExclusiveWork,
  resetDuckdbExclusiveWorkForTests,
  runWithDuckdbExclusiveWork as runWithSharedDuckdbExclusiveWork,
  updateActiveDuckdbExclusiveWorkProgress as updateSharedDuckdbExclusiveWorkProgress,
} from '../../utils/duckdbExclusiveWork.ts'
import {
  closeDuckdbService,
  getDuckdbAppendRuntimeMetrics,
  getDuckdbQueueRuntimeMetricsSnapshot,
} from '../../utils/duckdbService.ts'
import {getDefaultReviewServingRebuildChunkBatchMaxRssBytes} from '../../utils/env.ts'
import type {ProjectTransferProgressPayload} from './projectTransferContracts.ts'

const projectTransferExclusiveWorkPollIntervalMs = 250
const projectTransferExclusiveWorkTimeoutMs = 120_000
const projectTransferExclusiveWorkReadyRssRatio = 0.9

const getProjectTransferExclusiveWorkMaxRssBytes = () => {
  return getDefaultReviewServingRebuildChunkBatchMaxRssBytes()
}

const getProjectTransferExclusiveWorkReadinessSnapshot = () => {
  const queueMetrics = getDuckdbQueueRuntimeMetricsSnapshot()
  const appendMetrics = getDuckdbAppendRuntimeMetrics()
  const rssBytes = process.memoryUsage().rss
  const maxRssBytes = getProjectTransferExclusiveWorkMaxRssBytes()
  const rssReady = rssBytes < maxRssBytes * projectTransferExclusiveWorkReadyRssRatio

  return {
    activeMaintenance: [],
    appendQueueDepth: appendMetrics.queueDepth,
    backgroundQueueDepth: queueMetrics.background.queueDepth,
    foregroundQueueDepth: queueMetrics.main.queueDepth,
    maxRssBytes,
    recycleRecommended: !rssReady,
    rssBytes,
    rssReady,
  }
}

const recycleDuckdbRuntimeBeforeProjectTransferExclusiveWork = async () => {
  await closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})
}

export const runWithDuckdbExclusiveWork = async <T>(
  input: Omit<DuckdbExclusiveWorkInput, 'ownerToken' | 'sessionId'> & {
    ownerToken?: string | null
    sessionId?: string | null
  },
  operation: () => Promise<T>,
) => {
  return runWithSharedDuckdbExclusiveWork(
    {...input, ownerToken: input.ownerToken ?? null, sessionId: input.sessionId ?? 'unknown-project-transfer-session'},
    () => {
      return operation()
    },
    {
      dependencies: {
        forceGarbageCollection: () => {
          globalThis.Bun.gc(true)
        },
        getReadinessSnapshot: getProjectTransferExclusiveWorkReadinessSnapshot,
        recycleDuckdbRuntime: recycleDuckdbRuntimeBeforeProjectTransferExclusiveWork,
      },
      pollIntervalMs: projectTransferExclusiveWorkPollIntervalMs,
      timeoutMs: projectTransferExclusiveWorkTimeoutMs,
    },
  )
}

export const updateActiveDuckdbExclusiveWorkProgress = (progress: ProjectTransferProgressPayload) => {
  return updateSharedDuckdbExclusiveWorkProgress({
    completedRows: progress.completedRows ?? progress.rowCountProcessed ?? null,
    lastProgressedAt: progress.updatedAt,
    message: progress.message ?? undefined,
    percent: progress.percent ?? null,
    totalRows: progress.totalRows ?? progress.rowCountTotal ?? null,
  })
}

export {
  getActiveDuckdbExclusiveWorkSnapshot,
  hasActiveDuckdbExclusiveWork,
  type DuckdbExclusiveWorkSnapshot as ProjectTransferDuckdbExclusiveWorkSnapshot,
  resetDuckdbExclusiveWorkForTests,
}
