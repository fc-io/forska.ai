import {expect, test} from 'bun:test'

import {
  cleanupReviewServingRetentionState,
  getReviewServingRetentionCleanupTargets,
  type ReviewServingRetentionServiceDatabase,
} from './reviewServingRetentionService.ts'

const createRetentionDatabase = (input?: {
  cleanupTargetRows?: readonly {projectId: string; reviewConfigHash: string | null}[]
  retentionState?: {baseGeneration: number; cursorJson: unknown; patchWatermark: number; snapshotId: string | null}
}) => {
  const statements: string[] = []
  const database: ReviewServingRetentionServiceDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_serving_retention_mark')) {
        return (input?.retentionState === undefined ? [] : [input.retentionState]) as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest') && statement.includes('GROUP BY')) {
        return (input?.cleanupTargetRows ?? []) as T[]
      }

      if (statement.includes('AS cleanupRowCount')) {
        return [{cleanupRowCount: 1}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

test('retention cleanup advances a bounded cursor and protects active, last-known-good, and pinned snapshots', async () => {
  const {database, statements} = createRetentionDatabase()

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_article_serving_v4',
    cleanupTableIndex: 0,
    nextCleanupTableIndex: 1,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).toContain("snapshot_status = 'active'")
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('released_at IS NULL AND ref_count > 0 AND expires_at > TIMESTAMPTZ')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('UPDATE app.review_serving_retention_mark')
  expect(joined.indexOf('UPDATE app.review_serving_retention_mark')).toBeLessThan(
    joined.indexOf('INSERT INTO app.review_serving_retention_mark'),
  )
  expect(joined).toContain('INSERT INTO app.review_serving_retention_mark')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).toContain("(retention_scope || '') = ('reviewServing:project-1:review-config-1' || '')")
  expect(joined).not.toContain('ON CONFLICT(retention_scope) DO UPDATE SET')
  expect(joined).toContain('"tableIndex":1')
})

const legacyRetentionTables = [
  'mart.review_article_display_patch_v4',
  'mart.review_selected_import_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
  'mart.review_article_summary_contribution_v4',
]

test('retention cleanup cursor includes selected-import cleanup and wraps over current tables only', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 9}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'app.review_selected_article_import_v4',
    cleanupTableIndex: 9,
    nextCleanupTableIndex: 10,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM app.review_selected_article_import_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.selected_import_snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":10')
})

test('retention cleanup no longer references legacy patch or contribution tables at runtime', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 13}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_article_serving_v4',
    cleanupTableIndex: 0,
    nextCleanupTableIndex: 1,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":1')
  expect(
    legacyRetentionTables.filter((table) => {
      return joined.includes(table)
    }),
  ).toEqual([])
})

test('retention cleanup allowlists terminal summary contribution partial cleanup with conservative rebuild guards', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 10}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'terminalRebuildPartial',
    cleanupTable: 'mart.review_article_summary_contribution_rebuild_partial_v4',
    cleanupTableIndex: 10,
    nextCleanupTableIndex: 11,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('CREATE OR REPLACE TEMP TABLE review_serving_contribution_partial_cleanup_rowids AS')
  expect(joined).toContain('CREATE OR REPLACE TABLE mart.review_article_summary_contribution_rebuild_partial_v4 AS')
  expect(joined).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_unique',
  )
  expect(joined).toContain('summary_identity')
  expect(joined).not.toContain('contribution_key')
  expect(joined).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_rebuild_partial_v4_publish',
  )
  expect(joined).toContain('DROP TABLE IF EXISTS review_serving_contribution_partial_cleanup_rowids')
  expect(joined).toContain('INNER JOIN app.review_rebuild_request request')
  expect(joined).toContain('LEFT JOIN app.review_rebuild_chunk_manifest chunk')
  expect(joined).toContain('chunk.snapshot_id = candidate.snapshot_id')
  expect(joined).toContain("chunk.projection_component = 'summary'")
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain("candidate.review_config_hash IS NOT DISTINCT FROM 'review-config-1'")
  expect(joined).toContain("request.status = 'completed'")
  expect(joined).toContain("chunk.status = 'completed'")
  expect(joined).toContain('request.lease_owner IS NULL')
  expect(joined).toContain('chunk.lease_owner IS NULL')
  expect(joined).toContain('app.review_rebuild_partial_cleanup_authorization cleanup_authorization')
  expect(joined).toContain('cleanup_authorization.project_id = candidate.project_id')
  expect(joined).toContain('cleanup_authorization.review_config_hash = candidate.review_config_hash')
  expect(joined).toContain('cleanup_authorization.request_id = candidate.request_id')
  expect(joined).toContain('cleanup_authorization.chunk_id = candidate.chunk_id')
  expect(joined).toContain('cleanup_authorization.snapshot_id = candidate.snapshot_id')
  expect(joined).toContain(
    "cleanup_authorization.partial_table = 'mart.review_article_summary_contribution_rebuild_partial_v4'",
  )
  expect(joined).toContain("cleanup_authorization.cleanup_mode = 'stale_orphan_summary_partial'")
  expect(joined).toContain(
    "cleanup_authorization.operator_ack = 'authorize-stale-orphan-review-serving-summary-partial-cleanup'",
  )
  expect(joined).toContain('cleanup_authorization.expires_at > TIMESTAMPTZ')
  expect(joined).toContain('cleanup_authorization.expected_row_count = (')
  expect(joined).toContain('CREATE OR REPLACE TEMP TABLE review_serving_partial_cleanup_authorization_receipts AS')
  expect(joined).toContain('CREATE TABLE app.review_rebuild_partial_cleanup_authorization_repair')
  expect(joined).toContain('DROP TABLE app.review_rebuild_partial_cleanup_authorization')
  expect(joined).toContain(
    'ALTER TABLE app.review_rebuild_partial_cleanup_authorization_repair\n    RENAME TO review_rebuild_partial_cleanup_authorization;',
  )
  expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_review_rebuild_partial_cleanup_authorization_lookup')
  expect(joined).not.toContain('UPDATE app.review_rebuild_partial_cleanup_authorization')
  expect(joined).toContain('ELSE current_timestamp\n      END AS applied_at')
  expect(joined).toContain(
    'COALESCE(receipt.applied_row_count, cleanup_authorization.applied_row_count) AS applied_row_count',
  )
  expect(joined).toContain('FROM mart.review_article_summary_contribution_rebuild_partial_v4 row_count_partial')
  expect(joined).toContain('matching_summary_chunk.projection_component = ')
  expect(joined).toContain("'pending_admission'")
  expect(joined).toContain("'blocked_over_budget'")
  expect(joined).toContain("'quarantined'")
  expect(joined).toContain('retryable_chunk')
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('diagnostic_request.status IN')
  expect(joined).toContain('ORDER BY candidate.request_id, candidate.chunk_id, candidate.snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":11')
})

test('retention cleanup allowlists terminal summary partial cleanup with the same bounded guards', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 11}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 17, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 17,
    cleanupSpecKind: 'terminalRebuildPartial',
    cleanupTable: 'mart.review_article_summary_rebuild_partial_v4',
    cleanupTableIndex: 11,
    nextCleanupTableIndex: 12,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('CREATE OR REPLACE TEMP TABLE review_serving_summary_partial_cleanup_rowids AS')
  expect(joined).toContain('CREATE OR REPLACE TABLE mart.review_article_summary_rebuild_partial_v4 AS')
  expect(joined).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_unique')
  expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_reduce')
  expect(joined).toContain('DROP TABLE IF EXISTS review_serving_summary_partial_cleanup_rowids')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain("candidate.review_config_hash IS NOT DISTINCT FROM 'review-config-1'")
  expect(joined).toContain("request.status = 'completed'")
  expect(joined).toContain("chunk.status = 'completed'")
  expect(joined).toContain('app.review_rebuild_partial_cleanup_authorization cleanup_authorization')
  expect(joined).toContain("cleanup_authorization.partial_table = 'mart.review_article_summary_rebuild_partial_v4'")
  expect(joined).toContain('FROM mart.review_article_summary_rebuild_partial_v4 row_count_partial')
  expect(joined).toContain('matching_summary_chunk.request_id = candidate.request_id')
  expect(joined).toContain("matching_summary_chunk.projection_component = 'summary'")
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('diagnostic_request.status IN')
  expect(joined).toContain('LIMIT 17')
  expect(joined).toContain('"tableIndex":12')
})

test('retention cleanup allowlists chunk manifest cleanup only after dependent partial rows are gone', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 12}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 9, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 9,
    cleanupSpecKind: 'terminalRebuildChunkManifest',
    cleanupTable: 'app.review_rebuild_chunk_manifest',
    cleanupTableIndex: 12,
    nextCleanupTableIndex: 0,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM app.review_rebuild_chunk_manifest')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('candidate.snapshot_id IS NOT NULL')
  expect(joined).toContain('candidate.request_id IS NOT NULL')
  expect(joined).toContain("candidate.projection_component = 'summary'")
  expect(joined).toContain('cleanup_snapshot.review_config_hash IS NOT DISTINCT FROM')
  expect(joined).toContain("request.status = 'completed'")
  expect(joined).toContain("candidate.status = 'completed'")
  expect(joined).toContain('mart.review_article_summary_contribution_rebuild_partial_v4 contribution_partial')
  expect(joined).toContain('contribution_partial.request_id = candidate.request_id')
  expect(joined).toContain('contribution_partial.chunk_id = candidate.chunk_id')
  expect(joined).toContain('contribution_partial.snapshot_id = candidate.snapshot_id')
  expect(joined).toContain('mart.review_article_summary_rebuild_partial_v4 summary_partial')
  expect(joined).toContain('summary_partial.request_id = candidate.request_id')
  expect(joined).toContain('summary_partial.chunk_id = candidate.chunk_id')
  expect(joined).toContain('summary_partial.snapshot_id = candidate.snapshot_id')
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('diagnostic_request.status IN')
  expect(joined).toContain('ORDER BY candidate.request_id, candidate.chunk_id')
  expect(joined).toContain('LIMIT 9')
  expect(joined).toContain('"tableIndex":0')
})

test('retention cleanup target discovery scopes normal cleanup by project and review config', async () => {
  const {database, statements} = createRetentionDatabase({
    cleanupTargetRows: [{projectId: 'project-1', reviewConfigHash: 'review-config-1'}],
  })

  const targets = await getReviewServingRetentionCleanupTargets(
    {cleanupBatchSize: 25, now: '2026-06-16T00:00:00.000Z', targetLimit: 3},
    database,
  )

  expect(targets).toEqual([
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
  ])
  expect(statements.join('\n')).toContain("snapshot_status IN ('active', 'retired', 'failed')")
  expect(statements.join('\n')).toContain('GROUP BY project_id, review_config_hash')
  expect(statements.join('\n')).toContain('LIMIT 3')
})
