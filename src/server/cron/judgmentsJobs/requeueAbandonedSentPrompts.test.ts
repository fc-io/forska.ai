import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-requeue-abandoned-prompts')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let requeueAbandonedSentPrompts: ((input: {jobIds: string[]; serverJobId: string}) => Promise<number>) | null = null

type QueueCountRow = {count: number; status: string}

const getQueueCountMap = (rows: QueueCountRow[]) => {
  return Object.fromEntries(
    rows.map((row) => {
      return [row.status, row.count]
    }),
  )
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    requeueModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./requeueAbandonedSentPrompts.ts'),
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
  requeueAbandonedSentPrompts = requeueModule.requeueAbandonedSentPrompts
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('requeues sent SQLite prompts claimed by an older server job', async () => {
  if (!runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = `job-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const connectionId = `connection-${Date.now()}`
  const oldServerJobId = 'server-job-old-host-3004-111'
  const currentServerJobId = 'server-job-new-host-3004-222'

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
    VALUES ('${projectId}', 'Requeue Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: `article-stale-${Date.now()}`, promptId: `prompt-stale-${Date.now()}`},
      {articleId: `article-current-${Date.now()}`, promptId: `prompt-current-${Date.now()}`},
    ],
    'server-job-queued',
  )

  const [stalePrompt, currentPrompt] = await sqliteService.claimReadyPrompts(jobId, oldServerJobId, 2)

  if (!stalePrompt || !currentPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for requeue test')
  }

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = 'claimed',
              sent_at = CASE
                  WHEN id = ? THEN ?
                  ELSE sent_at
                END,
              updated_at = CASE
                  WHEN id = ? THEN ?
                  ELSE updated_at
                END,
              server_id = CASE
                  WHEN id = ? THEN ?
                  ELSE ?
                END
          WHERE id IN (?, ?)
        `,
      )
      .run(
        stalePrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        stalePrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        currentPrompt.recordId,
        currentServerJobId,
        oldServerJobId,
        stalePrompt.recordId,
        currentPrompt.recordId,
      )
  } finally {
    sqliteDatabase.close()
  }

  const requeued = await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})

  expect(requeued).toBe(1)
  expect(await sqliteService.getReadyCount(jobId)).toBe(1)
  expect(await sqliteService.getInFlightCount(jobId)).toBe(1)
  await sqliteService.closeAll()
})

test('keeps older ready rows ahead of newer inserts and preserves stale sent queue position after requeue', async () => {
  if (!runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = `job-order-${Date.now()}`
  const projectId = `project-order-${Date.now()}`
  const modelId = `model-order-${Date.now()}`
  const connectionId = `connection-order-${Date.now()}`
  const oldServerJobId = 'server-job-old-host-3004-333'
  const currentServerJobId = 'server-job-new-host-3004-444'

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
    VALUES ('${projectId}', 'Requeue Ordering Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-stale-first', promptId: 'prompt-stale-first'},
      {articleId: 'article-ready-middle', promptId: 'prompt-ready-middle'},
    ],
    'server-job-queued',
  )

  const [stalePrompt] = await sqliteService.claimReadyPrompts(jobId, oldServerJobId, 1)

  if (!stalePrompt) {
    throw new Error('Failed to claim stale SQLite queue prompt for requeue order test')
  }

  await sqliteService.addReadyPrompts(
    jobId,
    [{articleId: 'article-human-newest', promptId: 'prompt-human-newest'}],
    'server-job-queued',
  )

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = 'claimed', sent_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        new Date(Date.now() - 45_000).toISOString(),
        new Date(Date.now() - 45_000).toISOString(),
        stalePrompt.recordId,
      )
  } finally {
    sqliteDatabase.close()
  }

  expect(await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})).toBe(1)
  expect(
    (await sqliteService.claimReadyPrompts(jobId, currentServerJobId, 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-stale-first', 'article-ready-middle', 'article-human-newest'])
  await sqliteService.closeAll()
})

test('requeues stale sent, claimed, and running prompts while leaving terminal rows untouched', async () => {
  if (!runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = `job-terminal-safe-${Date.now()}`
  const projectId = `project-terminal-safe-${Date.now()}`
  const modelId = `model-terminal-safe-${Date.now()}`
  const connectionId = `connection-terminal-safe-${Date.now()}`
  const oldServerJobId = 'server-job-old-host-3004-555'
  const currentServerJobId = 'server-job-new-host-3004-666'

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
    VALUES ('${projectId}', 'Requeue Terminal Safety Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-sent', promptId: 'prompt-sent'},
      {articleId: 'article-claimed', promptId: 'prompt-claimed'},
      {articleId: 'article-running', promptId: 'prompt-running'},
      {articleId: 'article-judged', promptId: 'prompt-judged'},
      {articleId: 'article-skipped', promptId: 'prompt-skipped'},
    ],
    'server-job-queued',
  )

  const claimedPrompts = await sqliteService.claimReadyPrompts(jobId, oldServerJobId, 5)
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
    return prompt.articleId === 'article-judged'
  })
  const skippedPrompt = claimedPrompts.find((prompt) => {
    return prompt.articleId === 'article-skipped'
  })

  if (!sentPrompt || !claimedPrompt || !runningPrompt || !judgedPrompt || !skippedPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for terminal safety test')
  }

  await sqliteService.markPromptAsRunning(jobId, runningPrompt.recordId)
  await sqliteService.markPromptAsJudged(jobId, judgedPrompt.recordId)
  await sqliteService.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')
  await sqliteService.closeAll()

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
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
                WHEN id IN (?, ?, ?) THEN ?
                ELSE server_id
              END
          WHERE id IN (?, ?, ?)
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
        oldServerJobId,
        sentPrompt.recordId,
        claimedPrompt.recordId,
        runningPrompt.recordId,
      )
  } finally {
    sqliteDatabase.close()
  }

  const requeued = await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})

  expect(requeued).toBe(3)
  expect(getQueueCountMap(await sqliteService.getPromptStatusCounts(jobId))).toEqual({judged: 1, ready: 3, skipped: 1})
  expect(
    (await sqliteService.claimReadyPrompts(jobId, currentServerJobId, 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-sent', 'article-claimed', 'article-running'])
  await sqliteService.closeAll()
})
