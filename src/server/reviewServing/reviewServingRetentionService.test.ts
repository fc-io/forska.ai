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
    cleanupTable: 'mart.review_article_serving_base_v4',
    cleanupTableIndex: 0,
    nextCleanupTableIndex: 1,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_article_serving_base_v4')
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

test('retention cleanup cursor includes selected-import current cleanup', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 11}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_selected_article_import_current_v4',
    cleanupTableIndex: 11,
    nextCleanupTableIndex: 12,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_selected_article_import_current_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.selected_import_snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":12')
})

test('retention cleanup cursor includes selected-import staging cleanup', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 12}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_selected_article_import_staging_v4',
    cleanupTableIndex: 12,
    nextCleanupTableIndex: 13,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_selected_article_import_staging_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.selected_import_snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":13')
})

test('retention cleanup includes dynamic filtered count serving rows', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 5}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_filtered_count_serving_v4',
    cleanupTableIndex: 5,
    nextCleanupTableIndex: 6,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_filtered_count_serving_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":6')
})

test('retention cleanup no longer references legacy patch or contribution tables at runtime', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 2}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 25,
    cleanupSpecKind: 'snapshot',
    cleanupTable: 'mart.review_article_filter_posting_serving_v4',
    cleanupTableIndex: 2,
    nextCleanupTableIndex: 3,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":3')
  expect(
    legacyRetentionTables.filter((table) => {
      return joined.includes(table)
    }),
  ).toEqual([])
})

test('retention cleanup no longer includes terminal summary partial cleanup', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 14}, patchWatermark: 0, snapshotId: null},
  })

  const result = await cleanupReviewServingRetentionState(
    {batchSize: 17, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({
    cleanupBatchSize: 17,
    cleanupSpecKind: 'terminalRebuildChunkManifest',
    cleanupTable: 'app.review_rebuild_chunk_manifest',
    cleanupTableIndex: 14,
    nextCleanupTableIndex: 0,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM app.review_rebuild_chunk_manifest')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain("candidate.projection_component = 'summary'")
  expect(joined).not.toContain('review_article_summary_rebuild_partial_v4')
  expect(joined).not.toContain('review_rebuild_partial_cleanup_authorization')
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('diagnostic_request.status IN')
  expect(joined).toContain('LIMIT 17')
  expect(joined).toContain('"tableIndex":0')
})

test('retention cleanup allowlists chunk manifest cleanup after summary partial retirement', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 14}, patchWatermark: 0, snapshotId: null},
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
    cleanupTableIndex: 14,
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
  expect(joined).not.toContain('mart.review_article_summary_contribution_rebuild_partial_v4')
  expect(joined).not.toContain('mart.review_article_summary_rebuild_partial_v4')
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
