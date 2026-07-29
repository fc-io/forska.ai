import {DuckDBInstance} from '@duckdb/node-api'
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

test('retention cleanup cursor prunes selected-import current while compatibility is a view', async () => {
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
    cleanupSpecKind: 'selectedImportPublished',
    cleanupTable: 'mart.review_selected_article_import_current_v4',
    cleanupTableIndex: 11,
    nextCleanupTableIndex: 12,
    retentionScope: 'reviewServing:project-1:review-config-1',
  })
  expect(joined).toContain('DELETE FROM mart.review_selected_article_import_current_v4')
  expect(joined).not.toContain('DELETE FROM app.review_selected_article_import_v4')
  expect(joined).not.toContain('review_selected_import_retention_cleanup_candidate')
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
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 13}, patchWatermark: 0, snapshotId: null},
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
    cleanupTableIndex: 13,
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
    retentionState: {baseGeneration: 0, cursorJson: {tableIndex: 13}, patchWatermark: 0, snapshotId: null},
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
    cleanupTableIndex: 13,
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

test('retention cleanup removes selected-import published rows and compatibility view follows current', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()
  const database: ReviewServingRetentionServiceDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      await connection.run('BEGIN')

      try {
        const result = await operation(database)
        await connection.run('COMMIT')

        return result
      } catch (error) {
        await connection.run('ROLLBACK')
        throw error
      }
    },
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE SCHEMA mart;
      CREATE TABLE app.review_serving_retention_mark (
        retention_scope VARCHAR PRIMARY KEY,
        cutoff_snapshot_id VARCHAR,
        cutoff_base_generation BIGINT,
        cutoff_patch_watermark BIGINT,
        cleanup_cursor_json JSON,
        last_cleaned_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );
      CREATE TABLE app.review_serving_snapshot_manifest (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        snapshot_status VARCHAR NOT NULL,
        last_known_good_snapshot_id VARCHAR,
        selected_import_snapshot_id VARCHAR,
        review_config_hash VARCHAR
      );
      CREATE TABLE app.review_serving_snapshot_pin (
        project_id VARCHAR NOT NULL,
        snapshot_id VARCHAR NOT NULL,
        released_at TIMESTAMPTZ,
        ref_count INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE mart.review_selected_article_import_current_v4 (
        project_id VARCHAR NOT NULL,
        project_scope_identity VARCHAR NOT NULL,
        selected_import_snapshot_id VARCHAR NOT NULL,
        article_id VARCHAR NOT NULL,
        import_route_id VARCHAR,
        source_record_key VARCHAR,
        selected_rank_key VARCHAR,
        selected_rank_numeric DOUBLE,
        tombstone BOOLEAN NOT NULL DEFAULT FALSE,
        selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
      );
      CREATE VIEW app.review_selected_article_import_v4 AS
      SELECT *
      FROM mart.review_selected_article_import_current_v4;
      INSERT INTO app.review_serving_retention_mark (
        retention_scope,
        cutoff_snapshot_id,
        cutoff_base_generation,
        cutoff_patch_watermark,
        cleanup_cursor_json,
        last_cleaned_at,
        updated_at
      )
      VALUES (
        'reviewServing:project-1:review-config-1',
        NULL,
        0,
        0,
        '{"tableIndex":11}'::JSON,
        current_timestamp,
        current_timestamp
      );
      INSERT INTO app.review_serving_snapshot_manifest (
        project_id,
        snapshot_id,
        snapshot_status,
        last_known_good_snapshot_id,
        selected_import_snapshot_id,
        review_config_hash
      )
      VALUES
        ('project-1', 'active-snapshot', 'active', 'lkg-snapshot', 'selected-active', 'review-config-1'),
        ('project-1', 'lkg-snapshot', 'retired', NULL, 'selected-lkg', 'review-config-1'),
        ('project-1', 'pinned-snapshot', 'retired', NULL, 'selected-pinned', 'review-config-1');
      INSERT INTO app.review_serving_snapshot_pin (
        project_id,
        snapshot_id,
        released_at,
        ref_count,
        expires_at
      )
      VALUES ('project-1', 'pinned-snapshot', NULL, 1, TIMESTAMPTZ '2026-06-17T00:00:00Z');
      INSERT INTO mart.review_selected_article_import_current_v4 (
        project_id,
        project_scope_identity,
        selected_import_snapshot_id,
        article_id,
        import_route_id,
        source_record_key,
        selected_rank_key,
        selected_rank_numeric,
        tombstone,
        selected_import_updated_at
      )
      VALUES
        ('project-1', 'scope-1', 'selected-retired', 'article-retired', 'route-1', 'source-1', 'rank-1', 1, FALSE, TIMESTAMPTZ '2026-06-16T00:00:00Z'),
        ('project-1', 'scope-1', 'selected-current-only', 'article-current-only', 'route-1', 'source-2', 'rank-2', 2, FALSE, TIMESTAMPTZ '2026-06-16T00:00:00Z'),
        ('project-1', 'scope-1', 'selected-active', 'article-active', 'route-1', 'source-3', 'rank-3', 3, FALSE, TIMESTAMPTZ '2026-06-16T00:00:00Z'),
        ('project-1', 'scope-1', 'selected-lkg', 'article-lkg', 'route-1', 'source-4', 'rank-4', 4, FALSE, TIMESTAMPTZ '2026-06-16T00:00:00Z'),
        ('project-1', 'scope-1', 'selected-pinned', 'article-pinned', 'route-1', 'source-5', 'rank-5', 5, FALSE, TIMESTAMPTZ '2026-06-16T00:00:00Z');
    `)

    const result = await cleanupReviewServingRetentionState(
      {batchSize: 25, now: '2026-06-16T00:00:00.000Z', projectId: 'project-1', reviewConfigHash: 'review-config-1'},
      database,
    )
    const currentRows = await database.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM mart.review_selected_article_import_current_v4
      ORDER BY article_id
    `)
    const mirrorRows = await database.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.review_selected_article_import_v4
      ORDER BY article_id
    `)

    expect(result.cleanupSpecKind).toBe('selectedImportPublished')
    expect(
      currentRows.map((row) => {
        return row.articleId
      }),
    ).toEqual(['article-active', 'article-lkg', 'article-pinned'])
    expect(
      mirrorRows.map((row) => {
        return row.articleId
      }),
    ).toEqual(['article-active', 'article-lkg', 'article-pinned'])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
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
