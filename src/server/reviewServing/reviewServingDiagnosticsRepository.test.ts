import {expect, test} from 'bun:test'

import {
  getReviewServingDiagnostics,
  type ReviewServingDiagnosticsDatabase,
} from './reviewServingDiagnosticsRepository.ts'

const createDiagnosticsDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingDiagnosticsDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes("snapshot_status = 'active'")) {
        return [
          {
            componentStateJson: {
              optional: [
                {baseGeneration: '1', component: 'search', patchWatermark: '7', projectionIdentity: 'search:project-1'},
              ],
              required: [
                {
                  baseGeneration: '1',
                  component: 'display',
                  patchWatermark: '7',
                  projectionIdentity: 'display:project-1',
                },
              ],
            },
            lastKnownGoodSnapshotId: 'snapshot-0',
            optionalComponentsJson: ['search'],
            snapshotId: 'snapshot-1',
            updatedAt: '2026-06-18T10:00:00.000Z',
          },
        ] as T[]
      }

      if (statement.includes('GROUP BY snapshot_status')) {
        return [
          {snapshotCount: 1, snapshotStatus: 'active'},
          {snapshotCount: 2, snapshotStatus: 'failed'},
        ] as T[]
      }

      if (statement.includes('FROM app.review_serving_dirty_work')) {
        return [
          {
            completedCount: 5,
            failedCount: 1,
            oldestQueuedAt: '2026-06-18T09:00:00.000Z',
            pendingCount: 3,
            runningCount: 2,
            updatedAt: '2026-06-18T10:01:00.000Z',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
        return [
          {
            blockedQueuedCount: 4,
            blockedOverBudgetCount: 2,
            claimableCount: 1,
            completedCount: 8,
            expiredLeaseCount: 1,
            failedCount: 0,
            oldestClaimableQueuedAt: '2026-06-18T08:30:00.000Z',
            oldestQueuedAt: '2026-06-18T08:00:00.000Z',
            pendingCount: 5,
            quarantinedCount: 1,
            runningCount: 2,
            updatedAt: '2026-06-18T10:02:00.000Z',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_source_change_outbox') && statement.includes('ORDER BY')) {
        return [
          {
            outboxId: 'outbox-1',
            sourceHighWaterMark: 4,
            sourcePartition: 'reviewChange:project-1',
            status: 'quarantined',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [{quarantinedOutboxCount: 1, retryableOutboxCount: 2, unresolvedOutboxCount: 3}] as T[]
      }

      if (statement.includes('FROM app.review_delta_reconciliation_cursor')) {
        return [{quarantinedCursorCount: 1}] as T[]
      }

      return [] as T[]
    },
  }

  return {database, statements}
}

test('review serving diagnostics summarize snapshot search dirty work chunks and quarantine state', async () => {
  const {database, statements} = createDiagnosticsDatabase()
  const diagnostics = await getReviewServingDiagnostics(
    {now: '2026-06-18T10:05:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )

  expect(diagnostics).toMatchObject({
    dirtyWork: {failedCount: 1, pendingCount: 3, runningCount: 2},
    maintenance: {
      dirtyWorkRunningCount: 2,
      expiredRebuildChunkLeaseCount: 1,
      rebuildChunkRunningCount: 2,
      requiredConsumerRole: 'maintenance-worker',
    },
    quarantine: {
      oldestBarrier: {
        outboxId: 'outbox-1',
        sourceHighWaterMark: 4,
        sourcePartition: 'reviewChange:project-1',
        status: 'quarantined',
      },
      quarantinedCursorCount: 1,
      quarantinedOutboxCount: 1,
      retryableOutboxCount: 2,
      unresolvedOutboxCount: 3,
    },
    rebuildChunks: {
      blockedQueuedCount: 4,
      blockedOverBudgetCount: 2,
      claimableCount: 1,
      expiredLeaseCount: 1,
      failedCount: 0,
      oldestClaimableQueuedAt: '2026-06-18T08:30:00.000Z',
      pendingCount: 5,
      quarantinedCount: 1,
      runningCount: 2,
    },
    search: {availability: 'ready', optionalComponent: true, snapshotId: 'snapshot-1'},
    snapshot: {activeCount: 1, activeSnapshotId: 'snapshot-1', failedCount: 2, lastKnownGoodSnapshotId: 'snapshot-0'},
  })
  expect(statements.join('\n')).toContain('app.review_serving_snapshot_manifest')
  expect(statements.join('\n')).toContain('app.review_serving_dirty_work')
  expect(statements.join('\n')).toContain('app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).toContain("visible_chunk.status IN ('pending', 'failed')")
  expect(statements.join('\n')).toContain('AS claimableCount')
  expect(statements.join('\n')).toContain('AS blockedQueuedCount')
  expect(statements.join('\n')).toContain('visible_chunk.lease_expires_at IS NULL')
  expect(statements.join('\n')).toContain("CASE WHEN admission_state = 'admitted' AND status IN ('admitted', 'running')")
  expect(statements.join('\n')).toContain('COUNT(*) FILTER (WHERE classified_chunk.claimable = 1) = 0')
  expect(statements.join('\n')).toContain("latest_request.status IN ('failed', 'quarantined')")
  expect(statements.join('\n')).toContain("latest_request.status IN ('blocked_over_budget', 'failed')")
  expect(statements.join('\n')).toContain("latest_request.status IN ('quarantined', 'failed')")
  expect(statements.join('\n')).toContain('app.review_source_change_outbox')
  expect(statements.join('\n')).toContain('app.review_delta_reconciliation_cursor')
})
