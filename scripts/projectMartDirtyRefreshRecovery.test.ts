import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()
const defaultEnv = {
  ...process.env,
  API_SERVER_PORT: '39103',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39913',
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

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

const runDirtyRefreshRecoveryScript = <T>(body: string) => {
  const duckdbPath = join(
    projectRoot,
    '.tmp',
    `project-mart-dirty-refresh-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`,
  )
  removeFileIfExists(dirname(duckdbPath))
  const result = globalThis.Bun.spawnSync(
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
          VALUES ('dirty-recovery-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES (
            'dirty-recovery-model',
            'dirty-recovery-connection',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen/Qwen3.5-35B-A3B',
            'Qwen 35B',
            'manual',
            TRUE
          )
        \`)
        await database.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('dirty-recovery-project', 'Dirty Recovery Project', 'dirty-recovery-model', TRUE, TRUE, FALSE, FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
          VALUES (
            'dirty-recovery-article-1',
            'dirty-recovery-external-1',
            'Dirty Recovery Article 1',
            TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
            TIMESTAMPTZ '2026-04-01T01:00:00.000Z'
          )
        \`)

        ${body}
      `,
    ],
    {cwd: projectRoot, env: {...defaultEnv, DUCKDB_PATH: duckdbPath}},
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'dirty refresh recovery script failed')
    }

    return JSON.parse(getLastJsonLine(result.stdout.toString())) as T
  } finally {
    removeFileIfExists(dirname(duckdbPath))
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('project refresh ACK reconciliation caps owner ACKs at dirty-token barriers', () => {
  const result = runDirtyRefreshRecoveryScript<{
    ackAfterBarrier: number | null
    ackAfterCompletion: number | null
    reconciledAfterBarrier: number
    reconciledAfterCompletion: number
  }>(`
    const {getJudgmentJobSqliteService} = await import(
      './src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts'
    )
    const sqliteService = getJudgmentJobSqliteService()
    const jobId = 'dirty-recovery-job'

    await database.run(\`
      INSERT INTO app.judgment_job (id, project_id, status)
      VALUES ('dirty-recovery-job', 'dirty-recovery-project', 'running')
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_refresh_state (project_id, dirty_token, last_completed_dirty_token)
      VALUES ('dirty-recovery-project', 3, 3)
    \`)
    await database.run(\`
      INSERT INTO app.project_mart_dirty_materialization_state (
        project_id,
        source_kind,
        target_dirty_token,
        materialization_status
      ) VALUES (
        'dirty-recovery-project',
        'project_scope_article',
        2,
        'unreconciled'
      )
    \`)

    await sqliteService.initializeJob(jobId)
    const reconciledAfterBarrier = await sqliteService.reconcileProjectRefreshAcks({
      projectId: 'dirty-recovery-project',
    })
    const ackAfterBarrier = (await sqliteService.getScanState(jobId)).lastProjectRefreshAckSeq

    await database.run(\`
      UPDATE app.project_mart_dirty_materialization_state
      SET materialization_status = 'completed'
      WHERE project_id = 'dirty-recovery-project'
        AND source_kind = 'project_scope_article'
        AND target_dirty_token = 2
    \`)
    const reconciledAfterCompletion = await sqliteService.reconcileProjectRefreshAcks({
      projectId: 'dirty-recovery-project',
    })
    const ackAfterCompletion = (await sqliteService.getScanState(jobId)).lastProjectRefreshAckSeq

    console.log(JSON.stringify({
      ackAfterBarrier,
      ackAfterCompletion,
      reconciledAfterBarrier,
      reconciledAfterCompletion,
    }))
    await database.close()
  `)

  expect(result.reconciledAfterBarrier).toBe(1)
  expect(result.ackAfterBarrier).toBe(1)
  expect(result.reconciledAfterCompletion).toBe(1)
  expect(result.ackAfterCompletion).toBe(3)
})
