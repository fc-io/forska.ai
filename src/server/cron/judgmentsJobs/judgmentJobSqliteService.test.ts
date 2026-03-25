import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {afterAll, beforeAll, expect, test} from 'bun:test'

import {getJudgmentJobLeasePath} from './judgmentJobPaths.ts'

const tempDbPath = `/tmp/f1-judgment-job-sqlite-service-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

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
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
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
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getInFlightCount(jobId)).toBe(1)

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(2)
  expect(await service.getInFlightCount(jobId)).toBe(0)
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
