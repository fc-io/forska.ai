import {
  countReadyReviewServingComponents,
  defaultReadableReviewServingComponents,
  detailReadyReviewServingComponents,
  filterReadyReviewServingComponents,
  type ReviewServingProjectionComponent,
} from '../../../reviewServing/reviewServingContracts.ts'
import type {ReviewServingSnapshotManifest} from '../../../reviewServing/reviewServingManifestRepository.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'

type ReviewsWarningsCoverage = {
  countReadyArticleCount: number | null
  detailReadyArticleCount: number | null
  filterReadyArticleCount: number | null
  reviewPageReadyArticleCount: number
  rowReadyArticleCount: number | null
  searchReadyArticleCount: number | null
  totalArticleCount: number
}

const getReviewWarningsComponentState = (
  manifest: ReviewServingSnapshotManifest | null,
  component: ReviewServingProjectionComponent,
) => {
  return [...(manifest?.componentState.required ?? []), ...(manifest?.componentState.optional ?? [])].find((state) => {
    return state.component === component
  })
}

const getHasReviewWarningsComponentStates = (
  manifest: ReviewServingSnapshotManifest | null,
  components: readonly ReviewServingProjectionComponent[],
) => {
  return components.every((component) => {
    return getReviewWarningsComponentState(manifest, component) !== undefined
  })
}

const getReadyTierArticleCount = (input: {
  components: readonly ReviewServingProjectionComponent[]
  manifest: ReviewServingSnapshotManifest | null
  totalArticleCount: number
}) => {
  return getHasReviewWarningsComponentStates(input.manifest, input.components) ? input.totalArticleCount : null
}

const getReviewWarningsComponentCanMaterialize = (
  manifest: ReviewServingSnapshotManifest | null,
  component: ReviewServingProjectionComponent,
) => {
  return (
    manifest?.optionalComponents.includes(component) === true
    || getReviewWarningsComponentState(manifest, component) !== undefined
  )
}

export const getReviewsWarningsCoverage = async (input: {
  manifest: ReviewServingSnapshotManifest | null
  projectId: string
  reviewConfigHash: string | null
  totalArticleCount: number
}): Promise<ReviewsWarningsCoverage> => {
  const snapshotId = input.manifest?.snapshotId ?? null

  if (snapshotId === null) {
    return {
      countReadyArticleCount: null,
      detailReadyArticleCount: null,
      filterReadyArticleCount: null,
      reviewPageReadyArticleCount: 0,
      rowReadyArticleCount: null,
      searchReadyArticleCount: null,
      totalArticleCount: input.totalArticleCount,
    }
  }

  const hasRowsReady = getHasReviewWarningsComponentStates(input.manifest, defaultReadableReviewServingComponents)
  const countReadyArticleCount = getReadyTierArticleCount({
    components: countReadyReviewServingComponents,
    manifest: input.manifest,
    totalArticleCount: input.totalArticleCount,
  })
  const filterReadyArticleCount = getReadyTierArticleCount({
    components: filterReadyReviewServingComponents,
    manifest: input.manifest,
    totalArticleCount: input.totalArticleCount,
  })
  const detailReadyArticleCount = getReadyTierArticleCount({
    components: detailReadyReviewServingComponents,
    manifest: input.manifest,
    totalArticleCount: input.totalArticleCount,
  })
  const canMaterializeSearch = getReviewWarningsComponentCanMaterialize(input.manifest, 'search')
  const searchComponentState = getReviewWarningsComponentState(input.manifest, 'search')
  const [coverage] = await getApiReadOnlyAppDatabaseService().queryJson<{
    rowReadyArticleCount: number | null
    searchReadyArticleCount: number | null
  }>(
    `
    SELECT
      ${
        !hasRowsReady
          ? 'NULL'
          : `CAST((
              SELECT COUNT(DISTINCT serving.article_id)
              FROM mart.review_article_serving_base_v4 serving
              WHERE serving.project_id = '${escapeSqlString(input.projectId)}'
                AND serving.review_config_hash IS NOT DISTINCT FROM ${
                  input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
                }
                AND serving.snapshot_id = '${escapeSqlString(snapshotId)}'
            ) AS INTEGER)`
      } AS rowReadyArticleCount,
      ${
        !canMaterializeSearch
          ? 'NULL'
          : `CAST((
              WITH latest_search_request AS (
                SELECT request.request_id
                FROM app.review_rebuild_request request
                WHERE request.project_id = '${escapeSqlString(input.projectId)}'
                  AND request.admission_state = 'admitted'
                  AND request.status IN ('admitted', 'running')
                  AND EXISTS (
                    SELECT 1
                    FROM app.review_rebuild_chunk_manifest request_chunk
                    WHERE request_chunk.request_id IS NOT DISTINCT FROM request.request_id
                      AND request_chunk.project_id IS NOT DISTINCT FROM request.project_id
                      AND request_chunk.projection_component = 'search'
                  )
                ORDER BY request.priority DESC, request.updated_at DESC, request.request_id DESC
                LIMIT 1
              ), leaf_search_chunk AS (
                SELECT search_chunk.status
                FROM app.review_rebuild_chunk_manifest search_chunk
                INNER JOIN latest_search_request
                  ON latest_search_request.request_id IS NOT DISTINCT FROM search_chunk.request_id
                WHERE search_chunk.project_id = '${escapeSqlString(input.projectId)}'
                  AND search_chunk.projection_component = 'search'
                  ${
                    searchComponentState?.projectionIdentity === undefined
                      ? ''
                      : `AND search_chunk.projection_identity = '${escapeSqlString(searchComponentState.projectionIdentity)}'`
                  }
                  AND NOT EXISTS (
                    SELECT 1
                    FROM app.review_rebuild_chunk_manifest child_chunk
                    WHERE child_chunk.parent_chunk_id IS NOT DISTINCT FROM search_chunk.chunk_id
                      AND child_chunk.project_id IS NOT DISTINCT FROM search_chunk.project_id
                  )
              ), search_progress AS (
                SELECT
                  CAST(COUNT(*) AS DOUBLE) AS totalLeafCount,
                  CAST(COUNT(*) FILTER (WHERE status = 'completed') AS DOUBLE) AS completedLeafCount
                FROM leaf_search_chunk
              )
              SELECT COALESCE((
                SELECT CASE
                  WHEN NOT EXISTS (SELECT 1 FROM latest_search_request) THEN ${
                    searchComponentState?.projectionIdentity === undefined ? 'NULL' : input.totalArticleCount
                  }
                  WHEN search_progress.totalLeafCount <= 0 THEN 0
                  ELSE CAST(ROUND(${input.totalArticleCount} * search_progress.completedLeafCount / search_progress.totalLeafCount) AS INTEGER)
                END
                FROM search_progress
              ), ${searchComponentState?.projectionIdentity === undefined ? 'NULL' : input.totalArticleCount})
            ) AS INTEGER)`
      } AS searchReadyArticleCount
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'coverage'),
  )
  const rowReadyArticleCount =
    coverage?.rowReadyArticleCount === null || coverage?.rowReadyArticleCount === undefined
      ? null
      : Number(coverage.rowReadyArticleCount)

  return {
    countReadyArticleCount,
    detailReadyArticleCount,
    filterReadyArticleCount,
    reviewPageReadyArticleCount: rowReadyArticleCount ?? 0,
    rowReadyArticleCount,
    searchReadyArticleCount:
      coverage?.searchReadyArticleCount === null || coverage?.searchReadyArticleCount === undefined
        ? null
        : Number(coverage.searchReadyArticleCount),
    totalArticleCount: input.totalArticleCount,
  }
}
