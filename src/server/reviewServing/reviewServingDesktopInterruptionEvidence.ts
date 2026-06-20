export type ReviewServingDesktopInterruptionEvidenceArea =
  | 'browserDesktopParity'
  | 'projectorResume'
  | 'bulkJobResume'
  | 'searchJobResume'
  | 'cleanupResume'
  | 'lowMemoryDefaults'

export type ReviewServingDesktopInterruptionEvidenceEntry = {
  area: ReviewServingDesktopInterruptionEvidenceArea
  contract: string
  evidenceFiles: readonly string[]
  requiredMarkers: readonly string[]
}

export const reviewServingDesktopInterruptionEvidence: readonly ReviewServingDesktopInterruptionEvidenceEntry[] = [
  {
    area: 'browserDesktopParity',
    contract: 'desktop backend starts the same server entry and routes /api requests to the shared API surface',
    evidenceFiles: [
      'src/desktop/getDesktopRuntimeConfig.ts',
      'src/desktop/index.ts',
      'src/server/reviewServing/reviewServingReadContracts.ts',
    ],
    requiredMarkers: ['../server/index.ts', "pathname.startsWith('/api/')", 'reviewServingReadContractRouteInventory'],
  },
  {
    area: 'browserDesktopParity',
    contract: 'shared serving requests use the same admission contracts and DuckDB workload contexts',
    evidenceFiles: [
      'src/server/reviewServing/reviewServingAdmission.ts',
      'src/server/reviewServing/reviewServingReader.ts',
    ],
    requiredMarkers: ['admitReviewServingDuckdbWorkload', 'getDuckdbWorkloadContext', 'readReviewServingRows'],
  },
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
      'ON CONFLICT (job_id) DO UPDATE SET updated_at = current_timestamp',
      'FROM app.review_search_job',
      'creates bounded async substring work without synchronous title scans',
    ],
  },
  {
    area: 'cleanupResume',
    contract: 'retention cleanup advances bounded marks and protects active, pinned, and last-known-good snapshots',
    evidenceFiles: [
      'src/server/reviewServing/reviewServingRetentionService.ts',
      'src/server/reviewServing/reviewServingRetentionService.test.ts',
    ],
    requiredMarkers: [
      'app.review_serving_retention_mark',
      'defaultRetentionCleanupBatchSize = 512',
      'getActivePinPredicate',
      'retention cleanup advances a bounded cursor',
    ],
  },
  {
    area: 'lowMemoryDefaults',
    contract:
      'desktop and low-memory DuckDB runtime reduce memory pressure with bounded batches, one thread, and serialized work before raising concurrency',
    evidenceFiles: [
      'src/desktop/getDesktopRuntimeConfig.ts',
      'src/server/utils/duckdbService.ts',
      'src/server/utils/duckdbServiceMemoryLimit.test.ts',
      'src/server/workers/reviewServingProjectorWorker.ts',
      'src/server/workers/reviewBulkOperationWorker.ts',
      'src/server/reviewServing/reviewSearchService.ts',
      'src/server/reviewServing/reviewSearchService.test.ts',
    ],
    requiredMarkers: [
      "DUCKDB_MEMORY_LIMIT: getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT) ?? '6400MiB'",
      'memoryLimitMiB !== null && memoryLimitMiB <= 6400',
      'serializeConcurrentWork',
      'defaultReviewServingProjectorWorkerBatchSize = 64',
      'const defaultBatchSize = 500',
      '{"cursor":null,"limit":500}',
    ],
  },
] as const
