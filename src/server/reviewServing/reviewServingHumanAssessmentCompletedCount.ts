import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

type HumanAssessmentOverviewAnsweredCountRow = {totalCount: number | null}
type HumanAssessmentOverviewAnsweredProjectCountRow = {projectId: string; totalCount: number | null}

const getHumanAssessmentListMode = (contractKey: 'review.both.count' | 'review.human.count') => {
  return contractKey === 'review.both.count' ? 'both' : 'human'
}

const getHumanAssessmentCompletedCountPredicate = (contractKey: 'review.both.count' | 'review.human.count') => {
  const humanStatusPredicate = `
      AND list_mode_state.human_status = 'answered'`
  const llmStatusPredicate =
    contractKey === 'review.both.count'
      ? `
      AND list_mode_state.llm_status = 'answered'`
      : ''

  return `
      AND list_contains(list_mode_state.list_mode_keys, ${getSqlLiteral(getHumanAssessmentListMode(contractKey))})
      ${humanStatusPredicate}
      ${llmStatusPredicate}`
}

export const getReviewServingHumanAssessmentCompletedCount = async (input: {
  contractKey: 'review.both.count' | 'review.human.count'
  database: ReviewServingReaderDatabase
  manifest: ReviewServingSnapshotManifest
  projectId: string
}) => {
  const [answeredCount] = await input.database.queryJson<HumanAssessmentOverviewAnsweredCountRow>(`
    SELECT COUNT(DISTINCT serving.article_id) AS totalCount
    FROM mart.review_article_serving_base_v4 serving
    INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
      ON list_mode_state.project_id = serving.project_id
      AND list_mode_state.review_config_hash = serving.review_config_hash
      AND list_mode_state.snapshot_id = serving.snapshot_id
      AND list_mode_state.article_id = serving.article_id
    WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
      AND serving.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.manifest.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(input.manifest.snapshotId)}
      ${getHumanAssessmentCompletedCountPredicate(input.contractKey)}
  `)

  return answeredCount ? Number(answeredCount.totalCount ?? 0) : null
}

export const getReviewServingHumanAssessmentCompletedCounts = async (input: {
  contractKey: 'review.both.count' | 'review.human.count'
  database: ReviewServingReaderDatabase
  manifests: readonly {projectId: string; reviewConfigHash: string | null; snapshotId: string}[]
}) => {
  if (input.manifests.length === 0) {
    return new Map<string, number>()
  }

  const manifestRows = input.manifests
    .map((manifest) => {
      return `(${getSqlLiteral(manifest.projectId)}, ${getSqlLiteral(manifest.reviewConfigHash)}, ${getSqlLiteral(manifest.snapshotId)})`
    })
    .join(',\n      ')
  const rows = await input.database.queryJson<HumanAssessmentOverviewAnsweredProjectCountRow>(`
    WITH overview_manifest(project_id, review_config_hash, snapshot_id) AS (
      VALUES
      ${manifestRows}
    )
    SELECT
      overview_manifest.project_id AS projectId,
      COUNT(DISTINCT list_mode_state.article_id) AS totalCount
    FROM overview_manifest
    LEFT JOIN mart.review_article_serving_base_v4 serving
      ON serving.project_id = overview_manifest.project_id
      AND serving.review_config_hash IS NOT DISTINCT FROM overview_manifest.review_config_hash
      AND serving.snapshot_id = overview_manifest.snapshot_id
    LEFT JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
      ON list_mode_state.project_id = serving.project_id
      AND list_mode_state.review_config_hash = serving.review_config_hash
      AND list_mode_state.snapshot_id = serving.snapshot_id
      AND list_mode_state.article_id = serving.article_id
      ${getHumanAssessmentCompletedCountPredicate(input.contractKey)}
    GROUP BY overview_manifest.project_id
  `)

  return new Map(
    rows.map((row) => {
      return [row.projectId, Number(row.totalCount ?? 0)]
    }),
  )
}
