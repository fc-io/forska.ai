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

test('judgment jobs list allows stale health projections for drained jobs on api servers', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')
        const {createTempRuntimeRoot} = await import('./src/server/test/createTempRuntimeRoot.ts')

        const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-api-read-model')
        process.env.SERVER_ROLE = 'dev-single'
        process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
        process.env.API_SERVER_PORT = '3997'
        process.env.VITE_PORT = '3000'

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }
        const appReadOnlyModulePath = getModulePath('./src/server/services/appReadOnlyDatabaseService.ts')
        const appDatabaseServiceModule = await import('./src/server/services/appDatabaseService.ts')

        mock.module(appReadOnlyModulePath, () => {
          return {
            closeAppReadOnlyDatabaseServices: async () => {},
            getApiReadOnlyAppDatabaseService: appDatabaseServiceModule.getAppDatabaseService,
            getJudgeWorkerReadOnlyAppDatabaseService: appDatabaseServiceModule.getAppDatabaseService,
          }
        })

        const [
          {migrateDuckdb},
          {resetDuckdbServiceForTests},
          {resetServerRuntimeRoleForTests, withCurrentServerRoleOverride},
          {judgmentsJobsRoutes},
          {getJudgmentJobSqliteHealthProjectionService},
        ] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/routes/JudgmentsJobsRoutes.ts'),
          import('./src/server/services/judgmentJobSqliteHealthProjectionService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const db = appDatabaseServiceModule.getAppDatabaseService()
        const app = new Elysia().use(judgmentsJobsRoutes)
        const now = Date.now()
        const connectionId = 'api-drained-projection-connection-' + now
        const modelId = 'api-drained-projection-model-' + now
        const projectId = 'api-drained-projection-project-' + now
        const jobId = 'api-drained-projection-job-' + now
        const projectedHealth = {
          claimedOutboxCount: 0,
          hasOutboxRows: false,
          hasPendingCompletionAck: false,
          hasQueueRows: false,
          lastAckSeq: null,
          oldestUnackedCompletionAgeMs: null,
          oldestUnexportedAgeMs: null,
          orphanedJudgedRowCount: 0,
          outboxRowCount: 0,
          pendingCompletionAckCount: 0,
          promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
          retainedRowCount: 0,
          sqliteFileBytes: null,
          walBytes: 0,
        }

        await db.run("INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode) VALUES ('" + connectionId + "', 'sglang', 'SGLang', TRUE, 'none')")
        await db.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('" + modelId + "', '" + connectionId + "', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)")
        await db.run("INSERT INTO app.project (id, name, model_id) VALUES ('" + projectId + "', 'API Read Model Project', '" + modelId + "')")
        await db.run("INSERT INTO app.judgment_job (id, project_id, status, storage_state) VALUES ('" + jobId + "', '" + projectId + "', 'paused', 'drained')")

        await getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
          health: projectedHealth,
          jobId,
          now: new Date(now - 60_000),
          projectedBy: 'test-judge-worker',
          projectionSource: 'test',
        })

        await withCurrentServerRoleOverride('api', async () => {
          const response = await app.handle(new Request('http://localhost/api/judgmentsjobs'))
          const bodyText = await response.text()
          const body = JSON.parse(bodyText)

          console.log(JSON.stringify({body, jobId, status: response.status}))
        })

        await db.close()
        tempRuntimeRoot.cleanup()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'API read model regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    body: {data: Array<{health: {badges: string[]; isHealthy: boolean}; id: string}>}
    jobId: string
    status: number
  }
  const listedJob = result.body.data.find((job) => {
    return job.id === result.jobId
  })

  expect(result.status).toBe(200)
  expect(listedJob?.health).toEqual({badges: ['Healthy'], isHealthy: true})
})
