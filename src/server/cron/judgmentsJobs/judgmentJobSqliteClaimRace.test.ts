import {afterAll, beforeAll, expect, mock, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-sqlite-claim-race')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const judgmentExecutionSnapshotServiceModulePath = getModulePath(
  './src/server/services/judgmentExecutionSnapshotService.ts',
)
const judgmentJobSqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')

type SnapshotGate = {continuePromise: Promise<void>; started: () => void}

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let snapshotGate: SnapshotGate | null = null

void mock.module(judgmentExecutionSnapshotServiceModulePath, () => {
  return {
    createJudgmentExecutionSnapshotForClaim: async (input: {claimId: string}) => {
      const gate = snapshotGate

      if (gate) {
        gate.started()
        await gate.continuePromise
      }

      return {
        executionSnapshotHash: `hash-${input.claimId}`,
        executionSnapshotId: `snapshot-${input.claimId}`,
        modelId: 'model-race',
        projectId: 'project-race',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }
    },
  }
})

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../services/appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()
  const sqliteModule = (await import(
    `${judgmentJobSqliteServiceModulePath}?claim-race=${Date.now()}`
  )) as typeof import('./judgmentJobSqliteService.ts')

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

test('claimReadyPrompts survives lease release while snapshot creation is in flight', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-claim-race-${Date.now()}`
  const modelId = `model-claim-race-${Date.now()}`
  const projectId = `project-claim-race-${Date.now()}`
  const jobId = `job-claim-race-${Date.now()}`
  let continueSnapshot: () => void = () => {
    return undefined
  }
  const snapshotStarted = new Promise<void>((resolveStarted) => {
    snapshotGate = {
      continuePromise: new Promise<void>((resolveContinue) => {
        continueSnapshot = () => {
          resolveContinue()
        }
      }),
      started: resolveStarted,
    }
  })

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Claim Race Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId: 'article-race', promptId: 'prompt-race'}], 'server-a')

  const claimPromise = service.claimReadyPrompts(jobId, 'server-a', 1)
  await snapshotStarted

  const releasePromise = service.releaseOwnedLease(jobId)

  await new Promise((resolve) => {
    setTimeout(resolve, 50)
  })

  expect(service.hasOwnedLease(jobId)).toBe(true)

  continueSnapshot()

  const claimed = await claimPromise
  await releasePromise

  expect(
    claimed.map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual(['article-race:prompt-race'])
  expect(await service.getClaimedCount(jobId)).toBe(1)
  expect(service.hasOwnedLease(jobId)).toBe(false)
  snapshotGate = null

  await service.closeAll()
})
