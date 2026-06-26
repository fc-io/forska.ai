import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, spyOn, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import type {JudgmentJobLeaseMetadata} from './judgmentJobLease.ts'
import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-sqlite-service')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let JudgmentJobLeaseError: Awaited<typeof import('./judgmentJobSqliteService.ts')>['JudgmentJobLeaseError'] | null =
  null

type QueueCountRow = {count: number; status: string}

const getQueueCountMap = (rows: QueueCountRow[]) => {
  return Object.fromEntries(
    rows.map((row) => {
      return [row.status, row.count]
    }),
  )
}

const waitForPaths = async (paths: string[], timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  const check = async (): Promise<void> => {
    if (
      paths.every((path) => {
        return existsSync(path)
      })
    ) {
      return
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${paths.join(', ')}`)
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })

    return check()
  }

  return check()
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
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
  JudgmentJobLeaseError = sqliteModule.JudgmentJobLeaseError
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('claims and requeues prompts from the per-job SQLite queue', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Queue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-2', promptId: 'prompt-2'},
    ],
    'server-a',
  )

  expect(await service.getReadyCount(jobId)).toBe(2)

  const claimed = await service.claimReadyPrompts(jobId, 'server-a', 1)

  expect(claimed).toHaveLength(1)
  expect(claimed[0]).not.toHaveProperty('executionSnapshotPayload')
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getClaimedCount(jobId)).toBe(1)
  expect(await service.getRunningCount(jobId)).toBe(0)
  expect(await service.getDispatchCounts(jobId)).toEqual({claimed: 1, running: 0})
  expect(await service.getInFlightCount(jobId)).toBe(1)

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))
  const staleHeartbeatAt = new Date(Date.now() - 60_000).toISOString()

  try {
    sqliteDatabase
      .query(`UPDATE judge_worker_heartbeat SET heartbeat_at = ?, updated_at = ? WHERE server_id = ?`)
      .run(staleHeartbeatAt, staleHeartbeatAt, 'server-a')
  } finally {
    sqliteDatabase.close(false)
  }

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(2)
  expect(await service.getClaimedCount(jobId)).toBe(0)
  expect(await service.getInFlightCount(jobId)).toBe(0)
})

test('initializes local outbox sequence above imported central markers', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-sequence-seed-${Date.now()}`
  const modelId = `model-sequence-seed-${Date.now()}`
  const projectId = `project-sequence-seed-${Date.now()}`
  const jobId = `job-sequence-seed-${Date.now()}`
  const articleId = `article-sequence-seed-${Date.now()}`
  const promptId = `prompt-sequence-seed-${Date.now()}`
  const judgmentId = `judgment-sequence-seed-${Date.now()}`
  const importedOutboxSeq = 12_123

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
    VALUES ('${projectId}', 'SQLite Sequence Seed Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
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
      '${jobId}',
      ${importedOutboxSeq},
      '${jobId}-old-queue',
      '${jobId}-old-judgment',
      '${articleId}-old',
      '${promptId}-old',
      '${modelId}',
      '${projectId}',
      'imported'
    )
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-sequence-seed')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-sequence-seed', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for sequence seed test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 90,
    createdAt: new Date(),
    explanation: 'sequence seed',
    isAnswered: true,
    judgmentId,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})

  try {
    const row = sqliteDatabase
      .query(`SELECT outbox_seq AS outboxSeq FROM judgment_outbox WHERE judgment_id = ?`)
      .get(judgmentId) as {outboxSeq: number} | null

    expect(Number(row?.outboxSeq ?? 0)).toBe(importedOutboxSeq + 1)
  } finally {
    sqliteDatabase.close(false)
  }
})

test('treats externally removed cached SQLite jobs as missing', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-externally-removed-${Date.now()}`
  const modelId = `model-externally-removed-${Date.now()}`
  const projectId = `project-externally-removed-${Date.now()}`
  const jobId = `job-externally-removed-${Date.now()}`

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
    VALUES ('${projectId}', 'Externally Removed SQLite Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-externally-removed', promptId: 'prompt-externally-removed'}],
    'server-a',
  )
  await service.claimReadyPrompts(jobId, 'server-a', 1)

  expect(await service.getQueuePromptLifecycleRows(jobId)).toHaveLength(1)

  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  rmSync(sqlitePath, {force: true})
  rmSync(`${sqlitePath}-wal`, {force: true})
  rmSync(`${sqlitePath}-shm`, {force: true})

  expect(await service.getQueuePromptLifecycleRows(jobId)).toEqual([])
  expect(await service.getInFlightCount(jobId)).toBe(0)

  await service.releaseOwnedLease(jobId)
})

test('requeues stale same-server prompts only when they are not protected by dispatch', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-protected-requeue-${Date.now()}`
  const modelId = `model-protected-requeue-${Date.now()}`
  const projectId = `project-protected-requeue-${Date.now()}`
  const jobId = `job-protected-requeue-${Date.now()}`
  const serverJobId = 'server-protected-requeue-current'

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
    VALUES ('${projectId}', 'Protected Requeue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-protected', promptId: 'prompt-protected'},
      {articleId: 'article-abandoned', promptId: 'prompt-abandoned'},
    ],
    serverJobId,
  )

  const [protectedPrompt, abandonedPrompt] = await service.claimReadyPrompts(jobId, serverJobId, 2)

  if (!protectedPrompt || !abandonedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for protected requeue test')
  }

  expect(
    await service.requeueAbandonedSentPrompts({jobId, serverJobId, staleBefore: new Date(Date.now() + 1000)}),
  ).toBe(0)
  expect(await service.getClaimedCount(jobId)).toBe(2)

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    protectedRecordIds: [protectedPrompt.recordId],
    serverJobId,
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getClaimedCount(jobId)).toBe(1)
  expect(await service.getInFlightCount(jobId)).toBe(1)
})

test('does not requeue stale foreign prompts for a live judge-worker heartbeat', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-live-worker-requeue-${Date.now()}`
  const modelId = `model-live-worker-requeue-${Date.now()}`
  const projectId = `project-live-worker-requeue-${Date.now()}`
  const jobId = `job-live-worker-requeue-${Date.now()}`
  const workerServerId = 'server-live-worker-requeue-owner'

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
    VALUES ('${projectId}', 'Live Worker Requeue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-live-worker', promptId: 'prompt-live-worker'}],
    workerServerId,
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, workerServerId, 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for live worker requeue test')
  }

  await service.recordWorkerHeartbeat(jobId, workerServerId)

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-live-worker-requeue-reaper',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(0)
  expect(await service.getReadyCount(jobId)).toBe(0)
  expect(await service.getClaimedCount(jobId)).toBe(1)
})

test('requeues stale foreign prompts after judge-worker heartbeat expires', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-dead-worker-requeue-${Date.now()}`
  const modelId = `model-dead-worker-requeue-${Date.now()}`
  const projectId = `project-dead-worker-requeue-${Date.now()}`
  const jobId = `job-dead-worker-requeue-${Date.now()}`
  const workerServerId = 'server-dead-worker-requeue-owner'

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
    VALUES ('${projectId}', 'Dead Worker Requeue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-dead-worker', promptId: 'prompt-dead-worker'}],
    workerServerId,
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, workerServerId, 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for dead worker requeue test')
  }

  await service.recordWorkerHeartbeat(jobId, workerServerId)

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))
  const staleHeartbeatAt = new Date(Date.now() - 60_000).toISOString()

  try {
    sqliteDatabase
      .query(`UPDATE judge_worker_heartbeat SET heartbeat_at = ?, updated_at = ? WHERE server_id = ?`)
      .run(staleHeartbeatAt, staleHeartbeatAt, workerServerId)
  } finally {
    sqliteDatabase.close(false)
  }

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-dead-worker-requeue-reaper',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getClaimedCount(jobId)).toBe(0)
})

test('claims ready prompts in insertion order for a fresh SQLite queue', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-claim-order-${Date.now()}`
  const modelId = `model-claim-order-${Date.now()}`
  const projectId = `project-claim-order-${Date.now()}`
  const jobId = `job-claim-order-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Claim Order Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-first', promptId: 'prompt-first'},
      {articleId: 'article-second', promptId: 'prompt-second'},
      {articleId: 'article-third', promptId: 'prompt-third'},
    ],
    'server-a',
  )

  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 3)).map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual(['article-first:prompt-first', 'article-second:prompt-second', 'article-third:prompt-third'])

  await service.closeAll()
})

test('claimReadyPrompts skips legacy duplicate rows when a canonical queue row exists', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const suffix = `${Date.now()}`
  const connectionId = `connection-canonical-duplicate-${suffix}`
  const modelId = `model-canonical-duplicate-${suffix}`
  const projectId = `project-canonical-duplicate-${suffix}`
  const jobId = `job-canonical-duplicate-${suffix}`
  const canonicalArticleId = `article-canonical-duplicate-${suffix}`
  const legacyArticleId = `legacy-canonical-duplicate-${suffix}`
  const legacyQueueId = `queue-legacy-duplicate-${suffix}`
  const canonicalQueueId = `queue-canonical-duplicate-${suffix}`

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
    VALUES ('${projectId}', 'SQLite Canonical Duplicate Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES ('${canonicalArticleId}', '${legacyArticleId}', 'Canonical Duplicate Article')
  `)

  await service.initializeJob(jobId)

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))
  const now = new Date().toISOString()

  try {
    sqliteDatabase
      .query(
        `
          INSERT INTO queue_prompt (
            id,
            job_id,
            article_id,
            prompt_id,
            status,
            server_id,
            ready_insert_seq,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 'prompt-canonical-duplicate', 'ready', 'server-a', ?, ?, ?)
        `,
      )
      .run(legacyQueueId, jobId, legacyArticleId, 1, now, now)
    sqliteDatabase
      .query(
        `
          INSERT INTO queue_prompt (
            id,
            job_id,
            article_id,
            prompt_id,
            status,
            server_id,
            ready_insert_seq,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 'prompt-canonical-duplicate', 'ready', 'server-a', ?, ?, ?)
        `,
      )
      .run(canonicalQueueId, jobId, canonicalArticleId, 2, now, now)
  } finally {
    sqliteDatabase.close(false)
  }

  const claimed = await service.claimReadyPrompts(jobId, 'server-a', 2)
  const resultDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    const rows = resultDatabase
      .query(
        `
          SELECT
            id,
            article_id AS articleId,
            status,
            terminal_kind AS terminalKind,
            skip_reason AS skipReason
          FROM queue_prompt
          WHERE id IN (?, ?)
          ORDER BY ready_insert_seq ASC
        `,
      )
      .all(legacyQueueId, canonicalQueueId)

    expect(
      claimed.map((prompt) => {
        return {articleId: prompt.articleId, recordId: prompt.recordId}
      }),
    ).toEqual([{articleId: canonicalArticleId, recordId: canonicalQueueId}])
    expect(rows).toEqual([
      {
        articleId: legacyArticleId,
        id: legacyQueueId,
        skipReason: 'duplicate_canonical_article_prompt',
        status: 'judged',
        terminalKind: 'skipped',
      },
      {articleId: canonicalArticleId, id: canonicalQueueId, skipReason: null, status: 'claimed', terminalKind: null},
    ])
  } finally {
    resultDatabase.close(false)
  }

  await service.closeAll()
})

test('claimReadyPrompts skips delayed retry rows until their retry window opens', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-retry-delay-${Date.now()}`
  const modelId = `model-retry-delay-${Date.now()}`
  const projectId = `project-retry-delay-${Date.now()}`
  const jobId = `job-retry-delay-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Retry Delay Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-delayed', promptId: 'prompt-delayed'},
      {articleId: 'article-ready', promptId: 'prompt-ready'},
    ],
    'server-a',
  )

  const [firstClaimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!firstClaimedPrompt) {
    throw new Error('Failed to claim delayed retry prompt')
  }

  await service.markPromptAsRetry(jobId, firstClaimedPrompt.recordId, 25)

  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 2)).map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual(['article-ready:prompt-ready'])

  await new Promise((resolve) => {
    setTimeout(resolve, 35)
  })

  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 1)).map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual(['article-delayed:prompt-delayed'])

  await service.closeAll()
})

test('markPromptAsRetry moves failed prompts to the back of the ready queue', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-retry-tail-${Date.now()}`
  const modelId = `model-retry-tail-${Date.now()}`
  const projectId = `project-retry-tail-${Date.now()}`
  const jobId = `job-retry-tail-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Retry Tail Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-first', promptId: 'prompt-first'},
      {articleId: 'article-second', promptId: 'prompt-second'},
    ],
    'server-a',
  )

  const [firstClaimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!firstClaimedPrompt) {
    throw new Error('Expected first claimed prompt for retry tail test')
  }

  await service.addReadyPrompts(jobId, [{articleId: 'article-third', promptId: 'prompt-third'}], 'server-a')
  await service.markPromptAsRetry(jobId, firstClaimedPrompt.recordId)

  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-second', 'article-third', 'article-first'])

  await service.closeAll()
})

test('promotes claimed prompts to running without changing in-flight totals', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-running-state-${Date.now()}`
  const modelId = `model-running-state-${Date.now()}`
  const projectId = `project-running-state-${Date.now()}`
  const jobId = `job-running-state-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Running State Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId: 'article-running', promptId: 'prompt-running'}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Expected claimed prompt for running state test')
  }

  expect(await service.getDispatchCounts(jobId)).toEqual({claimed: 1, running: 0})
  await service.markPromptAsRunning(jobId, claimedPrompt.recordId)
  expect(await service.getClaimedCount(jobId)).toBe(0)
  expect(await service.getRunningCount(jobId)).toBe(1)
  expect(await service.getDispatchCounts(jobId)).toEqual({claimed: 0, running: 1})
  expect(await service.getInFlightCount(jobId)).toBe(1)
})

test('opening an existing job preserves legacy sent rows until recovery requeues them in original order', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-legacy-sent-${Date.now()}`
  const modelId = `model-legacy-sent-${Date.now()}`
  const projectId = `project-legacy-sent-${Date.now()}`
  const jobId = `job-legacy-sent-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

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
    VALUES ('${projectId}', 'SQLite Legacy Sent Upgrade Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-legacy-first', promptId: 'prompt-legacy-first'},
      {articleId: 'article-legacy-second', promptId: 'prompt-legacy-second'},
      {articleId: 'article-legacy-third', promptId: 'prompt-legacy-third'},
    ],
    'server-a',
  )
  await service.closeAll()

  const sqliteDatabase = new Database(sqlitePath)

  try {
    sqliteDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `)
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = 'sent',
              sent_at = ?,
              updated_at = ?,
              server_id = ?,
              claim_id = ?
          WHERE article_id = 'article-legacy-first'
        `,
      )
      .run(
        new Date(Date.now() - 45_000).toISOString(),
        new Date().toISOString(),
        'legacy-server',
        `legacy-claim-${Date.now()}`,
      )
  } finally {
    sqliteDatabase.close(false)
  }

  await service.initializeJob(jobId)

  expect(
    await service.requeueAbandonedSentPrompts({
      jobId,
      serverJobId: 'server-b',
      staleBefore: new Date(Date.now() + 1000),
    }),
  ).toBe(1)
  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 2)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-legacy-first', 'article-legacy-second'])
})

test('preserves original enqueue order when stale sent prompts are requeued', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-requeue-order-${Date.now()}`
  const modelId = `model-requeue-order-${Date.now()}`
  const projectId = `project-requeue-order-${Date.now()}`
  const jobId = `job-requeue-order-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Requeue Order Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-2', promptId: 'prompt-2'},
    ],
    'server-a',
  )

  const [firstClaimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!firstClaimedPrompt) {
    throw new Error('Expected first claimed prompt for requeue order test')
  }

  await service.addReadyPrompts(jobId, [{articleId: 'article-3', promptId: 'prompt-3'}], 'server-a')

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))
  const staleHeartbeatAt = new Date(Date.now() - 60_000).toISOString()

  try {
    sqliteDatabase
      .query(`UPDATE judge_worker_heartbeat SET heartbeat_at = ?, updated_at = ? WHERE server_id = ?`)
      .run(staleHeartbeatAt, staleHeartbeatAt, 'server-a')
  } finally {
    sqliteDatabase.close(false)
  }

  await service.requeueAbandonedSentPrompts({jobId, serverJobId: 'server-b', staleBefore: new Date(Date.now() + 1000)})

  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-1', 'article-2', 'article-3'])
})

test('requeues stale sent, claimed, and running rows without duplicating terminal outcomes', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-recovery-statuses-${Date.now()}`
  const modelId = `model-recovery-statuses-${Date.now()}`
  const projectId = `project-recovery-statuses-${Date.now()}`
  const jobId = `job-recovery-statuses-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Recovery Status Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-sent', promptId: 'prompt-sent'},
      {articleId: 'article-claimed', promptId: 'prompt-claimed'},
      {articleId: 'article-running', promptId: 'prompt-running'},
      {articleId: 'article-terminal-judged', promptId: 'prompt-terminal-judged'},
      {articleId: 'article-terminal-skipped', promptId: 'prompt-terminal-skipped'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 5)
  const sentPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-sent'
  })
  const claimedPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-claimed'
  })
  const runningPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-running'
  })
  const judgedPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-terminal-judged'
  })
  const skippedPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-terminal-skipped'
  })

  if (!sentPrompt || !claimedPrompt || !runningPrompt || !judgedPrompt || !skippedPrompt) {
    throw new Error('Expected claimed prompts for recovery status test')
  }

  await service.markPromptAsRunning(jobId, runningPrompt.recordId)
  await service.markPromptAsJudged(jobId, judgedPrompt.recordId)
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')
  await service.closeAll()

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `)
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = CASE
                WHEN id = ? THEN 'sent'
                WHEN id = ? THEN 'claimed'
                WHEN id = ? THEN 'running'
                ELSE status
              END,
              sent_at = CASE
                WHEN id IN (?, ?, ?) THEN ?
                ELSE sent_at
              END,
              updated_at = CASE
                WHEN id IN (?, ?, ?) THEN ?
                ELSE updated_at
              END,
              server_id = CASE
                WHEN id IN (?, ?, ?) THEN 'legacy-server'
                ELSE server_id
              END
          WHERE id IN (?, ?, ?, ?, ?)
        `,
      )
      .run(
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
        judgedPrompt.recordId,
        skippedPrompt.recordId,
      )
  } finally {
    sqliteDatabase.close(false)
  }

  await service.initializeJob(jobId)

  expect(getQueueCountMap(await service.getPromptStatusCounts(jobId))).toEqual({
    claimed: 1,
    judged: 1,
    running: 1,
    sent: 1,
    skipped: 1,
  })
  expect(
    await service.requeueAbandonedSentPrompts({
      jobId,
      serverJobId: 'server-b',
      staleBefore: new Date(Date.now() + 1000),
    }),
  ).toBe(3)
  expect(await service.getDispatchCounts(jobId)).toEqual({claimed: 0, running: 0})
  expect(getQueueCountMap(await service.getPromptStatusCounts(jobId))).toEqual({judged: 1, ready: 3, skipped: 1})
  expect(
    (await service.claimReadyPrompts(jobId, 'server-c', 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-sent', 'article-claimed', 'article-running'])
})

test('runs isolated SQLite preflight against queue and outbox state', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-preflight-${Date.now()}`
  const modelId = `model-preflight-${Date.now()}`
  const projectId = `project-preflight-${Date.now()}`
  const jobId = `job-preflight-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Preflight Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId: 'article-preflight', promptId: 'prompt-preflight'}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Expected a claimed prompt for SQLite preflight test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 90,
    createdAt: new Date(),
    explanation: 'preflight',
    isAnswered: true,
    judgmentId: `judgment-preflight-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const snapshot = await service.runIsolatedPreflight(jobId)

  expect(snapshot.queueSampleCount).toBe(1)
  expect(snapshot.outboxSampleCount).toBe(1)
  expect(snapshot.sqliteFileBytes).toBeGreaterThan(0)
  expect(snapshot.walBytes).toBeGreaterThanOrEqual(0)

  await service.closeAll()
})

test('isolated SQLite preflight fails when required schema is missing', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-preflight-fail-${Date.now()}`
  const modelId = `model-preflight-fail-${Date.now()}`
  const projectId = `project-preflight-fail-${Date.now()}`
  const jobId = `job-preflight-fail-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

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
    VALUES ('${projectId}', 'SQLite Preflight Failure Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)

  await service.initializeJob(jobId)
  await service.closeAll()

  const malformedDatabase = new Database(sqlitePath)
  malformedDatabase.exec(`DROP TABLE IF EXISTS queue_prompt;`)
  malformedDatabase.exec(`DROP TABLE IF EXISTS judgment_outbox;`)
  malformedDatabase.close(false)
  const preflightError = await service
    .runIsolatedPreflight(jobId)
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error instanceof Error ? error : new Error(String(error))
    })

  expect(preflightError).toBeInstanceOf(Error)
  expect(preflightError?.message).toContain('SQLite job DB preflight failed')

  await service.closeAll()
  rmSync(sqlitePath, {force: true})
})

test('system sqlite fallback runs explicit diagnostic, checkpoint, and export steps for one job', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-system-fallback-${Date.now()}`
  const modelId = `model-system-fallback-${Date.now()}`
  const projectId = `project-system-fallback-${Date.now()}`
  const jobId = `job-system-fallback-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const exportPath = `${sqlitePath}.repair-export.sql`
  const originalSpawnSync = globalThis.Bun.spawnSync

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
    VALUES ('${projectId}', 'SQLite System Fallback Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)

  await service.initializeJob(jobId)

  globalThis.Bun.spawnSync = ((command: string[]) => {
    const sql = command[2] ?? ''

    return sql === '.dump'
      ? {exitCode: 0, stderr: Buffer.from(''), stdout: Buffer.from('BEGIN TRANSACTION;\nCOMMIT;\n')}
      : sql.includes('wal_checkpoint')
        ? {exitCode: 0, stderr: Buffer.from(''), stdout: Buffer.from('0|0|0\n')}
        : {exitCode: 0, stderr: Buffer.from(''), stdout: Buffer.from('ok\n42\n0\n0\n0\n')}
  }) as typeof globalThis.Bun.spawnSync

  try {
    const results = await service.runSystemSqliteFallback({
      jobId,
      serverJobId: 'server-a',
      steps: ['diagnostic', 'checkpoint', 'export'],
    })

    expect(
      results.map((result) => {
        return result.step
      }),
    ).toEqual(['diagnostic', 'checkpoint', 'export'])
    expect(
      results.every((result) => {
        return result.command[0] === 'sqlite3'
      }),
    ).toBe(true)
    expect(
      results.every((result) => {
        return result.command[1] === sqlitePath
      }),
    ).toBe(true)
    expect(results[0]?.stdout).toContain('ok')
    expect(results[1]?.stdout).toBe('0|0|0')
    expect(results[2]?.exportPath).toBe(exportPath)
    expect(results[2]?.exportBytes).toBeGreaterThan(0)
    expect(existsSync(exportPath)).toBe(true)
  } finally {
    globalThis.Bun.spawnSync = originalSpawnSync
    await service.closeAll()
    rmSync(exportPath, {force: true})
  }
})

test('limits SQLite ready inserts to the requested deficit while skipping duplicates', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-limit-${Date.now()}`
  const modelId = `model-limit-${Date.now()}`
  const projectId = `project-limit-${Date.now()}`
  const jobId = `job-limit-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Queue Limit Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)

  expect(
    await service.addReadyPrompts(
      jobId,
      [
        {articleId: 'article-limit-1', promptId: 'prompt-limit-1'},
        {articleId: 'article-limit-2', promptId: 'prompt-limit-2'},
        {articleId: 'article-limit-3', promptId: 'prompt-limit-3'},
      ],
      'server-a',
      2,
    ),
  ).toBe(2)
  expect(await service.getReadyCount(jobId)).toBe(2)

  expect(
    await service.addReadyPrompts(
      jobId,
      [
        {articleId: 'article-limit-1', promptId: 'prompt-limit-1'},
        {articleId: 'article-limit-4', promptId: 'prompt-limit-4'},
        {articleId: 'article-limit-5', promptId: 'prompt-limit-5'},
      ],
      'server-a',
      1,
    ),
  ).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(3)
})

test('getJobInfo refreshes provider runtime settings from the current model connection', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-refresh-${Date.now()}`
  const modelId = `model-refresh-${Date.now()}`
  const projectId = `project-refresh-${Date.now()}`
  const jobId = `job-refresh-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      '${connectionId}',
      'sglang',
      'SGLang Refresh',
      TRUE,
      'none',
      'http://127.0.0.1:30000/v1',
      '{"manualWorkerUrls":[],"workerUrlMode":"runtime"}'
    )
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-27B', 'Qwen/Qwen3.5-27B', 'Qwen 27B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Queue Refresh Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await runDatabase(`
    UPDATE app.provider_connection
    SET base_url = 'http://127.0.0.1:30001/v1',
        config_json = '{"manualWorkerUrls":["http://127.0.0.1:30001"],"workerUrlMode":"runtime"}'
    WHERE id = '${connectionId}'
  `)

  const jobInfo = await service.getJobInfo(jobId)

  expect(jobInfo?.modelBaseUrl).toBe('http://127.0.0.1:30001/v1')
  expect(jobInfo?.providerConfigJson).toEqual({manualWorkerUrls: ['http://127.0.0.1:30001'], workerUrlMode: 'runtime'})
})

test('claims each SQLite prompt pair at most once under competing writers', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-contention-${Date.now()}`
  const modelId = `model-contention-${Date.now()}`
  const projectId = `project-contention-${Date.now()}`
  const jobId = `job-contention-${Date.now()}`
  const workerCount = 4
  const promptPairs = Array.from({length: 12}, (_value, index) => {
    return {articleId: `article-contention-${index + 1}`, promptId: `prompt-contention-${index + 1}`}
  })
  const syncDir = join(dirname(tempDbPath), `judgment-job-sqlite-contention-${jobId}`)
  const startPath = join(syncDir, 'start')
  const readyPaths = Array.from({length: workerCount}, (_value, index) => {
    return join(syncDir, `worker-${index}.ready`)
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
    VALUES ('${projectId}', 'SQLite Queue Contention Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, promptPairs, 'server-seed')

  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  const workerScript = `
    import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
    import {dirname} from 'node:path'
    import {randomUUID} from 'node:crypto'
    import {Database} from 'bun:sqlite'

    const sqlitePath = process.env.SQLITE_PATH
    const readyPath = process.env.SQLITE_READY_PATH
    const startPath = process.env.SQLITE_START_PATH
    const workerId = process.env.SQLITE_WORKER_ID

    if (!sqlitePath || !readyPath || !startPath || !workerId) {
      throw new Error('Missing SQLite worker env')
    }

    const waitForStart = () => {
      return existsSync(startPath)
        ? Promise.resolve()
        : new Promise((resolve) => {
            setTimeout(() => resolve(waitForStart()), 10)
          })
    }

    mkdirSync(dirname(readyPath), {recursive: true})
    writeFileSync(readyPath, 'ready')
    await waitForStart()

    const database = new Database(sqlitePath)
    database.exec(\`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    \`)
    const selectReady = database.query(\`
      SELECT id, article_id AS articleId, prompt_id AS promptId
      FROM queue_prompt
      WHERE status = 'ready'
      ORDER BY ready_insert_seq ASC, id ASC
      LIMIT 1
    \`)
    const markClaimed = database.query(\`
      UPDATE queue_prompt
      SET status = 'claimed',
          sent_at = ?,
          updated_at = ?,
          server_id = ?,
          claim_id = ?
      WHERE id = ?
        AND status = 'ready'
    \`)
    const waitForRetry = () => {
      return new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
    const claimOnePrompt = async () => {
      try {
        return database.transaction(() => {
          const now = new Date().toISOString()
          const row = selectReady.get() as {articleId: string; id: string; promptId: string} | null

          if (!row) {
            return []
          }

          const result = markClaimed.run(now, now, workerId, randomUUID(), row.id) as {changes?: number}

          return result.changes === 1 ? [{articleId: row.articleId, promptId: row.promptId}] : []
        })()
      } catch (error) {
        const isBusyError = error instanceof Error && 'code' in error && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'].includes(String(error.code))

        if (isBusyError) {
          await waitForRetry()
          return claimOnePrompt()
        }

        throw error
      }
    }
    const claimUntilEmpty = async (claims) => {
      const nextClaims = await claimOnePrompt()
      return nextClaims.length === 0 ? claims : claimUntilEmpty([...claims, ...nextClaims])
    }

    const claims = await claimUntilEmpty([])
    database.close()
    process.stdout.write(JSON.stringify({claims}))
  `

  const workers = readyPaths.map((readyPath, index) => {
    return globalThis.Bun.spawn(['bun', '-e', workerScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SQLITE_PATH: sqlitePath,
        SQLITE_READY_PATH: readyPath,
        SQLITE_START_PATH: startPath,
        SQLITE_WORKER_ID: `writer-${index + 1}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
  })

  try {
    await waitForPaths(readyPaths, 15_000)

    writeFileSync(startPath, 'start')

    const results = await Promise.all(
      workers.map(async (worker) => {
        const exitCode = await worker.exited
        const stdout = await new Response(worker.stdout).text()
        const stderr = await new Response(worker.stderr).text()

        return {exitCode, stderr, stdout}
      }),
    )

    results.forEach(({exitCode, stderr}) => {
      if (exitCode !== 0 || stderr !== '') {
        throw new Error(`SQLite contention worker failed: exit=${exitCode} stderr=${stderr}`)
      }
    })

    const claims = results.flatMap(({stdout}) => {
      return (JSON.parse(stdout) as {claims: Array<{articleId: string; promptId: string}>}).claims
    })
    const uniqueClaims = new Set(
      claims.map((claim) => {
        return `${jobId}:${claim.articleId}:${claim.promptId}`
      }),
    )
    const expectedClaims = new Set(
      promptPairs.map((pair) => {
        return `${jobId}:${pair.articleId}:${pair.promptId}`
      }),
    )

    expect(claims).toHaveLength(promptPairs.length)
    expect(uniqueClaims.size).toBe(promptPairs.length)
    expect(uniqueClaims).toEqual(expectedClaims)
    expect(await service.getReadyCount(jobId)).toBe(0)
    expect(await service.getInFlightCount(jobId)).toBe(promptPairs.length)
  } finally {
    workers.forEach((worker) => {
      if (worker.exitCode === null) {
        worker.kill('SIGTERM')
      }
    })
    await Promise.all(
      workers.map(async (worker) => {
        return worker.exitCode === null ? worker.exited.catch(() => {}) : undefined
      }),
    )
    rmSync(syncDir, {force: true, recursive: true})
  }
}, 20_000)

test('stores full SQLite scan state without clearing existing cursor fields', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-scan-${Date.now()}`
  const modelId = `model-scan-${Date.now()}`
  const projectId = `project-scan-${Date.now()}`
  const jobId = `job-scan-${Date.now()}`
  const seededCursorDate = new Date('2025-01-02T03:04:05.000Z')
  const updatedExhaustedAt = new Date('2025-01-03T03:04:05.000Z')

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
    VALUES ('${projectId}', 'SQLite Scan State Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, cursor_last_created_at, cursor_last_article_id)
    VALUES ('${jobId}', '${projectId}', 'running', '${seededCursorDate.toISOString()}', 'seed-article')
  `)

  await service.initializeJob(jobId)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate, priorityBucket: 0},
    exhaustedAt: null,
    lastProjectRefreshAckSeq: null,
    scanEpoch: 0,
    wrapVisibilityAckSeq: null,
  })

  await service.setScanState(jobId, {lastProjectRefreshAckSeq: 17, scanEpoch: 2, wrapVisibilityAckSeq: 19})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'seed-article', lastDate: seededCursorDate, priorityBucket: 0},
    exhaustedAt: null,
    lastProjectRefreshAckSeq: 17,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setScanState(jobId, {
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
  })

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
    exhaustedAt: null,
    lastProjectRefreshAckSeq: 17,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setExhaustedAt(jobId, updatedExhaustedAt)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 17,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setLastProjectRefreshAckSeq(jobId, 23)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setLastProjectRefreshAckSeq(jobId, 19)
  await service.setScanState(jobId, {lastProjectRefreshAckSeq: 11})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: 19,
  })

  await service.setScanState(jobId, {wrapVisibilityAckSeq: null})

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {
      lastArticleId: 'priority-article',
      lastDate: seededCursorDate,
      lastPromptId: 'prompt-2',
      priorityBucket: 1,
    },
    exhaustedAt: updatedExhaustedAt,
    lastProjectRefreshAckSeq: 23,
    scanEpoch: 2,
    wrapVisibilityAckSeq: null,
  })
})

test('upgrades legacy job_scan_state ack columns in place without losing row data', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-scan-upgrade-${Date.now()}`
  const modelId = `model-scan-upgrade-${Date.now()}`
  const projectId = `project-scan-upgrade-${Date.now()}`
  const jobId = `job-scan-upgrade-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const legacyCursorDate = new Date('2025-02-02T03:04:05.000Z')
  const legacyExhaustedAt = new Date('2025-02-03T03:04:05.000Z')

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
    VALUES ('${projectId}', 'SQLite Scan State Upgrade Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, cursor_last_created_at, cursor_last_article_id)
    VALUES ('${jobId}', '${projectId}', 'running', '${legacyCursorDate.toISOString()}', 'legacy-article')
  `)

  const legacyDatabase = new Database(sqlitePath)
  legacyDatabase.exec(`
    CREATE TABLE job_scan_state (
      job_id TEXT PRIMARY KEY,
      cursor_last_date TEXT,
      cursor_last_article_id TEXT,
      scan_epoch INTEGER NOT NULL DEFAULT 0,
      exhausted_at TEXT,
      last_project_refresh_ack_seq INTEGER,
      wrap_visibility_ack_seq INTEGER,
      updated_at TEXT NOT NULL
    );

    INSERT INTO job_scan_state (
      job_id,
      cursor_last_date,
      cursor_last_article_id,
      scan_epoch,
      exhausted_at,
      last_project_refresh_ack_seq,
      wrap_visibility_ack_seq,
      updated_at
    ) VALUES (
      '${jobId}',
      '${legacyCursorDate.toISOString()}',
      'legacy-article',
      7,
      '${legacyExhaustedAt.toISOString()}',
      41,
      43,
      '${legacyExhaustedAt.toISOString()}'
    );
  `)
  legacyDatabase.close(false)

  await service.initializeJob(jobId)

  expect(await service.getScanState(jobId)).toEqual({
    cursor: {lastArticleId: 'legacy-article', lastDate: legacyCursorDate, priorityBucket: 0},
    exhaustedAt: legacyExhaustedAt,
    lastProjectRefreshAckSeq: 41,
    scanEpoch: 7,
    wrapVisibilityAckSeq: 43,
  })

  await service.closeAll()

  const upgradedDatabase = new Database(sqlitePath, {readonly: true})
  const upgradedColumns = (
    upgradedDatabase.query(`PRAGMA table_info('job_scan_state')`).all() as Array<{name: string}>
  ).map((row) => {
    return row.name
  })
  const upgradedRow = upgradedDatabase
    .query(
      `
        SELECT
          last_project_refresh_ack_token AS lastProjectRefreshAckToken,
          wrap_visibility_ack_token AS wrapVisibilityAckToken,
          cursor_last_article_id AS cursorLastArticleId,
          scan_epoch AS scanEpoch
        FROM job_scan_state
        WHERE job_id = ?
      `,
    )
    .get(jobId) as {
    cursorLastArticleId: string
    lastProjectRefreshAckToken: number | null
    scanEpoch: number
    wrapVisibilityAckToken: number | null
  } | null
  upgradedDatabase.close(false)

  expect(upgradedColumns).toContain('last_project_refresh_ack_token')
  expect(upgradedColumns).toContain('wrap_visibility_ack_token')
  expect(upgradedColumns).toContain('cursor_last_prompt_id')
  expect(upgradedColumns).not.toContain('last_project_refresh_ack_seq')
  expect(upgradedColumns).not.toContain('wrap_visibility_ack_seq')
  expect(upgradedRow).toEqual({
    cursorLastArticleId: 'legacy-article',
    lastProjectRefreshAckToken: 41,
    scanEpoch: 7,
    wrapVisibilityAckToken: 43,
  })
})

test('upgrades legacy queue_prompt schema in place and backfills enqueue order without losing rows', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-legacy-queue-upgrade-${Date.now()}`
  const modelId = `model-legacy-queue-upgrade-${Date.now()}`
  const projectId = `project-legacy-queue-upgrade-${Date.now()}`
  const jobId = `job-legacy-queue-upgrade-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const firstCreatedAt = '2025-02-04T03:04:05.000Z'
  const secondCreatedAt = '2025-02-04T03:04:06.000Z'
  const thirdCreatedAt = '2025-02-04T03:04:07.000Z'

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
    VALUES ('${projectId}', 'Legacy Queue Upgrade Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  const legacyDatabase = new Database(sqlitePath)
  legacyDatabase.exec(`
    CREATE TABLE queue_prompt (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      server_id TEXT,
      claim_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, article_id, prompt_id)
    );

    INSERT INTO queue_prompt (
      id,
      job_id,
      article_id,
      prompt_id,
      status,
      server_id,
      claim_id,
      sent_at,
      created_at,
      updated_at
    ) VALUES
      ('queue-2', '${jobId}', 'article-second', 'prompt-second', 'ready', NULL, NULL, NULL, '${secondCreatedAt}', '${secondCreatedAt}'),
      ('queue-1', '${jobId}', 'article-first', 'prompt-first', 'ready', NULL, NULL, NULL, '${firstCreatedAt}', '${firstCreatedAt}'),
      ('queue-3', '${jobId}', 'article-third', 'prompt-third', 'ready', NULL, NULL, NULL, '${thirdCreatedAt}', '${thirdCreatedAt}');
  `)
  legacyDatabase.close(false)

  await service.initializeJob(jobId)

  expect(await service.getReadyCount(jobId)).toBe(3)
  expect(
    (await service.claimReadyPrompts(jobId, 'server-a', 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-first', 'article-second', 'article-third'])

  await service.closeAll()

  const upgradedDatabase = new Database(sqlitePath, {readonly: true})
  const upgradedColumns = (
    upgradedDatabase.query(`PRAGMA table_info('queue_prompt')`).all() as Array<{name: string}>
  ).map((row) => {
    return row.name
  })
  const upgradedRows = upgradedDatabase
    .query(
      `
        SELECT article_id AS articleId, ready_insert_seq AS readyInsertSeq
        FROM queue_prompt
        ORDER BY ready_insert_seq ASC, id ASC
      `,
    )
    .all() as Array<{articleId: string; readyInsertSeq: number}>
  upgradedDatabase.close(false)

  expect(upgradedColumns).toContain('ready_insert_seq')
  expect(upgradedRows).toEqual([
    {articleId: 'article-first', readyInsertSeq: 1},
    {articleId: 'article-second', readyInsertSeq: 2},
    {articleId: 'article-third', readyInsertSeq: 3},
  ])
})

test('publishes a refresh ack token to every tracked sqlite job for the same project', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-project-ack-${Date.now()}`
  const modelId = `model-project-ack-${Date.now()}`
  const projectId = `project-project-ack-${Date.now()}`
  const firstJobId = `job-project-ack-a-${Date.now()}`
  const secondJobId = `job-project-ack-b-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Project Ack Fanout Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)

  expect(await service.publishProjectRefreshAck({ackToken: 17, projectId})).toBe(2)
  expect((await service.getScanState(firstJobId)).lastProjectRefreshAckSeq).toBe(17)
  expect((await service.getScanState(secondJobId)).lastProjectRefreshAckSeq).toBe(17)
})

test('publishProjectRefreshAck skips tracked jobs with an active competing lease', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-project-ack-skip-${Date.now()}`
  const modelId = `model-project-ack-skip-${Date.now()}`
  const projectId = `project-project-ack-skip-${Date.now()}`
  const firstJobId = `job-project-ack-skip-a-${Date.now()}`
  const secondJobId = `job-project-ack-skip-b-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Project Ack Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)
  await service.releaseOwnedLease(secondJobId)

  writeFileSync(
    getJudgmentJobLeasePath(secondJobId),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date().toISOString(),
        hostname: 'foreign-host',
        jobId: secondJobId,
        leaseId: `active-${crypto.randomUUID()}`,
        machineFingerprint: 'foreign-fingerprint',
        pid: 123_456,
        serverJobId: 'foreign-owner',
      },
      null,
      2,
    ),
  )

  expect(await service.publishProjectRefreshAck({ackToken: 17, projectId})).toBe(1)
  expect((await service.getScanState(firstJobId)).lastProjectRefreshAckSeq).toBe(17)
  expect((await service.getScanState(secondJobId)).lastProjectRefreshAckSeq).toBeNull()
})

test('reconciles sqlite refresh ack fanout from ledger state after a partial post-completion crash', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-project-ack-reconcile-${Date.now()}`
  const modelId = `model-project-ack-reconcile-${Date.now()}`
  const projectId = `project-project-ack-reconcile-${Date.now()}`
  const firstJobId = `job-project-ack-reconcile-a-${Date.now()}`
  const secondJobId = `job-project-ack-reconcile-b-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Project Ack Reconcile Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)

  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})
  const [claim] = await refreshStateService.claimDirtyProjects({
    leaseMs: 1_000,
    limit: 1,
    workerId: 'worker-ack-reconcile',
  })

  expect(claim?.claimedToken).toBe(dirtyState?.dirtyToken)

  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-ack-reconcile',
  })

  const originalSetLastProjectRefreshAckSeq = service.setLastProjectRefreshAckSeq
  let publishCalls = 0
  service.setLastProjectRefreshAckSeq = async (jobId: string, ackToken: number | null) => {
    publishCalls += 1

    if (publishCalls === 2) {
      throw new Error('sqlite ack publish exploded')
    }

    return originalSetLastProjectRefreshAckSeq(jobId, ackToken)
  }

  try {
    await service.publishProjectRefreshAck({ackToken: dirtyState?.dirtyToken ?? 0, projectId})
    throw new Error('Expected sqlite ack publish failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('sqlite ack publish exploded')
  } finally {
    service.setLastProjectRefreshAckSeq = originalSetLastProjectRefreshAckSeq
  }

  expect((await service.getScanState(firstJobId)).lastProjectRefreshAckSeq).toBe(dirtyState?.dirtyToken ?? 0)
  expect((await service.getScanState(secondJobId)).lastProjectRefreshAckSeq).toBeNull()

  expect(await service.reconcileProjectRefreshAcks({projectId})).toBe(2)
  expect((await service.getScanState(firstJobId)).lastProjectRefreshAckSeq).toBe(dirtyState?.dirtyToken ?? 0)
  expect((await service.getScanState(secondJobId)).lastProjectRefreshAckSeq).toBe(dirtyState?.dirtyToken ?? 0)
})

test('reconcileProjectRefreshAcks skips tracked jobs with an active competing lease', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-project-ack-reconcile-skip-${Date.now()}`
  const modelId = `model-project-ack-reconcile-skip-${Date.now()}`
  const projectId = `project-project-ack-reconcile-skip-${Date.now()}`
  const firstJobId = `job-project-ack-reconcile-skip-a-${Date.now()}`
  const secondJobId = `job-project-ack-reconcile-skip-b-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Project Ack Reconcile Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)
  await service.releaseOwnedLease(secondJobId)

  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})
  const [claim] = await refreshStateService.claimDirtyProjects({leaseMs: 1_000, limit: 1, workerId: 'worker-ack-skip'})

  expect(claim?.claimedToken).toBe(dirtyState?.dirtyToken)

  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-ack-skip',
  })

  writeFileSync(
    getJudgmentJobLeasePath(secondJobId),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date().toISOString(),
        hostname: 'foreign-host',
        jobId: secondJobId,
        leaseId: `active-${crypto.randomUUID()}`,
        machineFingerprint: 'foreign-fingerprint',
        pid: 123_456,
        serverJobId: 'foreign-owner',
      },
      null,
      2,
    ),
  )

  expect(await service.reconcileProjectRefreshAcks({projectId})).toBe(1)
  expect((await service.getScanState(firstJobId)).lastProjectRefreshAckSeq).toBe(dirtyState?.dirtyToken ?? 0)
  expect((await service.getScanState(secondJobId)).lastProjectRefreshAckSeq).toBeNull()
})

test('isolated SQLite preflight upgrades legacy ack columns before readonly validation', async () => {
  if (!sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const jobId = `job-preflight-upgrade-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const createdAt = new Date('2025-02-04T03:04:05.000Z').toISOString()
  const legacyDatabase = new Database(sqlitePath)

  legacyDatabase.exec(`
    CREATE TABLE job_info (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE job_scan_state (
      job_id TEXT PRIMARY KEY,
      cursor_last_date TEXT,
      cursor_last_article_id TEXT,
      scan_epoch INTEGER NOT NULL DEFAULT 0,
      exhausted_at TEXT,
      last_project_refresh_ack_seq INTEGER,
      wrap_visibility_ack_seq INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE queue_prompt (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      server_id TEXT,
      claim_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE judgment_outbox (
      outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL UNIQUE,
      judgment_id TEXT NOT NULL UNIQUE,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT
    );

    INSERT INTO job_info (
      job_id,
      project_id,
      model_id,
      model_name,
      model_provider,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      created_at
    ) VALUES ('${jobId}', 'project', 'model', 'Model', 'provider', 1, 1, 0, 0, '${createdAt}');

    INSERT INTO job_scan_state (
      job_id,
      cursor_last_date,
      cursor_last_article_id,
      scan_epoch,
      exhausted_at,
      last_project_refresh_ack_seq,
      wrap_visibility_ack_seq,
      updated_at
    ) VALUES ('${jobId}', '${createdAt}', 'legacy-article', 3, NULL, 11, 13, '${createdAt}');

    INSERT INTO queue_prompt (
      id,
      job_id,
      article_id,
      prompt_id,
      status,
      server_id,
      claim_id,
      sent_at,
      created_at,
      updated_at
    ) VALUES ('queue-1', '${jobId}', 'article-1', 'prompt-1', 'judged', NULL, NULL, NULL, '${createdAt}', '${createdAt}');

    INSERT INTO judgment_outbox (
      job_id,
      queue_prompt_id,
      judgment_id,
      article_id,
      prompt_id,
      model_id,
      created_at,
      updated_at,
      exported_at
    ) VALUES ('${jobId}', 'queue-1', 'judgment-1', 'article-1', 'prompt-1', 'model', '${createdAt}', '${createdAt}', NULL);
  `)
  legacyDatabase.close(false)

  const snapshot = await service.runIsolatedPreflight(jobId)

  expect(snapshot.queueSampleCount).toBe(1)
  expect(snapshot.outboxSampleCount).toBe(1)

  const upgradedDatabase = new Database(sqlitePath, {readonly: true})
  const upgradedColumns = (
    upgradedDatabase.query(`PRAGMA table_info('job_scan_state')`).all() as Array<{name: string}>
  ).map((row) => {
    return row.name
  })
  const upgradedQueueColumns = (
    upgradedDatabase.query(`PRAGMA table_info('queue_prompt')`).all() as Array<{name: string}>
  ).map((row) => {
    return row.name
  })
  const upgradedQueueRows = upgradedDatabase
    .query(
      `
        SELECT article_id AS articleId, ready_insert_seq AS readyInsertSeq
        FROM queue_prompt
        ORDER BY ready_insert_seq ASC, id ASC
      `,
    )
    .all() as Array<{articleId: string; readyInsertSeq: number}>
  upgradedDatabase.close(false)

  expect(upgradedColumns).toContain('last_project_refresh_ack_token')
  expect(upgradedColumns).toContain('wrap_visibility_ack_token')
  expect(upgradedColumns).not.toContain('last_project_refresh_ack_seq')
  expect(upgradedColumns).not.toContain('wrap_visibility_ack_seq')
  expect(upgradedQueueColumns).toContain('ready_insert_seq')
  expect(upgradedQueueRows).toEqual([{articleId: 'article-1', readyInsertSeq: 1}])
})

test('claims, reaps, releases, and completes outbox batches', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-outbox-${Date.now()}`
  const modelId = `model-outbox-${Date.now()}`
  const projectId = `project-outbox-${Date.now()}`
  const jobId = `job-outbox-${Date.now()}`
  const promptId = `prompt-outbox-${Date.now()}`
  const articleId = `article-outbox-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Outbox Claim Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-outbox-${Date.now()}`,
    modelId,
    projectId,
    promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const firstClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(firstClaim?.rows).toHaveLength(1)
  expect(
    await service.claimPendingOutboxBatch({claimedBy: 'server-b', jobId, maxBytes: 1024 * 1024, maxRows: 10}),
  ).toBeNull()
  expect(await service.reapStaleOutboxClaims({jobId, staleBefore: new Date(Date.now() + 1000)})).toBe(1)

  const secondClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-b',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(secondClaim?.rows).toHaveLength(1)
  expect(
    await service.releaseOutboxClaim({
      claimId: secondClaim?.claim.claimId ?? '',
      errorMessage: 'temporary failure',
      jobId,
    }),
  ).toBe(1)

  const thirdClaim = await service.claimPendingOutboxBatch({
    claimedBy: 'server-c',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  expect(thirdClaim?.rows).toHaveLength(1)
  expect(await service.completeOutboxClaim({claimId: thirdClaim?.claim.claimId ?? '', jobId})).toBe(1)
  expect(await service.getUnexportedOutboxCount(jobId)).toBe(0)
})

test('reapStaleOutboxClaims skips jobs with an active competing lease', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-reap-skip-${Date.now()}`
  const modelId = `model-reap-skip-${Date.now()}`
  const projectId = `project-reap-skip-${Date.now()}`
  const jobId = `job-reap-skip-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Reap Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)

  writeFileSync(
    getJudgmentJobLeasePath(jobId),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date().toISOString(),
        hostname: 'foreign-host',
        jobId,
        leaseId: `active-${crypto.randomUUID()}`,
        machineFingerprint: 'foreign-fingerprint',
        pid: 123_456,
        serverJobId: 'foreign-owner',
      },
      null,
      2,
    ),
  )

  expect(await service.reapStaleOutboxClaims({jobId, staleBefore: new Date(Date.now() + 1000)})).toBe(0)
})

test('computes a per-job SQLite health snapshot', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-health-${Date.now()}`
  const modelId = `model-health-${Date.now()}`
  const projectId = `project-health-${Date.now()}`
  const jobId = `job-health-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Health Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-health-ready', promptId: 'prompt-health-ready'},
      {articleId: 'article-health-judged', promptId: 'prompt-health-judged'},
      {articleId: 'article-health-skipped', promptId: 'prompt-health-skipped'},
      {articleId: 'article-health-claimed', promptId: 'prompt-health-claimed'},
    ],
    'server-a',
  )

  const [judgedPrompt, skippedPrompt, claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 3)

  if (!judgedPrompt || !skippedPrompt || !claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for health snapshot test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: judgedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(Date.now() - 1_000),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-health-${Date.now()}`,
    modelId,
    projectId,
    promptId: judgedPrompt.promptId,
    queuePromptId: judgedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')

  await service.claimPendingOutboxBatch({claimedBy: 'server-a', jobId, maxBytes: 1024 * 1024, maxRows: 10})
  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})

  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-health-snapshot',
  })
  await service.setLastProjectRefreshAckSeq(jobId, dirtyState?.dirtyToken ?? null)

  const snapshot = await service.getHealthSnapshot(jobId)

  expect(snapshot.sqliteFileBytes).not.toBeNull()
  expect(snapshot.sqliteFileBytes ?? 0).toBeGreaterThan(0)
  expect(snapshot.walBytes).toBeGreaterThanOrEqual(0)
  expect(snapshot.outboxRowCount).toBe(1)
  expect(snapshot.oldestUnexportedAgeMs).toBeGreaterThanOrEqual(0)
  expect(snapshot.claimedOutboxCount).toBe(1)
  expect(snapshot.promptCounts).toEqual({claimed: 1, judged: 1, ready: 1, running: 0, skipped: 1})
  expect(snapshot.lastAckSeq).toBe(dirtyState?.dirtyToken ?? null)
  expect(snapshot.retainedRowCount).toBe(4)
})

test('returns safe health snapshot defaults when the SQLite job db is missing', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-health-missing-${Date.now()}`
  const modelId = `model-health-missing-${Date.now()}`
  const projectId = `project-health-missing-${Date.now()}`
  const jobId = `job-health-missing-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'SQLite Missing Health Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  expect(await service.getHealthSnapshot(jobId)).toEqual({
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
  })
})

test('prunes only visibility-acked exported outbox rows in bounded batches', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-retention-${Date.now()}`
  const modelId = `model-retention-${Date.now()}`
  const projectId = `project-retention-${Date.now()}`
  const jobId = `job-retention-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Retention Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-retention-1', promptId: 'prompt-retention-1'},
      {articleId: 'article-retention-2', promptId: 'prompt-retention-2'},
      {articleId: 'article-retention-3', promptId: 'prompt-retention-3'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 3)

  await Promise.all(
    claimedPrompts.map((claimedPrompt, index) => {
      const suffix = index + 1

      return service.recordJudgmentSuccess(jobId, {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
        articleId: claimedPrompt.articleId,
        chunkingStrategy: null,
        confidenceOriginal: 50,
        createdAt: new Date(),
        explanation: 'because',
        isAnswered: true,
        judgmentId: `judgment-retention-${suffix}-${Date.now()}`,
        modelId,
        projectId,
        promptId: claimedPrompt.promptId,
        queuePromptId: claimedPrompt.recordId,
        quotes: ['quote'],
        rawResponseJson: {answer: 'yes'},
        snapshotProjectId: projectId,
        snapshotProjectModelName: 'Qwen 35B',
        updatedAt: new Date(),
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      })
    }),
  )

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-retention-bounded',
  })
  await service.setLastProjectRefreshAckSeq(jobId, dirtyState?.dirtyToken ?? null)

  expect(await service.getOutboxCount(jobId)).toBe(3)

  const firstPrune = await service.pruneVisibilityAckedRetention({jobId, maxRows: 1})

  expect(firstPrune).toEqual({outboxRowsDeleted: 1, queuePromptRowsDeleted: 1})
  expect(await service.getOutboxCount(jobId)).toBe(2)
  expect(
    (await service.getPromptStatusCounts(jobId)).find((row) => {
      return row.status === 'judged'
    })?.count ?? 0,
  ).toBe(2)

  const secondPrune = await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})

  expect(secondPrune).toEqual({outboxRowsDeleted: 2, queuePromptRowsDeleted: 2})
  expect(await service.getOutboxCount(jobId)).toBe(0)
  expect(await service.getMaxOutboxSeq(jobId)).toBeNull()
  expect(
    (await service.getPromptStatusCounts(jobId)).find((row) => {
      return row.status === 'judged'
    })?.count ?? 0,
  ).toBe(0)
})

test('pruneVisibilityAckedRetention skips jobs with an active competing lease', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-prune-skip-${Date.now()}`
  const modelId = `model-prune-skip-${Date.now()}`
  const projectId = `project-prune-skip-${Date.now()}`
  const jobId = `job-prune-skip-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Prune Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-prune-skip',
  })
  await service.setLastProjectRefreshAckSeq(jobId, dirtyState?.dirtyToken ?? null)
  await service.releaseOwnedLease(jobId)

  writeFileSync(
    getJudgmentJobLeasePath(jobId),
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date().toISOString(),
        hostname: 'foreign-host',
        jobId,
        leaseId: `active-${crypto.randomUUID()}`,
        machineFingerprint: 'foreign-fingerprint',
        pid: 123_456,
        serverJobId: 'foreign-owner',
      },
      null,
      2,
    ),
  )

  expect(await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 0,
    queuePromptRowsDeleted: 0,
  })
})

test('published refresh ack tokens unlock retention pruning for every sqlite job in the project', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const now = Date.now()
  const connectionId = `connection-retention-replay-${now}`
  const modelId = `model-retention-replay-${now}`
  const projectId = `project-retention-replay-${now}`
  const firstJobId = `job-retention-replay-a-${now}`
  const secondJobId = `job-retention-replay-b-${now}`

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
    VALUES ('${projectId}', 'SQLite Retention Replay Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)
  await service.addReadyPrompts(
    firstJobId,
    [{articleId: `article-retention-replay-a-${now}`, promptId: `prompt-retention-replay-a-${now}`}],
    'server-a',
  )
  await service.addReadyPrompts(
    secondJobId,
    [{articleId: `article-retention-replay-b-${now}`, promptId: `prompt-retention-replay-b-${now}`}],
    'server-a',
  )

  const [firstClaimedPrompt] = await service.claimReadyPrompts(firstJobId, 'server-a', 1)
  const [secondClaimedPrompt] = await service.claimReadyPrompts(secondJobId, 'server-a', 1)

  if (!firstClaimedPrompt || !secondClaimedPrompt) {
    throw new Error('Expected claimed prompts for retention replay test')
  }

  await service.recordJudgmentSuccess(firstJobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: firstClaimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-replay-a-${now}`,
    modelId,
    projectId,
    promptId: firstClaimedPrompt.promptId,
    queuePromptId: firstClaimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.recordJudgmentSuccess(secondJobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: secondClaimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-replay-b-${now}`,
    modelId,
    projectId,
    promptId: secondClaimedPrompt.promptId,
    queuePromptId: secondClaimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const firstOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId: firstJobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const secondOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId: secondJobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  await service.completeOutboxClaim({claimId: firstOutboxBatch?.claim.claimId ?? '', jobId: firstJobId})
  await service.completeOutboxClaim({claimId: secondOutboxBatch?.claim.claimId ?? '', jobId: secondJobId})

  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})
  const [refreshClaim] = await refreshStateService.claimDirtyProjects({
    leaseMs: 1_000,
    limit: 1,
    workerId: 'worker-retention-replay',
  })

  expect(refreshClaim?.claimedToken).toBe(dirtyState?.dirtyToken)

  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-retention-replay',
  })
  await service.setLastProjectRefreshAckSeq(firstJobId, dirtyState?.dirtyToken ?? 0)

  expect(await service.pruneVisibilityAckedRetention({jobId: firstJobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 1,
    queuePromptRowsDeleted: 1,
  })
  expect(await service.pruneVisibilityAckedRetention({jobId: secondJobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 0,
    queuePromptRowsDeleted: 0,
  })

  expect(await service.reconcileProjectRefreshAcks({projectId})).toBe(2)
  await service.setLastProjectRefreshAckSeq(secondJobId, dirtyState?.dirtyToken ?? 0)
  expect(await service.pruneVisibilityAckedRetention({jobId: secondJobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 1,
    queuePromptRowsDeleted: 1,
  })
})

test('keeps skipped and unacked prompt rows during visibility-acked retention cleanup', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const service = sqliteService()
  const connectionId = `connection-retention-skip-${Date.now()}`
  const modelId = `model-retention-skip-${Date.now()}`
  const projectId = `project-retention-skip-${Date.now()}`
  const jobId = `job-retention-skip-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Retention Skip Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-retention-acked', promptId: 'prompt-retention-acked'},
      {articleId: 'article-retention-skipped', promptId: 'prompt-retention-skipped'},
      {articleId: 'article-retention-unacked', promptId: 'prompt-retention-unacked'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 3)
  const ackedPrompt = claimedPrompts[0]
  const skippedPrompt = claimedPrompts[1]
  const unackedPrompt = claimedPrompts[2]

  if (!ackedPrompt || !skippedPrompt || !unackedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for retention cleanup test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: ackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-acked-${Date.now()}`,
    modelId,
    projectId,
    promptId: ackedPrompt.promptId,
    queuePromptId: ackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')
  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: unackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-retention-unacked-${Date.now()}`,
    modelId,
    projectId,
    promptId: unackedPrompt.promptId,
    queuePromptId: unackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const ackedOutboxSeq =
    (claimedOutboxBatch?.rows ?? []).find((row) => {
      return row.queuePromptId === ackedPrompt.recordId
    })?.outboxSeq ?? null
  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await refreshStateService.completeProjectRefresh({
    completedToken: dirtyState?.dirtyToken ?? 0,
    projectId,
    workerId: 'worker-retention-skip',
  })
  await service.setLastProjectRefreshAckSeq(jobId, dirtyState?.dirtyToken ?? ackedOutboxSeq)

  expect(await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 2,
    queuePromptRowsDeleted: 2,
  })
  expect(await service.hasLocalJudgment(jobId, ackedPrompt.articleId, ackedPrompt.promptId)).toBe(false)
  expect(await service.hasLocalJudgment(jobId, skippedPrompt.articleId, skippedPrompt.promptId)).toBe(true)
  expect(await service.hasLocalJudgment(jobId, unackedPrompt.articleId, unackedPrompt.promptId)).toBe(false)
  expect(await service.getOutboxCount(jobId)).toBe(0)
})

test('transitions draining SQLite jobs to drained only after retention cleanup and checkpointing finish', async () => {
  if (!queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drained-delete-${Date.now()}`
  const modelId = `model-drained-delete-${Date.now()}`
  const projectId = `project-drained-delete-${Date.now()}`
  const jobId = `job-drained-delete-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Drained Delete Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-drained-acked', promptId: 'prompt-drained-acked'},
      {articleId: 'article-drained-skipped', promptId: 'prompt-drained-skipped'},
    ],
    'server-a',
  )

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', 2)
  const ackedPrompt = claimedPrompts[0]
  const skippedPrompt = claimedPrompts[1]

  if (!ackedPrompt || !skippedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for drained delete test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: ackedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drained-acked-${Date.now()}`,
    modelId,
    projectId,
    promptId: ackedPrompt.promptId,
    queuePromptId: ackedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const ackedOutboxSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, ackedOutboxSeq)

  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'draining'}])

  await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})

  expect(await service.finalizeDrainingJobs({jobId})).toEqual([jobId])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'drained'}])
  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(true)
  expect(await service.deleteDrainedJobs({jobId})).toEqual([jobId])
  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(false)
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(false)
})

test('transitions paused draining SQLite jobs to drained only after retention cleanup and checkpointing finish', async () => {
  if (!queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-paused-drain-${Date.now()}`
  const modelId = `model-paused-drain-${Date.now()}`
  const projectId = `project-paused-drain-${Date.now()}`
  const jobId = `job-paused-drain-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Paused Drain Transition Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-paused-drain', promptId: 'prompt-paused-drain'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for paused drain transition test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-paused-drain-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const ackedOutboxSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, ackedOutboxSeq)

  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'draining'}])

  await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})

  expect(await service.finalizeDrainingJobs({jobId})).toEqual([jobId])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'drained'}])
})

test('orphan judged queue rows keep draining SQLite jobs out of drained state', async () => {
  if (!queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-orphan-drain-${Date.now()}`
  const modelId = `model-orphan-drain-${Date.now()}`
  const projectId = `project-orphan-drain-${Date.now()}`
  const jobId = `job-orphan-drain-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Orphan Drain Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-orphan-drain', promptId: 'prompt-orphan-drain'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for orphan drain test')
  }

  await service.markPromptAsJudged(jobId, claimedPrompt.recordId)

  expect(await service.getOutboxCount(jobId)).toBe(0)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'draining'}])
})

test('retained outbox rows keep draining SQLite jobs out of drained state', async () => {
  if (!queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drained-keep-${Date.now()}`
  const modelId = `model-drained-keep-${Date.now()}`
  const projectId = `project-drained-keep-${Date.now()}`
  const jobId = `job-drained-keep-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Drained Keep Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-drained-pending', promptId: 'prompt-drained-pending'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for drained keep test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drained-pending-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await service.claimPendingOutboxBatch({claimedBy: 'server-a', jobId, maxBytes: 1024 * 1024, maxRows: 10})
  await service.completeOutboxClaim({
    claimId: (await service.getClaimedOutboxBatch({jobId, serverJobId: 'server-a'}))?.claim.claimId ?? '',
    jobId,
  })

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'draining'}])
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(getJudgmentJobSqlitePath(jobId))).toBe(true)
})

test('deletes drained SQLite job files deterministically only after draining finalizes', async () => {
  if (!queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-drain-lifecycle-${Date.now()}`
  const modelId = `model-drain-lifecycle-${Date.now()}`
  const projectId = `project-drain-lifecycle-${Date.now()}`
  const jobId = `job-drain-lifecycle-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Drain Lifecycle Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-drain-lifecycle', promptId: 'prompt-drain-lifecycle'}],
    'server-a',
  )

  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const leasePath = getJudgmentJobLeasePath(jobId)
  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for drain lifecycle test')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `judgment-drain-lifecycle-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 35B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(true)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  const claimedOutboxBatch = await service.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })
  const outboxSeq = claimedOutboxBatch?.rows[0]?.outboxSeq ?? null

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  await service.setLastProjectRefreshAckSeq(jobId, outboxSeq)

  expect(await service.getOutboxCount(jobId)).toBe(1)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(true)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([])
  expect(await service.deleteDrainedJobs({jobId})).toEqual([])
  expect(existsSync(sqlitePath)).toBe(true)
  expect(existsSync(leasePath)).toBe(true)

  expect(await service.pruneVisibilityAckedRetention({jobId, maxRows: 10})).toEqual({
    outboxRowsDeleted: 1,
    queuePromptRowsDeleted: 1,
  })
  expect(await service.getOutboxCount(jobId)).toBe(0)
  expect(await service.hasLocalJudgment(jobId, claimedPrompt.articleId, claimedPrompt.promptId)).toBe(false)
  expect(await service.finalizeDrainingJobs({jobId})).toEqual([jobId])
  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'drained'}])
  expect(await service.deleteDrainedJobs({jobId})).toEqual([jobId])
  expect(existsSync(sqlitePath)).toBe(false)
  expect(existsSync(leasePath)).toBe(false)
})

test('syncOwnedLeases releases only inactive SQLite job leases', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-sync-${Date.now()}`
  const modelId = `model-sync-${Date.now()}`
  const firstProjectId = `project-sync-a-${Date.now()}`
  const firstJobId = `job-sync-a-${Date.now()}`
  const secondProjectId = `project-sync-b-${Date.now()}`
  const secondJobId = `job-sync-b-${Date.now()}`

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
    VALUES ('${firstProjectId}', 'SQLite Lease Sync A', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${secondProjectId}', 'SQLite Lease Sync B', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${firstJobId}', '${firstProjectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${secondJobId}', '${secondProjectId}', 'running')
  `)

  await service.initializeJob(firstJobId)
  await service.initializeJob(secondJobId)
  await service.ensureOwnedLease(firstJobId, 'server-a')
  await service.ensureOwnedLease(secondJobId, 'server-a')

  expect(service.hasOwnedLease(firstJobId)).toBe(true)
  expect(service.hasOwnedLease(secondJobId)).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(firstJobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(secondJobId))).toBe(true)

  await service.syncOwnedLeases([firstJobId])

  expect(service.hasOwnedLease(firstJobId)).toBe(true)
  expect(service.hasOwnedLease(secondJobId)).toBe(false)
  expect(existsSync(getJudgmentJobLeasePath(firstJobId))).toBe(true)
  expect(existsSync(getJudgmentJobLeasePath(secondJobId))).toBe(false)
})

test('ensureOwnedLease recovers a job lease when a stale replacement lease is detected', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-lease-recover-${Date.now()}`
  const modelId = `model-lease-recover-${Date.now()}`
  const projectId = `project-lease-recover-${Date.now()}`
  const jobId = `job-lease-recover-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Lease Recover', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  const firstLease = await service.ensureOwnedLease(jobId, 'server-a')

  const leasePath = getJudgmentJobLeasePath(jobId)
  const staleLease: JudgmentJobLeaseMetadata = {
    ...firstLease.metadata,
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    leaseId: crypto.randomUUID(),
    pid: 999_999,
    serverJobId: 'other-process',
  }

  writeFileSync(leasePath, JSON.stringify(staleLease, null, 2))

  const nextLease = await service.ensureOwnedLease(jobId, 'server-a')

  expect(nextLease.metadata.leaseId).not.toBe(staleLease.leaseId)
  expect(nextLease.metadata.leaseId).not.toBe(firstLease.metadata.leaseId)
  expect(service.hasOwnedLease(jobId)).toBe(true)
  expect(readFileSync(leasePath, 'utf8')).toContain(nextLease.metadata.leaseId)
})

test('ensureOwnedLease fails refresh when an active competing process lease is detected', async () => {
  if (!runDatabase || !sqliteService || !JudgmentJobLeaseError) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-lease-conflict-${Date.now()}`
  const modelId = `model-lease-conflict-${Date.now()}`
  const projectId = `project-lease-conflict-${Date.now()}`
  const jobId = `job-lease-conflict-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Lease Conflict', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  const firstLease = await service.ensureOwnedLease(jobId, 'server-a')

  const leasePath = getJudgmentJobLeasePath(jobId)
  const activeLease: JudgmentJobLeaseMetadata = {
    ...firstLease.metadata,
    heartbeatAt: new Date().toISOString(),
    hostname: 'foreign-host',
    machineFingerprint: 'foreign-fingerprint',
    leaseId: `active-${crypto.randomUUID()}`,
    pid: process.pid,
    serverJobId: 'other-live-process',
  }

  writeFileSync(leasePath, JSON.stringify(activeLease, null, 2))

  const refreshError = await service
    .ensureOwnedLease(jobId, 'server-a')
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  expect(refreshError).toBeInstanceOf(JudgmentJobLeaseError)
  expect(service.hasOwnedLease(jobId)).toBe(false)
  expect(refreshError instanceof Error ? refreshError.message : '').toContain(
    `Failed to refresh SQLite job lease for ${jobId}`,
  )
})

test('recoverJudgmentJobLeasesOnStartup recovers stale lease files', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-startup-recover-${Date.now()}`
  const modelId = `model-startup-recover-${Date.now()}`
  const projectId = `project-startup-recover-${Date.now()}`
  const jobId = `job-startup-recover-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Startup Recover', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)

  const leasePath = getJudgmentJobLeasePath(jobId)
  writeFileSync(
    leasePath,
    JSON.stringify(
      {
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
        hostname: 'foreign-host',
        jobId,
        leaseId: `stale-${crypto.randomUUID()}`,
        pid: 999_999,
        serverJobId: 'startup-recover-server',
      },
      null,
      2,
    ),
  )

  const recovery = await service.recoverJudgmentJobLeasesOnStartup({jobIds: [jobId]})

  expect(recovery.recovered).toContain(jobId)
  expect(service.hasOwnedLease(jobId)).toBe(true)
  expect(readFileSync(leasePath, 'utf8')).toContain('startup-recover-server')
  expect(readFileSync(leasePath, 'utf8')).not.toContain('stale-')
})

test('recoverJudgmentJobLeasesOnStartup ignores an active competing lease', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-startup-ignore-${Date.now()}`
  const modelId = `model-startup-ignore-${Date.now()}`
  const projectId = `project-startup-ignore-${Date.now()}`
  const jobId = `job-startup-ignore-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Startup Ignore', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)

  const leasePath = getJudgmentJobLeasePath(jobId)
  writeFileSync(
    leasePath,
    JSON.stringify(
      {
        acquiredAt: new Date(Date.now() + 60_000).toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date(Date.now() + 60_000).toISOString(),
        hostname: 'foreign-host',
        machineFingerprint: 'foreign-fingerprint',
        jobId,
        leaseId: `active-${crypto.randomUUID()}`,
        pid: 123_456,
        serverJobId: 'foreign-startup',
      },
      null,
      2,
    ),
  )

  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  const recovery = await service.recoverJudgmentJobLeasesOnStartup({jobIds: [jobId]})
  const runtimeFailureMessages = consoleError.mock.calls
    .map((call) => {
      return String(call[0] ?? '')
    })
    .filter((message) => {
      return message.includes('[judgments] failed to recover SQLite job lease during startup recovery')
    })
  consoleError.mockRestore()

  expect(recovery.ignored).toContain(jobId)
  expect(runtimeFailureMessages).toEqual([])
  expect(service.hasOwnedLease(jobId)).toBe(false)
  expect(existsSync(leasePath)).toBe(true)
})

test('recoverJudgmentJobLeasesOnStartup deletes orphaned lease files', async () => {
  if (!sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const jobId = `job-startup-orphan-${Date.now()}`
  const leasePath = getJudgmentJobLeasePath(jobId)
  await service.releaseOwnedLease(jobId)

  writeFileSync(
    leasePath,
    JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
        heartbeatAt: new Date().toISOString(),
        hostname: 'foreign-host',
        jobId,
        leaseId: `orphan-${crypto.randomUUID()}`,
        pid: 123_456,
        serverJobId: 'orphan-startup',
      },
      null,
      2,
    ),
  )

  const recovery = await service.recoverJudgmentJobLeasesOnStartup({jobIds: [jobId]})

  expect(recovery.deleted).toContain(jobId)
  expect(existsSync(leasePath)).toBe(false)
  expect(service.hasOwnedLease(jobId)).toBe(false)
})
