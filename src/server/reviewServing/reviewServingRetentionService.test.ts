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

  expect(result).toEqual({retentionScope: 'reviewServing:project-1:review-config-1'})
  expect(joined).toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).toContain("snapshot_status = 'active'")
  expect(joined).toContain('last_known_good_snapshot_id')
  expect(joined).toContain('FROM app.review_serving_snapshot_pin pin')
  expect(joined).toContain('released_at IS NULL AND ref_count > 0 AND expires_at > TIMESTAMPTZ')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('INSERT INTO app.review_serving_retention_mark')
  expect(joined).toContain('updated_at = excluded.updated_at')
  expect(joined).toContain('"tableIndex":1')
})

const legacyRetentionTables = [
  'mart.review_article_display_patch_v4',
  'mart.review_selected_import_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_queue_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
  'mart.review_article_summary_contribution_v4',
]

test('retention cleanup cursor includes selected-import cleanup and wraps over current tables only', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 10}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM app.review_selected_article_import_v4')
  expect(joined).toContain("candidate.project_id = 'project-1'")
  expect(joined).toContain('ORDER BY candidate.selected_import_snapshot_id')
  expect(joined).toContain('LIMIT 25')
  expect(joined).toContain('"tableIndex":0')
})

test('retention cleanup no longer references legacy patch or contribution tables at runtime', async () => {
  const {database, statements} = createRetentionDatabase({
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 11}, patchWatermark: 0, snapshotId: null},
  })

  await cleanupReviewServingRetentionState(
    {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
    database,
  )
  const joined = statements.join('\n')

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
