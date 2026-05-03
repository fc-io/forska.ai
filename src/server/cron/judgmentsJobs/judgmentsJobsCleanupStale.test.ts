import {existsSync} from 'node:fs'

import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'
import {getRequestAttemptLifecycleState, parseRequestAttempts} from './judgmentRequestAttemptManifest.ts'
import {
  getProviderAdmissionProbeLeaseIdentity,
  getProviderAdmissionRequestLeaseIdentity,
} from './providerAdmissionLease.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-cleanup-stale')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let judgmentsJobsCleanupStale: (() => Promise<void>) | null = null
let runStartupJudgmentRolloutCleanup: ((input: {claimedBy: string}) => Promise<unknown>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    cleanupModule,
    rolloutCleanupModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentsJobsCleanupStale.ts'),
    import('./judgmentStartupRolloutCleanup.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  judgmentsJobsCleanupStale = cleanupModule.judgmentsJobsCleanupStale
  runStartupJudgmentRolloutCleanup = rolloutCleanupModule.runStartupJudgmentRolloutCleanup
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
})

test('startup rollout cleanup preserves local completion evidence before discarding active runtime rows', async () => {
  if (!queryDatabase || !runDatabase || !runStartupJudgmentRolloutCleanup || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const timestamp = Date.now()
  const connectionId = `startup-rollout-connection-${timestamp}`
  const modelId = `startup-rollout-model-${timestamp}`
  const projectId = `startup-rollout-project-${timestamp}`
  const jobId = `startup-rollout-job-${timestamp}`
  const judgedArticleId = `startup-rollout-judged-article-${timestamp}`
  const judgedPromptId = `startup-rollout-judged-prompt-${timestamp}`
  const readyArticleId = `startup-rollout-ready-article-${timestamp}`
  const readyPromptId = `startup-rollout-ready-prompt-${timestamp}`

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
    VALUES ('${projectId}', 'Startup rollout cleanup test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES
      ('${judgedArticleId}', 'external-${judgedArticleId}', 'Startup rollout judged article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
      ('${readyArticleId}', 'external-${readyArticleId}', 'Startup rollout ready article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES
      ('${judgedPromptId}', 'Startup rollout judged prompt', '${judgedPromptId}-hash'),
      ('${readyPromptId}', 'Startup rollout ready prompt', '${readyPromptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: judgedArticleId, promptId: judgedPromptId},
      {articleId: readyArticleId, promptId: readyPromptId},
    ],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for startup rollout cleanup test')
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
    judgmentId: `startup-rollout-judgment-${timestamp}`,
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

  expect(await service.getUnexportedOutboxCount(jobId)).toBe(1)

  await runStartupJudgmentRolloutCleanup({claimedBy: 'server-a'})

  const health = await service.getHealthSnapshot(jobId)
  const [job] = await queryDatabase<{error: unknown; status: string; storageState: string}>(`
    SELECT
      TO_JSON(error) AS error,
      status,
      storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `)
  const [judgmentCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${judgedArticleId}'
      AND prompt_id = '${judgedPromptId}'
      AND model_id = '${modelId}'
  `)

  expect(job).toEqual({error: null, status: 'paused', storageState: 'draining'})
  expect(Number(judgmentCount?.count ?? 0)).toBe(1)
  expect(health.outboxRowCount).toBe(1)
  expect(health.pendingCompletionAckCount).toBe(1)
  expect(health.promptCounts).toEqual({claimed: 0, judged: 1, ready: 0, running: 0, skipped: 0})

  await service.deleteJob(jobId)
  await runDatabase(`
    UPDATE app.judgment_job
    SET status = 'completed',
        storage_state = 'drained'
    WHERE id = '${jobId}'
  `)
})

test('startup rollout cleanup fails local jobs only when no completion evidence remains', async () => {
  if (!queryDatabase || !runDatabase || !runStartupJudgmentRolloutCleanup || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const timestamp = Date.now()
  const connectionId = `startup-rollout-empty-connection-${timestamp}`
  const modelId = `startup-rollout-empty-model-${timestamp}`
  const projectId = `startup-rollout-empty-project-${timestamp}`
  const jobId = `startup-rollout-empty-job-${timestamp}`
  const articleId = `startup-rollout-empty-article-${timestamp}`
  const promptId = `startup-rollout-empty-prompt-${timestamp}`

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
    VALUES ('${projectId}', 'Startup rollout no evidence test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES ('${articleId}', 'external-${articleId}', 'Startup rollout no evidence article', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Startup rollout no evidence prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  await runStartupJudgmentRolloutCleanup({claimedBy: 'server-a'})

  const health = await service.getHealthSnapshot(jobId)
  const [job] = await queryDatabase<{error: unknown; status: string; storageState: string}>(`
    SELECT
      TO_JSON(error) AS error,
      status,
      storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `)

  expect(job).toEqual({error: '["robustSendRolloutDiscarded"]', status: 'failed', storageState: 'active'})
  expect(health.outboxRowCount).toBe(0)
  expect(health.pendingCompletionAckCount).toBe(0)
  expect(health.promptCounts).toEqual({claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0})

  await service.deleteJob(jobId)
  await runDatabase(`
    UPDATE app.judgment_job
    SET status = 'completed',
        storage_state = 'drained'
    WHERE id = '${jobId}'
  `)
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('cleanupStale automatically repairs recoverable orphaned judged queue rows for draining jobs', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `cleanup-stale-orphan-connection-${Date.now()}`
  const modelId = `cleanup-stale-orphan-model-${Date.now()}`
  const projectId = `cleanup-stale-orphan-project-${Date.now()}`
  const jobId = `cleanup-stale-orphan-job-${Date.now()}`
  const articleId = `cleanup-stale-orphan-article-${Date.now()}`
  const promptId = `cleanup-stale-orphan-prompt-${Date.now()}`

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
    VALUES ('${projectId}', 'Cleanup stale orphan repair test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Cleanup stale orphan article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Cleanup stale orphan prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for cleanup stale orphan repair test')
  }

  await service.markPromptAsJudged(jobId, claimedPrompt.recordId)

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `),
  ).toEqual([{status: 'paused', storageState: 'draining'}])
  expect((await service.getHealthSnapshot(jobId)).orphanedJudgedRowCount).toBe(1)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `),
  ).toEqual([{status: 'paused', storageState: 'active'}])
  expect(await service.getHealthSnapshot(jobId)).toMatchObject({
    orphanedJudgedRowCount: 0,
    outboxRowCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 1, running: 0, skipped: 0},
    retainedRowCount: 1,
  })
})

test('cleanupStale finalizes terminal draining jobs without local SQLite files', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const connectionId = `cleanup-stale-missing-sqlite-connection-${Date.now()}`
  const modelId = `cleanup-stale-missing-sqlite-model-${Date.now()}`
  const projectId = `cleanup-stale-missing-sqlite-project-${Date.now()}`
  const jobId = `cleanup-stale-missing-sqlite-job-${Date.now()}`
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
    VALUES ('${projectId}', 'Cleanup stale missing SQLite drain test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  expect(existsSync(sqlitePath)).toBe(false)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
      SELECT status, storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{status: 'paused', storageState: 'drained'}])
  expect(existsSync(sqlitePath)).toBe(false)
})

test('cleanupStale clears acked draining retention beyond the legacy small batch in one run', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const {getProjectMartDirtyRefreshStateService} = await import('../../services/projectMartDirtyRefreshStateService.ts')
  const service = sqliteService()
  const refreshStateService = getProjectMartDirtyRefreshStateService()
  const rowCount = 150
  const timestamp = Date.now()
  const connectionId = `cleanup-stale-retention-connection-${timestamp}`
  const modelId = `cleanup-stale-retention-model-${timestamp}`
  const projectId = `cleanup-stale-retention-project-${timestamp}`
  const jobId = `cleanup-stale-retention-job-${timestamp}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const prompts = Array.from({length: rowCount}, (_, index) => {
    return {
      articleId: `cleanup-stale-retention-article-${timestamp}-${index}`,
      promptId: `cleanup-stale-retention-prompt-${timestamp}-${index}`,
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
    VALUES ('${projectId}', 'Cleanup stale retention drain test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, prompts, 'server-a')

  const claimedPrompts = await service.claimReadyPrompts(jobId, 'server-a', rowCount)

  await Promise.all(
    claimedPrompts.map((claimedPrompt, index) => {
      return service.recordJudgmentSuccess(jobId, {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
        articleId: claimedPrompt.articleId,
        chunkingStrategy: null,
        confidenceOriginal: 50,
        createdAt: new Date(),
        explanation: 'because',
        isAnswered: true,
        judgmentId: `cleanup-stale-retention-judgment-${timestamp}-${index}`,
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
    maxRows: rowCount,
  })
  const [dirtyState] = await refreshStateService.markProjectsDirtyAtomically({projects: [{projectId}]})

  await service.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})
  await service.setLastProjectRefreshAckSeq(jobId, dirtyState?.dirtyToken ?? null)

  expect((await service.getHealthSnapshot(jobId)).pendingCompletionAckCount).toBe(0)
  expect(await service.getOutboxCount(jobId)).toBe(rowCount)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{storageState: string}>(`
      SELECT storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{storageState: 'drained'}])
  expect(existsSync(sqlitePath)).toBe(false)
})

test('cleanupStale clears stale running prompts before finalizing draining jobs', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `cleanup-stale-running-connection-${Date.now()}`
  const modelId = `cleanup-stale-running-model-${Date.now()}`
  const projectId = `cleanup-stale-running-project-${Date.now()}`
  const jobId = `cleanup-stale-running-job-${Date.now()}`
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
    VALUES ('${projectId}', 'Cleanup stale running drain test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-stale-running', promptId: 'prompt-stale-running'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for cleanup stale running test')
  }

  await service.markPromptAsRunning(jobId, claimedPrompt.recordId)
  const sqliteDatabase = new Database(sqlitePath)

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET sent_at = ?
          WHERE id = ?
        `,
      )
      .run('2026-04-01T00:00:00.000Z', claimedPrompt.recordId)
  } finally {
    sqliteDatabase.close()
  }

  expect((await service.getHealthSnapshot(jobId)).promptCounts).toEqual({
    claimed: 0,
    judged: 0,
    ready: 0,
    running: 1,
    skipped: 0,
  })
  expect(existsSync(sqlitePath)).toBe(true)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
      SELECT status, storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{status: 'paused', storageState: 'drained'}])
  expect(existsSync(sqlitePath)).toBe(false)
})

test('stale prompt requeue closes recoverable live request attempts before a future attempt id exists', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const timestamp = Date.now()
  const connectionId = `cleanup-stale-lifecycle-connection-${timestamp}`
  const modelId = `cleanup-stale-lifecycle-model-${timestamp}`
  const projectId = `cleanup-stale-lifecycle-project-${timestamp}`
  const jobId = `cleanup-stale-lifecycle-job-${timestamp}`
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
    VALUES ('${projectId}', 'Cleanup stale lifecycle test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-stale-lifecycle', promptId: 'prompt-stale-lifecycle'}],
    'server-a',
  )

  const sqliteDatabase = new Database(sqlitePath)
  const queueRecordId = (() => {
    try {
      const row = sqliteDatabase.query(`SELECT id FROM queue_prompt LIMIT 1`).get() as {id: string} | null
      const recordId = row?.id ?? ''

      if (!recordId) {
        throw new Error('Expected queue prompt row')
      }
      sqliteDatabase
        .query(
          `
            UPDATE queue_prompt
            SET status = 'running',
                sent_at = ?,
                request_attempt_manifest_json = ?,
                request_attempt_manifest_version = 1,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          '2026-04-01T00:00:00.000Z',
          JSON.stringify([
            {
              closeoutKind: 'live_request',
              createdAt: '2026-04-01T00:00:00.000Z',
              jobId,
              lifecycleState: 'liveRequest',
              outcome: 'unknown',
              providerKey: 'provider:openai:default',
              queueRecordId: recordId,
              requestAttemptId: 'attempt-stale-live',
              startedAt: '2026-04-01T00:00:01.000Z',
            },
          ]),
          '2026-04-01T00:00:01.000Z',
          recordId,
        )

      return recordId
    } finally {
      sqliteDatabase.close()
    }
  })()

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date('2026-04-02T00:00:00.000Z'),
  })
  const inspectionDatabase = new Database(sqlitePath)

  try {
    const row = inspectionDatabase
      .query(
        `
          SELECT
            request_attempt_manifest_json AS requestAttemptManifestJson,
            status
          FROM queue_prompt
          WHERE id = ?
        `,
      )
      .get(queueRecordId) as {requestAttemptManifestJson: string; status: string} | null
    const [attempt] = parseRequestAttempts(row?.requestAttemptManifestJson)

    expect(requeued).toBe(1)
    expect(row?.status).toBe('ready')
    expect(attempt).toBeDefined()
    if (!attempt) {
      throw new Error('Expected closed request attempt')
    }
    expect(attempt?.requestAttemptId).toBe('attempt-stale-live')
    expect(getRequestAttemptLifecycleState(attempt)).toBe('closedRequest')
    expect(attempt?.closeoutReason).toBe('workerLostRequeued')
  } finally {
    inspectionDatabase.close()
  }
})

test('unavailable request diagnostics close explicitly after repair deadline without durable evidence', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const timestamp = Date.now()
  const connectionId = `cleanup-stale-unavailable-connection-${timestamp}`
  const modelId = `cleanup-stale-unavailable-model-${timestamp}`
  const projectId = `cleanup-stale-unavailable-project-${timestamp}`
  const jobId = `cleanup-stale-unavailable-job-${timestamp}`
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
    VALUES ('${projectId}', 'Cleanup stale unavailable test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-unavailable-lifecycle', promptId: 'prompt-unavailable-lifecycle'}],
    'server-a',
  )

  const sqliteDatabase = new Database(sqlitePath)
  const queueRecordId = (() => {
    try {
      const row = sqliteDatabase.query(`SELECT id FROM queue_prompt LIMIT 1`).get() as {id: string} | null
      const recordId = row?.id ?? ''

      if (!recordId) {
        throw new Error('Expected queue prompt row')
      }
      sqliteDatabase
        .query(
          `
            UPDATE queue_prompt
            SET status = 'judged',
                terminal_kind = 'closed',
                skip_reason = 'requestFailure',
                judged_at = ?,
                request_attempt_manifest_json = ?,
                request_attempt_manifest_version = 1,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          '2026-04-01T00:00:00.000Z',
          JSON.stringify([
            {
              closeoutKind: 'live_request',
              createdAt: '2026-04-01T00:00:00.000Z',
              jobId,
              lifecycleState: 'workerUnavailable',
              outcome: 'unknown',
              providerKey: 'provider:openai:default',
              queueRecordId: recordId,
              requestAttemptId: 'attempt-worker-unavailable',
              stateStartedAt: '2026-04-01T00:00:01.000Z',
              updatedAt: '2026-04-01T00:00:01.000Z',
            },
          ]),
          '2026-04-01T00:00:01.000Z',
          recordId,
        )

      return recordId
    } finally {
      sqliteDatabase.close()
    }
  })()

  const repaired = await service.repairUnavailableRequestAttemptDiagnostics({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date('2026-04-02T00:00:00.000Z'),
  })
  const inspectionDatabase = new Database(sqlitePath)

  try {
    const row = inspectionDatabase
      .query(
        `
          SELECT request_attempt_manifest_json AS requestAttemptManifestJson
          FROM queue_prompt
          WHERE id = ?
        `,
      )
      .get(queueRecordId) as {requestAttemptManifestJson: string} | null
    const [attempt] = parseRequestAttempts(row?.requestAttemptManifestJson)

    expect(repaired).toBe(1)
    expect(attempt).toBeDefined()
    if (!attempt) {
      throw new Error('Expected repaired request attempt')
    }
    expect(getRequestAttemptLifecycleState(attempt)).toBe('closedRequest')
    expect(attempt.closeoutReason).toBe('workerLostNoDurableResult')
  } finally {
    inspectionDatabase.close()
  }
})

test('cleanupStale releases token-use closed request leases without closing probe leases', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const timestamp = Date.now()
  const providerKey = `cleanup-stale-provider-lease-${timestamp}`
  const requestAttemptId = `cleanup-stale-request-attempt-${timestamp}`
  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity(requestAttemptId)
  const endpointAvailabilityKey = `${providerKey}::http://localhost:30001`
  const probeLeaseIdentity = getProviderAdmissionProbeLeaseIdentity({
    endpointAvailabilityKey,
    probeAttemptId: `cleanup-stale-probe-attempt-${timestamp}`,
  })
  const requestAttemptsJson = JSON.stringify([
    {
      closeoutKind: 'token_use',
      durableCloseoutRef: {id: `cleanup-stale-token-use-${timestamp}`, kind: 'token_use', requestAttemptId},
      outcome: 'success',
      providerKey,
      requestAttemptId,
    },
  ])

  await runDatabase(`
    INSERT INTO app.provider_admission_lease (
      provider_key,
      lease_kind,
      lease_identity,
      request_attempt_id,
      endpoint_availability_key,
      probe_attempt_id,
      holder_token,
      acquired_at,
      heartbeat_at,
      expires_at
    ) VALUES
      (
        ${getSqlLiteral(providerKey)},
        'request',
        ${getSqlLiteral(requestLeaseIdentity)},
        ${getSqlLiteral(requestAttemptId)},
        NULL,
        NULL,
        'request-holder',
        TIMESTAMPTZ '2026-05-04T10:00:00.000Z',
        TIMESTAMPTZ '2026-05-04T10:00:00.000Z',
        TIMESTAMPTZ '2036-05-04T10:00:00.000Z'
      ),
      (
        ${getSqlLiteral(providerKey)},
        'probe',
        ${getSqlLiteral(probeLeaseIdentity)},
        NULL,
        ${getSqlLiteral(endpointAvailabilityKey)},
        ${getSqlLiteral(`cleanup-stale-probe-attempt-${timestamp}`)},
        'probe-holder',
        TIMESTAMPTZ '2026-05-04T10:00:00.000Z',
        TIMESTAMPTZ '2026-05-04T10:00:00.000Z',
        TIMESTAMPTZ '2036-05-04T10:00:00.000Z'
      )
  `)
  await runDatabase(`
    INSERT INTO app.token_use (
      id,
      requests,
      total_prompt_tokens,
      total_completion_tokens,
      total_tokens,
      started_at,
      finished_at,
      request_attempts_json
    ) VALUES (
      ${getSqlLiteral(`cleanup-stale-token-use-${timestamp}`)},
      1,
      0,
      0,
      0,
      TIMESTAMPTZ '2026-05-04T10:00:00.000Z',
      TIMESTAMPTZ '2026-05-04T10:00:01.000Z',
      CAST(${getSqlLiteral(requestAttemptsJson)} AS JSON)
    )
  `)

  await judgmentsJobsCleanupStale()

  const rows = await queryDatabase<{leaseIdentity: string; leaseKind: string}>(`
    SELECT lease_identity AS leaseIdentity, lease_kind AS leaseKind
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
    ORDER BY lease_kind ASC
  `)

  expect(rows).toEqual([{leaseIdentity: probeLeaseIdentity, leaseKind: 'probe'}])
})

test('cleanupStale clears transient locked quarantine after SQLite preflight succeeds', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `cleanup-stale-lock-connection-${Date.now()}`
  const modelId = `cleanup-stale-lock-model-${Date.now()}`
  const projectId = `cleanup-stale-lock-project-${Date.now()}`
  const jobId = `cleanup-stale-lock-job-${Date.now()}`

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
    VALUES ('${projectId}', 'Cleanup stale transient lock test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${jobId}', '${projectId}', 'failed', 'quarantined', current_timestamp, 'database is locked')
  `)

  await service.initializeJob(jobId)
  await service.releaseOwnedLease(jobId)
  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{quarantineReason: string | null; status: string; storageState: string}>(`
      SELECT
        quarantine_reason AS quarantineReason,
        status,
        storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{quarantineReason: null, status: 'paused', storageState: 'active'}])
})
