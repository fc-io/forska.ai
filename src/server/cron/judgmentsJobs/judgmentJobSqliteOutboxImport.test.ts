import {rmSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'

const tempDbPath = `/tmp/f1-judgment-job-sqlite-import-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let getAppDatabaseService:
  | Awaited<typeof import('../../services/appDatabaseService.ts')>['getAppDatabaseService']
  | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let importOutboxBatch: (() => Promise<number>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let storeSinglePromptJudgment:
  | (typeof import('../../../agent/judge/storeSinglePromptJudgment.ts'))['storeSinglePromptJudgment']
  | null = null

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

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService: getDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    importModule,
    storeModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentJobSqliteOutboxImport.ts'),
    import('../../../agent/judge/storeSinglePromptJudgment.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  getAppDatabaseService = getDatabaseService
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
  importOutboxBatch = () => {
    return importModule.importJudgmentJobSqliteOutboxBatch()
  }
  storeSinglePromptJudgment = storeModule.storeSinglePromptJudgment
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

afterEach(async () => {
  await sqliteService?.().closeAll()
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('ignores orphaned and non-running SQLite job files during background import', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
        const sqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
        const importModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
        let inspectedOrphanJob = false
        let inspectedPausedJob = false
        let inspectedTrackedJob = false

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("status = 'running'") ? [{id: 'tracked-job'}] : []
                },
              }
            },
          }
        })

        void mock.module(sqliteServiceModulePath, () => {
          return {
            JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
            getJudgmentJobSqliteService: () => {
              return {
                claimPendingOutboxBatch: async ({jobId}) => {
                  inspectedOrphanJob ||= jobId === 'orphan-job'
                  inspectedPausedJob ||= jobId === 'paused-job'
                  inspectedTrackedJob ||= jobId === 'tracked-job'
                  return null
                },
                getClaimedOutboxBatch: async ({jobId}) => {
                  inspectedOrphanJob ||= jobId === 'orphan-job'
                  inspectedPausedJob ||= jobId === 'paused-job'
                  inspectedTrackedJob ||= jobId === 'tracked-job'
                  return null
                },
                listJobIds: () => {
                  return ['orphan-job', 'paused-job', 'tracked-job']
                },
              }
            },
          }
        })

        const {importJudgmentJobSqliteOutboxBatch} = await import(importModulePath + '?orphaned=' + Date.now())
        const imported = await importJudgmentJobSqliteOutboxBatch({claimedBy: 'test-server'})

        console.log(JSON.stringify({imported, inspectedOrphanJob, inspectedPausedJob, inspectedTrackedJob}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'SQLite orphaned job import regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {
    imported: number
    inspectedOrphanJob: boolean
    inspectedPausedJob: boolean
    inspectedTrackedJob: boolean
  }

  expect(result.imported).toBe(0)
  expect(result.inspectedOrphanJob).toBe(false)
  expect(result.inspectedPausedJob).toBe(false)
  expect(result.inspectedTrackedJob).toBe(true)
})

test('imports SQLite-backed judgments into DuckDB in batches', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const promptId = `prompt-${Date.now()}`
  const articleId = `article-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(1)
  expect((await service.getPendingOutboxBatch({jobId, maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(0)
})

test('drops orphaned SQLite-backed judgments when the article no longer exists', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-orphan-${Date.now()}`
  const modelId = `model-orphan-${Date.now()}`
  const projectId = `project-orphan-${Date.now()}`
  const jobId = `job-orphan-${Date.now()}`
  const promptId = `prompt-orphan-${Date.now()}`
  const articleId = `article-orphan-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Orphan Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  await runDatabase(`
    DELETE FROM app.article
    WHERE id = '${articleId}'
  `)

  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(1)
  expect(await importOutboxBatch()).toBe(0)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(0)
})

test('skips lease-blocked SQLite jobs and imports the next available outbox batch', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-lease-skip-${Date.now()}`
  const modelId = `model-lease-skip-${Date.now()}`
  const blockedProjectId = `project-lease-skip-a-${Date.now()}`
  const blockedJobId = `job-a-lease-skip-${Date.now()}`
  const importableProjectId = `project-lease-skip-z-${Date.now()}`
  const importableJobId = `job-z-lease-skip-${Date.now()}`
  const promptId = `prompt-lease-skip-${Date.now()}`
  const articleId = `article-lease-skip-${Date.now()}`

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
    VALUES ('${blockedProjectId}', 'SQLite Import Lease Skip Blocked', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${importableProjectId}', 'SQLite Import Lease Skip Importable', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${blockedJobId}', '${blockedProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${importableJobId}', '${importableProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(blockedJobId)
  await service.initializeJob(importableJobId)
  await writeFile(
    join(tempJobDir, `${blockedJobId}.lease.json`),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: 3002,
        heartbeatAt: new Date().toISOString(),
        hostname: hostname(),
        jobId: blockedJobId,
        leaseId: crypto.randomUUID(),
        pid: process.ppid,
        serverJobId: 'other-process',
      },
      null,
      2,
    ),
    'utf8',
  )
  await service.addReadyPrompts(importableJobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(importableJobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: importableJobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId: importableProjectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(1)
  expect(
    (await service.getPendingOutboxBatch({jobId: importableJobId, maxBytes: 1024 * 1024, maxRows: 10})).length,
  ).toBe(0)
})

test('replays a SQLite outbox batch after crashing between DuckDB commit and SQLite acknowledgement', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const originalCompleteOutboxClaim = service.completeOutboxClaim
  const connectionId = `connection-replay-${Date.now()}`
  const modelId = `model-replay-${Date.now()}`
  const projectId = `project-replay-${Date.now()}`
  const jobId = `job-replay-${Date.now()}`
  const promptId = `prompt-replay-${Date.now()}`
  const articleId = `article-replay-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Replay Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  service.completeOutboxClaim = async () => {
    throw new Error('sqlite acknowledgement crashed')
  }

  try {
    await importOutboxBatch()
    throw new Error('Expected SQLite acknowledgement crash')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('sqlite acknowledgement crashed')
  } finally {
    service.completeOutboxClaim = originalCompleteOutboxClaim
  }

  const rowsAfterCrash = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rowsAfterCrash[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rows[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
})

test('releases claimed SQLite outbox batches for retry when DuckDB insert fails before commit', async () => {
  if (
    !getAppDatabaseService
    || !runDatabase
    || !queryDatabase
    || !sqliteService
    || !importOutboxBatch
    || !storeSinglePromptJudgment
  ) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const database = getAppDatabaseService()
  const originalAppendJudgments = database.appendJudgments
  const connectionId = `connection-retry-${Date.now()}`
  const modelId = `model-retry-${Date.now()}`
  const projectId = `project-retry-${Date.now()}`
  const jobId = `job-retry-${Date.now()}`
  const promptId = `prompt-retry-${Date.now()}`
  const articleId = `article-retry-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Retry Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  try {
    database.appendJudgments = async () => {
      throw new Error('append failed before commit')
    }

    await importOutboxBatch()
    throw new Error('Expected outbox import failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('append failed before commit')
  } finally {
    database.appendJudgments = originalAppendJudgments
  }

  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(Number(rows[0]?.count ?? 0)).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
})

test('records the last project refresh acknowledgement seq after mart visibility completes', async () => {
  if (!runDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-ack-${Date.now()}`
  const modelId = `model-ack-${Date.now()}`
  const projectId = `project-ack-${Date.now()}`
  const jobId = `job-ack-${Date.now()}`
  const promptId = `prompt-ack-${Date.now()}`
  const articleId = `article-ack-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Ack Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  const [pendingOutboxRow] = await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})

  expect(await importOutboxBatch()).toBe(1)
  expect((await service.getScanState(jobId)).lastProjectRefreshAckSeq).toBe(pendingOutboxRow?.outboxSeq ?? null)
})

test('keeps the previous refresh acknowledgement seq when mart visibility acknowledgement fails', async () => {
  if (!runDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const {getDuckdbMartRefreshService} = await import('../../services/getDuckdbMartRefreshService.ts')
  const martRefreshService = getDuckdbMartRefreshService()
  const originalFlush = martRefreshService.flush
  const service = sqliteService()
  const connectionId = `connection-ack-fail-${Date.now()}`
  const modelId = `model-ack-fail-${Date.now()}`
  const projectId = `project-ack-fail-${Date.now()}`
  const jobId = `job-ack-fail-${Date.now()}`
  const promptId = `prompt-ack-fail-${Date.now()}`
  const articleId = `article-ack-fail-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Import Ack Failure Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.setLastProjectRefreshAckSeq(jobId, 0)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimedPrompt.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  const [pendingOutboxRow] = await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})
  martRefreshService.flush = async () => {
    throw new Error('refresh visibility failed')
  }

  try {
    await importOutboxBatch()
    throw new Error('Expected mart refresh acknowledgement failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('refresh visibility failed')
  } finally {
    martRefreshService.flush = originalFlush
  }

  expect((await service.getScanState(jobId)).lastProjectRefreshAckSeq).toBe(0)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)

  expect(await importOutboxBatch()).toBe(1)
  expect((await service.getScanState(jobId)).lastProjectRefreshAckSeq).toBe(pendingOutboxRow?.outboxSeq ?? null)
})
