import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

type HumanAssessmentOverviewAnsweredCountRow = {totalCount: number | null}

export const getReviewServingHumanAssessmentCompletedCount = async (input: {
  contractKey: 'review.both.count' | 'review.human.count'
  database: ReviewServingReaderDatabase
  manifest: ReviewServingSnapshotManifest
  projectId: string
}) => {
  const [answeredCount] = await input.database.queryJson<HumanAssessmentOverviewAnsweredCountRow>(`
    SELECT COUNT(DISTINCT article_id) AS totalCount
    FROM mart.review_article_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.manifest.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.manifest.snapshotId)}
      AND list_mode_key = ${getSqlLiteral(input.contractKey === 'review.both.count' ? 'both' : 'human')}
      AND human_status_key = 'answered'
      ${input.contractKey === 'review.both.count' ? "AND llm_status_key = 'answered'" : ''}
  `)

  return answeredCount ? Number(answeredCount.totalCount ?? 0) : null
}
