import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39213',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39923',
}

const getLastJsonLine = (output: string) => {
  const [lastLine = ''] = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })
    .slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${output}`)
  }

  return lastLine
}

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
}

const runCutoverScript = <T>(body: string) => {
  const duckdbPath = join(
    projectRoot,
    '.tmp',
    `rebuild2-cutover-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`,
  )

  removePathIfExists(dirname(duckdbPath))

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {runRebuild2Cutover} = await import('./scripts/rebuild2Cutover.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        ${body}
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'rebuild2 cutover test failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removePathIfExists(dirname(duckdbPath))
    removePathIfExists('/tmp/duckdb-temp')
  }
}

test('package exposes the rebuild2 cutover command', async () => {
  const packageJson = (await Bun.file(join(projectRoot, 'package.json')).json()) as {scripts: Record<string, string>}

  expect(packageJson.scripts['db:duck:rebuild2-cutover']).toBe(
    'SERVER_ROLE=maintenance-worker SERVER_DUCKDB_OWNER_URL= bun scripts/rebuild2Cutover.ts',
  )
})

test('rebuild2 cutover clears obsolete state and rederives replacement work under the owner token', () => {
  const result = runCutoverScript<{
    counts: {
      largeRebuildRows: number
      maintenanceLeases: number
      materializationRows: number
      outboxImportRows: number
      queueRows: number
      quarantineRows: number
      refreshArticleRows: number
      refreshRows: number
    }
    fence: {ownerToken: string; status: string}
    largeRebuild: {refreshStatus: string; refreshToken: number}
    materialization: {materializationStatus: string; owner: string | null; targetDirtyToken: number}
    refreshState: {
      dirtyToken: number
      lastCompletedDirtyToken: number
      refreshStatus: string
      requestedBy: string
      workerId: string | null
    }
    report: {
      afterClearProof: {martRefreshQueueRows: number; nonCutoverRefreshRows: number}
      beforeProof: {martRefreshQueueRows: number; nonCutoverRefreshRows: number; quarantineRows: number}
      cutoverOwnerToken: string
      largeRebuildProjectIds: string[]
      pausedWorkerState: {dirtyMaterializationRows: number; largeRebuildRows: number; refreshRows: number}
      rederivedDirtyProjectCount: number
    }
  }>(`
    const ownerToken = 'test-rebuild2-cutover-owner'

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('rebuild2-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('rebuild2-model', 'rebuild2-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('rebuild2-project', 'Rebuild2 Project', 'rebuild2-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
      VALUES (
        'rebuild2-article',
        'rebuild2-external-article',
        'Rebuild2 Article',
        TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
        TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES ('rebuild2-project-article', 'rebuild2-project', 'rebuild2-article')
    \`)
    await database.run(\`
      CREATE TABLE app.mart_refresh_queue (
        id VARCHAR PRIMARY KEY,
        refresh_scope VARCHAR NOT NULL,
        project_id VARCHAR,
        article_id VARCHAR,
        project_key VARCHAR NOT NULL DEFAULT '',
        article_key VARCHAR NOT NULL DEFAULT '',
        refresh_generation BIGINT NOT NULL DEFAULT 0,
        reason VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        UNIQUE(refresh_scope, project_key, article_key)
      )
    \`)
    await database.run(\`
      CREATE INDEX idx_app_mart_refresh_queue_created_at ON app.mart_refresh_queue(created_at)
    \`)
    await database.run(\`
      INSERT INTO app.mart_refresh_queue (
        id,
        refresh_scope,
        project_id,
        article_id,
        project_key,
        article_key,
        reason
      ) VALUES (
        'rebuild2-queue',
        'judgment_article',
        'rebuild2-project',
        'rebuild2-article',
        'rebuild2-project',
        'rebuild2-article',
        'legacy'
      )
    \`)
    await database.run(\`
      INSERT INTO app.mart_refresh_queue (
        id,
        refresh_scope,
        article_id,
        article_key,
        reason
      ) VALUES (
        'rebuild2-non-project-queue',
        'judgment_article',
        'rebuild2-non-project-article',
        'rebuild2-non-project-article',
        'legacy-non-project'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        active_dirty_token,
        last_completed_dirty_token,
        requested_by,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'rebuild2-project',
        5,
        5,
        2,
        'legacy-worker',
        'running',
        'legacy-refresh-worker',
        TIMESTAMPTZ '2036-04-01T00:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_article_state (
        project_id,
        article_id,
        first_dirty_token,
        last_dirty_token
      ) VALUES (
        'rebuild2-project',
        'rebuild2-article',
        3,
        5
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        materialization_status,
        materialization_owner,
        lease_expires_at
      ) VALUES (
        'rebuild2-project',
        'project_scope_article',
        5,
        'running',
        'legacy-materializer',
        TIMESTAMPTZ '2036-04-01T00:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_large_rebuild_state (
        project_id,
        refresh_token,
        rebuild_phase,
        refresh_status,
        worker_id,
        lease_expires_at
      ) VALUES (
        'rebuild2-project',
        5,
        'project_scope_article',
        'running',
        'legacy-large-rebuild-worker',
        TIMESTAMPTZ '2036-04-01T00:00:00.000Z'
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_article_quarantine (
        project_id,
        article_id,
        dirty_token,
        error,
        detected_by
      ) VALUES (
        'rebuild2-project',
        'rebuild2-article',
        5,
        'legacy quarantine',
        'legacy-worker'
      )
    \`)
    await database.run(\`
      INSERT INTO app.judgment_job_sqlite_outbox_import (
        job_id,
        outbox_seq,
        queue_prompt_id,
        judgment_id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        import_status
      ) VALUES (
        'rebuild2-job',
        1,
        'rebuild2-queue-prompt',
        'rebuild2-judgment',
        'rebuild2-article',
        'rebuild2-prompt',
        'rebuild2-model',
        'rebuild2-project',
        'imported'
      )
    \`)
    await database.run(\`
      INSERT INTO app.maintenance_work_lease (
        id,
        work_kind,
        scope_kind,
        project_id,
        required_consumer_role,
        consumer_id,
        lease_expires_at,
        fresh_until_at
      ) VALUES (
        'rebuild2-expired-lease',
        'review_index_project_refresh',
        'project',
        'rebuild2-project',
        'maintenance-worker',
        'legacy-refresh-worker',
        TIMESTAMPTZ '2026-01-01T00:00:00.000Z',
        TIMESTAMPTZ '2026-01-01T00:00:00.000Z'
      )
    \`)

    const report = await runRebuild2Cutover({
      apply: true,
      fenceLeaseMs: 60000,
      help: false,
      maxWaitMs: 1000,
      ownerToken,
      pollMs: 5,
    })
    const [refreshState] = await database.queryJson(\`
      SELECT
        CAST(dirty_token AS INTEGER) AS dirtyToken,
        CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
        refresh_status AS refreshStatus,
        requested_by AS requestedBy,
        worker_id AS workerId
      FROM app.project_mart_refresh_state
      WHERE project_id = 'rebuild2-project'
    \`)
    const [materialization] = await database.queryJson(\`
      SELECT
        CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
        materialization_status AS materializationStatus,
        materialization_owner AS owner
      FROM app.project_mart_dirty_materialization_state
      WHERE project_id = 'rebuild2-project'
    \`)
    const [largeRebuild] = await database.queryJson(\`
      SELECT
        CAST(refresh_token AS INTEGER) AS refreshToken,
        refresh_status AS refreshStatus
      FROM app.project_mart_large_rebuild_state
      WHERE project_id = 'rebuild2-project'
    \`)
    const [fence] = await database.queryJson(\`
      SELECT owner_token AS ownerToken, status
      FROM app.rebuild2_cutover_fence
      WHERE id = 'rebuild2'
    \`)
    const [counts] = await database.queryJson(\`
      SELECT
        CAST((SELECT COUNT(*) FROM app.mart_refresh_queue) AS INTEGER) AS queueRows,
        CAST((SELECT COUNT(*) FROM app.project_mart_refresh_state) AS INTEGER) AS refreshRows,
        CAST((SELECT COUNT(*) FROM app.project_mart_refresh_article_state) AS INTEGER) AS refreshArticleRows,
        CAST((SELECT COUNT(*) FROM app.project_mart_dirty_materialization_state) AS INTEGER) AS materializationRows,
        CAST((SELECT COUNT(*) FROM app.project_mart_large_rebuild_state) AS INTEGER) AS largeRebuildRows,
        CAST((SELECT COUNT(*) FROM app.project_mart_refresh_article_quarantine) AS INTEGER) AS quarantineRows,
        CAST((SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import) AS INTEGER) AS outboxImportRows,
        CAST((SELECT COUNT(*) FROM app.maintenance_work_lease) AS INTEGER) AS maintenanceLeases
    \`)

    console.log(JSON.stringify({counts, fence, largeRebuild, materialization, refreshState, report}))
  `)

  expect(result.report.beforeProof).toMatchObject({
    martRefreshQueueRows: 2,
    nonCutoverRefreshRows: 1,
    quarantineRows: 1,
  })
  expect(result.report.afterClearProof).toMatchObject({martRefreshQueueRows: 0, nonCutoverRefreshRows: 0})
  expect(result.report.pausedWorkerState).toEqual({dirtyMaterializationRows: 1, largeRebuildRows: 1, refreshRows: 1})
  expect(result.report.cutoverOwnerToken).toBe('test-rebuild2-cutover-owner')
  expect(result.report.rederivedDirtyProjectCount).toBe(1)
  expect(result.report.largeRebuildProjectIds).toEqual(['rebuild2-project'])
  expect(result.counts).toEqual({
    largeRebuildRows: 1,
    maintenanceLeases: 0,
    materializationRows: 1,
    outboxImportRows: 0,
    queueRows: 0,
    quarantineRows: 0,
    refreshArticleRows: 0,
    refreshRows: 1,
  })
  expect(result.refreshState).toEqual({
    dirtyToken: 1,
    lastCompletedDirtyToken: 0,
    refreshStatus: 'idle',
    requestedBy: 'test-rebuild2-cutover-owner',
    workerId: null,
  })
  expect(result.materialization).toMatchObject({materializationStatus: 'pending', owner: null, targetDirtyToken: 1})
  expect(result.largeRebuild).toEqual({refreshStatus: 'idle', refreshToken: 1})
  expect(result.fence).toEqual({ownerToken: 'test-rebuild2-cutover-owner', status: 'completed'})
})

test('rebuild2 cutover waits for active maintenance leases to expire before clearing', () => {
  const result = runCutoverScript<{
    elapsedMs: number
    leaseCount: number
    report: {beforeProof: {freshMaintenanceLeaseRows: number}; rederivedDirtyProjectCount: number}
  }>(`
    const leaseExpiresAt = new Date(Date.now() + 100).toISOString()

    await database.run(\`
      INSERT INTO app.maintenance_work_lease (
        id,
        work_kind,
        scope_kind,
        required_consumer_role,
        consumer_id,
        lease_expires_at,
        fresh_until_at
      ) VALUES (
        'rebuild2-active-lease',
        'review_index_project_refresh',
        'queue',
        'maintenance-worker',
        'active-worker',
        TIMESTAMPTZ '\${leaseExpiresAt}',
        TIMESTAMPTZ '\${leaseExpiresAt}'
      )
    \`)

    const startedAt = Date.now()
    const report = await runRebuild2Cutover({
      apply: true,
      fenceLeaseMs: 60000,
      help: false,
      maxWaitMs: 2000,
      ownerToken: 'test-rebuild2-wait-owner',
      pollMs: 5,
    })
    const elapsedMs = Date.now() - startedAt
    const [counts] = await database.queryJson(\`
      SELECT COUNT(*) AS leaseCount
      FROM app.maintenance_work_lease
    \`)

    console.log(JSON.stringify({elapsedMs, leaseCount: Number(counts.leaseCount), report}))
  `)

  expect(result.report.beforeProof.freshMaintenanceLeaseRows).toBe(1)
  expect(result.report.rederivedDirtyProjectCount).toBe(0)
  expect(result.leaseCount).toBe(0)
  expect(result.elapsedMs).toBeGreaterThanOrEqual(50)
})
