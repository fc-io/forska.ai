import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'
import {legacyRequiredBootstrapEnrichmentComponents} from './legacyRequiredBootstrapEnrichmentComponents.ts'

export const getHasLegacyRequiredBootstrapEnrichmentCandidate = async (input: {
  projectId: string
  reviewConfigHash: string | null
}) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{count: number}>(
    `
    SELECT CAST(COUNT(*) AS INTEGER) AS count
    FROM app.review_serving_snapshot_manifest snapshot,
      json_each(snapshot.required_components_json) required_component
    WHERE snapshot.project_id = '${escapeSqlString(input.projectId)}'
      AND snapshot.review_config_hash IS NOT DISTINCT FROM ${
        input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
      }
      AND snapshot.snapshot_status = 'candidate'
      AND json_extract_string(required_component.value, '$') IN (${legacyRequiredBootstrapEnrichmentComponents
        .map((component) => {
          return `'${component}'`
        })
        .join(', ')})
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'legacyCandidateEnrichmentState'),
  )

  return Number(row?.count ?? 0) > 0
}
