import {isReviewServingSnapshotDetailReady} from '../../../reviewServing/reviewBulkOperationService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
} from '../../../reviewServing/reviewServingManifestRepository.ts'

export const getPayloadPendingExportSourceProjectIds = async (input: {
  reviewConfigHash: string | null
  reviewConfigHashByProjectId: Record<string, string | null>
  snapshot: {snapshotId: string; type: 'pinned'} | {type: 'latest'}
  sourceProjectIds: string[]
}) => {
  const pendingSourceProjectIds = await Promise.all(
    input.sourceProjectIds.map(async (sourceProjectId) => {
      const manifest =
        input.snapshot.type === 'pinned'
          ? await getReviewServingSnapshotManifest({
              componentStateMode: 'available',
              projectId: sourceProjectId,
              snapshotId: input.snapshot.snapshotId,
            })
          : await getActiveReviewServingSnapshotManifest({
              componentStateMode: 'available',
              projectId: sourceProjectId,
              reviewConfigHash: input.reviewConfigHashByProjectId[sourceProjectId] ?? input.reviewConfigHash,
            })

      return manifest
        && (input.snapshot.type === 'latest' ? manifest.status === 'active' : true)
        && !isReviewServingSnapshotDetailReady(manifest)
        ? sourceProjectId
        : null
    }),
  )

  return pendingSourceProjectIds.filter((sourceProjectId): sourceProjectId is string => {
    return sourceProjectId !== null
  })
}
