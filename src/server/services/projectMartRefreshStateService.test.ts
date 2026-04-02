import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import type {ProjectMartRefreshStateRecord} from '../../db/schemaTypes.ts'

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

test('project mart refresh state migration creates the typed ledger schema', () => {
  const duckdbPath = `/tmp/f1-project-mart-refresh-state-${Date.now()}.duckdb`
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('refresh-state-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('refresh-state-model', 'refresh-state-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('refresh-state-project', 'Refresh State Project', 'refresh-state-model', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.project_mart_refresh_state (
            project_id,
            dirty_token,
            active_refresh_token,
            last_completed_refresh_token,
            last_request_reason,
            requested_by,
            refresh_status,
            last_started_at,
            last_completed_at,
            last_failed_at,
            last_error,
            worker_id,
            lease_expires_at
          ) VALUES (
            'refresh-state-project',
            7,
            7,
            5,
            'judgment-import',
            'worker-test',
            'running',
            TIMESTAMPTZ '2026-04-02 10:00:00+00',
            TIMESTAMPTZ '2026-04-02 10:01:00+00',
            TIMESTAMPTZ '2026-04-02 10:02:00+00',
            'transient error',
            'worker-1',
            TIMESTAMPTZ '2026-04-02 10:05:00+00'
          )
        \`)

        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'app'
            AND table_name = 'project_mart_refresh_state'
          ORDER BY ordinal_position
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'app'
            AND table_name = 'project_mart_refresh_state'
          ORDER BY index_name
        \`)
        const [row] = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            CAST(dirty_token AS INTEGER) AS dirtyToken,
            CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
            CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
            last_requested_at AS lastRequestedAt,
            last_request_reason AS lastRequestReason,
            requested_by AS requestedBy,
            refresh_status AS refreshStatus,
            last_started_at AS lastStartedAt,
            last_completed_at AS lastCompletedAt,
            last_failed_at AS lastFailedAt,
            last_error AS lastError,
            worker_id AS workerId,
            lease_expires_at AS leaseExpiresAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM app.project_mart_refresh_state
          WHERE project_id = 'refresh-state-project'
          LIMIT 1
        \`)

        console.log(JSON.stringify({columns, indexes, row}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runScript.exitCode !== 0) {
      throw new Error(
        runScript.stderr.toString() || runScript.stdout.toString() || 'Refresh state migration test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
      columns: Array<{columnName: string}>
      indexes: Array<{indexName: string}>
      row: ProjectMartRefreshStateRecord
    }

    expect(
      result.columns.map((column) => {
        return column.columnName
      }),
    ).toEqual([
      'project_id',
      'dirty_token',
      'active_refresh_token',
      'last_completed_refresh_token',
      'last_requested_at',
      'last_request_reason',
      'requested_by',
      'refresh_status',
      'last_started_at',
      'last_completed_at',
      'last_failed_at',
      'last_error',
      'worker_id',
      'lease_expires_at',
      'created_at',
      'updated_at',
    ])
    expect(
      result.indexes.map((index) => {
        return index.indexName
      }),
    ).toEqual(['idx_app_project_mart_refresh_state_claim', 'idx_app_project_mart_refresh_state_stale_work'])
    expect(result.row.projectId).toBe('refresh-state-project')
    expect(result.row.dirtyToken).toBe(7)
    expect(result.row.activeRefreshToken).toBe(7)
    expect(result.row.lastCompletedRefreshToken).toBe(5)
    expect(result.row.lastRequestReason).toBe('judgment-import')
    expect(result.row.requestedBy).toBe('worker-test')
    expect(result.row.refreshStatus).toBe('running')
    expect(result.row.lastError).toBe('transient error')
    expect(result.row.workerId).toBe('worker-1')
    expect(result.row.lastRequestedAt).toBeTruthy()
    expect(result.row.lastStartedAt).toBeTruthy()
    expect(result.row.lastCompletedAt).toBeTruthy()
    expect(result.row.lastFailedAt).toBeTruthy()
    expect(result.row.leaseExpiresAt).toBeTruthy()
    expect(result.row.createdAt).toBeTruthy()
    expect(result.row.updatedAt).toBeTruthy()
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
