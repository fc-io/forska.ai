import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import type {ProjectMartLargeRebuildStateRecord} from '../../db/schemaTypes.ts'

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

const getScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectMartLargeRebuildStateService} = await import('./src/server/services/projectMartLargeRebuildStateService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const service = getProjectMartLargeRebuildStateService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('large-rebuild-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('large-rebuild-model', 'large-rebuild-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        ('large-rebuild-project-1', 'Large Rebuild Project 1', 'large-rebuild-model', TRUE, TRUE, FALSE, FALSE),
        ('large-rebuild-project-2', 'Large Rebuild Project 2', 'large-rebuild-model', TRUE, TRUE, FALSE, FALSE)
    \`)

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-project-mart-large-rebuild-state-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
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
    if (runResult.exitCode !== 0) {
      throw new Error(runResult.stderr.toString() || runResult.stdout.toString() || 'Large rebuild state test failed')
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('large rebuild state migration creates typed schema and indexes', () => {
  const result = runScript<{columns: Array<{columnName: string}>; indexes: Array<{indexName: string}>}>(`
    const columns = await database.queryJson(\`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'project_mart_large_rebuild_state'
      ORDER BY ordinal_position
    \`)
    const indexes = await database.queryJson(\`
      SELECT index_name AS indexName
      FROM duckdb_indexes()
      WHERE schema_name = 'app'
        AND table_name = 'project_mart_large_rebuild_state'
      ORDER BY index_name
    \`)

    console.log(JSON.stringify({columns, indexes}))
    await database.close()
  `)

  expect(
    result.columns.map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'project_id',
    'refresh_token',
    'rebuild_phase',
    'cursor_article_created_at',
    'cursor_article_id',
    'target_generation',
    'refresh_status',
    'last_started_at',
    'last_completed_at',
    'last_failed_at',
    'last_error',
    'operator_note',
    'worker_id',
    'lease_expires_at',
    'created_at',
    'updated_at',
    'source_dirty_token',
    'source_high_water_dirty_token',
    'superseded_at',
  ])
  expect(
    result.indexes.map((index) => {
      return index.indexName
    }),
  ).toEqual([
    'idx_app_project_mart_large_rebuild_state_claim',
    'idx_app_project_mart_large_rebuild_state_current',
    'idx_app_project_mart_large_rebuild_state_stale_work',
  ])
})

test('requestLargeRebuild creates and resets requested rebuild state', () => {
  const result = runScript<{row: ProjectMartLargeRebuildStateRecord}>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:00:00.000Z'),
      cursorArticleId: 'article-1',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 7,
      targetGeneration: 3,
    })

    const [row] = await database.queryJson(\`
      SELECT
        project_id AS projectId,
        CAST(refresh_token AS INTEGER) AS refreshToken,
        rebuild_phase AS rebuildPhase,
        cursor_article_created_at AS cursorArticleCreatedAt,
        cursor_article_id AS cursorArticleId,
        CAST(target_generation AS INTEGER) AS targetGeneration,
        refresh_status AS refreshStatus,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project_mart_large_rebuild_state
      WHERE project_id = 'large-rebuild-project-1'
      LIMIT 1
    \`)

    console.log(JSON.stringify({row}))
    await database.close()
  `)

  expect(result.row.projectId).toBe('large-rebuild-project-1')
  expect(result.row.refreshToken).toBe(7)
  expect(result.row.rebuildPhase).toBe('prompt_answer_fact')
  expect(result.row.cursorArticleId).toBe('article-1')
  expect(result.row.targetGeneration).toBe(3)
  expect(result.row.refreshStatus).toBe('idle')
  expect(result.row.lastError).toBeNull()
})

test('requestLargeRebuild preserves active work when another rebuild is already requested', () => {
  const result = runScript<{
    row: {
      cursorArticleCreatedAt: string | null
      cursorArticleId: string | null
      rebuildPhase: string
      refreshToken: number
    } | null
  }>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:00:00.000Z'),
      cursorArticleId: 'article-1',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 7,
    })
    await service.claimLargeRebuilds({leaseMs: 5000, limit: 1, workerId: 'worker-1'})
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 11,
    })

    console.log(JSON.stringify({row: await service.getLargeRebuildState('large-rebuild-project-1')}))
    await database.close()
  `)

  expect(result.row?.refreshToken).toBe(7)
  expect(result.row?.rebuildPhase).toBe('prompt_answer_fact')
  expect(result.row?.cursorArticleId).toBe('article-1')
  expect(new Date(result.row?.cursorArticleCreatedAt ?? '').toISOString()).toBe('2026-04-03T08:00:00.000Z')
})

test('requestLargeRebuild supersedes idle requested work with a newer rebuild token', () => {
  const result = runScript<{row: {rebuildPhase: string; refreshToken: number} | null}>(`
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'judgment_fact',
      refreshToken: 7,
    })
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_article_serving',
      refreshToken: 11,
      targetGeneration: 4,
    })

    console.log(JSON.stringify({row: await service.getLargeRebuildState('large-rebuild-project-1')}))
    await database.close()
  `)

  expect(result.row?.refreshToken).toBe(11)
  expect(result.row?.rebuildPhase).toBe('review_article_serving')
})

test('requestLargeRebuild clears completed target generation for the next rebuild', () => {
  const result = runScript<{completedTargetGeneration: number | null; requestedTargetGeneration: number | null}>(`
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_article_serving',
      refreshToken: 7,
      targetGeneration: 3,
    })
    await service.claimLargeRebuilds({leaseMs: 5000, limit: 1, workerId: 'worker-1'})
    const completed = await service.completeLargeRebuild({
      projectId: 'large-rebuild-project-1',
      workerId: 'worker-1',
    })
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'project_scope_article',
      refreshToken: 8,
    })
    const requested = await service.getLargeRebuildState('large-rebuild-project-1')

    console.log(JSON.stringify({
      completedTargetGeneration: completed?.targetGeneration ?? null,
      requestedTargetGeneration: requested?.targetGeneration ?? null,
    }))
    await database.close()
  `)

  expect(result.completedTargetGeneration).toBeNull()
  expect(result.requestedTargetGeneration).toBeNull()
})

test('requestLargeRebuild does not rewind active work when requested again into a new phase', () => {
  const result = runScript<{
    row: {
      cursorArticleCreatedAt: string | null
      cursorArticleId: string | null
      rebuildPhase: string
      refreshToken: number
    } | null
  }>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:00:00.000Z'),
      cursorArticleId: 'article-1',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 7,
    })
    await service.claimLargeRebuilds({leaseMs: 5000, limit: 1, workerId: 'worker-1'})
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_article_filter_member',
      refreshToken: 11,
    })

    console.log(JSON.stringify({row: await service.getLargeRebuildState('large-rebuild-project-1')}))
    await database.close()
  `)

  expect(result.row?.refreshToken).toBe(7)
  expect(result.row?.rebuildPhase).toBe('prompt_answer_fact')
  expect(result.row?.cursorArticleId).toBe('article-1')
  expect(new Date(result.row?.cursorArticleCreatedAt ?? '').toISOString()).toBe('2026-04-03T08:00:00.000Z')
})

test('ensureLargeRebuildTargetGeneration initializes once from the next serving generation', () => {
  const result = runScript<{
    initializedTargetGeneration: number | null
    preservedTargetGeneration: number | null
    servingGenerationRows: Array<{activeGeneration: number}>
  }>(`
    await database.run(\`
      INSERT INTO app.project_review_serving_generation (project_id, active_generation)
      VALUES ('large-rebuild-project-1', 4)
    \`)
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_article_filter_member',
      refreshToken: 7,
    })

    const initialized = await service.ensureLargeRebuildTargetGeneration({
      projectId: 'large-rebuild-project-1',
    })
    await database.run(\`
      UPDATE app.project_review_serving_generation
      SET active_generation = 9
      WHERE project_id = 'large-rebuild-project-1'
    \`)
    const preserved = await service.ensureLargeRebuildTargetGeneration({
      projectId: 'large-rebuild-project-1',
    })
    const servingGenerationRows = await database.queryJson(\`
      SELECT CAST(active_generation AS INTEGER) AS activeGeneration
      FROM app.project_review_serving_generation
      WHERE project_id = 'large-rebuild-project-1'
    \`)

    console.log(JSON.stringify({
      initializedTargetGeneration: initialized?.targetGeneration ?? null,
      preservedTargetGeneration: preserved?.targetGeneration ?? null,
      servingGenerationRows,
    }))
    await database.close()
  `)

  expect(result.initializedTargetGeneration).toBe(5)
  expect(result.preservedTargetGeneration).toBe(5)
  expect(result.servingGenerationRows).toEqual([{activeGeneration: 9}])
})

test('claim heartbeat complete fail and reset large rebuild state', () => {
  const result = runScript<{
    claimed: Array<{projectId: string; rebuildPhase: string; refreshToken: number; workerId: string}>
    completed: ProjectMartLargeRebuildStateRecord | null
    failed: ProjectMartLargeRebuildStateRecord | null
    heartbeated: {leaseExpiresAt: string; projectId: string} | null
    reset: ProjectMartLargeRebuildStateRecord | null
  }>(`
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'judgment_fact',
      refreshToken: 5,
    })
    await service.requestLargeRebuild({
      projectId: 'large-rebuild-project-2',
      rebuildPhase: 'review_article_rollup',
      refreshToken: 9,
    })

    const claimed = await service.claimLargeRebuilds({leaseMs: 5000, limit: 2, workerId: 'worker-1'})
    const heartbeated = await service.heartbeatLargeRebuildClaim({
      leaseMs: 5000,
      projectId: 'large-rebuild-project-1',
      workerId: 'worker-1',
    })
    const completed = await service.completeLargeRebuild({projectId: 'large-rebuild-project-1', workerId: 'worker-1'})
    const failed = await service.failLargeRebuild({
      error: 'phase crashed',
      projectId: 'large-rebuild-project-2',
      workerId: 'worker-1',
    })
    const reset = await service.resetLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T09:00:00.000Z'),
      cursorArticleId: 'article-99',
      projectId: 'large-rebuild-project-2',
      rebuildPhase: 'review_article_serving',
      targetGeneration: 12,
    })

    console.log(JSON.stringify({claimed, completed, failed, heartbeated, reset}))
    await database.close()
  `)

  expect(result.claimed).toHaveLength(2)
  expect(
    result.claimed.map((row) => {
      return row.projectId
    }),
  ).toEqual(['large-rebuild-project-1', 'large-rebuild-project-2'])
  expect(result.heartbeated?.projectId).toBe('large-rebuild-project-1')
  expect(result.completed?.projectId).toBe('large-rebuild-project-1')
  expect(result.completed?.refreshToken).toBe(0)
  expect(result.completed?.refreshStatus).toBe('idle')
  expect(result.completed?.cursorArticleId).toBeNull()
  expect(result.failed?.projectId).toBe('large-rebuild-project-2')
  expect(result.failed?.refreshStatus).toBe('failed')
  expect(result.failed?.lastError).toBe('phase crashed')
  expect(result.reset?.projectId).toBe('large-rebuild-project-2')
  expect(result.reset?.refreshStatus).toBe('idle')
  expect(result.reset?.rebuildPhase).toBe('review_article_serving')
  expect(result.reset?.cursorArticleId).toBe('article-99')
  expect(result.reset?.targetGeneration).toBe(12)
  expect(result.reset?.lastError).toBeNull()
})

test('claimLargeRebuilds preserves target generation across expired lease resume', () => {
  const result = runScript<{
    firstClaim: Array<{projectId: string; targetGeneration: number | null; workerId: string}>
    resumedClaim: Array<{projectId: string; targetGeneration: number | null; workerId: string}>
    row: {targetGeneration: number | null; workerId: string | null} | null
  }>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:00:00.000Z'),
      cursorArticleId: 'article-1',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_article_filter_member',
      refreshToken: 7,
      targetGeneration: 13,
    })

    const firstClaim = await service.claimLargeRebuilds({
      leaseMs: 1000,
      limit: 1,
      now: new Date('2026-04-03T09:00:00.000Z'),
      workerId: 'worker-1',
    })
    const resumedClaim = await service.claimLargeRebuilds({
      leaseMs: 1000,
      limit: 1,
      now: new Date('2026-04-03T09:00:02.000Z'),
      workerId: 'worker-2',
    })
    const row = await service.getLargeRebuildState('large-rebuild-project-1')

    console.log(JSON.stringify({firstClaim, resumedClaim, row}))
    await database.close()
  `)

  expect(result.firstClaim).toMatchObject([
    {projectId: 'large-rebuild-project-1', targetGeneration: 13, workerId: 'worker-1'},
  ])
  expect(result.resumedClaim).toMatchObject([
    {projectId: 'large-rebuild-project-1', targetGeneration: 13, workerId: 'worker-2'},
  ])
  expect(result.row?.targetGeneration).toBe(13)
  expect(result.row?.workerId).toBe('worker-2')
})

test('resetLargeRebuild succeeds after lease expiry when the claim was not transferred', () => {
  const result = runScript<{
    reset: {cursorArticleId: string | null; projectId: string; rebuildPhase: string; refreshStatus: string} | null
  }>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:00:00.000Z'),
      cursorArticleId: 'article-1',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'review_answer_dictionary',
      refreshToken: 7,
      targetGeneration: 13,
    })

    const [claim] = await service.claimLargeRebuilds({
      leaseMs: 1000,
      limit: 1,
      now: new Date('2026-04-03T09:00:00.000Z'),
      workerId: 'worker-1',
    })

    const reset = await service.resetLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-03T08:01:00.000Z'),
      cursorArticleId: 'article-2',
      expectedRebuildPhase: claim.rebuildPhase,
      expectedRefreshToken: claim.refreshToken,
      expectedTargetGeneration: claim.targetGeneration,
      now: new Date('2026-04-03T09:00:02.000Z'),
      projectId: claim.projectId,
      rebuildPhase: 'review_article_filter_member',
      targetGeneration: claim.targetGeneration,
      workerId: claim.workerId,
    })

    console.log(JSON.stringify({reset}))
    await database.close()
  `)

  expect(result.reset?.projectId).toBe('large-rebuild-project-1')
  expect(result.reset?.refreshStatus).toBe('idle')
  expect(result.reset?.rebuildPhase).toBe('review_article_filter_member')
  expect(result.reset?.cursorArticleId).toBe('article-2')
})

test('claimLargeRebuilds rotates to less recently started work instead of starving other projects', () => {
  const result = runScript<{firstClaim: Array<{projectId: string}>; secondClaim: Array<{projectId: string}>}>(`
    await service.requestLargeRebuild({projectId: 'large-rebuild-project-1', rebuildPhase: 'prompt_answer_fact', refreshToken: 1})
    await service.requestLargeRebuild({projectId: 'large-rebuild-project-2', rebuildPhase: 'prompt_answer_fact', refreshToken: 99})

    const firstClaim = await service.claimLargeRebuilds({leaseMs: 5000, limit: 1, workerId: 'worker-1'})
    await service.resetLargeRebuild({projectId: 'large-rebuild-project-1', rebuildPhase: 'prompt_answer_fact'})
    const secondClaim = await service.claimLargeRebuilds({leaseMs: 5000, limit: 1, workerId: 'worker-2'})

    console.log(JSON.stringify({
      firstClaim: firstClaim.map((claim) => ({projectId: claim.projectId})),
      secondClaim: secondClaim.map((claim) => ({projectId: claim.projectId})),
    }))
    await database.close()
  `)

  expect(result.firstClaim).toEqual([{projectId: 'large-rebuild-project-1'}])
  expect(result.secondClaim).toEqual([{projectId: 'large-rebuild-project-2'}])
})

test('clearArchivedLargeRebuildStates removes archived rebuild debt and claimLargeRebuilds skips archived projects', () => {
  const result = runScript<{archivedRows: number; claims: Array<{projectId: string}>}>(`
    await database.run(\`
      UPDATE app.project
      SET archived = TRUE
      WHERE id = 'large-rebuild-project-2'
    \`)
    await service.requestLargeRebuild({projectId: 'large-rebuild-project-1', rebuildPhase: 'judgment_fact', refreshToken: 5})
    await service.requestLargeRebuild({projectId: 'large-rebuild-project-2', rebuildPhase: 'review_article_rollup', refreshToken: 9})

    const claims = await service.claimLargeRebuilds({leaseMs: 5000, limit: 5, workerId: 'worker-1'})
    await service.clearArchivedLargeRebuildStates()
    const [archivedRow] = await database.queryJson(\`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM app.project_mart_large_rebuild_state
      WHERE project_id = 'large-rebuild-project-2'
    \`)

    console.log(JSON.stringify({
      archivedRows: archivedRow?.rowCount ?? 0,
      claims: claims.map((claim) => ({projectId: claim.projectId})),
    }))
    await database.close()
  `)

  expect(result.claims).toEqual([{projectId: 'large-rebuild-project-1'}])
  expect(result.archivedRows).toBe(0)
})

test('pauseLargeRebuild and resumeLargeRebuild preserve cursor state and exclude paused rows from claims', () => {
  const result = runScript<{
    claimsWhilePaused: Array<{projectId: string}>
    paused: {cursorArticleId: string | null; lastError: string | null; refreshStatus: string} | null
    resumed: {cursorArticleId: string | null; refreshStatus: string} | null
  }>(`
    await service.requestLargeRebuild({
      cursorArticleCreatedAt: new Date('2026-04-04T08:00:00.000Z'),
      cursorArticleId: 'article-paused',
      projectId: 'large-rebuild-project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 11,
    })
    const paused = await service.pauseLargeRebuild({projectId: 'large-rebuild-project-1', reason: 'Paused by operator for inspection'})
    const claimsWhilePaused = await service.claimLargeRebuilds({leaseMs: 5000, limit: 5, workerId: 'worker-paused'})
    const resumed = await service.resumeLargeRebuild({projectId: 'large-rebuild-project-1'})

    console.log(JSON.stringify({
      claimsWhilePaused: claimsWhilePaused.map((claim) => ({projectId: claim.projectId})),
      paused,
      resumed,
    }))
    await database.close()
  `)

  expect(result.claimsWhilePaused).toEqual([])
  expect(result.paused?.refreshStatus).toBe('paused')
  expect(result.paused?.cursorArticleId).toBe('article-paused')
  expect(result.paused?.lastError).toBe('Paused by operator for inspection')
  expect(result.resumed?.refreshStatus).toBe('idle')
  expect(result.resumed?.cursorArticleId).toBe('article-paused')
})

test('setLargeRebuildOperatorNote persists durable operator notes separately from errors', () => {
  const result = runScript<{note: string | null; lastError: string | null}>(`
    await service.requestLargeRebuild({projectId: 'large-rebuild-project-1', rebuildPhase: 'prompt_answer_fact', refreshToken: 7})
    await service.setLargeRebuildOperatorNote({projectId: 'large-rebuild-project-1', note: 'Investigating intermittent cursor stall'})
    const noteRow = await service.getLargeRebuildState('large-rebuild-project-1')

    console.log(JSON.stringify({lastError: noteRow?.lastError ?? null, note: noteRow?.operatorNote ?? null}))
    await database.close()
  `)

  expect(result.note).toBe('Investigating intermittent cursor stall')
  expect(result.lastError).toBeNull()
})
