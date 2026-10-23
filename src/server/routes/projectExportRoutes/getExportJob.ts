import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectExportWorkloadContext} from './getProjectExportWorkloadContext.ts'
import type {ExportJobRow} from './projectExportRouteTypes.ts'

export const getExportJob = async (projectId: string, jobId: string) => {
  const [job] = await getAppDatabaseService().queryJson<ExportJobRow>(
    `
    SELECT
      criteria_json AS criteriaJson,
      latest_snapshot_semantics AS latestSnapshotSemantics,
      result_manifest_json AS resultManifestJson,
      review_config_hash AS reviewConfigHash,
      snapshot_id AS snapshotId,
      status
    FROM app.review_bulk_operation_job
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND project_id = ${getSqlLiteral(projectId)}
      AND job_kind = 'review.export.selection'
    LIMIT 1
  `,
    getProjectExportWorkloadContext({maxResultRows: 1, operation: 'jobLookup', projectId}),
  )

  return job ?? null
}
