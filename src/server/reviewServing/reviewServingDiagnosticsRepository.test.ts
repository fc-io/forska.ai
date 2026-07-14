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

      if (statement.includes('WITH active_snapshot AS')) {
        return [
          {
            activeSnapshotComponentStateJson: {
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
            activeSnapshotLastKnownGoodSnapshotId: 'snapshot-0',
            activeSnapshotOptionalComponentsJson: ['search'],
            activeSnapshotSnapshotId: 'snapshot-1',
            activeSnapshotUpdatedAt: '2026-06-18T10:00:00.000Z',
            dirtyWorkCompletedCount: 5,
            dirtyWorkFailedCount: 1,
            dirtyWorkOldestQueuedAt: '2026-06-18T09:00:00.000Z',
            dirtyWorkPendingCount: 3,
            dirtyWorkRunningCount: 2,
            dirtyWorkUpdatedAt: '2026-06-18T10:01:00.000Z',
            oldestBarrierOutboxId: 'outbox-1',
            oldestBarrierSourceHighWaterMark: 4,
            oldestBarrierSourcePartition: 'reviewChange:project-1',
            oldestBarrierStatus: 'quarantined',
            quarantinedCursorCount: 1,
            quarantinedOutboxCount: 1,
            rebuildChunkBlockedOverBudgetCount: 2,
            rebuildChunkBlockedQueuedCount: 4,
            rebuildChunkClaimableCount: 1,
            rebuildChunkCompletedCount: 8,
            rebuildChunkExpiredLeaseCount: 1,
            rebuildChunkFailedCount: 0,
            rebuildChunkOldestClaimableQueuedAt: '2026-06-18T08:30:00.000Z',
            rebuildChunkOldestQueuedAt: '2026-06-18T08:00:00.000Z',
            rebuildChunkPendingCount: 5,
            rebuildChunkQuarantinedCount: 1,
            rebuildChunkRunningCount: 2,
            rebuildChunkUpdatedAt: '2026-06-18T10:02:00.000Z',
            retryableOutboxCount: 2,
            snapshotActiveCount: 1,
            snapshotCandidateCount: 1,
            snapshotFailedCount: 2,
            snapshotInvalidCandidateCount: 1,
            snapshotRetiredCount: 0,
            unresolvedOutboxCount: 3,
          },
        ] as T[]
      }

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
          {invalidCandidateCount: 0, snapshotCount: 1, snapshotStatus: 'active'},
          {invalidCandidateCount: 1, snapshotCount: 1, snapshotStatus: 'candidate'},
          {invalidCandidateCount: 0, snapshotCount: 2, snapshotStatus: 'failed'},
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
    snapshot: {
      activeCount: 1,
      activeSnapshotId: 'snapshot-1',
      candidateCount: 1,
      failedCount: 2,
      invalidCandidateCount: 1,
      lastKnownGoodSnapshotId: 'snapshot-0',
    },
  })
  expect(statements.join('\n')).toContain('app.review_serving_snapshot_manifest')
  expect(statements.join('\n')).toContain('app.review_selected_import_snapshot')
  expect(statements.join('\n')).toContain('missing_required_candidate')
  expect(statements.join('\n')).toContain('invalid_required_state_candidate')
  expect(statements.join('\n')).toContain('invalid_optional_state_candidate')
  expect(statements.join('\n')).toContain("json_extract(snapshot.component_state_json, '$.optional')")
  expect(statements.join('\n')).toContain('app.review_projection_identity_manifest')
  expect(statements.join('\n')).toContain("manifest.status IN ('active', 'candidate')")
  expect(statements.join('\n')).toContain('snapshot.source_watermarks_json')
  expect(statements.join('\n')).toContain('manifest.input_watermarks_json')
  expect(statements.join('\n')).toContain("source_watermark.key IN ('reviewChange', 'review-change')")
  expect(statements.join('\n')).toContain(
    "source_watermark.key IN ('reviewChange', 'review-change', 'importRunArticle'",
  )
  expect(statements.join('\n')).toContain('app.review_serving_dirty_work')
  expect(statements.join('\n')).toContain("status IN ('failed', 'running')")
  expect(statements.join('\n')).toContain("INTERVAL '900 seconds'")
  expect(statements.join('\n')).toContain('app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).toContain("visible_chunk.status IN ('pending', 'failed')")
  expect(statements.join('\n')).toContain('AS claimableCount')
  expect(statements.join('\n')).toContain('AS blockedQueuedCount')
  expect(statements.join('\n')).toContain('visible_chunk.lease_expires_at IS NULL')
  expect(statements.join('\n')).toContain(
    "CASE WHEN admission_state = 'admitted' AND status IN ('admitted', 'running')",
  )
  expect(statements.join('\n')).toContain('FROM terminal_request')
  expect(statements.join('\n')).toContain('classified_chunk.request_id IS NOT DISTINCT FROM latest_request.request_id')
  expect(statements.join('\n')).toContain("latest_request.status IN ('failed', 'quarantined')")
  expect(statements.join('\n')).toContain("latest_request.status IN ('blocked_over_budget', 'failed')")
  expect(statements.join('\n')).toContain("latest_request.status IN ('quarantined', 'failed')")
  expect(statements.join('\n')).toContain('app.review_source_change_outbox')
  expect(statements.join('\n')).toContain('app.review_delta_reconciliation_cursor')
})

test('review serving diagnostics query sequentially instead of fanning out owner reads', async () => {
  const {database} = createDiagnosticsDatabase()
  let activeQueryCount = 0
  let maxActiveQueryCount = 0
  const guardedDatabase: ReviewServingDiagnosticsDatabase = {
    queryJson: async <T>(statement: string) => {
      activeQueryCount += 1
      maxActiveQueryCount = Math.max(maxActiveQueryCount, activeQueryCount)

      try {
        await new Promise((resolve) => {
          setTimeout(resolve, 0)
        })

        return database.queryJson<T>(statement)
      } finally {
        activeQueryCount -= 1
      }
    },
  }

  await getReviewServingDiagnostics(
    {now: '2026-06-18T10:05:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    guardedDatabase,
  )

  expect(maxActiveQueryCount).toBe(1)
})

test('review serving diagnostics batch warning state into one owner read', async () => {
  const {database, statements} = createDiagnosticsDatabase()

  await getReviewServingDiagnostics(
    {now: '2026-06-18T10:05:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )

  expect(statements).toHaveLength(1)
})

test('review serving diagnostics preserve project-wide snapshot status counts when review config is omitted', async () => {
  const {database, statements} = createDiagnosticsDatabase()

  await getReviewServingDiagnostics({now: '2026-06-18T10:05:00.000Z', projectId: 'project-1'}, database)

  const snapshotStatusStatement = statements.find((statement) => {
    return statement.includes('snapshot_status_counts AS')
  })

  expect(snapshotStatusStatement).toBeDefined()
  expect(snapshotStatusStatement).not.toContain('review_config_hash IS NOT DISTINCT FROM')
})
