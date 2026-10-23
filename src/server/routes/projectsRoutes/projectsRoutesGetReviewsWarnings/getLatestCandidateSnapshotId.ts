import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'

export const getLatestCandidateSnapshotId = async (input: {projectId: string; reviewConfigHash: string | null}) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{snapshotId: string}>(
    `
    SELECT snapshot_id AS snapshotId
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${escapeSqlString(input.projectId)}'
      AND review_config_hash IS NOT DISTINCT FROM ${
        input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
      }
      AND snapshot_status = 'candidate'
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'candidateSnapshot'),
  )

  return row?.snapshotId ?? null
}
