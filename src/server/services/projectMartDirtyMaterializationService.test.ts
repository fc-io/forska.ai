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
    'source_scope_expected_row_count',
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
    sourceScopeExpectedRowCount: null,
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

test('project-wide dirty materialization inserts scoped article state in database batches before dirty claims', () => {
  const result = runDirtyMaterializationScript<{
    articleRows: Array<{articleId: string; firstDirtyToken: number; lastDirtyToken: number}>
    dirtyClaimsAfterComplete: Array<{claimedToken: number; projectId: string}>
    dirtyClaimsBeforeComplete: Array<{claimedToken: number; projectId: string}>
    dirtyProjects: Array<{articleIds?: string[]; projectId: string}>
    firstBatch: {insertedRowCountDelta: number; isComplete: boolean}
    materializationState: ProjectMartDirtyMaterializationStateRecord | null
    secondBatch: {insertedRowCountDelta: number; isComplete: boolean}
    thirdBatch: {insertedRowCountDelta: number; isComplete: boolean}
  }>(`
    const {getProjectMartDirtyMaterializationService} = await import(
      './src/server/services/projectMartDirtyMaterializationService.ts'
    )
    const {getProjectMartDirtyRefreshStateService} = await import(
      './src/server/services/projectMartDirtyRefreshStateService.ts'
    )
    const materializationService = getProjectMartDirtyMaterializationService()
    const refreshStateService = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES
        ('dirty-materialization-article-1', 'external-1', 'Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('dirty-materialization-article-2', 'external-2', 'Article 2', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z'),
        ('dirty-materialization-article-3', 'external-3', 'Article 3', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T01:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('dirty-materialization-project-article-1', 'dirty-materialization-project', 'dirty-materialization-article-1'),
        ('dirty-materialization-project-article-2', 'dirty-materialization-project', 'dirty-materialization-article-2')
    \`)
    await database.run(\`
      INSERT INTO mart.project_scope_article (
        project_id,
        article_id,
        in_curated_scope,
        in_route_scope,
        article_created_at,
        article_updated_at
      ) VALUES (
        'dirty-materialization-project',
        'dirty-materialization-article-3',
        TRUE,
        FALSE,
        TIMESTAMPTZ '2026-04-03T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-03T01:00:00.000Z'
      )
    \`)

    const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(database, [
      'dirty-materialization-project',
    ])
    const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({
      projects: dirtyProjects,
      reason: 'project-wide-materialization-test',
      runner: database,
      now: new Date('2026-04-04T10:00:00.000Z'),
    })
    const sourceSnapshot = await materializationService.getProjectScopeDirtyMaterializationSnapshot({
      projectId: 'dirty-materialization-project',
      runner: database,
    })
    await materializationService.queueDirtyMaterialization({
      ...sourceSnapshot,
      projectId: 'dirty-materialization-project',
      runner: database,
      sourceKind: 'project_scope_article',
      targetDirtyToken: dirtyState.dirtyToken,
      now: new Date('2026-04-04T10:00:00.000Z'),
    })
    const [claim] = await materializationService.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'dirty-materialization-worker',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T10:00:01.000Z'),
    })
    const firstBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...claim,
      batchSize: 2,
      now: new Date('2026-04-04T10:00:02.000Z'),
    })
    const dirtyClaimsBeforeComplete = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-before-complete',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T10:00:02.500Z'),
    })
    const secondBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...claim,
      batchSize: 2,
      now: new Date('2026-04-04T10:00:03.000Z'),
    })
    const thirdBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...claim,
      batchSize: 2,
      now: new Date('2026-04-04T10:00:04.000Z'),
    })
    const dirtyClaimsAfterComplete = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-after-complete',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T10:00:04.500Z'),
    })
    const materializationState = await materializationService.getCompletedDirtyMaterializationToken({
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: dirtyState.dirtyToken,
      sourceScopeGeneration: claim.sourceScopeGeneration,
      sourceScopeHighWaterArticleCreatedAt: claim.sourceScopeHighWaterArticleCreatedAt,
      sourceScopeHighWaterArticleId: claim.sourceScopeHighWaterArticleId,
      sourceScopeFingerprint: claim.sourceScopeFingerprint,
      sourceScopeExpectedRowCount: claim.sourceScopeExpectedRowCount,
    }).then(async () => {
      const [row] = await database.queryJson(\`
        SELECT
          project_id AS projectId,
          source_kind AS sourceKind,
          CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
          cursor_article_created_at AS cursorArticleCreatedAt,
          cursor_article_id AS cursorArticleId,
          CAST(inserted_row_count AS INTEGER) AS insertedRowCount,
          CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
          source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
          source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
          source_scope_fingerprint AS sourceScopeFingerprint,
          CAST(source_scope_expected_row_count AS INTEGER) AS sourceScopeExpectedRowCount,
          materialization_status AS materializationStatus,
          materialization_owner AS materializationOwner,
          lease_expires_at AS leaseExpiresAt,
          last_started_at AS lastStartedAt,
          last_completed_at AS lastCompletedAt,
          last_failed_at AS lastFailedAt,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM app.project_mart_dirty_materialization_state
        WHERE project_id = 'dirty-materialization-project'
          AND source_kind = 'project_scope_article'
          AND target_dirty_token = \${dirtyState.dirtyToken}
        LIMIT 1
      \`)

      return row ?? null
    })
    const articleRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        CAST(first_dirty_token AS INTEGER) AS firstDirtyToken,
        CAST(last_dirty_token AS INTEGER) AS lastDirtyToken
      FROM app.project_mart_refresh_article_state
      WHERE project_id = 'dirty-materialization-project'
      ORDER BY article_id ASC
    \`)

    console.log(JSON.stringify({
      articleRows,
      dirtyClaimsAfterComplete,
      dirtyClaimsBeforeComplete,
      dirtyProjects,
      firstBatch,
      materializationState,
      secondBatch,
      thirdBatch,
    }))
    await database.close()
  `)

  expect(result.dirtyProjects).toEqual([{projectId: 'dirty-materialization-project'}])
  expect(result.firstBatch).toMatchObject({insertedRowCountDelta: 2, isComplete: false})
  expect(result.dirtyClaimsBeforeComplete).toEqual([])
  expect(result.secondBatch).toMatchObject({insertedRowCountDelta: 1, isComplete: false})
  expect(result.thirdBatch).toMatchObject({insertedRowCountDelta: 0, isComplete: true})
  expect(result.materializationState).toMatchObject({
    insertedRowCount: 3,
    materializationStatus: 'completed',
    sourceScopeExpectedRowCount: 3,
    targetDirtyToken: 1,
  })
  expect(result.articleRows).toEqual([
    {articleId: 'dirty-materialization-article-1', firstDirtyToken: 1, lastDirtyToken: 1},
    {articleId: 'dirty-materialization-article-2', firstDirtyToken: 1, lastDirtyToken: 1},
    {articleId: 'dirty-materialization-article-3', firstDirtyToken: 1, lastDirtyToken: 1},
  ])
  expect(result.dirtyClaimsAfterComplete).toHaveLength(1)
  expect(result.dirtyClaimsAfterComplete[0]).toMatchObject({
    claimedToken: 1,
    projectId: 'dirty-materialization-project',
  })
})

test('dirty project claims stay behind earlier incomplete materialization tokens', () => {
  const result = runDirtyMaterializationScript<{
    claimsAfterMaterialization: Array<{claimedToken: number; lastCompletedToken: number; projectId: string}>
    claimsBeforeMaterialization: Array<{claimedToken: number; projectId: string}>
    materializationState: ProjectMartDirtyMaterializationStateRecord | null
  }>(`
    const {getProjectMartDirtyMaterializationService} = await import(
      './src/server/services/projectMartDirtyMaterializationService.ts'
    )
    const {getProjectMartDirtyRefreshStateService} = await import(
      './src/server/services/projectMartDirtyRefreshStateService.ts'
    )
    const materializationService = getProjectMartDirtyMaterializationService()
    const refreshStateService = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES (
        'dirty-materialization-barrier-article-1',
        'barrier-external-1',
        'Barrier Article 1',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES (
        'dirty-materialization-barrier-project-article-1',
        'dirty-materialization-project',
        'dirty-materialization-barrier-article-1'
      )
    \`)

    const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({
      projects: [{projectId: 'dirty-materialization-project'}],
      reason: 'project-wide-materialization-barrier-test',
      now: new Date('2026-04-04T12:00:00.000Z'),
    })
    const sourceSnapshot = await materializationService.getProjectScopeDirtyMaterializationSnapshot({
      projectId: 'dirty-materialization-project',
    })
    await materializationService.queueDirtyMaterialization({
      ...sourceSnapshot,
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: dirtyState.dirtyToken,
      now: new Date('2026-04-04T12:00:00.000Z'),
    })
    await refreshStateService.markProjectsDirtyAtomically({
      projects: [{
        projectId: 'dirty-materialization-project',
        articleIds: ['dirty-materialization-barrier-article-1'],
      }],
      reason: 'article-dirty-after-materialization-barrier',
      now: new Date('2026-04-04T12:00:01.000Z'),
    })

    const claimsBeforeMaterialization = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-before-barrier',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T12:00:02.000Z'),
    })
    const [materializationClaim] = await materializationService.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'dirty-materialization-worker',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T12:00:03.000Z'),
    })
    await materializationService.materializeProjectScopeDirtyBatch({
      ...materializationClaim,
      batchSize: 5,
      now: new Date('2026-04-04T12:00:04.000Z'),
    })
    const finalMaterializationBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...materializationClaim,
      batchSize: 5,
      now: new Date('2026-04-04T12:00:05.000Z'),
    })
    const claimsAfterMaterialization = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-after-barrier',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T12:00:06.000Z'),
    })

    console.log(JSON.stringify({
      claimsAfterMaterialization,
      claimsBeforeMaterialization,
      materializationState: finalMaterializationBatch.materializationState,
    }))
    await database.close()
  `)

  expect(result.claimsBeforeMaterialization).toEqual([])
  expect(result.materializationState).toMatchObject({
    materializationStatus: 'completed',
    sourceScopeExpectedRowCount: 1,
    targetDirtyToken: 1,
  })
  expect(result.claimsAfterMaterialization).toHaveLength(1)
  expect(result.claimsAfterMaterialization[0]).toMatchObject({
    claimedToken: 2,
    lastCompletedToken: 0,
    projectId: 'dirty-materialization-project',
  })
})

test('project-wide dirty materialization requeues with a fresh snapshot when the source fingerprint changes', () => {
  const result = runDirtyMaterializationScript<{
    claimAfterMutation: Array<{claimedToken: number; projectId: string}>
    materializationState: ProjectMartDirtyMaterializationStateRecord | null
    reclaimed: Array<{materializationOwner: string; targetDirtyToken: number}>
    finalBatch: {insertedRowCountDelta: number; isComplete: boolean}
    retryBatch: {insertedRowCountDelta: number; isComplete: boolean}
    completedRetryBatch: {insertedRowCountDelta: number; isComplete: boolean}
    claimAfterRetry: Array<{claimedToken: number; projectId: string}>
  }>(`
    const {getProjectMartDirtyMaterializationService} = await import(
      './src/server/services/projectMartDirtyMaterializationService.ts'
    )
    const {getProjectMartDirtyRefreshStateService} = await import(
      './src/server/services/projectMartDirtyRefreshStateService.ts'
    )
    const materializationService = getProjectMartDirtyMaterializationService()
    const refreshStateService = getProjectMartDirtyRefreshStateService()

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES
        ('dirty-materialization-fingerprint-article-1', 'fingerprint-external-1', 'Fingerprint Article 1', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T01:00:00.000Z'),
        ('dirty-materialization-fingerprint-article-2', 'fingerprint-external-2', 'Fingerprint Article 2', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T01:00:00.000Z')
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('dirty-materialization-fingerprint-project-article-1', 'dirty-materialization-project', 'dirty-materialization-fingerprint-article-1')
    \`)

    const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({
      projects: [{projectId: 'dirty-materialization-project'}],
      reason: 'project-wide-materialization-fingerprint-test',
      now: new Date('2026-04-04T11:00:00.000Z'),
    })
    const sourceSnapshot = await materializationService.getProjectScopeDirtyMaterializationSnapshot({
      projectId: 'dirty-materialization-project',
    })
    await materializationService.queueDirtyMaterialization({
      ...sourceSnapshot,
      projectId: 'dirty-materialization-project',
      sourceKind: 'project_scope_article',
      targetDirtyToken: dirtyState.dirtyToken,
      now: new Date('2026-04-04T11:00:00.000Z'),
    })
    const [claim] = await materializationService.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'dirty-materialization-worker',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T11:00:01.000Z'),
    })

    await materializationService.materializeProjectScopeDirtyBatch({
      ...claim,
      batchSize: 1,
      now: new Date('2026-04-04T11:00:02.000Z'),
    })
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('dirty-materialization-fingerprint-project-article-2', 'dirty-materialization-project', 'dirty-materialization-fingerprint-article-2')
    \`)
    const finalBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...claim,
      batchSize: 1,
      now: new Date('2026-04-04T11:00:03.000Z'),
    })
    const claimAfterMutation = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-after-mutation',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T11:00:04.000Z'),
    })
    const reclaimed = await materializationService.claimDirtyMaterializations({
      sourceKind: 'project_scope_article',
      workerId: 'dirty-materialization-worker-retry',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T11:00:05.000Z'),
    })
    const retryBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...reclaimed[0],
      batchSize: 2,
      now: new Date('2026-04-04T11:00:06.000Z'),
    })
    const completedRetryBatch = await materializationService.materializeProjectScopeDirtyBatch({
      ...reclaimed[0],
      batchSize: 2,
      now: new Date('2026-04-04T11:00:07.000Z'),
    })
    const claimAfterRetry = await refreshStateService.claimDirtyProjects({
      workerId: 'refresh-worker-after-retry',
      limit: 1,
      leaseMs: 5000,
      now: new Date('2026-04-04T11:00:08.000Z'),
    })
    const [materializationState] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        source_kind AS sourceKind,
        CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
        cursor_article_created_at AS cursorArticleCreatedAt,
        cursor_article_id AS cursorArticleId,
        CAST(inserted_row_count AS INTEGER) AS insertedRowCount,
        CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
        source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
        source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
        source_scope_fingerprint AS sourceScopeFingerprint,
        CAST(source_scope_expected_row_count AS INTEGER) AS sourceScopeExpectedRowCount,
        materialization_status AS materializationStatus,
        materialization_owner AS materializationOwner,
        lease_expires_at AS leaseExpiresAt,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_dirty_materialization_state
      WHERE project_id = 'dirty-materialization-project'
        AND source_kind = 'project_scope_article'
        AND target_dirty_token = \${dirtyState.dirtyToken}
      LIMIT 1
    \`)

    console.log(JSON.stringify({
      claimAfterMutation,
      claimAfterRetry,
      completedRetryBatch,
      finalBatch,
      materializationState,
      reclaimed,
      retryBatch,
    }))
    await database.close()
  `)

  expect(result.finalBatch).toMatchObject({insertedRowCountDelta: 0, isComplete: false})
  expect(result.reclaimed).toMatchObject([
    {materializationOwner: 'dirty-materialization-worker-retry', targetDirtyToken: 1},
  ])
  expect(result.retryBatch).toMatchObject({insertedRowCountDelta: 2, isComplete: false})
  expect(result.completedRetryBatch).toMatchObject({insertedRowCountDelta: 0, isComplete: true})
  expect(result.materializationState).toMatchObject({
    lastError: null,
    materializationStatus: 'completed',
    sourceScopeExpectedRowCount: 2,
    targetDirtyToken: 1,
  })
  expect(result.claimAfterMutation).toEqual([])
  expect(result.claimAfterRetry).toMatchObject([
    {claimedToken: 1, lastCompletedToken: 0, projectId: 'dirty-materialization-project'},
  ])
})
