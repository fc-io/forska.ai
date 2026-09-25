import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

export type ReviewServingCandidateComponentState = {
  baseGeneration: number
  projectionIdentity: string
  snapshotId: string
}

export type ReviewServingCandidateArticleAwaitingRebuild = {articleId: string; snapshotId: string}

type ReviewServingCandidateRebuildCoverageDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

const getClaimedArticleValuesSql = (articleIds: readonly string[]) => {
  return articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')
}

const getCandidateComponentValuesSql = (candidates: readonly ReviewServingCandidateComponentState[]) => {
  return candidates
    .map((candidate) => {
      return `(${getSqlLiteral(candidate.snapshotId)}, ${getSqlLiteral(candidate.projectionIdentity)}, CAST(${Math.trunc(candidate.baseGeneration)} AS BIGINT))`
    })
    .join(', ')
}

// A pending chunk of an admitted request rebuilds its whole article range from source when it runs, so the candidate
// rows it covers do not need incremental patches before then. The filters mirror the chunk claim predicate: chunks
// the claim path would not pick up may never run, and their candidates keep receiving patches.
export const getReviewServingCandidateArticlesAwaitingRebuild = async (
  input: {
    articleIds: readonly string[]
    candidates: readonly ReviewServingCandidateComponentState[]
    component: ReviewServingProjectionComponent
    projectId: string
  },
  database: ReviewServingCandidateRebuildCoverageDatabase,
) => {
  if (input.articleIds.length === 0 || input.candidates.length === 0) {
    return []
  }

  return database.queryJson<ReviewServingCandidateArticleAwaitingRebuild>(`
    WITH claimed_article(article_id) AS (
      VALUES ${getClaimedArticleValuesSql(input.articleIds)}
    ),
    candidate_component(snapshot_id, projection_identity, output_base_generation) AS (
      VALUES ${getCandidateComponentValuesSql(input.candidates)}
    )
    SELECT DISTINCT
      chunk.snapshot_id AS snapshotId,
      claimed_article.article_id AS articleId
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN candidate_component
      ON candidate_component.snapshot_id = chunk.snapshot_id
      AND candidate_component.projection_identity = chunk.projection_identity
      AND candidate_component.output_base_generation = chunk.output_base_generation
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.project_id = chunk.project_id
      AND snapshot.snapshot_id = chunk.snapshot_id
    INNER JOIN app.review_rebuild_request request
      ON request.request_id = chunk.request_id
    INNER JOIN claimed_article
      ON claimed_article.article_id >= chunk.chunk_start_key
      AND claimed_article.article_id <= chunk.chunk_end_key
    WHERE chunk.project_id = ${getSqlLiteral(input.projectId)}
      AND chunk.projection_component = ${getSqlLiteral(input.component)}
      AND chunk.status = 'pending'
      AND chunk.admission_state = 'admitted'
      AND snapshot.snapshot_status = 'candidate'
      AND request.status IN ('admitted', 'running')
      AND request.admission_state = 'admitted'
    ORDER BY snapshotId, articleId
  `)
}
