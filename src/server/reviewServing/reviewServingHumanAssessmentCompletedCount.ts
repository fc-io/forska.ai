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
      AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_state_serving_v4 human_status_state
        WHERE human_status_state.project_id = serving.project_id
          AND human_status_state.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
          AND human_status_state.snapshot_id = serving.snapshot_id
          AND human_status_state.article_id = serving.article_id
          AND human_status_state.list_mode_key = serving.list_mode_key
          AND human_status_state.human_status = 'answered'
      )`
  const llmStatusPredicate =
    contractKey === 'review.both.count'
      ? `
      AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_state_serving_v4 llm_status_state
        WHERE llm_status_state.project_id = serving.project_id
          AND llm_status_state.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
          AND llm_status_state.snapshot_id = serving.snapshot_id
          AND llm_status_state.article_id = serving.article_id
          AND llm_status_state.list_mode_key = serving.list_mode_key
          AND llm_status_state.llm_status = 'answered'
      )`
      : ''

  return `
      AND serving.list_mode_key = ${getSqlLiteral(getHumanAssessmentListMode(contractKey))}
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
    SELECT COUNT(DISTINCT article_id) AS totalCount
    FROM mart.review_article_serving_v4 serving
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
      COUNT(DISTINCT serving.article_id) AS totalCount
    FROM overview_manifest
    LEFT JOIN mart.review_article_serving_v4 serving
      ON serving.project_id = overview_manifest.project_id
      AND serving.review_config_hash IS NOT DISTINCT FROM overview_manifest.review_config_hash
      AND serving.snapshot_id = overview_manifest.snapshot_id
      ${getHumanAssessmentCompletedCountPredicate(input.contractKey)}
    GROUP BY overview_manifest.project_id
  `)

  return new Map(
    rows.map((row) => {
      return [row.projectId, Number(row.totalCount ?? 0)]
    }),
  )
}
