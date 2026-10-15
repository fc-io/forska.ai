export type ReviewServingInterruptionEvidenceArea =
  | 'projectorResume'
  | 'bulkJobResume'
  | 'searchJobResume'
  | 'cleanupResume'
  | 'lowMemoryDefaults'

export type ReviewServingInterruptionEvidenceEntry = {
  area: ReviewServingInterruptionEvidenceArea
  contract: string
  evidenceFiles: readonly string[]
  requiredMarkers: readonly string[]
}

export const reviewServingInterruptionEvidence: readonly ReviewServingInterruptionEvidenceEntry[] = [
  {
    area: 'projectorResume',
    contract: 'projector work resumes through durable dirty-work leases, chunk manifests, and released claims',
    evidenceFiles: [
      'src/server/workers/reviewServingProjectorWorker.ts',
      'src/server/reviewServing/reviewServingDirtyWorkService.test.ts',
      'src/server/reviewServing/reviewServingChunkManifestRepository.test.ts',
      'src/server/workers/reviewServingProjectorWorker.test.ts',
    ],
    requiredMarkers: [
      'releaseReviewServingDirtyWorkClaims',
      'getNextClaimableReviewServingRebuildChunk',
      'claims stale running work after the running lease expires',
      'completed chunks resume after restart',
    ],
  },
  {
    area: 'bulkJobResume',
    contract:
      'bulk/export/PDF work resumes from durable job rows, keyset cursors, stale running claims, and terminal cancellation/failure state',
    evidenceFiles: [
      'src/server/workers/reviewBulkOperationWorker.ts',
      'src/server/workers/reviewBulkOperationWorker.test.ts',
    ],
    requiredMarkers: [
      "status = 'running' AND updated_at < current_timestamp - INTERVAL",
      'cursor_json',
      'processed_count = processed_count +',
      'persists cancellation and terminal failure without local state',
    ],
  },
  {
    area: 'searchJobResume',
    contract: 'substring search resumes from app.review_search_job instead of synchronous title scans',
    evidenceFiles: [
      'src/server/reviewServing/reviewSearchService.ts',
      'src/server/reviewServing/reviewSearchService.test.ts',
    ],
    requiredMarkers: [
      'INSERT INTO app.review_search_job',
      'ON CONFLICT (job_id) DO NOTHING',
      'FROM app.review_search_job',
      'creates bounded async substring work without synchronous title scans',
    ],
  },
  {
    area: 'cleanupResume',
    contract:
      'snapshot purge resumes purging snapshots in bounded batches and protects active, candidate, last-known-good, latest retired, pinned, and job- or request-referenced snapshots',
    evidenceFiles: [
      'src/server/reviewServing/reviewServingSnapshotPurge.ts',
      'src/server/reviewServing/reviewServingSnapshotPurge.duckdb.test.ts',
    ],
    requiredMarkers: [
      "snapshot.snapshot_status = 'purging'",
      'heapTableRowsPerStatement = 1_000_000',
      'app.review_serving_snapshot_pin',
      'each call is bounded by snapshots, deleted rows, time and foreground work and resumes a partial purge',
    ],
  },
  {
    area: 'lowMemoryDefaults',
    contract:
      'low-memory DuckDB runtimes reduce memory pressure with bounded batches, one thread, and serialized work before raising concurrency',
    evidenceFiles: [
      'src/server/utils/duckdbService.ts',
      'src/server/utils/duckdbServiceMemoryLimit.test.ts',
      'src/server/workers/reviewServingProjectorWorker.ts',
      'src/server/workers/reviewBulkOperationWorker.ts',
      'src/server/reviewServing/reviewSearchService.ts',
      'src/server/reviewServing/reviewSearchService.test.ts',
    ],
    requiredMarkers: [
      'memoryLimitMiB !== null && memoryLimitMiB <= 6400',
      'serializeConcurrentWork',
      'defaultReviewServingProjectorWorkerBatchSize = 64',
      'const defaultBatchSize = 500',
      '{"cursor":null,"limit":500}',
    ],
  },
] as const
