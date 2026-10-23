import {getCurrentReviewConfigHash} from '../../../services/reviewServingProjectConfigIdentity.ts'

export const getSharedReviewConfigHash = async (sourceProjectIds: string[]) => {
  const hashEntries = await Promise.all(
    sourceProjectIds.map((sourceProjectId) => {
      return getCurrentReviewConfigHash(sourceProjectId).then((reviewConfigHash) => {
        return [sourceProjectId, reviewConfigHash] as const
      })
    }),
  )
  const hashes = hashEntries.map(([, reviewConfigHash]) => {
    return reviewConfigHash
  })
  const uniqueHashes = [...new Set(hashes)]

  return {
    reviewConfigHash: uniqueHashes.length === 1 ? (uniqueHashes[0] ?? null) : null,
    reviewConfigHashByProjectId: Object.fromEntries(hashEntries),
  }
}
