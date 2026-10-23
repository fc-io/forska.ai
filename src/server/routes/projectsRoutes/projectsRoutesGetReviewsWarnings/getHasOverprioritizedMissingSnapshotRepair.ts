import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {foregroundReviewServingRepairPriority} from './foregroundReviewServingRepairPriority.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'

export const getHasOverprioritizedMissingSnapshotRepair = async (projectId: string) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{count: number}>(
    `
    SELECT CAST(COUNT(*) AS INTEGER) AS count
    FROM app.review_rebuild_request request
    WHERE request.project_id = '${escapeSqlString(projectId)}'
      AND request.reason = 'missingReviewServingSnapshot'
      AND request.status IN ('admitted', 'running')
      AND request.admission_state = 'admitted'
      AND request.priority > ${foregroundReviewServingRepairPriority}
    `,
    getReviewWarningsWorkloadContext(projectId, 'overprioritizedMissingSnapshotRepair'),
  )

  return Number(row?.count ?? 0) > 0
}
