import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'
import {legacyRequiredBootstrapEnrichmentComponents} from './legacyRequiredBootstrapEnrichmentComponents.ts'

export const getHasActiveEnrichmentMissingSnapshotRepair = async (input: {
  projectId: string
  reviewConfigHash: string | null
}) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{count: number}>(
    `
    SELECT CAST(COUNT(DISTINCT request.request_id) AS INTEGER) AS count
    FROM app.review_rebuild_request request,
      json_each(request.requested_components_json) requested_component
    WHERE request.project_id = '${escapeSqlString(input.projectId)}'
      AND request.reason = 'missingReviewServingSnapshot'
      AND request.status = 'admitted'
      AND request.admission_state = 'admitted'
      AND (
        json_extract_string(request.identity_json, '$.reviewConfigHash') IS NOT DISTINCT FROM ${
          input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
        }
        OR (
          json_extract_string(request.identity_json, '$.reviewConfigHash') IS NULL
          AND EXISTS (
            SELECT 1
            FROM app.review_rebuild_chunk_manifest chunk
            INNER JOIN app.review_serving_snapshot_manifest snapshot
              ON snapshot.project_id IS NOT DISTINCT FROM chunk.project_id
             AND snapshot.snapshot_id = chunk.snapshot_id
            WHERE chunk.request_id = request.request_id
              AND snapshot.review_config_hash IS NOT DISTINCT FROM ${
                input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
              }
          )
        )
      )
      AND json_extract_string(requested_component.value, '$') IN (${legacyRequiredBootstrapEnrichmentComponents
        .map((component) => {
          return `'${component}'`
        })
        .join(', ')})
      AND EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = request.request_id
          AND chunk.status IN ('pending', 'running', 'failed')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = request.request_id
          AND chunk.status IN ('blocked_over_budget', 'quarantined')
      )
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'activeEnrichmentMissingSnapshotRepair'),
  )

  return Number(row?.count ?? 0) > 0
}
