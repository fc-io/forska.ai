import {getSqlLiteral} from '../services/appQueryHelpers.ts'

// A fresh bootstrap chunk builds a component into a snapshot that holds no rows of it yet.
export const freshReviewServingSnapshotRebuildChunkInputDigest = 'freshReviewServingSnapshot'

// Chunks that build into a snapshot that is already active. An addition builds a component the snapshot did not
// carry yet, so it stays unavailable until its chunks finish; a refresh rebuilds a component the snapshot already
// serves, range by range in place, so the component keeps being served while it runs.
export const inPlaceAdditionReviewServingRebuildChunkInputDigest = 'inPlaceReviewServingAddition'
export const inPlaceRefreshReviewServingRebuildChunkInputDigest = 'inPlaceReviewServingRefresh'

// In-place chunks write into rows the snapshot may already hold, so their writers replace the chunk's range.
export const isInPlaceReviewServingRebuildChunkInputDigest = (inputDigest: string | null | undefined) => {
  return (
    inputDigest === inPlaceAdditionReviewServingRebuildChunkInputDigest
    || inputDigest === inPlaceRefreshReviewServingRebuildChunkInputDigest
  )
}

export const getReviewServingRebuildChunkInPlaceRefreshPredicateSql = (tableAlias?: string) => {
  return `${tableAlias ? `${tableAlias}.` : ''}input_digest = ${getSqlLiteral(inPlaceRefreshReviewServingRebuildChunkInputDigest)}`
}

export const getReviewServingRebuildChunkInPlacePredicateSql = (tableAlias?: string) => {
  return `COALESCE(${tableAlias ? `${tableAlias}.` : ''}input_digest, '') IN (${[
    inPlaceAdditionReviewServingRebuildChunkInputDigest,
    inPlaceRefreshReviewServingRebuildChunkInputDigest,
  ]
    .map(getSqlLiteral)
    .join(', ')})`
}
