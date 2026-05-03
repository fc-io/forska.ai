import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-request-attempt-sqlite-schema')
const originalEnv = {
  API_SERVER_PORT: process.env.API_SERVER_PORT,
  DUCKDB_PATH: process.env.DUCKDB_PATH,
  RUN_SERVER_JUDGING: process.env.RUN_SERVER_JUDGING,
  SERVER_ROLE: process.env.SERVER_ROLE,
  VITE_PORT: process.env.VITE_PORT,
}

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

const getColumnNames = (database: Database, tableName: string): string[] => {
  return (database.query(`PRAGMA table_info('${tableName}')`).all() as Array<{name: string}>).map((row) => {
    return row.name
  })
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()
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
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }

    process.env[key] = value
  })
})

test('SQLite judgment runtime schema includes request-attempt manifest and evidence columns', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const suffix = `${Date.now()}`
  const connectionId = `request-attempt-connection-${suffix}`
  const modelId = `request-attempt-model-${suffix}`
  const projectId = `request-attempt-project-${suffix}`
  const jobId = `request-attempt-job-${suffix}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'codex', 'Codex', TRUE, 'none', NULL)
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'codex', 'codex', 'Codex', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Request Attempt Schema', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)

  const database = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})
  const queuePromptColumns = getColumnNames(database, 'queue_prompt')
  const judgmentOutboxColumns = getColumnNames(database, 'judgment_outbox')
  const completionAckColumns = getColumnNames(database, 'completion_ack')

  database.close(false)

  expect(queuePromptColumns).toContain('request_attempt_manifest_json')
  expect(queuePromptColumns).toContain('request_attempt_manifest_version')
  expect(judgmentOutboxColumns).toContain('request_attempts_json')
  expect(completionAckColumns).toContain('request_attempts_json')
})
