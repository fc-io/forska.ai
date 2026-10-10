import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {backfillNextComparisonJudgmentContext} from '../services/comparisonJudgmentContext.ts'
import {getComparisonProjectServingRebuildService} from '../services/comparisonProjectServingRebuildService.ts'
import {
  getDuckdbAppendRuntimeMetrics,
  getDuckdbQueueRuntimeMetricsSnapshot,
  getMaintenanceDuckdbWorkloadContext,
} from '../utils/duckdbService.ts'

type ComparisonJudgmentContextBackfillResult = Awaited<ReturnType<typeof backfillNextComparisonJudgmentContext>>

type ComparisonProjectServingMaintenanceWorkerDependencies = {
  backfillNextComparisonJudgmentContext: () => Promise<ComparisonJudgmentContextBackfillResult>
  getAppendQueueDepth: () => number
  getForegroundQueueDepth: () => number
  hasReviewServingRebuildWork: () => Promise<boolean>
  rebuildNextUnavailableComparisonProjectServing: ReturnType<
    typeof getComparisonProjectServingRebuildService
  >['rebuildNextUnavailableComparisonProjectServing']
}

type ComparisonProjectServingMaintenanceWorkerResult =
  | {comparisonProjectId: null; reason: 'foreground-work-active'; status: 'idle'}
  | {comparisonProjectId: null; reason: 'no-unavailable-project'; status: 'idle'}
  | {comparisonProjectId: null; reason: 'review-serving-work-active'; status: 'idle'}
  | {comparisonProjectId: string; rebuilt: boolean; status: 'processed'}
  | {
      comparisonProjectId: string
      generation: number
      judgmentContextId: string | null
      reason: 'judgment-context-backfilled'
      status: 'backfilled'
    }

type ReviewServingRebuildWorkProbeRow = {workCount: number | string | bigint}

const comparisonProjectServingMaintenanceWorkerWorkloadContext = getMaintenanceDuckdbWorkloadContext(
  'comparisonProjectServingMaintenanceWorker',
)

const hasReviewServingRebuildWork = async () => {
  const [row] = await getAppDatabaseService().queryJson<ReviewServingRebuildWorkProbeRow>(
    `
    SELECT CAST(COUNT(*) AS INTEGER) AS workCount
    FROM (
      SELECT 1
      FROM app.review_rebuild_chunk_manifest chunk
      WHERE chunk.admission_state = 'admitted'
        AND (
          chunk.status = 'pending'
          OR (
            chunk.status = 'failed'
            AND (
              chunk.retry_after IS NULL
              OR chunk.retry_after <= current_timestamp
            )
          )
          OR (
            chunk.status = 'running'
            AND (
              chunk.lease_expires_at IS NULL
              OR chunk.lease_expires_at <= current_timestamp
            )
          )
        )
        AND (
          chunk.request_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM app.review_rebuild_request request
            WHERE request.request_id = chunk.request_id
              AND request.status IN ('admitted', 'running')
              AND request.admission_state = 'admitted'
              AND (
                request.retry_after IS NULL
                OR request.retry_after <= current_timestamp
              )
          )
        )
      LIMIT 1
    ) active_review_serving_work
  `,
    comparisonProjectServingMaintenanceWorkerWorkloadContext,
  )

  return Number(row?.workCount ?? 0) > 0
}

const backfillNextComparisonJudgmentContextOnMaintenanceWorker = () => {
  const database = getAppDatabaseService()

  return backfillNextComparisonJudgmentContext({
    queryJson: (statement) => {
      return database.queryJson(statement, comparisonProjectServingMaintenanceWorkerWorkloadContext)
    },
    transaction: (operation) => {
      return database.transaction(operation, comparisonProjectServingMaintenanceWorkerWorkloadContext)
    },
  })
}

const getComparisonJudgmentContextBackfillWorkerResult = (
  result: ComparisonJudgmentContextBackfillResult,
): ComparisonProjectServingMaintenanceWorkerResult => {
  return result.comparisonProjectId === null || result.generation === null
    ? {comparisonProjectId: null, reason: 'no-unavailable-project', status: 'idle'}
    : {
        comparisonProjectId: result.comparisonProjectId,
        generation: result.generation,
        judgmentContextId: result.judgmentContextId,
        reason: 'judgment-context-backfilled',
        status: 'backfilled',
      }
}

const getDefaultComparisonProjectServingMaintenanceWorkerDependencies =
  (): ComparisonProjectServingMaintenanceWorkerDependencies => {
    return {
      backfillNextComparisonJudgmentContext: backfillNextComparisonJudgmentContextOnMaintenanceWorker,
      getAppendQueueDepth: () => {
        return getDuckdbAppendRuntimeMetrics().queueDepth
      },
      getForegroundQueueDepth: () => {
        return getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth
      },
      hasReviewServingRebuildWork,
      rebuildNextUnavailableComparisonProjectServing:
        getComparisonProjectServingRebuildService().rebuildNextUnavailableComparisonProjectServing,
    }
  }

export const runComparisonProjectServingMaintenanceWorkerOnce = async (
  dependencies: Partial<ComparisonProjectServingMaintenanceWorkerDependencies> = {},
): Promise<ComparisonProjectServingMaintenanceWorkerResult> => {
  const workerDependencies = {...getDefaultComparisonProjectServingMaintenanceWorkerDependencies(), ...dependencies}

  if (workerDependencies.getForegroundQueueDepth() > 0 || workerDependencies.getAppendQueueDepth() > 0) {
    return {comparisonProjectId: null, reason: 'foreground-work-active', status: 'idle'}
  }

  if (await workerDependencies.hasReviewServingRebuildWork()) {
    return {comparisonProjectId: null, reason: 'review-serving-work-active', status: 'idle'}
  }

  const result = await workerDependencies.rebuildNextUnavailableComparisonProjectServing()

  return result.comparisonProjectId === null
    ? getComparisonJudgmentContextBackfillWorkerResult(await workerDependencies.backfillNextComparisonJudgmentContext())
    : {comparisonProjectId: result.comparisonProjectId, rebuilt: result.rebuilt, status: 'processed'}
}

export type {ComparisonProjectServingMaintenanceWorkerResult}
