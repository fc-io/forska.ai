import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

const runFreshnessScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-judgments-jobs-dirty-materialization-freshness-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runScript = globalThis.Bun.spawnSync(['bun', '-e', body], {
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
      throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'Freshness test failed')
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

test('judgment job freshness treats incomplete dirty materialization as stale', () => {
  const result = runFreshnessScript<{
    completed: {dirtyToken: number | null; hasIncompleteDirtyMaterialization: boolean; isFresh: boolean}
    pending: {dirtyToken: number | null; hasIncompleteDirtyMaterialization: boolean; isFresh: boolean}
  }>(`
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getProjectMartFreshnessState} = await import('./src/server/routes/JudgmentsJobsRoutes.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('freshness-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    \`)
    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('freshness-model', 'freshness-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    \`)
    await database.run(\`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('freshness-project', 'Freshness Project', 'freshness-model', TRUE, TRUE, FALSE, FALSE)
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_state (
        project_id,
        dirty_token,
        last_completed_dirty_token
      ) VALUES (
        'freshness-project',
        3,
        3
      )
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        source_scope_expected_row_count,
        materialization_status
      ) VALUES (
        'freshness-project',
        'project_scope_article',
        3,
        10,
        'pending'
      )
    \`)

    const pending = await getProjectMartFreshnessState('freshness-project')

    await database.run(\`
      UPDATE app.project_mart_dirty_materialization_state
      SET materialization_status = 'completed'
      WHERE project_id = 'freshness-project'
        AND source_kind = 'project_scope_article'
        AND target_dirty_token = 3
    \`)

    const completed = await getProjectMartFreshnessState('freshness-project')

    console.log(JSON.stringify({completed, pending}))
    await database.close()
  `)

  expect(result.pending).toMatchObject({dirtyToken: 3, hasIncompleteDirtyMaterialization: true, isFresh: false})
  expect(result.completed).toMatchObject({dirtyToken: 3, hasIncompleteDirtyMaterialization: false, isFresh: true})
})
