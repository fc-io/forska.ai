import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'
import {getDurableTerminalCompletionAckProofSql} from './judgmentJobSqliteService/terminalCloseoutProofSql.ts'

setDefaultTimeout(120_000)

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
  const jobInfoColumns = getColumnNames(database, 'job_info')
  const completionAckColumns = getColumnNames(database, 'completion_ack')

  database.close(false)

  expect(queuePromptColumns).toContain('request_attempt_manifest_json')
  expect(queuePromptColumns).toContain('request_attempt_manifest_version')
  expect(queuePromptColumns).toContain('request_attempt_manifest_repair_json')
  expect(judgmentOutboxColumns).toContain('request_attempts_json')
  expect(judgmentOutboxColumns).toContain('system_prompt_variant')
  expect(judgmentOutboxColumns).toContain('use_metadata')
  expect(jobInfoColumns).toContain('use_metadata')
  expect(completionAckColumns).toContain('request_attempts_json')
})

const getQueryPlanDetails = (database: Database, sql: string): string[] => {
  return (database.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{detail: string}>).map((row) => {
    return row.detail
  })
}

const getIndexNames = (database: Database, tableName: string): string[] => {
  return (database.query(`PRAGMA index_list('${tableName}')`).all() as Array<{name: string}>).map((row) => {
    return row.name
  })
}

test('completion_ack closeout-proof reads walk an index instead of sorting the table, also after opening an older job file', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const suffix = `${Date.now()}`
  const connectionId = `closeout-proof-connection-${suffix}`
  const modelId = `closeout-proof-model-${suffix}`
  const projectId = `closeout-proof-project-${suffix}`
  const jobId = `closeout-proof-job-${suffix}`

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
    VALUES ('${projectId}', 'Closeout Proof Index', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)
  await service.closeAll()

  const olderFile = new Database(getJudgmentJobSqlitePath(jobId))
  olderFile.exec('DROP INDEX idx_completion_ack_closeout_proof')
  const indexesBeforeReopen = getIndexNames(olderFile, 'completion_ack')
  olderFile.close(false)

  await service.getDurableTerminalRequestAttemptCloseoutProofs(jobId, 1_000)
  await service.closeAll()

  const database = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})
  const indexesAfterReopen = getIndexNames(database, 'completion_ack')
  const boundedPlan = getQueryPlanDetails(database, getDurableTerminalCompletionAckProofSql(334))
  const unboundedPlan = getQueryPlanDetails(database, getDurableTerminalCompletionAckProofSql(null))
  database.close(false)

  expect(indexesBeforeReopen).not.toContain('idx_completion_ack_closeout_proof')
  expect(indexesAfterReopen).toContain('idx_completion_ack_closeout_proof')
  expect(boundedPlan).toEqual(['SCAN completion_ack USING INDEX idx_completion_ack_closeout_proof'])
  expect(unboundedPlan).toEqual(['SCAN completion_ack USING INDEX idx_completion_ack_closeout_proof'])
})
