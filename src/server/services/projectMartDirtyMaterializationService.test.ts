import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import type {ProjectMartDirtyMaterializationStateRecord} from '../../db/schemaTypes.ts'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getDirtyMaterializationScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('dirty-materialization-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES (
        'dirty-materialization-model',
        'dirty-materialization-connection',
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen 35B',
        'manual',
        TRUE
      )
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('dirty-materialization-project', 'Dirty Materialization Project', 'dirty-materialization-model', TRUE, TRUE, FALSE, FALSE)
    \`)

    ${body}
  `
}

const runDirtyMaterializationScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-dirty-materialization-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runScript = globalThis.Bun.spawnSync(['bun', '-e', getDirtyMaterializationScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runScript.exitCode !== 0) {
      throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Dirty materialization test failed')
    }

    return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists(`${duckdbPath}.tmp`)
    removeFileIfExists(`${duckdbPath}.tmp/`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project mart dirty materialization migration creates durable fenced state schema', () => {
  const result = runDirtyMaterializationScript<{
    columns: Array<{columnName: string}>
    indexes: Array<{indexName: string}>
    row: ProjectMartDirtyMaterializationStateRecord | null
  }>(`
    const {getProjectMartDirtyMaterializationService} = await import(
      './src/server/services/projectMartDirtyMaterializationService.ts'
    )
    const service = getProjectMartDirtyMaterializationService()

    const row = await service.queueDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      sourceScopeGeneration: 42,
      sourceScopeHighWaterArticleCreatedAt: new Date('2026-04-03T10:00:00.000Z'),
      sourceScopeHighWaterArticleId: 'article-999',
      sourceScopeFingerprint: 'scope-fingerprint-1',
      now: new Date('2026-04-03T10:01:00.000Z'),
    })
    const columns = await database.queryJson(\`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'project_mart_dirty_materialization_state'
      ORDER BY ordinal_position
    \`)
    const indexes = await database.queryJson(\`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'project_mart_dirty_materialization_state'
      ORDER BY index_name
    \`)

    console.log(JSON.stringify({columns, indexes, row}))
    await database.close()
  `)

  expect(
    result.columns.map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'project_id',
    'source_kind',
    'target_dirty_token',
    'cursor_article_created_at',
    'cursor_article_id',
    'inserted_row_count',
    'source_scope_generation',
    'source_scope_high_water_article_created_at',
    'source_scope_high_water_article_id',
    'source_scope_fingerprint',
    'materialization_status',
    'materialization_owner',
    'lease_expires_at',
    'last_started_at',
    'last_completed_at',
    'last_failed_at',
    'last_error',
    'created_at',
    'updated_at',
  ])
  expect(
    result.indexes.map((index) => {
      return index.indexName
    }),
  ).toEqual([
    'idx_app_project_mart_dirty_materialization_state_claim',
    'idx_app_project_mart_dirty_materialization_state_project_token',
    'idx_app_project_mart_dirty_materialization_state_stale_work',
  ])
  expect(result.row).toMatchObject({
    cursorArticleCreatedAt: null,
    cursorArticleId: null,
    insertedRowCount: 0,
    materializationOwner: null,
    materializationStatus: 'pending',
    projectId: 'dirty-materialization-project',
    sourceKind: 'project_scope_article',
    sourceScopeFingerprint: 'scope-fingerprint-1',
    sourceScopeGeneration: 42,
    sourceScopeHighWaterArticleId: 'article-999',
    targetDirtyToken: 7,
  })
})

test('project mart dirty materialization updates require owner lease token source and status fences', () => {
  const result = runDirtyMaterializationScript<{
    claimed: Array<{materializationOwner: string; targetDirtyToken: number}>
    claimedAfterHeartbeat: ProjectMartDirtyMaterializationStateRecord | null
    completed: ProjectMartDirtyMaterializationStateRecord | null
    completedToken: number | null
    expiredAdvance: ProjectMartDirtyMaterializationStateRecord | null
    failed: ProjectMartDirtyMaterializationStateRecord | null
    failedClaim: Array<{materializationOwner: string; targetDirtyToken: number}>
    hiddenCompletedToken: number | null
    staleFailure: ProjectMartDirtyMaterializationStateRecord | null
    staleOwnerAdvance: ProjectMartDirtyMaterializationStateRecord | null
    staleSnapshotAdvance: ProjectMartDirtyMaterializationStateRecord | null
    updated: ProjectMartDirtyMaterializationStateRecord | null
  }>(`
    const {getProjectMartDirtyMaterializationService} = await import(
      './src/server/services/projectMartDirtyMaterializationService.ts'
    )
    const service = getProjectMartDirtyMaterializationService()
    const sourceSnapshot = {
      sourceScopeGeneration: 42,
      sourceScopeHighWaterArticleCreatedAt: new Date('2026-04-03T10:00:00.000Z'),
      sourceScopeHighWaterArticleId: 'article-999',
      sourceScopeFingerprint: 'scope-fingerprint-1',
    }

    await service.queueDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      ...sourceSnapshot,
      now: new Date('2026-04-03T10:01:00.000Z'),
    })
    const claimed = await service.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'worker-1',
      limit: 1,
      leaseMs: 1000,
      now: new Date('2026-04-03T10:02:00.000Z'),
    })
    const staleOwnerAdvance = await service.advanceDirtyMaterializationCursor({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-2',
      ...sourceSnapshot,
      cursorArticleCreatedAt: new Date('2026-04-03T10:03:00.000Z'),
      cursorArticleId: 'article-100',
      insertedRowCountDelta: 3,
      now: new Date('2026-04-03T10:02:00.500Z'),
    })
    const staleSnapshotAdvance = await service.advanceDirtyMaterializationCursor({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      sourceScopeFingerprint: 'wrong-fingerprint',
      cursorArticleCreatedAt: new Date('2026-04-03T10:03:00.000Z'),
      cursorArticleId: 'article-100',
      insertedRowCountDelta: 3,
      now: new Date('2026-04-03T10:02:00.500Z'),
    })
    const expiredAdvance = await service.advanceDirtyMaterializationCursor({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      cursorArticleCreatedAt: new Date('2026-04-03T10:03:00.000Z'),
      cursorArticleId: 'article-100',
      insertedRowCountDelta: 3,
      now: new Date('2026-04-03T10:02:01.500Z'),
    })
    await service.heartbeatDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      leaseMs: 5000,
      now: new Date('2026-04-03T10:02:00.500Z'),
    })
    const claimedAfterHeartbeat = await service.getClaimedDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      now: new Date('2026-04-03T10:02:01.000Z'),
    })
    const updated = await service.advanceDirtyMaterializationCursor({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      cursorArticleCreatedAt: new Date('2026-04-03T10:03:00.000Z'),
      cursorArticleId: 'article-100',
      insertedRowCountDelta: 3,
      now: new Date('2026-04-03T10:02:01.000Z'),
    })
    const hiddenCompletedToken = await service.getCompletedDirtyMaterializationToken({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      ...sourceSnapshot,
    })
    const completed = await service.completeDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      materializationOwner: 'worker-1',
      ...sourceSnapshot,
      now: new Date('2026-04-03T10:02:02.000Z'),
    })
    const completedToken = await service.getCompletedDirtyMaterializationToken({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 7,
      ...sourceSnapshot,
    })

    await service.queueDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 8,
      sourceScopeGeneration: 43,
      sourceScopeHighWaterArticleCreatedAt: new Date('2026-04-03T11:00:00.000Z'),
      sourceScopeHighWaterArticleId: 'article-1000',
      sourceScopeFingerprint: 'scope-fingerprint-2',
      now: new Date('2026-04-03T11:01:00.000Z'),
    })
    const failedClaim = await service.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'worker-3',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-03T11:02:00.000Z'),
    })
    const staleFailure = await service.failDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 8,
      materializationOwner: 'worker-4',
      sourceScopeGeneration: 43,
      sourceScopeHighWaterArticleCreatedAt: new Date('2026-04-03T11:00:00.000Z'),
      sourceScopeHighWaterArticleId: 'article-1000',
      sourceScopeFingerprint: 'scope-fingerprint-2',
      error: 'wrong owner',
      now: new Date('2026-04-03T11:02:01.000Z'),
    })
    const failed = await service.failDirtyMaterialization({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: 8,
      materializationOwner: 'worker-3',
      sourceScopeGeneration: 43,
      sourceScopeHighWaterArticleCreatedAt: new Date('2026-04-03T11:00:00.000Z'),
      sourceScopeHighWaterArticleId: 'article-1000',
      sourceScopeFingerprint: 'scope-fingerprint-2',
      error: 'insert failed',
      now: new Date('2026-04-03T11:02:01.000Z'),
    })

    console.log(JSON.stringify({
      claimed,
      claimedAfterHeartbeat,
      completed,
      completedToken,
      expiredAdvance,
      failed,
      failedClaim,
      hiddenCompletedToken,
      staleFailure,
      staleOwnerAdvance,
      staleSnapshotAdvance,
      updated,
    }))
    await database.close()
  `)

  expect(result.claimed).toHaveLength(1)
  expect(result.claimed[0]).toMatchObject({materializationOwner: 'worker-1', targetDirtyToken: 7})
  expect(result.staleOwnerAdvance).toBeNull()
  expect(result.staleSnapshotAdvance).toBeNull()
  expect(result.expiredAdvance).toBeNull()
  expect(result.claimedAfterHeartbeat?.targetDirtyToken).toBe(7)
  expect(result.updated).toMatchObject({
    cursorArticleId: 'article-100',
    insertedRowCount: 3,
    materializationOwner: 'worker-1',
    materializationStatus: 'running',
    targetDirtyToken: 7,
  })
  expect(result.hiddenCompletedToken).toBeNull()
  expect(result.completed).toMatchObject({
    insertedRowCount: 3,
    materializationOwner: null,
    materializationStatus: 'completed',
    targetDirtyToken: 7,
  })
  expect(result.completedToken).toBe(7)
  expect(result.failedClaim).toHaveLength(1)
  expect(result.failedClaim[0]).toMatchObject({materializationOwner: 'worker-3', targetDirtyToken: 8})
  expect(result.staleFailure).toBeNull()
  expect(result.failed).toMatchObject({
    lastError: 'insert failed',
    materializationOwner: null,
    materializationStatus: 'failed',
    targetDirtyToken: 8,
  })
})
