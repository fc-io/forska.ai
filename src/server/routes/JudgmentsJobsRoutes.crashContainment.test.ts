import {expect, test} from 'bun:test'

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${stdout}`)
  }

  return lastLine
}

test('repair route blocks live repair for quarantined crash-path jobs with offline guidance', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {createTempRuntimeRoot} = await import('./src/server/test/createTempRuntimeRoot.ts')

        const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-routes-crash-repair')
        const tempDbPath = tempRuntimeRoot.duckdbPath
        process.env.SERVER_ROLE = 'dev-single'
        process.env.DUCKDB_PATH = tempDbPath
        process.env.API_SERVER_PORT = '3998'
        process.env.VITE_PORT = '3000'

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const [
          {migrateDuckdb},
          {getAppDatabaseService},
          {resetDuckdbServiceForTests},
          {resetServerRuntimeRoleForTests},
          {judgmentsJobsRoutes},
          {getJudgmentJobSqliteService},
          {Elysia},
        ] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/routes/JudgmentsJobsRoutes.ts'),
          import('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts'),
          import('elysia'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const db = getAppDatabaseService()
        const sqliteService = getJudgmentJobSqliteService()
        const app = new Elysia().use(judgmentsJobsRoutes)
        const now = Date.now()
        const connectionId = 'repair-crash-connection-' + now
        const modelId = 'repair-crash-model-' + now
        const projectId = 'repair-crash-project-' + now
        const jobId = 'repair-crash-job-' + now

        await db.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('" + connectionId + "', 'sglang', 'SGLang', TRUE, 'none')")
        await db.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('" + modelId + "', '" + connectionId + "', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)")
        await db.run("INSERT INTO app.project (id, name, model_id) VALUES ('" + projectId + "', 'Repair Crash Project', '" + modelId + "')")
        await db.run("INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason) VALUES ('" + jobId + "', '" + projectId + "', 'failed', 'quarantined', current_timestamp, 'Isolated SQLite import crashes Bun for this paused job')")
        await sqliteService.initializeJob(jobId)

        const response = await app.handle(new Request('http://localhost/api/judgmentsjobs/' + jobId + '/repair', {method: 'POST'}))
        const body = await response.json()

        console.log(JSON.stringify({body, status: response.status}))

        await sqliteService.closeAll()
        await db.close()
        tempRuntimeRoot.cleanup()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Repair crash containment regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    body: {data: {job: {quarantineReason: string | null; storageState: string}; message: string; ok: boolean}}
    status: number
  }

  expect(result.status).toBe(200)
  expect(result.body.data.ok).toBe(false)
  expect(result.body.data.job.storageState).toBe('quarantined')
  expect(result.body.data.job.quarantineReason).toContain('crashes Bun')
  expect(result.body.data.message).toContain('Live repair is disabled')
  expect(result.body.data.message).toContain('run offline repair')
})

test('delete route fails safely for quarantined crash-path jobs when isolated flush fails', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {createTempRuntimeRoot} = await import('./src/server/test/createTempRuntimeRoot.ts')

        const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-routes-crash-delete')
        const tempDbPath = tempRuntimeRoot.duckdbPath
        process.env.SERVER_ROLE = 'dev-single'
        process.env.DUCKDB_PATH = tempDbPath
        process.env.API_SERVER_PORT = '3999'
        process.env.VITE_PORT = '3000'

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const isolatedImportModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts')

        void mock.module(isolatedImportModulePath, () => {
          return {
            isJudgmentJobSqliteIsolatedImportLeaseConflict: () => false,
            runJudgmentJobSqliteExclusiveIsolatedFlush: async () => {
              return {
                cycleCount: 1,
                errorMessage: 'panic: A C++ exception occurred',
                exitCode: 133,
                importedCount: 0,
                lastResult: null,
              }
            },
            runJudgmentJobSqliteIsolatedFlush: async () => {
              return {
                cycleCount: 1,
                errorMessage: 'panic: A C++ exception occurred',
                exitCode: 133,
                importedCount: 0,
                lastResult: null,
              }
            },
          }
        })

        const [
          {migrateDuckdb},
          {getAppDatabaseService},
          {resetDuckdbServiceForTests},
          {resetServerRuntimeRoleForTests},
          {judgmentsJobsRoutes},
          {getJudgmentJobSqliteService},
          {Elysia},
        ] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/routes/JudgmentsJobsRoutes.ts'),
          import('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts'),
          import('elysia'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const db = getAppDatabaseService()
        const sqliteService = getJudgmentJobSqliteService()
        const app = new Elysia().use(judgmentsJobsRoutes)
        const now = Date.now()
        const connectionId = 'delete-crash-connection-' + now
        const modelId = 'delete-crash-model-' + now
        const projectId = 'delete-crash-project-' + now
        const jobId = 'delete-crash-job-' + now
        const articleId = 'delete-crash-article-' + now
        const promptId = 'delete-crash-prompt-' + now

        await db.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('" + connectionId + "', 'sglang', 'SGLang', TRUE, 'none')")
        await db.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('" + modelId + "', '" + connectionId + "', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)")
        await db.run("INSERT INTO app.project (id, name, model_id) VALUES ('" + projectId + "', 'Delete Crash Project', '" + modelId + "')")
        await db.run("INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason) VALUES ('" + jobId + "', '" + projectId + "', 'failed', 'quarantined', current_timestamp, 'Isolated SQLite import crashes Bun for this paused job')")
        await sqliteService.initializeJob(jobId)
        await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
        await db.run("INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens) VALUES ('delete-crash-token-" + now + "', '" + jobId + "', 1, 10, 5, 15)")

        const response = await app.handle(new Request('http://localhost/api/judgmentsjobs/' + jobId, {method: 'DELETE'}))
        const body = await response.text()
        const rows = await db.queryJson("SELECT id, storage_state AS storageState FROM app.judgment_job WHERE id = '" + jobId + "' LIMIT 1")

        console.log(JSON.stringify({body, job: rows[0] ?? null, status: response.status}))

        await sqliteService.closeAll()
        await db.close()
        tempRuntimeRoot.cleanup()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Delete crash containment regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    body: string
    job: {id: string; storageState: string} | null
    status: number
  }

  expect(result.status).toBe(409)
  expect(result.body).toContain('Delete Job stopped safely')
  expect(result.job?.storageState).toBe('quarantined')
})
