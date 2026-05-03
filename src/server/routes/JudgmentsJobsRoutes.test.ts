import {Database} from 'bun:sqlite'
import {afterAll, afterEach, beforeAll, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'
import {existsSync, rmSync, writeFileSync} from 'fs'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {HttpError} from '../utils/httpError.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-routes')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url)
  .pathname
const providerRuntimeMatchResolverModulePath = new URL('../providers/providerRuntimeMatchResolver.ts', import.meta.url)
  .pathname
const judgmentDispatchRuntimeModulePath = new URL('../cron/judgmentsJobs/judgmentDispatchRuntime.ts', import.meta.url)
  .pathname

const getDefaultRuntimeMatch = () => {
  return {
    candidate: null,
    detectedModelNames: ['Qwen/Qwen3.5-122B-A10B'],
    effectiveBaseURL: 'http://owner-sglang:30000/v1',
    effectiveWorkerUrls: ['http://owner-sglang-worker:30001'],
    localUrls: ['http://owner-sglang:30000/v1'],
    modelNames: ['Qwen/Qwen3.5-122B-A10B'],
    reason: 'runtime-auto-detect',
    reasons: ['runtime-auto-detect'],
    remoteUrls: [],
    resolutionMode: 'auto-detect',
    source: 'detected-runtime',
    sourceMetadata: null,
    status: 'matched',
  }
}

const state = {
  assertStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {}),
  getStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {
    return {message: null, ok: true, reason: null}
  }),
  getJudgmentDispatchProviderStats: mock(
    async (_input: {
      jobId: string
      providerConnectionId: string | null
      providerMaxInflightRequests: number | null
      providerUsesFamilyDefault: boolean
    }) => {
      return {
        jobActivePromptCount: 0,
        jobQueuedPromptCount: 0,
        providerActiveLimit: 1,
        providerActivePromptCount: 0,
        providerQueueLimit: 1,
        providerQueuedPromptCount: 0,
      }
    },
  ),
  getJudgmentDispatchQueueCapacity: mock(
    async (_input: {
      providerConnectionId: string | null
      providerMaxInflightRequests: number | null
      providerUsesFamilyDefault: boolean
    }) => {
      return 1
    },
  ),
  getJudgmentDispatchJobPromptIds: mock(async (_jobId: string) => {
    return []
  }),
  getJudgmentDispatchPromptLifecycleRecords: mock(async (_input: unknown) => {
    return []
  }),
  getJudgmentDispatchProviderKey: mock((input: {providerConnectionId: string | null}) => {
    return input.providerConnectionId ?? 'provider:unknown:default'
  }),
  enqueueClaimedJudgmentPrompts: mock(async (_input: {label: string; prompts: unknown[]}) => {
    return {acceptedCount: 0, rejectedPrompts: []}
  }),
  resolveProviderConnectionRuntimeMatch: mock(async (_input: unknown) => {
    return getDefaultRuntimeMatch()
  }),
}

const registerModuleMocks = () => {
  void mock.module(providerRuntimeModelGuardModulePath, () => {
    return {
      assertStoredProviderModelRuntimeMatch: state.assertStoredProviderModelRuntimeMatch,
      getStoredProviderModelRuntimeMatch: state.getStoredProviderModelRuntimeMatch,
    }
  })
  void mock.module(providerRuntimeMatchResolverModulePath, () => {
    return {resolveProviderConnectionRuntimeMatch: state.resolveProviderConnectionRuntimeMatch}
  })
  void mock.module(judgmentDispatchRuntimeModulePath, () => {
    return {
      enqueueClaimedJudgmentPrompts: state.enqueueClaimedJudgmentPrompts,
      getJudgmentDispatchJobPromptIds: state.getJudgmentDispatchJobPromptIds,
      getJudgmentDispatchPromptLifecycleRecords: state.getJudgmentDispatchPromptLifecycleRecords,
      getJudgmentDispatchProviderKey: state.getJudgmentDispatchProviderKey,
      getJudgmentDispatchProviderStats: state.getJudgmentDispatchProviderStats,
      getJudgmentDispatchQueueCapacity: state.getJudgmentDispatchQueueCapacity,
    }
  })
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  registerModuleMocks()

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])
  const judgmentsJobsRoutesModule = (await import(
    `./JudgmentsJobsRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./JudgmentsJobsRoutes.ts')
  const {judgmentsJobsRoutes} = judgmentsJobsRoutesModule

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
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

afterEach(async () => {
  state.assertStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {})
  state.getStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {
    return {message: null, ok: true, reason: null}
  })
  state.getJudgmentDispatchProviderStats.mockImplementation(async (_input) => {
    return {
      jobActivePromptCount: 0,
      jobQueuedPromptCount: 0,
      providerActiveLimit: 1,
      providerActivePromptCount: 0,
      providerQueueLimit: 1,
      providerQueuedPromptCount: 0,
    }
  })
  state.getJudgmentDispatchQueueCapacity.mockImplementation(async (_input) => {
    return 1
  })
  state.enqueueClaimedJudgmentPrompts.mockImplementation(async (_input) => {
    return {acceptedCount: 0, rejectedPrompts: []}
  })
  state.resolveProviderConnectionRuntimeMatch.mockImplementation(async (_input: unknown) => {
    return getDefaultRuntimeMatch()
  })
  state.resolveProviderConnectionRuntimeMatch.mockClear()
  const {resetProjectMartLargeRebuildRuntimeMetricsForTests} =
    await import('../utils/projectMartLargeRebuildRuntimeMetrics.ts')
  const {resetJudgmentEndpointAvailabilityForTests} =
    await import('../cron/judgmentsJobs/judgmentEndpointAvailability.ts')
  const {resetJudgmentJobStorageTransferRuntimeForTests} =
    await import('../cron/judgmentsJobs/judgmentJobStorageTransferRuntime.ts')
  const {resetDuckdbOwnerConnectionsForTests} = await import('../utils/duckdbOwnerConnections.ts')

  resetProjectMartLargeRebuildRuntimeMetricsForTests()
  resetJudgmentEndpointAvailabilityForTests()
  resetJudgmentJobStorageTransferRuntimeForTests()
  await resetDuckdbOwnerConnectionsForTests()
})

const registerJudgeWorkerHeartbeat = async () => {
  const [{upsertDuckdbOwnerConnectionHeartbeat}, {getRuntimeCutoverVersion}] = await Promise.all([
    import('../utils/duckdbOwnerConnections.ts'),
    import('../utils/runtimeCutover.ts'),
  ])
  const nowIso = new Date().toISOString()

  await upsertDuckdbOwnerConnectionHeartbeat({
    apiServerPort: 4102,
    capabilities: ['judging'],
    hostname: 'judging-test-host',
    instanceId: `judge-worker-server:judging-test-host:4102:1002:${nowIso}`,
    listenPort: 4102,
    memoryLimit: null,
    pid: 1002,
    processStartedAt: nowIso,
    runtimeProfile: 'local',
    runtimeVersion: getRuntimeCutoverVersion(),
    serverRole: 'judge-worker',
    service: 'judge-worker-server',
    startedAt: nowIso,
    duckdbOwnerUrl: `http://127.0.0.1:${process.env.API_SERVER_PORT}`,
  })
}

const insertProjectFixture = async ({
  connectionId,
  modelId,
  providerKind = 'sglang',
  projectId,
}: {
  connectionId: string
  modelId: string
  providerKind?: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', '${providerKind}', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'Runtime Match Project', '${modelId}')
  `)
}

const insertQueuedPromptFixture = async ({
  articleId,
  jobId,
  promptId,
}: {
  articleId: string
  jobId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
}

const insertOutboxFixture = async ({
  jobId,
  modelId,
  projectId,
}: {
  jobId: string
  modelId: string
  projectId: string
}) => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const articleId = `health-outbox-article-${Date.now()}`
  const promptId = `health-outbox-prompt-${Date.now()}`

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for health route test')
  }

  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 80,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `health-outbox-judgment-${Date.now()}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
}

const insertOrphanedJudgedQueueFixture = async ({
  articleId,
  jobId,
  promptId,
}: {
  articleId: string
  jobId: string
  promptId: string
}) => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for orphaned queue test')
  }

  await sqliteService.markPromptAsJudged(jobId, claimedPrompt.recordId)
}

const insertUnassessedServingFixture = async ({jobId, projectId}: {jobId: string; projectId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const articleId = `unassessed-serving-article-${Date.now()}`
  const promptId = `unassessed-serving-prompt-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Unassessed stale preview article',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      TIMESTAMPTZ '2025-09-10 00:00:00+00'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Unassessed prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ('project-prompt-${promptId}', '${projectId}', '${promptId}', 0)
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('project-article-${articleId}', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_review_serving_generation (project_id, active_generation)
    VALUES ('${projectId}', 1)
  `)
  await runDatabase(`
    INSERT INTO mart.review_article_serving (
      project_id,
      generation,
      article_id,
      article_created_at,
      article_updated_at,
      article_title,
      article_external_id,
      journal_title,
      url,
      full_text_pdf,
      full_text_fetched_at,
      full_text_conversion_status,
      source_metadata,
      has_all_llm_judgments,
      llm_judged_prompt_count,
      llm_judged_prompt_ids,
      enabled_prompt_count,
      human_answered_prompt_count,
      human_answered_prompt_ids,
      has_all_human_answers,
      review_opened,
      review_sections_completed,
      latest_llm_created_at,
      latest_human_updated_at,
      latest_review_updated_at,
      serving_updated_at
    ) VALUES (
      '${projectId}',
      1,
      '${articleId}',
      TIMESTAMPTZ '2025-09-09 00:00:00+00',
      TIMESTAMPTZ '2025-09-10 00:00:00+00',
      'Unassessed stale preview article',
      'external-${articleId}',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      TRUE,
      1,
      ['${promptId}'],
      1,
      0,
      NULL,
      FALSE,
      FALSE,
      0,
      current_timestamp,
      NULL,
      NULL,
      current_timestamp
    )
  `)
}

test('owner-backed claim route returns immutable execution snapshot identity and snapshot fetch returns payload', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `snapshot-claim-project-${Date.now()}`
  const modelId = `snapshot-claim-model-${Date.now()}`
  const connectionId = `snapshot-claim-connection-${Date.now()}`
  const jobId = `snapshot-claim-job-${Date.now()}`
  const articleId = `snapshot-claim-article-${Date.now()}`
  const promptId = `snapshot-claim-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const claimResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/claims`, {
      body: JSON.stringify({claimedBy: 'judge-worker-a', limit: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const claimBody = (await claimResponse.json()) as {
    data: {
      claims: Array<{
        articleId: string
        claimId: string
        executionSnapshotHash: string
        executionSnapshotId: string
        modelId: string
        projectId: string
        promptId: string
        recordId: string
      }>
    }
  }
  const [claim] = claimBody.data.claims

  expect(claimResponse.status).toBe(200)
  expect(claim).toMatchObject({articleId, modelId, projectId, promptId})
  expect(typeof claim?.claimId).toBe('string')
  expect(typeof claim?.executionSnapshotId).toBe('string')
  expect(claim?.executionSnapshotHash).toHaveLength(64)

  const snapshotResponse = await app.handle(
    new Request(
      `http://localhost/api/judgmentsjobs/execution-snapshots/${claim?.executionSnapshotId}?executionSnapshotHash=${claim?.executionSnapshotHash}`,
    ),
  )
  const snapshotBody = (await snapshotResponse.json()) as {
    data: {articleId: string; claimId: string; payload: {identity: {queueRecordId: string}}}
  }

  expect(snapshotResponse.status).toBe(200)
  expect(snapshotBody.data.articleId).toBe(articleId)
  expect(snapshotBody.data.claimId).toBe(claim?.claimId)
  expect(snapshotBody.data.payload.identity.queueRecordId).toBe(claim?.recordId)

  await sqliteService.closeAll()
})

test('owner-backed claim route honors claim limits above 100', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `large-claim-project-${Date.now()}`
  const modelId = `large-claim-model-${Date.now()}`
  const connectionId = `large-claim-connection-${Date.now()}`
  const jobId = `large-claim-job-${Date.now()}`
  const promptPairs = Array.from({length: 101}).map((_, index) => {
    return {articleId: `large-claim-article-${index}`, promptId: `large-claim-prompt-${index}`}
  })

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, promptPairs, 'server-a')

  const claimResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/claims`, {
      body: JSON.stringify({claimedBy: 'judge-worker-a', limit: 101}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const claimBody = (await claimResponse.json()) as {data: {claims: Array<{recordId: string}>}}

  expect(claimResponse.status).toBe(200)
  expect(claimBody.data.claims).toHaveLength(101)
  expect(await sqliteService.getClaimedCount(jobId)).toBe(101)
  expect(await sqliteService.getReadyCount(jobId)).toBe(0)

  await sqliteService.closeAll()
})

test('owner-backed claim requeues stale unprotected worker claims before claiming', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `snapshot-requeue-project-${Date.now()}`
  const modelId = `snapshot-requeue-model-${Date.now()}`
  const connectionId = `snapshot-requeue-connection-${Date.now()}`
  const jobId = `snapshot-requeue-job-${Date.now()}`
  const staleArticleId = `snapshot-requeue-stale-article-${Date.now()}`
  const freshArticleId = `snapshot-requeue-fresh-article-${Date.now()}`
  const stalePromptId = `snapshot-requeue-stale-prompt-${Date.now()}`
  const freshPromptId = `snapshot-requeue-fresh-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: staleArticleId, promptId: stalePromptId},
      {articleId: freshArticleId, promptId: freshPromptId},
    ],
    'server-a',
  )

  const staleClaimResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/claims`, {
      body: JSON.stringify({claimedBy: 'judge-worker-old', limit: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const staleClaimBody = (await staleClaimResponse.json()) as {data: {claims: Array<{recordId: string}>}}
  const [staleClaim] = staleClaimBody.data.claims

  if (!staleClaim) {
    throw new Error('Expected stale owner-backed claim')
  }

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET sent_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run('2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', staleClaim.recordId)
  } finally {
    sqliteDatabase.close()
  }

  const nextClaimResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/claims`, {
      body: JSON.stringify({claimedBy: 'judge-worker-new', limit: 2, protectedRecordIds: []}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const nextClaimBody = (await nextClaimResponse.json()) as {
    data: {claims: Array<{articleId: string; recordId: string}>}
  }

  expect(nextClaimResponse.status).toBe(200)
  expect(
    nextClaimBody.data.claims.map((claim) => {
      return claim.articleId
    }),
  ).toEqual([staleArticleId, freshArticleId])
  expect(await sqliteService.getClaimedCount(jobId)).toBe(2)
  expect(await sqliteService.getReadyCount(jobId)).toBe(0)

  await sqliteService.closeAll()
})

test('owner-backed completion rejects snapshot mismatch before accepting the claimed work', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `snapshot-complete-project-${Date.now()}`
  const modelId = `snapshot-complete-model-${Date.now()}`
  const connectionId = `snapshot-complete-connection-${Date.now()}`
  const jobId = `snapshot-complete-job-${Date.now()}`
  const articleId = `snapshot-complete-article-${Date.now()}`
  const promptId = `snapshot-complete-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const claimResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/claims`, {
      body: JSON.stringify({claimedBy: 'judge-worker-a', limit: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const claimBody = (await claimResponse.json()) as {
    data: {
      claims: Array<{
        articleId: string
        claimId: string
        executionSnapshotHash: string
        executionSnapshotId: string
        modelId: string
        projectId: string
        promptId: string
        recordId: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>
    }
  }
  const [claim] = claimBody.data.claims

  if (!claim) {
    throw new Error('Expected owner-backed claim')
  }

  const completionBody = {
    articleId: claim.articleId,
    claimId: claim.claimId,
    executionSnapshotHash: claim.executionSnapshotHash,
    executionSnapshotId: claim.executionSnapshotId,
    jobId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    modelId: claim.modelId,
    projectId: claim.projectId,
    promptId: claim.promptId,
    queueRecordId: claim.recordId,
    useAbstract: claim.useAbstract,
    useFulltext: claim.useFulltext,
    useFulltextNoImages: claim.useFulltextNoImages,
    useTitle: claim.useTitle,
  }
  const mismatchResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/completions`, {
      body: JSON.stringify({...completionBody, executionSnapshotHash: `bad-${claim.executionSnapshotHash.slice(4)}`}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(mismatchResponse.status).toBe(409)
  expect(await sqliteService.getOutboxCount(jobId)).toBe(0)

  const completionResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/completions`, {
      body: JSON.stringify(completionBody),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const completionResponseBody = (await completionResponse.json()) as {data: {status: string}}

  expect(completionResponse.status).toBe(200)
  expect(completionResponseBody.data.status).toBe('judged')
  expect(await sqliteService.getOutboxCount(jobId)).toBe(1)

  await sqliteService.closeAll()
})

test('owner-backed runtime route returns resolved non-Codex runtime diagnostics', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `runtime-owner-project-${Date.now()}`
  const modelId = `runtime-owner-model-${Date.now()}`
  const connectionId = `runtime-owner-connection-${Date.now()}`
  const jobId = `runtime-owner-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    UPDATE app.provider_connection
    SET base_url = 'http://saved-sglang:30000/v1',
        config_json = '{"manualWorkerUrls":[],"workerUrlMode":"runtime"}'
    WHERE id = '${connectionId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  state.resolveProviderConnectionRuntimeMatch.mockImplementationOnce(async (input: unknown) => {
    expect(input).toMatchObject({
      baseURL: 'http://saved-sglang:30000/v1',
      config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
      providerKind: 'sglang',
      savedModelIds: ['Qwen/Qwen3.5-122B-A10B'],
    })

    return getDefaultRuntimeMatch()
  })

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/runtime`))
  const body = (await response.json()) as {
    data: {
      job: {
        maxInflightRequests: number | null
        modelBaseUrl: string | null
        modelId: string
        modelProvider: string
        providerFamily: string
        providerId: string
        providerKey: string
        providerLimit: number
        providerLimitVersion: string
        providerName: string
        providerUsesFamilyDefault: boolean
        resolvedDefaultCapacity: number
        resolvedRuntime: {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]} | null
        runtimeMatchReason: string
        runtimeMatchStatus: string
        runtimeResolutionMode: string
      } | null
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.job).toMatchObject({
    maxInflightRequests: null,
    modelBaseUrl: 'http://saved-sglang:30000/v1',
    modelId,
    modelProvider: 'sglang',
    providerFamily: 'sglang',
    providerId: connectionId,
    providerKey: connectionId,
    providerName: 'SGLang',
    providerUsesFamilyDefault: true,
    resolvedRuntime: {
      modelBaseUrl: 'http://owner-sglang:30000/v1',
      modelProvider: 'sglang',
      modelWorkerUrls: ['http://owner-sglang-worker:30001'],
    },
    runtimeMatchReason: 'runtime-auto-detect',
    runtimeMatchStatus: 'matched',
    runtimeResolutionMode: 'auto-detect',
  })
  expect(body.data.job?.providerLimit).toBeGreaterThan(0)
  expect(body.data.job?.resolvedDefaultCapacity).toBe(body.data.job?.providerLimit)
  expect(body.data.job?.providerLimitVersion).toHaveLength(64)
  expect(state.resolveProviderConnectionRuntimeMatch).toHaveBeenCalledTimes(1)
})

test('owner-backed running jobs route returns provider bucket snapshots', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `running-owner-project-${Date.now()}`
  const modelId = `running-owner-model-${Date.now()}`
  const connectionId = `running-owner-connection-${Date.now()}`
  const jobId = `running-owner-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    UPDATE app.provider_connection
    SET max_inflight_requests = 3
    WHERE id = '${connectionId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  const response = await app.handle(new Request('http://localhost/api/judgmentsjobs-running'))
  const body = (await response.json()) as {
    data: {
      jobs: Array<{
        id: string
        maxInflightRequests: number | null
        providerFamily: string
        providerId: string
        providerKey: string
        providerLimit: number
        providerLimitVersion: string
        providerName: string
        providerUsesFamilyDefault: boolean
        resolvedDefaultCapacity: number
      }>
    }
  }
  const job = body.data.jobs.find((entry) => {
    return entry.id === jobId
  })

  expect(response.status).toBe(200)
  expect(job).toMatchObject({
    maxInflightRequests: 3,
    providerFamily: 'sglang',
    providerId: connectionId,
    providerKey: connectionId,
    providerLimit: 3,
    providerName: 'SGLang',
    providerUsesFamilyDefault: false,
  })
  expect(job?.resolvedDefaultCapacity).toBeGreaterThan(0)
  expect(job?.providerLimitVersion).toHaveLength(64)
})

test('creating a judgments job fails when the runtime model check fails', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const projectId = `runtime-mismatch-project-${Date.now()}`
  const modelId = `runtime-mismatch-model-${Date.now()}`
  const connectionId = `runtime-mismatch-connection-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  state.assertStoredProviderModelRuntimeMatch.mockImplementationOnce(async () => {
    throw new HttpError(400, 'Project model Qwen/Qwen3.5-122B-A10B does not match the active SGLang runtime.')
  })

  const response = await app.handle(
    new Request('http://localhost/api/judgmentsjobs', {
      body: JSON.stringify({projectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toContain('does not match the active SGLang runtime')
})

test('starting an existing judgments job fails when the runtime model check fails', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `runtime-restart-project-${Date.now()}`
  const modelId = `runtime-restart-model-${Date.now()}`
  const connectionId = `runtime-restart-connection-${Date.now()}`
  const jobId = `runtime-restart-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)
  state.assertStoredProviderModelRuntimeMatch.mockImplementationOnce(async () => {
    throw new HttpError(400, 'Project model Qwen/Qwen3.5-122B-A10B does not match the active SGLang runtime.')
  })

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toContain('does not match the active SGLang runtime')
})

test('starting a quarantined judgments job returns an actionable error', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `quarantine-start-project-${Date.now()}`
  const modelId = `quarantine-start-model-${Date.now()}`
  const connectionId = `quarantine-start-connection-${Date.now()}`
  const jobId = `quarantine-start-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${jobId}', '${projectId}', 'paused', 'quarantined', '${new Date().toISOString()}', 'sqlite checksum mismatch')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain(`Job ${jobId} is quarantined.`)
  expect(body).toContain('Repair or recreate the local SQLite job DB before starting or resuming it.')
})

test('starting a judgments job quarantines corrupt SQLite state after isolated preflight fails', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `corrupt-start-project-${Date.now()}`
  const modelId = `corrupt-start-model-${Date.now()}`
  const connectionId = `corrupt-start-connection-${Date.now()}`
  const jobId = `corrupt-start-job-${Date.now()}`
  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.closeAll()

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase.exec(`DROP TABLE queue_prompt`)
  } finally {
    sqliteDatabase.close(false)
  }

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain('missing table queue_prompt')

  const healthResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const healthBody = (await healthResponse.json()) as {
    quarantine: {quarantineReason: string | null}
    recommendedNextAction: string
    storageState: string
  }

  expect(healthResponse.status).toBe(200)
  expect(healthBody.storageState).toBe('quarantined')
  expect(healthBody.recommendedNextAction).toBe('repair_offline_required')
  expect(healthBody.quarantine.quarantineReason).toContain('missing table queue_prompt')

  rmSync(getJudgmentJobSqlitePath(jobId), {force: true})
  rmSync(`${getJudgmentJobSqlitePath(jobId)}-shm`, {force: true})
  rmSync(`${getJudgmentJobSqlitePath(jobId)}-wal`, {force: true})
  await sqliteService.closeAll()
})

test('starting a draining judgments job returns an actionable error', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `draining-start-project-${Date.now()}`
  const modelId = `draining-start-model-${Date.now()}`
  const connectionId = `draining-start-connection-${Date.now()}`
  const jobId = `draining-start-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, pause_requested_at)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining', current_timestamp)
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain(`Job ${jobId} is draining.`)
  expect(body).toContain('Wait for the local SQLite judgments to finish exporting before starting or resuming it.')
})

test('starting a job with a failing SQLite preflight quarantines it without starting', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `preflight-start-project-${Date.now()}`
  const modelId = `preflight-start-model-${Date.now()}`
  const connectionId = `preflight-start-connection-${Date.now()}`
  const jobId = `preflight-start-job-${Date.now()}`
  const {getAppDatabaseService} = await import('../services/appDatabaseService.ts')
  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'active')
  `)

  writeFileSync(sqlitePath, 'not a sqlite database')

  try {
    const response = await app.handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
        body: JSON.stringify({status: 'running'}),
        headers: {'content-type': 'application/json'},
        method: 'PATCH',
      }),
    )
    const body = await response.text()
    const [job] = await getAppDatabaseService().queryJson<{
      quarantineReason: string | null
      status: string
      storageState: string
    }>(`
      SELECT
        quarantine_reason AS quarantineReason,
        status AS status,
        storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
      LIMIT 1
    `)

    expect(response.status).toBe(409)
    expect(body).toContain(`Job ${jobId} is quarantined.`)
    expect(job?.status).toBe('failed')
    expect(job?.storageState).toBe('quarantined')
    expect(job?.quarantineReason).toContain('file is not a database')
  } finally {
    rmSync(sqlitePath, {force: true})
  }
})

test('starting a job with a transient locked SQLite preflight does not quarantine it', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `preflight-locked-project-${Date.now()}`
  const modelId = `preflight-locked-model-${Date.now()}`
  const connectionId = `preflight-locked-connection-${Date.now()}`
  const jobId = `preflight-locked-job-${Date.now()}`
  const {getAppDatabaseService} = await import('../services/appDatabaseService.ts')
  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const sqliteService = getJudgmentJobSqliteService()
  let didBegin = false

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'active')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.closeAll()

  const sqliteDatabase = new Database(sqlitePath)

  try {
    sqliteDatabase.exec('BEGIN EXCLUSIVE')
    didBegin = true

    const response = await app.handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
        body: JSON.stringify({status: 'running'}),
        headers: {'content-type': 'application/json'},
        method: 'PATCH',
      }),
    )
    const body = await response.text()
    const [job] = await getAppDatabaseService().queryJson<{
      quarantineReason: string | null
      status: string
      storageState: string
    }>(`
      SELECT
        quarantine_reason AS quarantineReason,
        status AS status,
        storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
      LIMIT 1
    `)

    expect(response.status).toBe(409)
    expect(body).toContain('transient lock')
    expect(body).toContain('was not quarantined')
    expect(job?.status).toBe('paused')
    expect(job?.storageState).toBe('active')
    expect(job?.quarantineReason).toBeNull()
  } finally {
    if (didBegin) {
      sqliteDatabase.exec('ROLLBACK')
    }
    sqliteDatabase.close(false)
    await sqliteService.closeAll()
    rmSync(sqlitePath, {force: true})
    rmSync(`${sqlitePath}-shm`, {force: true})
    rmSync(`${sqlitePath}-wal`, {force: true})
  }
})

test('pausing an existing judgments job succeeds when queued prompts reference the job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `pause-project-${Date.now()}`
  const modelId = `pause-model-${Date.now()}`
  const connectionId = `pause-connection-${Date.now()}`
  const jobId = `pause-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await insertQueuedPromptFixture({
    articleId: `pause-article-${Date.now()}`,
    jobId,
    promptId: `pause-prompt-${Date.now()}`,
  })

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'paused'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain('paused')
})

test('pausing a judgments job marks it draining, clears ready queue state, and releases the SQLite lease', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobLeasePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `pause-drain-project-${Date.now()}`
  const modelId = `pause-drain-model-${Date.now()}`
  const connectionId = `pause-drain-connection-${Date.now()}`
  const jobId = `pause-drain-job-${Date.now()}`
  const articleId = `pause-drain-article-${Date.now()}`
  const promptId = `pause-drain-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
  await sqliteService.ensureOwnedLease(jobId, 'server-a')

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'paused'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {
    data: {pauseRequestedAt: string | null; status: string; storageState: string}
  }

  expect(response.status).toBe(200)
  expect(body.data.status).toBe('paused')
  expect(body.data.storageState).toBe('draining')
  expect(body.data.pauseRequestedAt).not.toBeNull()
  expect(await sqliteService.getReadyCount(jobId)).toBe(0)
  expect(sqliteService.hasOwnedLease(jobId)).toBe(false)
  expect(await sqliteService.getInFlightCount(jobId)).toBe(0)
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(false)
})

test('starting a judgments job clean preserves token usage while recreating local SQLite state', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getAppDatabaseService} = await import('../services/appDatabaseService.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `start-clean-project-${Date.now()}`
  const modelId = `start-clean-model-${Date.now()}`
  const connectionId = `start-clean-connection-${Date.now()}`
  const jobId = `start-clean-job-${Date.now()}`
  const articleId = `start-clean-article-${Date.now()}`
  const promptId = `start-clean-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, pause_requested_at)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining', current_timestamp)
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
  await runDatabase(`
    INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
    VALUES ('start-clean-token-${Date.now()}', '${jobId}', 2, 12, 6, 18)
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/start-clean`, {method: 'POST'}),
  )
  const body = (await response.json()) as {
    data: {pauseRequestedAt: string | null; quarantineReason: string | null; status: string; storageState: string}
  }

  const tokenUseRows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.token_use
    WHERE judgment_job_id = '${jobId}'
  `)

  expect(response.status).toBe(200)
  expect(body.data.status).toBe('running')
  expect(body.data.storageState).toBe('active')
  expect(body.data.pauseRequestedAt).toBeNull()
  expect(body.data.quarantineReason).toBeNull()
  expect(sqliteService.hasJob(jobId)).toBe(true)
  expect(await sqliteService.getReadyCount(jobId)).toBe(0)
  expect(await sqliteService.getInFlightCount(jobId)).toBe(0)
  expect(Number(tokenUseRows[0]?.count ?? 0)).toBe(1)
})

test('judgment job routes expose storage health fields', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `storage-fields-project-${Date.now()}`
  const modelId = `storage-fields-model-${Date.now()}`
  const connectionId = `storage-fields-connection-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})

  const createResponse = await app.handle(
    new Request('http://localhost/api/judgmentsjobs', {
      body: JSON.stringify({projectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createBody = (await createResponse.json()) as {
    data: {
      jobId: string
      storageState: string
      quarantinedAt: string | null
      quarantineReason: string | null
      lastImportStartedAt: string | null
      lastImportCompletedAt: string | null
      lastImportErrorAt: string | null
      lastImportError: string | null
      lastImportExitCode: number | null
      importFailureCount: number
      pauseRequestedAt: string | null
    }
  }

  expect(createResponse.status).toBe(200)
  expect(createBody.data.storageState).toBe('active')
  expect(createBody.data.quarantinedAt).toBeNull()
  expect(createBody.data.quarantineReason).toBeNull()
  expect(createBody.data.lastImportStartedAt).toBeNull()
  expect(createBody.data.lastImportCompletedAt).toBeNull()
  expect(createBody.data.lastImportErrorAt).toBeNull()
  expect(createBody.data.lastImportError).toBeNull()
  expect(createBody.data.lastImportExitCode).toBeNull()
  expect(createBody.data.importFailureCount).toBe(0)
  expect(createBody.data.pauseRequestedAt).toBeNull()

  const detailsResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${createBody.data.jobId}`))
  const detailsBody = (await detailsResponse.json()) as {
    storageState: string
    quarantinedAt: string | null
    quarantineReason: string | null
    lastImportStartedAt: string | null
    lastImportCompletedAt: string | null
    lastImportErrorAt: string | null
    lastImportError: string | null
    lastImportExitCode: number | null
    importFailureCount: number
    pauseRequestedAt: string | null
  }

  expect(detailsResponse.status).toBe(200)
  expect(detailsBody.storageState).toBe('active')
  expect(detailsBody.importFailureCount).toBe(0)
  expect(detailsBody.pauseRequestedAt).toBeNull()

  const listResponse = await app.handle(new Request('http://localhost/api/judgmentsjobs'))
  const listBody = (await listResponse.json()) as {
    data: Array<{
      health: {badges: string[]; isHealthy: boolean}
      id: string
      storageState: string
      quarantinedAt: string | null
      quarantineReason: string | null
      lastImportStartedAt: string | null
      lastImportCompletedAt: string | null
      lastImportErrorAt: string | null
      lastImportError: string | null
      lastImportExitCode: number | null
      importFailureCount: number
      pauseRequestedAt: string | null
    }>
  }

  const listedJob = listBody.data.find((job) => {
    return job.id === createBody.data.jobId
  })

  expect(listResponse.status).toBe(200)
  expect(listedJob?.health).toEqual({badges: ['Healthy'], isHealthy: true})
  expect(listedJob?.storageState).toBe('active')
  expect(listedJob?.importFailureCount).toBe(0)
  expect(listedJob?.pauseRequestedAt).toBeNull()
})

test('reads SQLite-backed skipped prompt stats separately from judged prompts', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `sqlite-stats-project-${Date.now()}`
  const modelId = `sqlite-stats-model-${Date.now()}`
  const connectionId = `sqlite-stats-connection-${Date.now()}`
  const jobId = `sqlite-stats-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId, providerKind: 'anthropic'})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: `sqlite-stats-article-ready-${Date.now()}`, promptId: `sqlite-stats-prompt-ready-${Date.now()}`},
      {articleId: `sqlite-stats-article-judged-${Date.now()}`, promptId: `sqlite-stats-prompt-judged-${Date.now()}`},
      {articleId: `sqlite-stats-article-skipped-${Date.now()}`, promptId: `sqlite-stats-prompt-skipped-${Date.now()}`},
      {articleId: `sqlite-stats-article-claimed-${Date.now()}`, promptId: `sqlite-stats-prompt-claimed-${Date.now()}`},
      {articleId: `sqlite-stats-article-running-${Date.now()}`, promptId: `sqlite-stats-prompt-running-${Date.now()}`},
    ],
    'server-a',
  )

  const [judgedPrompt, skippedPrompt, claimedPrompt, runningPrompt] = await sqliteService.claimReadyPrompts(
    jobId,
    'server-a',
    4,
  )

  if (!judgedPrompt || !skippedPrompt || !claimedPrompt || !runningPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for stats test')
  }

  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: judgedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `sqlite-stats-judgment-${Date.now()}`,
    modelId,
    projectId,
    promptId: judgedPrompt.promptId,
    queuePromptId: judgedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await sqliteService.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')
  await sqliteService.markPromptAsRunning(jobId, runningPrompt.recordId)
  await runDatabase(`
    INSERT INTO app.token_use (
      id,
      judgment_job_id,
      requests,
      total_prompt_tokens,
      total_completion_tokens,
      total_tokens,
      successful_requests,
      failed_requests,
      has_failed_requests,
      failed_requests_details
    )
    VALUES (
      'sqlite-stats-token-${Date.now()}',
      '${jobId}',
      3,
      10,
      5,
      15,
      1,
      2,
      TRUE,
      CAST('[{"articleId":"article-refusal","error":"Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)","providerDiagnostics":{"initial":{"stopReason":"refusal"}}},{"articleId":"article-other","error":"Invalid JSON response"}]' AS JSON)
    )
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    promptStats: {claimed: number; judged: number; ready: number; running: number; skipped: number}
    requestStats: {
      attempts: number
      dispatch: {
        jobActivePrompts: number
        jobQueuedPrompts: number
        providerDispatchActivePromptFillPct: number | null
        providerDispatchActivePromptLimit: number
        providerDispatchActivePrompts: number
        providerDispatchPrefetchFillPct: number | null
        providerDispatchQueueLimit: number
        providerDispatchQueuedPrompts: number
      }
      failures: {anthropicRefusalArticles: number; anthropicRefusals: number; persistedFailedRequests: number}
      inFlight: number
      providerTelemetry: {
        normalRequestCapacity: number
        providerAvailableRequestLeases: number
        providerLeasedLiveRequests: number
        providerLeasedPhysicalCalls: number
        providerLeasedProbeCalls: number
        providerLimit: number
        providerRequestFillPct: number | null
        targetRequestLiveCalls: number
      }
    }
    storageHealth: {
      claimedOutboxCount: number
      lastAckSeq: number | null
      oldestUnexportedAgeMs: number | null
      orphanedJudgedRowCount?: number
      outboxRowCount: number
      promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
      retainedRowCount: number
      sqliteFileBytes: number | null
      walBytes: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.promptStats).toEqual({claimed: 1, judged: 1, ready: 1, running: 1, skipped: 1})
  expect(body.storageHealth.promptCounts).toEqual(body.promptStats)
  expect(body.requestStats.inFlight).toBe(0)
  expect(body.requestStats.attempts).toBe(3)
  expect(body.requestStats.failures).toEqual({
    anthropicRefusalArticles: 1,
    anthropicRefusals: 1,
    persistedFailedRequests: 2,
  })
  expect(body.requestStats.dispatch).toEqual({
    jobActivePrompts: 0,
    jobQueuedPrompts: 0,
    providerDispatchActivePromptFillPct: 0,
    providerDispatchActivePromptLimit: 1,
    providerDispatchActivePrompts: 0,
    providerDispatchPrefetchFillPct: 0,
    providerDispatchQueueLimit: 1,
    providerDispatchQueuedPrompts: 0,
  })
  expect(body.requestStats.providerTelemetry).toMatchObject({
    normalRequestCapacity: 1,
    providerAvailableRequestLeases: 1,
    providerLeasedLiveRequests: 0,
    providerLeasedPhysicalCalls: 0,
    providerLeasedProbeCalls: 0,
    providerLimit: 1,
    providerRequestFillPct: 0,
    targetRequestLiveCalls: 1,
  })
  expect(body.storageHealth.outboxRowCount).toBe(1)
  expect(body.storageHealth.retainedRowCount).toBe(5)
  expect(body.storageHealth.sqliteFileBytes).not.toBeNull()
  expect(body.storageHealth.oldestUnexportedAgeMs).toBeGreaterThanOrEqual(0)
})

test('judgment job health projection tracks completions waiting on maintenance visibility ack', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getAppDatabaseService} = await import('../services/appDatabaseService.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const now = Date.now()
  const projectId = `sqlite-health-ack-project-${now}`
  const modelId = `sqlite-health-ack-model-${now}`
  const connectionId = `sqlite-health-ack-connection-${now}`
  const jobId = `sqlite-health-ack-job-${now}`
  const sqliteService = getJudgmentJobSqliteService()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await runDatabase(`
    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      last_completed_dirty_token,
      refresh_status
    ) VALUES (
      '${projectId}',
      10,
      0,
      'queued'
    )
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [{articleId: `sqlite-health-ack-article-${now}`, promptId: `sqlite-health-ack-prompt-${now}`}],
    'server-a',
  )

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for completion ack health test')
  }

  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 80,
    createdAt: new Date(),
    explanation: 'completion ack',
    isAnswered: true,
    judgmentId: `sqlite-health-ack-judgment-${now}`,
    modelId,
    projectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const claimedOutboxBatch = await sqliteService.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  await sqliteService.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId})

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {
    blockedReason: string | null
    liveSqlite: {
      hasPendingCompletionAck: boolean
      oldestUnackedCompletionAgeMs: number | null
      pendingCompletionAckCount: number
    }
    progressState: string
  }
  const [projectionBeforeAck] = await getAppDatabaseService().queryJson<{
    pendingCompletionAckCount: number
    projectionSource: string
  }>(`
    SELECT
      pending_completion_ack_count AS pendingCompletionAckCount,
      projection_source AS projectionSource
    FROM app.judgment_job_sqlite_health_projection
    WHERE job_id = '${jobId}'
    LIMIT 1
  `)

  expect(response.status).toBe(200)
  expect(body.progressState).toBe('waiting_for_owner_ack')
  expect(body.blockedReason).toBe('waiting_for_owner_ack')
  expect(body.liveSqlite.hasPendingCompletionAck).toBe(true)
  expect(body.liveSqlite.pendingCompletionAckCount).toBe(1)
  expect(body.liveSqlite.oldestUnackedCompletionAgeMs).toBeGreaterThanOrEqual(0)
  expect(projectionBeforeAck).toEqual({pendingCompletionAckCount: 1, projectionSource: 'local-sqlite'})

  await sqliteService.setLastProjectRefreshAckSeq(jobId, 10)

  const ackedResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const ackedBody = (await ackedResponse.json()) as {
    liveSqlite: {hasPendingCompletionAck: boolean; pendingCompletionAckCount: number}
  }

  expect(ackedResponse.status).toBe(200)
  expect(ackedBody.liveSqlite.hasPendingCompletionAck).toBe(false)
  expect(ackedBody.liveSqlite.pendingCompletionAckCount).toBe(0)
})

test('returns safe SQLite health values for jobs without a local sqlite db', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `sqlite-health-missing-project-${Date.now()}`
  const modelId = `sqlite-health-missing-model-${Date.now()}`
  const connectionId = `sqlite-health-missing-connection-${Date.now()}`
  const jobId = `sqlite-health-missing-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    promptStats: {claimed: number; judged: number; ready: number; running: number; skipped: number}
    storageHealth: {
      claimedOutboxCount: number
      lastAckSeq: number | null
      oldestUnexportedAgeMs: number | null
      orphanedJudgedRowCount?: number
      outboxRowCount: number
      promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
      retainedRowCount: number
      sqliteFileBytes: number | null
      walBytes: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.promptStats).toEqual({claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0})
  expect(body.storageHealth).toEqual({
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

test('job details expose shared endpoint availability diagnostics', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {classifyConnectionFailure, recordConnectionFailure} = await import('../cron/judgmentsJobs/connectionHealth.ts')
  const projectId = `endpoint-diagnostics-project-${Date.now()}`
  const modelId = `endpoint-diagnostics-model-${Date.now()}`
  const connectionId = `endpoint-diagnostics-connection-${Date.now()}`
  const jobId = `endpoint-diagnostics-job-${Date.now()}`
  const baseURL = 'https://runtime-paused.example.com/v1'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    UPDATE app.provider_connection
    SET base_url = '${baseURL}'
    WHERE id = '${connectionId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  recordConnectionFailure({
    effectiveBaseURL: baseURL,
    failure: classifyConnectionFailure({
      context: {effectiveBaseURL: baseURL, endpointPath: '/v1/models', providerKind: 'sglang'},
      error: Object.assign(new Error('Service unavailable'), {status: 503}),
    }),
    providerConnectionId: connectionId,
  })

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    requestStats: {
      attempts: number
      endpointAvailability: {
        cooldownRemainingMs: number | null
        endpointAvailabilityKey: string
        endpointIdentity: string | null
        lastFailureKind: string | null
        lastFailureMessage: string | null
        localProbeLiveCount: number
        localProbeState: string
        observedAggregateProbeLiveCount: number | null
        probeInProgress: boolean
        status: string
      } | null
      inFlight: number
      lifecycleCounters: {
        claimedPrompts: number
        liveLlmCalls: number
        providerKey: string
        runningPrompts: number
        workerActivePrompts: number
        workerQueuedPrompts: number
      }
      liveLlmCalls: number
      providerTelemetry: {
        bottleneck: string | null
        bottleneckSource: string | null
        bottleneckSubreason: string | null
        endpointDiagnosticsByKey: Record<
          string,
          {
            cooldownRemainingMs: number | null
            localProbeLiveCount: number
            localProbeState: string
            observedAggregateProbeLiveCount: number | null
          }
        >
        endpointDiagnosticsSummary: {
          blockedEndpointCount: number
          cooldownEndpointCount: number
          endpointCount: number
          hasHealthyEndpointOrEndpointlessPath: boolean
          localProbeLiveCount: number
          observedAggregateProbeLiveCount: number | null
          providerKey: string
        }
        leaseAuthority: {
          normalRequestCapacity: number
          providerAvailableRequestLeases: number
          providerKey: string
          providerLeasedLiveRequests: number
          providerLeasedPhysicalCalls: number
          providerLeasedProbeCalls: number
        }
        observedBestEffort: {label: 'bestEffort'; providerLiveRequests: number; requestWorkBacklog: number}
      }
      telemetrySource: {
        aggregateCompleteness: string
        observedAggregatesAreBestEffort: true
        providerCoverage: unknown[]
      }
    }
  }
  const endpointAvailabilityKey = `${connectionId}::https://runtime-paused.example.com`

  expect(response.status).toBe(200)
  expect(body.requestStats.inFlight).toBe(0)
  expect(body.requestStats.liveLlmCalls).toBe(0)
  expect(body.requestStats.attempts).toBe(0)
  expect(body.requestStats.endpointAvailability).toMatchObject({
    endpointAvailabilityKey,
    endpointIdentity: 'https://runtime-paused.example.com',
    lastFailureKind: 'endpoint_unavailable',
    localProbeLiveCount: 0,
    localProbeState: 'cooldown',
    observedAggregateProbeLiveCount: null,
    probeInProgress: false,
    status: 'cooldown',
  })
  expect(body.requestStats.endpointAvailability?.lastFailureMessage).toContain('Provider endpoint outage:')
  expect(body.requestStats.endpointAvailability?.cooldownRemainingMs).toBeGreaterThan(0)
  expect(body.requestStats.lifecycleCounters).toEqual({
    claimedPrompts: 0,
    liveLlmCalls: 0,
    providerKey: connectionId,
    runningPrompts: 0,
    workerActivePrompts: 0,
    workerQueuedPrompts: 0,
  })
  expect(body.requestStats.providerTelemetry.leaseAuthority).toMatchObject({
    normalRequestCapacity: 1,
    providerAvailableRequestLeases: 1,
    providerKey: connectionId,
    providerLeasedLiveRequests: 0,
    providerLeasedPhysicalCalls: 0,
    providerLeasedProbeCalls: 0,
  })
  expect(body.requestStats.providerTelemetry.observedBestEffort).toMatchObject({
    label: 'bestEffort',
    providerLiveRequests: 0,
    requestWorkBacklog: 0,
  })
  const providerEndpointDiagnostics =
    body.requestStats.providerTelemetry.endpointDiagnosticsByKey[endpointAvailabilityKey]

  expect(providerEndpointDiagnostics?.cooldownRemainingMs).toBeGreaterThan(0)
  expect(providerEndpointDiagnostics).toMatchObject({
    localProbeLiveCount: 0,
    localProbeState: 'cooldown',
    observedAggregateProbeLiveCount: null,
  })
  expect(body.requestStats.providerTelemetry.endpointDiagnosticsSummary).toMatchObject({
    blockedEndpointCount: 1,
    cooldownEndpointCount: 1,
    endpointCount: 1,
    hasHealthyEndpointOrEndpointlessPath: false,
    localProbeLiveCount: 0,
    observedAggregateProbeLiveCount: null,
    providerKey: connectionId,
  })
  expect(body.requestStats.providerTelemetry.bottleneck).toBe('endpointUnavailable')
  expect(body.requestStats.providerTelemetry.bottleneckSource).toBe(`endpoint:${endpointAvailabilityKey}`)
  expect(body.requestStats.providerTelemetry.bottleneckSubreason).toBe('endpointCooldown')
  expect(body.requestStats.telemetrySource).toMatchObject({
    aggregateCompleteness: 'complete',
    observedAggregatesAreBestEffort: true,
  })

  const healthResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const healthBody = (await healthResponse.json()) as {
    blockedReason: string | null
    endpointAvailability: {
      cooldownRemainingMs: number | null
      endpointAvailabilityKey: string
      localProbeState: string
      status: string
    } | null
    providerDiagnostics: {
      endpointDiagnosticsByKey: Record<string, {localProbeState: string}>
      endpointDiagnosticsSummary: {blockedEndpointCount: number; providerKey: string}
    }
    progressState: string
    recoveryMode: string
    retryAfterAt: string | null
  }

  expect(healthResponse.status).toBe(200)
  expect(healthBody.progressState).toBe('cooldown')
  expect(healthBody.blockedReason).toBe('endpoint_cooldown')
  expect(healthBody.endpointAvailability?.status).toBe('cooldown')
  expect(healthBody.endpointAvailability?.endpointAvailabilityKey).toBe(endpointAvailabilityKey)
  expect(healthBody.endpointAvailability?.localProbeState).toBe('cooldown')
  expect(healthBody.endpointAvailability?.cooldownRemainingMs).toBeGreaterThan(0)
  expect(healthBody.providerDiagnostics.endpointDiagnosticsByKey[endpointAvailabilityKey]).toMatchObject({
    localProbeState: 'cooldown',
  })
  expect(healthBody.providerDiagnostics.endpointDiagnosticsSummary).toMatchObject({
    blockedEndpointCount: 1,
    providerKey: connectionId,
  })
  expect(healthBody.recoveryMode).toBe('retry_backoff')
  expect(healthBody.retryAfterAt).not.toBeNull()
})

test('job details expose provider dispatch saturation stats', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `dispatch-stats-project-${Date.now()}`
  const modelId = `dispatch-stats-model-${Date.now()}`
  const connectionId = `dispatch-stats-connection-${Date.now()}`
  const jobId = `dispatch-stats-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    UPDATE app.provider_connection
    SET max_inflight_requests = 80
    WHERE id = '${connectionId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  state.getJudgmentDispatchProviderStats.mockImplementationOnce(async (_input) => {
    return {
      jobActivePromptCount: 12,
      jobQueuedPromptCount: 18,
      providerActiveLimit: 80,
      providerActivePromptCount: 64,
      providerQueueLimit: 80,
      providerQueuedPromptCount: 40,
    }
  })

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    requestStats: {
      dispatch: {
        jobActivePrompts: number
        jobQueuedPrompts: number
        providerDispatchActivePromptFillPct: number | null
        providerDispatchActivePromptLimit: number
        providerDispatchActivePrompts: number
        providerDispatchPrefetchFillPct: number | null
        providerDispatchQueueLimit: number
        providerDispatchQueuedPrompts: number
      }
      providerTelemetry: {normalRequestCapacity: number; providerLimit: number; providerRequestFillPct: number | null}
    }
  }

  expect(response.status).toBe(200)
  expect(body.requestStats.dispatch).toEqual({
    jobActivePrompts: 12,
    jobQueuedPrompts: 18,
    providerDispatchActivePromptFillPct: 80,
    providerDispatchActivePromptLimit: 80,
    providerDispatchActivePrompts: 64,
    providerDispatchPrefetchFillPct: 50,
    providerDispatchQueueLimit: 80,
    providerDispatchQueuedPrompts: 40,
  })
  expect(body.requestStats.providerTelemetry).toMatchObject({
    normalRequestCapacity: 80,
    providerLimit: 80,
    providerRequestFillPct: 0,
  })
})

test('job details count active worker prompts as running prompt flow', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const projectId = `dispatch-flow-project-${Date.now()}`
  const modelId = `dispatch-flow-model-${Date.now()}`
  const connectionId = `dispatch-flow-connection-${Date.now()}`
  const jobId = `dispatch-flow-job-${Date.now()}`
  const sqliteService = getJudgmentJobSqliteService()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: `dispatch-flow-article-a-${Date.now()}`, promptId: `dispatch-flow-prompt-a-${Date.now()}`},
      {articleId: `dispatch-flow-article-b-${Date.now()}`, promptId: `dispatch-flow-prompt-b-${Date.now()}`},
    ],
    'server-a',
  )
  await sqliteService.claimReadyPrompts(jobId, 'server-a', 2)

  state.getJudgmentDispatchProviderStats.mockImplementationOnce(async (_input) => {
    return {
      jobActivePromptCount: 1,
      jobQueuedPromptCount: 1,
      providerActiveLimit: 80,
      providerActivePromptCount: 1,
      providerQueueLimit: 80,
      providerQueuedPromptCount: 1,
    }
  })

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    promptStats: {claimed: number; judged: number; ready: number; running: number; skipped: number}
    storageHealth: {promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}}
  }

  expect(response.status).toBe(200)
  expect(body.storageHealth.promptCounts).toEqual({claimed: 2, judged: 0, ready: 0, running: 0, skipped: 0})
  expect(body.promptStats).toEqual({claimed: 1, judged: 0, ready: 0, running: 1, skipped: 0})
})

test('job detail treats a registered remote judge worker as judging runtime availability', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {withCurrentServerRoleOverride} = await import('../utils/serverRuntimeRole.ts')
  const projectId = `remote-judge-runtime-project-${Date.now()}`
  const modelId = `remote-judge-runtime-model-${Date.now()}`
  const connectionId = `remote-judge-runtime-connection-${Date.now()}`
  const jobId = `remote-judge-runtime-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await registerJudgeWorkerHeartbeat()

  await withCurrentServerRoleOverride('maintenance-worker', async () => {
    const response = await app?.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
    const body = (await response?.json()) as {judgingRuntime: {enabled: boolean; reason: string | null}}

    expect(response?.status).toBe(200)
    expect(body.judgingRuntime).toEqual({enabled: true, reason: null})
  })
})

test('job creation succeeds on the owner when a remote judge worker is registered', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const {withCurrentServerRoleOverride} = await import('../utils/serverRuntimeRole.ts')
  const projectId = `remote-judge-create-project-${Date.now()}`
  const modelId = `remote-judge-create-model-${Date.now()}`
  const connectionId = `remote-judge-create-connection-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await registerJudgeWorkerHeartbeat()

  await withCurrentServerRoleOverride('maintenance-worker', async () => {
    const response = await app?.handle(
      new Request('http://localhost/api/judgmentsjobs', {
        body: JSON.stringify({projectId}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )
    const body = (await response?.json()) as {data: {projectId: string; status: string}; error: string | null}

    expect(response?.status).toBe(200)
    expect(body.error).toBeNull()
    expect(body.data.projectId).toBe(projectId)
    expect(body.data.status).toBe('running')
  })
})

test('job details include projected storage drain when a large rebuild is active', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `sqlite-health-projection-project-${Date.now()}`
  const modelId = `sqlite-health-projection-model-${Date.now()}`
  const connectionId = `sqlite-health-projection-connection-${Date.now()}`
  const jobId = `sqlite-health-projection-job-${Date.now()}`
  const articleIdA = `sqlite-health-projection-article-a-${Date.now()}`
  const articleIdB = `sqlite-health-projection-article-b-${Date.now()}`
  const articleIdC = `sqlite-health-projection-article-c-${Date.now()}`
  const now = Date.now()
  const {recordProjectMartLargeRebuildCycleMetric} = await import('../utils/projectMartLargeRebuildRuntimeMetrics.ts')

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)
  await insertOutboxFixture({jobId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES
      ('${articleIdA}', 'external-${articleIdA}', 'Projection article A', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
      ('${articleIdB}', 'external-${articleIdB}', 'Projection article B', TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T00:00:00.000Z'),
      ('${articleIdC}', 'external-${articleIdC}', 'Projection article C', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('project-article-${articleIdA}', '${projectId}', '${articleIdA}'),
      ('project-article-${articleIdB}', '${projectId}', '${articleIdB}'),
      ('project-article-${articleIdC}', '${projectId}', '${articleIdC}')
  `)
  await runDatabase(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at)
    VALUES
      ('${projectId}', '${articleIdA}', TRUE, FALSE, TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
      ('${projectId}', '${articleIdB}', TRUE, FALSE, TIMESTAMPTZ '2026-04-02T00:00:00.000Z', TIMESTAMPTZ '2026-04-02T00:00:00.000Z')
  `)
  await runDatabase(`
    INSERT INTO app.project_mart_large_rebuild_state (
      project_id,
      refresh_token,
      rebuild_phase,
      cursor_article_created_at,
      cursor_article_id,
      refresh_status,
      last_error
    ) VALUES (
      '${projectId}',
      11,
      'project_scope_article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      '${articleIdA}',
      'running',
      NULL
    )
  `)

  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 50,
    committedRowCount: 50,
    durationMs: 1000,
    duckdbQueues: null,
    endedAt: new Date(now - 7000).toISOString(),
    error: null,
    lastCommittedCursor: null,
    phase: 'prompt_answer_fact',
    projectId,
    startedAt: new Date(now - 8000).toISOString(),
    status: 'progressed',
    workerId: 'test-worker',
  })
  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 100,
    committedRowCount: 100,
    durationMs: 1000,
    duckdbQueues: null,
    endedAt: new Date(now - 5000).toISOString(),
    error: null,
    lastCommittedCursor: {articleCreatedAt: '2026-04-03T00:00:00.000Z', articleId: articleIdC},
    phase: 'judgment_fact',
    projectId,
    startedAt: new Date(now - 6000).toISOString(),
    status: 'progressed',
    workerId: 'test-worker',
  })
  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 1,
    durationMs: 1000,
    duckdbQueues: null,
    endedAt: new Date(now - 3000).toISOString(),
    error: null,
    lastCommittedCursor: {articleCreatedAt: '2026-04-01T00:00:00.000Z', articleId: articleIdA},
    phase: 'prompt_answer_fact',
    projectId,
    startedAt: new Date(now - 4000).toISOString(),
    status: 'progressed',
    workerId: 'test-worker',
  })
  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 1,
    durationMs: 1000,
    duckdbQueues: null,
    endedAt: new Date(now).toISOString(),
    error: null,
    lastCommittedCursor: {articleCreatedAt: '2026-04-01T00:00:00.000Z', articleId: articleIdA},
    phase: 'prompt_answer_fact',
    projectId,
    startedAt: new Date(now - 1000).toISOString(),
    status: 'progressed',
    workerId: 'test-worker',
  })

  let response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  let body = (await response.json()) as {
    storageHealth: {
      projection?: {
        activeLargeRebuildProjectCount: number
        currentPhase: string | null
        estimatedCurrentPhaseRemainingMs: number | null
        estimatedStorageDrainRemainingMs: number | null
        projectedStorageDrainAt: string | null
        remainingCurrentPhaseArticleCount: number | null
        rowsPerMinute: number | null
        scopeArticleCount: number | null
      }
    }
  }

  expect(response.status).toBe(200)
  expect(body.storageHealth.projection).toBeDefined()
  expect(body.storageHealth.projection?.activeLargeRebuildProjectCount).toBe(1)
  expect(body.storageHealth.projection?.currentPhase).toBe('project_scope_article')
  expect(body.storageHealth.projection?.remainingCurrentPhaseArticleCount).toBe(2)
  expect(body.storageHealth.projection?.scopeArticleCount).toBe(3)

  await runDatabase(`
    UPDATE app.project_mart_large_rebuild_state
    SET rebuild_phase = 'prompt_answer_fact'
    WHERE project_id = '${projectId}'
  `)

  response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  body = (await response.json()) as typeof body

  expect(response.status).toBe(200)
  expect(body.storageHealth.projection?.currentPhase).toBe('prompt_answer_fact')
  expect(body.storageHealth.projection?.remainingCurrentPhaseArticleCount).toBe(1)
  expect(body.storageHealth.projection?.scopeArticleCount).toBe(2)
  expect(body.storageHealth.projection?.rowsPerMinute).toBe(30)
  expect(body.storageHealth.projection?.estimatedCurrentPhaseRemainingMs).toBeGreaterThanOrEqual(1500)
  expect(body.storageHealth.projection?.estimatedCurrentPhaseRemainingMs).toBeLessThanOrEqual(2500)
  expect(body.storageHealth.projection?.estimatedStorageDrainRemainingMs).toBeGreaterThanOrEqual(13000)
  expect(body.storageHealth.projection?.estimatedStorageDrainRemainingMs).toBeLessThanOrEqual(15000)
  expect(body.storageHealth.projection?.projectedStorageDrainAt).not.toBeNull()
})

test('returns recent outbox flow metrics from actual SQLite add and import activity', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {flushJudgmentJobSqliteOutbox} = await import('../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `recent-outbox-flow-project-${Date.now()}`
  const modelId = `recent-outbox-flow-model-${Date.now()}`
  const connectionId = `recent-outbox-flow-connection-${Date.now()}`
  const jobId = `recent-outbox-flow-job-${Date.now()}`
  const firstArticleId = `recent-outbox-flow-article-1-${Date.now()}`
  const firstPromptId = `recent-outbox-flow-prompt-1-${Date.now()}`
  const secondArticleId = `recent-outbox-flow-article-2-${Date.now()}`
  const secondPromptId = `recent-outbox-flow-prompt-2-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES
      ('${firstArticleId}', 'external-${firstArticleId}', 'Recent outbox flow article 1', current_timestamp, current_timestamp),
      ('${secondArticleId}', 'external-${secondArticleId}', 'Recent outbox flow article 2', current_timestamp, current_timestamp)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES
      ('${firstPromptId}', 'Recent outbox flow prompt 1', '${firstPromptId}-hash'),
      ('${secondPromptId}', 'Recent outbox flow prompt 2', '${secondPromptId}-hash')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: firstArticleId, promptId: firstPromptId},
      {articleId: secondArticleId, promptId: secondPromptId},
    ],
    'server-a',
  )

  const [firstPrompt, secondPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 2)

  if (!firstPrompt || !secondPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for recent outbox flow test')
  }

  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: firstPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 70,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `recent-outbox-flow-judgment-1-${Date.now()}`,
    modelId,
    projectId,
    promptId: firstPrompt.promptId,
    queuePromptId: firstPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await flushJudgmentJobSqliteOutbox({jobId})
  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'no',
    answeredOriginalAsArray: ['no'],
    articleId: secondPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 80,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `recent-outbox-flow-judgment-2-${Date.now()}`,
    modelId,
    projectId,
    promptId: secondPrompt.promptId,
    queuePromptId: secondPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'no'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    storageHealth: {
      outboxRowCount: number
      recentTransfer?: {
        addedRows: number
        addedRowsPerMinute: number
        clearedRows: number
        clearedRowsPerMinute: number
        insertedRows: number
        insertedRowsPerMinute: number
        netRows: number
        netRowsPerMinute: number
        windowMinutes: number
      }
    }
  }

  expect(response.status).toBe(200)
  expect(body.storageHealth.outboxRowCount).toBe(2)
  expect(body.storageHealth.recentTransfer).toEqual({
    addedRows: 2,
    addedRowsPerMinute: 0.4,
    clearedRows: 1,
    clearedRowsPerMinute: 0.2,
    insertedRows: 1,
    insertedRowsPerMinute: 0.2,
    netRows: 1,
    netRowsPerMinute: 0.2,
    windowMinutes: 5,
  })
})

test('judgment job health route returns healthy job details', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `health-healthy-project-${Date.now()}`
  const modelId = `health-healthy-model-${Date.now()}`
  const connectionId = `health-healthy-connection-${Date.now()}`
  const jobId = `health-healthy-job-${Date.now()}`
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await getJudgmentJobSqliteService().initializeJob(jobId)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {
    jobId: string
    storageState: string
    recommendedNextAction: string
    importMetadata: {importFailureCount: number; lastImportStartedAt: string | null}
    liveSqlite: {
      outboxRowCount: number
      promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
      sqliteFileBytes: number | null
    }
  }

  expect(response.status).toBe(200)
  expect(body.jobId).toBe(jobId)
  expect(body.storageState).toBe('active')
  expect(body.recommendedNextAction).toBe('none')
  expect(body.importMetadata.importFailureCount).toBe(0)
  expect(body.importMetadata.lastImportStartedAt).toBeNull()
  expect(body.liveSqlite.outboxRowCount).toBe(0)
  expect(body.liveSqlite.promptCounts).toEqual({claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0})
  expect(body.liveSqlite.sqliteFileBytes).not.toBeNull()
})

test('judgment job health route returns missing job details', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `health-missing-project-${Date.now()}`
  const modelId = `health-missing-model-${Date.now()}`
  const connectionId = `health-missing-connection-${Date.now()}`
  const jobId = `health-missing-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'missing')
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {
    blockedReason: string | null
    progressState: string
    storageState: string
    recommendedNextAction: string
    liveSqlite: {
      claimedOutboxCount: number
      lastAckSeq: number | null
      oldestUnexportedAgeMs: number | null
      outboxRowCount: number
      promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
      retainedRowCount: number
      sqliteFileBytes: number | null
      walBytes: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.storageState).toBe('missing')
  expect(body.recommendedNextAction).toBe('repair_missing_sqlite')
  expect(body.progressState).toBe('repair_required')
  expect(body.blockedReason).toBe('storage_repair_required')
  expect(body.liveSqlite).toEqual({
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

test('judgment job health route returns draining job details', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `health-draining-project-${Date.now()}`
  const modelId = `health-draining-model-${Date.now()}`
  const connectionId = `health-draining-connection-${Date.now()}`
  const jobId = `health-draining-job-${Date.now()}`
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)
  await getJudgmentJobSqliteService().initializeJob(jobId)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {storageState: string; recommendedNextAction: string}

  expect(response.status).toBe(200)
  expect(body.storageState).toBe('draining')
  expect(body.recommendedNextAction).toBe('wait_for_drain')
})

test('judgment job health route flags orphaned judged queue rows for repair', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const projectId = `health-orphan-project-${Date.now()}`
  const modelId = `health-orphan-model-${Date.now()}`
  const connectionId = `health-orphan-connection-${Date.now()}`
  const jobId = `health-orphan-job-${Date.now()}`
  const sqliteService = getJudgmentJobSqliteService()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'completed', 'draining')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [{articleId: 'article-health-orphan', promptId: 'prompt-health-orphan'}],
    'server-a',
  )

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for orphan health test')
  }

  await sqliteService.markPromptAsJudged(jobId, claimedPrompt.recordId)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {
    liveSqlite: {orphanedJudgedRowCount?: number}
    recommendedNextAction: string
    storageState: string
  }

  expect(response.status).toBe(200)
  expect(body.storageState).toBe('draining')
  expect(body.recommendedNextAction).toBe('repair_orphaned_queue')
  expect(body.liveSqlite.orphanedJudgedRowCount).toBe(1)
})

test('judgment job health route returns quarantined job details', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `health-quarantined-project-${Date.now()}`
  const modelId = `health-quarantined-model-${Date.now()}`
  const connectionId = `health-quarantined-connection-${Date.now()}`
  const jobId = `health-quarantined-job-${Date.now()}`
  const quarantinedAt = new Date().toISOString()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${jobId}', '${projectId}', 'failed', 'quarantined', '${quarantinedAt}', 'sqlite checksum mismatch')
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/health`))
  const body = (await response.json()) as {
    storageState: string
    recommendedNextAction: string
    quarantine: {quarantineReason: string | null}
  }

  expect(response.status).toBe(200)
  expect(body.storageState).toBe('quarantined')
  expect(body.recommendedNextAction).toBe('repair_quarantine')
  expect(body.quarantine.quarantineReason).toBe('sqlite checksum mismatch')
})

test('judgment job health summary aggregates storage risk counts', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const baselineResponse = await app.handle(new Request('http://localhost/api/judgmentsjobs-health'))
  const baselineBody = (await baselineResponse.json()) as {
    data: {
      healthy: number
      draining: number
      offlineRepairRequired: number
      orphanedLocalQueue: number
      quarantined: number
      retainedOutbox: number
      staleImport: number
    }
  }

  const now = Date.now()
  const healthyProjectId = `health-summary-healthy-project-${now}`
  const healthyModelId = `health-summary-healthy-model-${now}`
  const healthyConnectionId = `health-summary-healthy-connection-${now}`
  const healthyJobId = `health-summary-healthy-job-${now}`
  const drainingProjectId = `health-summary-draining-project-${now}`
  const drainingModelId = `health-summary-draining-model-${now}`
  const drainingConnectionId = `health-summary-draining-connection-${now}`
  const drainingJobId = `health-summary-draining-job-${now}`
  const quarantinedProjectId = `health-summary-quarantined-project-${now}`
  const quarantinedModelId = `health-summary-quarantined-model-${now}`
  const quarantinedConnectionId = `health-summary-quarantined-connection-${now}`
  const quarantinedJobId = `health-summary-quarantined-job-${now}`
  const retainedProjectId = `health-summary-retained-project-${now}`
  const retainedModelId = `health-summary-retained-model-${now}`
  const retainedConnectionId = `health-summary-retained-connection-${now}`
  const retainedJobId = `health-summary-retained-job-${now}`
  const orphanedProjectId = `health-summary-orphaned-project-${now}`
  const orphanedModelId = `health-summary-orphaned-model-${now}`
  const orphanedConnectionId = `health-summary-orphaned-connection-${now}`
  const orphanedJobId = `health-summary-orphaned-job-${now}`
  const staleProjectId = `health-summary-stale-project-${now}`
  const staleModelId = `health-summary-stale-model-${now}`
  const staleConnectionId = `health-summary-stale-connection-${now}`
  const staleJobId = `health-summary-stale-job-${now}`
  const staleStartedAt = new Date(Date.now() - 16 * 60 * 1_000).toISOString()
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await insertProjectFixture({connectionId: healthyConnectionId, modelId: healthyModelId, projectId: healthyProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${healthyJobId}', '${healthyProjectId}', 'running', 'active')
  `)
  await getJudgmentJobSqliteService().initializeJob(healthyJobId)

  await insertProjectFixture({
    connectionId: drainingConnectionId,
    modelId: drainingModelId,
    projectId: drainingProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${drainingJobId}', '${drainingProjectId}', 'completed', 'draining')
  `)

  await insertProjectFixture({
    connectionId: quarantinedConnectionId,
    modelId: quarantinedModelId,
    projectId: quarantinedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${quarantinedJobId}', '${quarantinedProjectId}', 'failed', 'quarantined', '${new Date().toISOString()}', 'manual quarantine')
  `)

  await insertProjectFixture({
    connectionId: retainedConnectionId,
    modelId: retainedModelId,
    projectId: retainedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${retainedJobId}', '${retainedProjectId}', 'running', 'active')
  `)
  await insertOutboxFixture({jobId: retainedJobId, modelId: retainedModelId, projectId: retainedProjectId})

  await insertProjectFixture({
    connectionId: orphanedConnectionId,
    modelId: orphanedModelId,
    projectId: orphanedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${orphanedJobId}', '${orphanedProjectId}', 'running', 'active')
  `)
  await insertOrphanedJudgedQueueFixture({
    articleId: `health-summary-orphaned-article-${now}`,
    jobId: orphanedJobId,
    promptId: `health-summary-orphaned-prompt-${now}`,
  })

  await insertProjectFixture({connectionId: staleConnectionId, modelId: staleModelId, projectId: staleProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, last_import_started_at)
    VALUES ('${staleJobId}', '${staleProjectId}', 'running', 'active', '${staleStartedAt}')
  `)

  const response = await app.handle(new Request('http://localhost/api/judgmentsjobs-health'))
  const body = (await response.json()) as {
    data: {
      healthy: number
      draining: number
      offlineRepairRequired: number
      orphanedLocalQueue: number
      quarantined: number
      retainedOutbox: number
      staleImport: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.data).toMatchObject({
    healthy: baselineBody.data.healthy + 1,
    draining: baselineBody.data.draining + 1,
    offlineRepairRequired: baselineBody.data.offlineRepairRequired,
    orphanedLocalQueue: baselineBody.data.orphanedLocalQueue + 1,
    quarantined: baselineBody.data.quarantined + 1,
    retainedOutbox: baselineBody.data.retainedOutbox + 1,
    staleImport: baselineBody.data.staleImport + 1,
  })
})

test('judgment job health routes distinguish active and blocked import ownership states', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteHealthProjectionService} =
    await import('../services/judgmentJobSqliteHealthProjectionService.ts')
  const {getAppDatabaseService} = await import('../services/appDatabaseService.ts')
  const {withCurrentServerRoleOverride} = await import('../utils/serverRuntimeRole.ts')
  const now = Date.now()
  const activeProjectId = `health-active-import-project-${now}`
  const activeModelId = `health-active-import-model-${now}`
  const activeConnectionId = `health-active-import-connection-${now}`
  const activeJobId = `health-active-import-job-${now}`
  const blockedProjectId = `health-blocked-import-project-${now}`
  const blockedModelId = `health-blocked-import-model-${now}`
  const blockedConnectionId = `health-blocked-import-connection-${now}`
  const blockedJobId = `health-blocked-import-job-${now}`
  const activeStartedAt = new Date(now - 5_000).toISOString()
  const activeProgressedAt = new Date(now - 1_000).toISOString()
  const activeFreshUntilAt = new Date(now + 30_000).toISOString()
  const buildProjectedHealth = (outboxRowCount: number) => {
    return {
      claimedOutboxCount: 0,
      hasOutboxRows: outboxRowCount > 0,
      hasPendingCompletionAck: false,
      hasQueueRows: false,
      lastAckSeq: null,
      oldestUnackedCompletionAgeMs: null,
      oldestUnexportedAgeMs: 1_000,
      orphanedJudgedRowCount: 0,
      outboxRowCount,
      pendingCompletionAckCount: 0,
      promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
      retainedRowCount: outboxRowCount,
      sqliteFileBytes: 4096,
      walBytes: 0,
    }
  }

  await insertProjectFixture({connectionId: activeConnectionId, modelId: activeModelId, projectId: activeProjectId})
  await insertProjectFixture({connectionId: blockedConnectionId, modelId: blockedModelId, projectId: blockedProjectId})
  await runDatabase(`
    UPDATE app.project
    SET use_title = TRUE, use_abstract = FALSE, use_fulltext = FALSE, use_fulltext_no_images = TRUE
    WHERE id = '${activeProjectId}'
  `)
  await runDatabase(`
    UPDATE app.project
    SET use_title = FALSE, use_abstract = TRUE, use_fulltext = TRUE, use_fulltext_no_images = FALSE
    WHERE id = '${blockedProjectId}'
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${activeJobId}', '${activeProjectId}', 'running', 'active')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${blockedJobId}', '${blockedProjectId}', 'running', 'active')
  `)
  await runDatabase(`
    INSERT INTO app.maintenance_work_lease (
      id,
      work_kind,
      scope_kind,
      project_id,
      judgment_job_id,
      required_consumer_role,
      consumer_id,
      last_started_at,
      last_progressed_at,
      lease_expires_at,
      fresh_until_at,
      recovery_mode
    ) VALUES (
      'active-import-lease-${now}',
      'judgment_sqlite_outbox_import',
      'job',
      '${activeProjectId}',
      '${activeJobId}',
      'judge-worker',
      'judge-worker-active-import',
      TIMESTAMPTZ '${activeStartedAt}',
      TIMESTAMPTZ '${activeProgressedAt}',
      TIMESTAMPTZ '${activeFreshUntilAt}',
      TIMESTAMPTZ '${activeFreshUntilAt}',
      'none'
    )
  `)
  const allJobRows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment_job
  `)

  await Promise.all(
    allJobRows
      .filter((row) => {
        return row.id !== activeJobId && row.id !== blockedJobId
      })
      .map((row) => {
        return getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
          health: buildProjectedHealth(0),
          jobId: row.id,
          projectedBy: 'test-judge-worker',
          projectionSource: 'test',
        })
      }),
  )
  await getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
    health: buildProjectedHealth(3),
    jobId: activeJobId,
    projectedBy: 'test-judge-worker',
    projectionSource: 'test',
  })
  await getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
    health: buildProjectedHealth(2),
    jobId: blockedJobId,
    projectedBy: 'test-judge-worker',
    projectionSource: 'test',
  })

  await withCurrentServerRoleOverride('maintenance-worker', async () => {
    const activeResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${activeJobId}/health`))
    const blockedResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${blockedJobId}/health`))
    const summaryResponse = await app.handle(new Request('http://localhost/api/judgmentsjobs-health'))
    const activeBody = (await activeResponse.json()) as {
      blockedReason: string | null
      importConsumer: {eligibleConsumerCount: number; requiredConsumerRole: string}
      importWork: {activeConsumerCount: number; activeWorkCount: number; outboxRowCount: number}
      lastProgressedAt: string | null
      lastStartedAt: string | null
      progressState: string
      workIdentity: {
        modelId: string
        projectId: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
    }
    const blockedBody = (await blockedResponse.json()) as {
      blockedReason: string | null
      importConsumer: {eligibleConsumerCount: number; requiredConsumerRole: string}
      importWork: {activeConsumerCount: number; activeWorkCount: number; outboxRowCount: number}
      progressState: string
      workIdentity: {
        modelId: string
        projectId: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }
    }
    const summaryBody = (await summaryResponse.json()) as {
      data: {
        activeImport: number
        blockedImport: number
        importConsumer: {eligibleConsumerCount: number; requiredConsumerRole: string}
        jobs: Array<{
          blockedReason: string | null
          jobId: string
          progressState: string
          workIdentity: {
            modelId: string
            projectId: string
            useAbstract: boolean
            useFulltext: boolean
            useFulltextNoImages: boolean
            useTitle: boolean
          }
        }>
      }
    }

    const activeSummary = summaryBody.data.jobs.find((job) => {
      return job.jobId === activeJobId
    })
    const blockedSummary = summaryBody.data.jobs.find((job) => {
      return job.jobId === blockedJobId
    })

    expect(activeResponse.status).toBe(200)
    expect(blockedResponse.status).toBe(200)
    expect(summaryResponse.status).toBe(200)
    expect(activeBody.progressState).toBe('active_import')
    expect(activeBody.blockedReason).toBeNull()
    expect(activeBody.importConsumer.requiredConsumerRole).toBe('judge-worker')
    expect(activeBody.importWork.activeConsumerCount).toBe(1)
    expect(activeBody.importWork.activeWorkCount).toBe(1)
    expect(activeBody.importWork.outboxRowCount).toBe(3)
    expect(activeBody.lastStartedAt).toBe(activeStartedAt)
    expect(activeBody.lastProgressedAt).toBe(activeProgressedAt)
    expect(activeBody.workIdentity).toEqual({
      modelId: activeModelId,
      projectId: activeProjectId,
      useAbstract: false,
      useFulltext: false,
      useFulltextNoImages: true,
      useTitle: true,
    })
    expect(blockedBody.progressState).toBe('blocked_import')
    expect(blockedBody.blockedReason).toBe('waiting_for_judge_worker')
    expect(blockedBody.importConsumer.requiredConsumerRole).toBe('judge-worker')
    expect(blockedBody.importConsumer.eligibleConsumerCount).toBe(0)
    expect(blockedBody.importWork.activeConsumerCount).toBe(0)
    expect(blockedBody.importWork.activeWorkCount).toBe(0)
    expect(blockedBody.importWork.outboxRowCount).toBe(2)
    expect(blockedBody.workIdentity).toEqual({
      modelId: blockedModelId,
      projectId: blockedProjectId,
      useAbstract: true,
      useFulltext: true,
      useFulltextNoImages: false,
      useTitle: false,
    })
    expect(summaryBody.data.importConsumer.requiredConsumerRole).toBe('judge-worker')
    expect(summaryBody.data.importConsumer.eligibleConsumerCount).toBe(0)
    expect(summaryBody.data.activeImport).toBeGreaterThanOrEqual(1)
    expect(summaryBody.data.blockedImport).toBeGreaterThanOrEqual(1)
    expect(activeSummary?.progressState).toBe('active_import')
    expect(activeSummary?.workIdentity).toEqual(activeBody.workIdentity)
    expect(blockedSummary?.progressState).toBe('blocked_import')
    expect(blockedSummary?.blockedReason).toBe('waiting_for_judge_worker')
    expect(blockedSummary?.workIdentity).toEqual(blockedBody.workIdentity)
  })
})

test('job detail exposes storage policy for safe live repair and offline-only recovery', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const now = Date.now()
  const safeProjectId = `storage-policy-safe-project-${now}`
  const safeModelId = `storage-policy-safe-model-${now}`
  const safeConnectionId = `storage-policy-safe-connection-${now}`
  const safeJobId = `storage-policy-safe-job-${now}`
  const offlineProjectId = `storage-policy-offline-project-${now}`
  const offlineModelId = `storage-policy-offline-model-${now}`
  const offlineConnectionId = `storage-policy-offline-connection-${now}`
  const offlineJobId = `storage-policy-offline-job-${now}`

  await insertProjectFixture({connectionId: safeConnectionId, modelId: safeModelId, projectId: safeProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${safeJobId}', '${safeProjectId}', 'running', 'active')
  `)
  await getJudgmentJobSqliteService().initializeJob(safeJobId)

  await insertProjectFixture({connectionId: offlineConnectionId, modelId: offlineModelId, projectId: offlineProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${offlineJobId}', '${offlineProjectId}', 'failed', 'quarantined', '${new Date().toISOString()}', 'manual quarantine')
  `)
  await getJudgmentJobSqliteService().initializeJob(offlineJobId)
  await insertOutboxFixture({jobId: offlineJobId, modelId: offlineModelId, projectId: offlineProjectId})

  const safeResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${safeJobId}`))
  const offlineResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${offlineJobId}`))
  const safeBody = (await safeResponse.json()) as {
    storagePolicy: {hasLocalSqliteState: boolean; repairMode: string; startupHandling: string}
  }
  const offlineBody = (await offlineResponse.json()) as {
    storagePolicy: {hasLocalSqliteState: boolean; repairMode: string; startupHandling: string}
  }

  expect(safeResponse.status).toBe(200)
  expect(safeBody.storagePolicy).toEqual({
    hasLocalSqliteState: true,
    repairMode: 'safe_live_repair',
    startupHandling: 'auto_drain',
  })
  expect(offlineResponse.status).toBe(200)
  expect(offlineBody.storagePolicy).toEqual({
    hasLocalSqliteState: true,
    repairMode: 'offline_repair_required',
    startupHandling: 'skip_offline_repair',
  })
})

test('judgment jobs list includes inline health badges for risky jobs', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const now = Date.now()
  const drainingProjectId = `list-health-draining-project-${now}`
  const drainingModelId = `list-health-draining-model-${now}`
  const drainingConnectionId = `list-health-draining-connection-${now}`
  const drainingJobId = `list-health-draining-job-${now}`
  const quarantinedProjectId = `list-health-quarantined-project-${now}`
  const quarantinedModelId = `list-health-quarantined-model-${now}`
  const quarantinedConnectionId = `list-health-quarantined-connection-${now}`
  const quarantinedJobId = `list-health-quarantined-job-${now}`
  const retainedProjectId = `list-health-retained-project-${now}`
  const retainedModelId = `list-health-retained-model-${now}`
  const retainedConnectionId = `list-health-retained-connection-${now}`
  const retainedJobId = `list-health-retained-job-${now}`
  const orphanedProjectId = `list-health-orphaned-project-${now}`
  const orphanedModelId = `list-health-orphaned-model-${now}`
  const orphanedConnectionId = `list-health-orphaned-connection-${now}`
  const orphanedJobId = `list-health-orphaned-job-${now}`
  const staleProjectId = `list-health-stale-project-${now}`
  const staleModelId = `list-health-stale-model-${now}`
  const staleConnectionId = `list-health-stale-connection-${now}`
  const staleJobId = `list-health-stale-job-${now}`
  const staleStartedAt = new Date(Date.now() - 16 * 60 * 1_000).toISOString()

  await insertProjectFixture({
    connectionId: drainingConnectionId,
    modelId: drainingModelId,
    projectId: drainingProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${drainingJobId}', '${drainingProjectId}', 'completed', 'draining')
  `)

  await insertProjectFixture({
    connectionId: quarantinedConnectionId,
    modelId: quarantinedModelId,
    projectId: quarantinedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${quarantinedJobId}', '${quarantinedProjectId}', 'failed', 'quarantined', '${new Date().toISOString()}', 'manual quarantine')
  `)

  await insertProjectFixture({
    connectionId: retainedConnectionId,
    modelId: retainedModelId,
    projectId: retainedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${retainedJobId}', '${retainedProjectId}', 'running', 'active')
  `)
  await insertOutboxFixture({jobId: retainedJobId, modelId: retainedModelId, projectId: retainedProjectId})

  await insertProjectFixture({
    connectionId: orphanedConnectionId,
    modelId: orphanedModelId,
    projectId: orphanedProjectId,
  })
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${orphanedJobId}', '${orphanedProjectId}', 'running', 'active')
  `)
  await insertOrphanedJudgedQueueFixture({
    articleId: `list-health-orphaned-article-${now}`,
    jobId: orphanedJobId,
    promptId: `list-health-orphaned-prompt-${now}`,
  })

  await insertProjectFixture({connectionId: staleConnectionId, modelId: staleModelId, projectId: staleProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, last_import_started_at)
    VALUES ('${staleJobId}', '${staleProjectId}', 'running', 'active', '${staleStartedAt}')
  `)

  const response = await app.handle(new Request('http://localhost/api/judgmentsjobs'))
  const body = (await response.json()) as {data: Array<{health: {badges: string[]; isHealthy: boolean}; id: string}>}

  const drainingJob = body.data.find((job) => {
    return job.id === drainingJobId
  })
  const quarantinedJob = body.data.find((job) => {
    return job.id === quarantinedJobId
  })
  const retainedJob = body.data.find((job) => {
    return job.id === retainedJobId
  })
  const orphanedJob = body.data.find((job) => {
    return job.id === orphanedJobId
  })
  const staleJob = body.data.find((job) => {
    return job.id === staleJobId
  })

  expect(response.status).toBe(200)
  expect(drainingJob?.health).toEqual({badges: ['Draining'], isHealthy: false})
  expect(quarantinedJob?.health).toEqual({badges: ['Quarantined'], isHealthy: false})
  expect(retainedJob?.health).toEqual({badges: ['Retained Outbox'], isHealthy: false})
  expect(orphanedJob?.health).toEqual({badges: ['Orphaned Local Queue'], isHealthy: false})
  expect(staleJob?.health).toEqual({badges: ['Stale Import'], isHealthy: false})
})

test('repair action routes return structured preflight, quarantine, unquarantine, and checkpoint results', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const projectId = `repair-actions-project-${Date.now()}`
  const modelId = `repair-actions-model-${Date.now()}`
  const connectionId = `repair-actions-connection-${Date.now()}`
  const jobId = `repair-actions-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'active')
  `)
  await getJudgmentJobSqliteService().initializeJob(jobId)

  const preflightResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/preflight`, {method: 'POST'}),
  )
  const preflightBody = (await preflightResponse.json()) as {
    data: {action: string; jobId: string; ok: boolean; preflight: {sqliteFileBytes: number} | null}
  }

  expect(preflightResponse.status).toBe(200)
  expect(preflightBody.data.action).toBe('preflight')
  expect(preflightBody.data.jobId).toBe(jobId)
  expect(preflightBody.data.ok).toBe(true)
  expect(preflightBody.data.preflight?.sqliteFileBytes).toBeGreaterThan(0)

  const quarantineResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/quarantine`, {
      body: JSON.stringify({reason: 'operator quarantine'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const quarantineBody = (await quarantineResponse.json()) as {
    data: {action: string; job: {quarantineReason: string | null; storageState: string}; ok: boolean}
  }

  expect(quarantineResponse.status).toBe(200)
  expect(quarantineBody.data.action).toBe('quarantine')
  expect(quarantineBody.data.ok).toBe(true)
  expect(quarantineBody.data.job.storageState).toBe('quarantined')
  expect(quarantineBody.data.job.quarantineReason).toBe('operator quarantine')

  const unquarantineResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/unquarantine`, {method: 'POST'}),
  )
  const unquarantineBody = (await unquarantineResponse.json()) as {
    data: {action: string; changes: {unquarantined: boolean}; job: {storageState: string}; ok: boolean}
  }

  expect(unquarantineResponse.status).toBe(200)
  expect(unquarantineBody.data.action).toBe('unquarantine')
  expect(unquarantineBody.data.ok).toBe(true)
  expect(unquarantineBody.data.changes.unquarantined).toBe(true)
  expect(unquarantineBody.data.job.storageState).toBe('active')

  const checkpointResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/checkpoint`, {method: 'POST'}),
  )
  const checkpointBody = (await checkpointResponse.json()) as {
    data: {action: string; changes: {checkpointed: boolean}; ok: boolean}
  }

  expect(checkpointResponse.status).toBe(200)
  expect(checkpointBody.data.action).toBe('checkpoint')
  expect(checkpointBody.data.ok).toBe(true)
  expect(checkpointBody.data.changes.checkpointed).toBe(true)
})

test('repair route recreates missing sqlite state for one quarantined job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `repair-route-project-${Date.now()}`
  const modelId = `repair-route-model-${Date.now()}`
  const connectionId = `repair-route-connection-${Date.now()}`
  const jobId = `repair-route-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state, quarantined_at, quarantine_reason)
    VALUES ('${jobId}', '${projectId}', 'failed', 'quarantined', current_timestamp, 'missing sqlite db')
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/repair`, {method: 'POST'}))
  const body = (await response.json()) as {
    data: {
      action: string
      changes: {initializedSqlite: boolean; unquarantined: boolean}
      job: {status: string; storageState: string}
      ok: boolean
      preflight: {sqliteFileBytes: number} | null
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.action).toBe('repair')
  expect(body.data.ok).toBe(true)
  expect(body.data.changes.initializedSqlite).toBe(true)
  expect(body.data.changes.unquarantined).toBe(true)
  expect(body.data.job.status).toBe('paused')
  expect(body.data.job.storageState).toBe('active')
  expect(body.data.preflight?.sqliteFileBytes).toBeGreaterThan(0)
})

test('repair route requeues orphaned judged queue rows and restores resumable local state', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const projectId = `repair-orphan-project-${Date.now()}`
  const modelId = `repair-orphan-model-${Date.now()}`
  const connectionId = `repair-orphan-connection-${Date.now()}`
  const jobId = `repair-orphan-job-${Date.now()}`
  const articleId = `repair-orphan-article-${Date.now()}`
  const promptId = `repair-orphan-prompt-${Date.now()}`
  const sqliteService = getJudgmentJobSqliteService()

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Repair orphan article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Repair orphan prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for orphan repair test')
  }

  await sqliteService.markPromptAsJudged(jobId, claimedPrompt.recordId)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/repair`, {method: 'POST'}))
  const body = (await response.json()) as {
    data: {action: string; job: {status: string; storageState: string}; ok: boolean}
  }
  const healthResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const healthBody = (await healthResponse.json()) as {
    storageHealth: {
      orphanedJudgedRowCount?: number
      outboxRowCount: number
      promptCounts: {judged: number; ready: number}
    }
    storageState: string
    status: string
  }

  expect(response.status).toBe(200)
  expect(body.data.action).toBe('repair')
  expect(body.data.ok).toBe(true)
  expect(body.data.job.status).toBe('paused')
  expect(body.data.job.storageState).toBe('active')
  expect(healthResponse.status).toBe(200)
  expect(healthBody.status).toBe('paused')
  expect(healthBody.storageState).toBe('active')
  expect(healthBody.storageHealth.promptCounts.ready).toBe(1)
  expect(healthBody.storageHealth.promptCounts.judged).toBe(0)
  expect(healthBody.storageHealth.outboxRowCount).toBe(0)
  expect(healthBody.storageHealth.orphanedJudgedRowCount).toBe(0)
})

test('repair orphaned queue route requeues only orphaned judged queue rows', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `repair-orphaned-queue-project-${Date.now()}`
  const modelId = `repair-orphaned-queue-model-${Date.now()}`
  const connectionId = `repair-orphaned-queue-connection-${Date.now()}`
  const jobId = `repair-orphaned-queue-job-${Date.now()}`
  const articleId = `repair-orphaned-queue-article-${Date.now()}`
  const promptId = `repair-orphaned-queue-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Repair orphaned queue article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Repair orphaned queue prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)
  await insertOrphanedJudgedQueueFixture({articleId, jobId, promptId})

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/repair-orphaned-queue`, {method: 'POST'}),
  )
  const body = (await response.json()) as {
    data: {
      action: string
      changes: {deletedOrphanedJudgedRows: number; requeuedOrphanedJudgedRows: number}
      job: {status: string; storageState: string}
      liveSqlite: {orphanedJudgedRowCount?: number; promptCounts: {judged: number; ready: number}}
      ok: boolean
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.action).toBe('repair_orphaned_queue')
  expect(body.data.ok).toBe(true)
  expect(body.data.changes.requeuedOrphanedJudgedRows).toBe(1)
  expect(body.data.changes.deletedOrphanedJudgedRows).toBe(0)
  expect(body.data.job.status).toBe('paused')
  expect(body.data.job.storageState).toBe('active')
  expect(body.data.liveSqlite.promptCounts.ready).toBe(1)
  expect(body.data.liveSqlite.promptCounts.judged).toBe(0)
  expect(body.data.liveSqlite.orphanedJudgedRowCount).toBe(0)
})

test('repair orphaned queue route continues across multiple batches until clear', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const now = Date.now()
  const orphanedRowCount = 1_001
  const projectId = `repair-orphaned-multi-project-${now}`
  const modelId = `repair-orphaned-multi-model-${now}`
  const connectionId = `repair-orphaned-multi-connection-${now}`
  const jobId = `repair-orphaned-multi-job-${now}`
  const sqliteService = getJudgmentJobSqliteService()
  const promptEntries = Array.from({length: orphanedRowCount}, (_value, index) => {
    return {
      articleId: `repair-orphaned-multi-article-${now}-${index}`,
      promptId: `repair-orphaned-multi-prompt-${now}-${index}`,
    }
  })

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES ${promptEntries
      .map((entry, index) => {
        return `('${entry.articleId}', 'external-${entry.articleId}', 'Repair orphaned multi article ${index}', TIMESTAMPTZ '2026-04-01T00:00:00.000Z', TIMESTAMPTZ '2026-04-01T00:00:00.000Z')`
      })
      .join(', ')}
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ${promptEntries
      .map((entry, index) => {
        return `('${entry.promptId}', 'Repair orphaned multi prompt ${index}', '${entry.promptId}-hash')`
      })
      .join(', ')}
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, promptEntries, 'server-a')
  await sqliteService.closeAll()

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(`UPDATE queue_prompt SET status = 'judged', updated_at = ? WHERE job_id = ?`)
      .run(new Date().toISOString(), jobId)
  } finally {
    sqliteDatabase.close(false)
  }

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}/repair-orphaned-queue`, {method: 'POST'}),
  )
  const body = (await response.json()) as {
    data: {
      changes: {deletedOrphanedJudgedRows: number; requeuedOrphanedJudgedRows: number}
      liveSqlite: {orphanedJudgedRowCount?: number; promptCounts: {judged: number; ready: number}}
      message: string
      ok: boolean
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(body.data.message).toContain('processed 2 batch(es)')
  expect(body.data.changes.requeuedOrphanedJudgedRows).toBe(orphanedRowCount)
  expect(body.data.changes.deletedOrphanedJudgedRows).toBe(0)
  expect(body.data.liveSqlite.promptCounts.ready).toBe(orphanedRowCount)
  expect(body.data.liveSqlite.promptCounts.judged).toBe(0)
  expect(body.data.liveSqlite.orphanedJudgedRowCount).toBe(0)
})

test('starting a job automatically repairs orphaned judged queue rows before running', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `start-repair-orphaned-queue-project-${Date.now()}`
  const modelId = `start-repair-orphaned-queue-model-${Date.now()}`
  const connectionId = `start-repair-orphaned-queue-connection-${Date.now()}`
  const jobId = `start-repair-orphaned-queue-job-${Date.now()}`
  const articleId = `start-repair-orphaned-queue-article-${Date.now()}`
  const promptId = `start-repair-orphaned-queue-prompt-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Start repair orphaned queue article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Start repair orphaned queue prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)
  await insertOrphanedJudgedQueueFixture({articleId, jobId, promptId})

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {jobId: string; status: string; storageState: string}}
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const health = await getJudgmentJobSqliteService().getHealthSnapshot(jobId)

  expect(response.status).toBe(200)
  expect(body.data).toMatchObject({jobId, status: 'running', storageState: 'active'})
  expect(health.orphanedJudgedRowCount).toBe(0)
  expect(health.promptCounts.ready).toBe(1)
  expect(health.promptCounts.judged).toBe(0)
})

test('repair route captures explicit system sqlite fallback results without changing normal repair flows', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `repair-fallback-project-${Date.now()}`
  const modelId = `repair-fallback-model-${Date.now()}`
  const connectionId = `repair-fallback-connection-${Date.now()}`
  const jobId = `repair-fallback-job-${Date.now()}`
  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const exportPath = `${sqlitePath}.repair-export.sql`
  const originalSpawnSync = globalThis.Bun.spawnSync

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'active')
  `)

  writeFileSync(sqlitePath, 'not a sqlite database')
  globalThis.Bun.spawnSync = ((command: string[]) => {
    return (command[2] ?? '') === '.dump'
      ? {exitCode: 0, stderr: Buffer.from(''), stdout: Buffer.from('BEGIN TRANSACTION;\nCOMMIT;\n')}
      : {exitCode: 0, stderr: Buffer.from(''), stdout: Buffer.from('ok\n')}
  }) as typeof globalThis.Bun.spawnSync

  try {
    const response = await app.handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}/repair`, {
        body: JSON.stringify({systemSqliteFallbackSteps: ['diagnostic', 'export']}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )
    const body = (await response.json()) as {
      data: {
        job: {storageState: string}
        ok: boolean
        systemSqliteFallback: {
          requestedSteps: string[]
          results: Array<{command: string[]; exportPath: string | null; ok: boolean; step: string}>
        }
      }
    }

    expect(response.status).toBe(200)
    expect(body.data.ok).toBe(false)
    expect(body.data.job.storageState).toBe('quarantined')
    expect(body.data.systemSqliteFallback.requestedSteps).toEqual(['diagnostic', 'export'])
    expect(
      body.data.systemSqliteFallback.results.map((result) => {
        return result.step
      }),
    ).toEqual(['diagnostic', 'export'])
    expect(
      body.data.systemSqliteFallback.results.every((result) => {
        return result.ok && result.command[0] === 'sqlite3'
      }),
    ).toBe(true)
    expect(body.data.systemSqliteFallback.results[1]?.exportPath).toBe(exportPath)
    expect(existsSync(exportPath)).toBe(true)
  } finally {
    globalThis.Bun.spawnSync = originalSpawnSync
    rmSync(exportPath, {force: true})
    rmSync(sqlitePath, {force: true})
  }
})

test('drain route only acts on the requested job and can finalize a drained sqlite job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const now = Date.now()
  const firstProjectId = `drain-route-project-a-${now}`
  const firstModelId = `drain-route-model-a-${now}`
  const firstConnectionId = `drain-route-connection-a-${now}`
  const firstJobId = `drain-route-job-a-${now}`
  const secondProjectId = `drain-route-project-b-${now}`
  const secondModelId = `drain-route-model-b-${now}`
  const secondConnectionId = `drain-route-connection-b-${now}`
  const secondJobId = `drain-route-job-b-${now}`

  await insertProjectFixture({connectionId: firstConnectionId, modelId: firstModelId, projectId: firstProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${firstJobId}', '${firstProjectId}', 'completed', 'draining')
  `)
  await sqliteService.initializeJob(firstJobId)
  await sqliteService.addReadyPrompts(
    firstJobId,
    [{articleId: `drain-route-article-a-${now}`, promptId: `drain-route-prompt-a-${now}`}],
    'server-a',
  )

  const [claimedPrompt] = await sqliteService.claimReadyPrompts(firstJobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for drain route test')
  }

  await sqliteService.recordJudgmentSuccess(firstJobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: claimedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 80,
    createdAt: new Date(),
    explanation: 'drain route',
    isAnswered: true,
    judgmentId: `drain-route-judgment-a-${now}`,
    modelId: firstModelId,
    projectId: firstProjectId,
    promptId: claimedPrompt.promptId,
    queuePromptId: claimedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: firstProjectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const claimedOutboxBatch = await sqliteService.claimPendingOutboxBatch({
    claimedBy: 'server-a',
    jobId: firstJobId,
    maxBytes: 1024 * 1024,
    maxRows: 10,
  })

  await sqliteService.completeOutboxClaim({claimId: claimedOutboxBatch?.claim.claimId ?? '', jobId: firstJobId})
  await sqliteService.setLastProjectRefreshAckSeq(firstJobId, claimedOutboxBatch?.rows[0]?.outboxSeq ?? null)

  await insertProjectFixture({connectionId: secondConnectionId, modelId: secondModelId, projectId: secondProjectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${secondJobId}', '${secondProjectId}', 'running', 'active')
  `)
  await sqliteService.initializeJob(secondJobId)
  await sqliteService.addReadyPrompts(
    secondJobId,
    [{articleId: `drain-route-article-b-${now}`, promptId: `drain-route-prompt-b-${now}`}],
    'server-a',
  )

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${firstJobId}/drain`, {method: 'POST'}),
  )
  const body = (await response.json()) as {
    data: {
      action: string
      changes: {finalizedDrain: boolean; prunedOutboxRows: number}
      job: {storageState: string}
      ok: boolean
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.action).toBe('drain')
  expect(body.data.ok).toBe(true)
  expect(body.data.changes.finalizedDrain).toBe(true)
  expect(body.data.changes.prunedOutboxRows).toBe(1)
  expect(body.data.job.storageState).toBe('drained')
  expect(await sqliteService.getReadyCount(secondJobId)).toBe(1)
})

test('unassessed endpoints bypass stale serving rows and invalidate cached counts after dirty state is recorded', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const now = Date.now()
  const projectId = `unassessed-freshness-project-${now}`
  const modelId = `unassessed-freshness-model-${now}`
  const connectionId = `unassessed-freshness-connection-${now}`
  const jobId = `unassessed-freshness-job-${now}`
  const {getProjectMartDirtyRefreshStateService} = await import('../services/projectMartDirtyRefreshStateService.ts')

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertUnassessedServingFixture({jobId, projectId})

  const freshCountResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs-unassessed-count?jobId=${jobId}`),
  )
  const freshCountBody = (await freshCountResponse.json()) as {count: number}

  expect(freshCountResponse.status).toBe(200)
  expect(freshCountBody.count).toBe(0)

  await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    projects: [{projectId}],
    reason: 'JudgmentsJobsRoutes.test.unassessedFreshness',
  })

  const staleCountResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs-unassessed-count?jobId=${jobId}`),
  )
  const staleCountBody = (await staleCountResponse.json()) as {count: number}

  expect(staleCountResponse.status).toBe(200)
  expect(staleCountBody.count).toBe(1)

  const previewResponse = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs-unassessed-articles?jobId=${jobId}`),
  )
  const previewBody = (await previewResponse.json()) as {data: Array<{articleTitle: string; id: string}>; error: null}

  expect(previewResponse.status).toBe(200)
  expect(previewBody.error).toBeNull()
  expect(previewBody.data).toHaveLength(1)
  expect(previewBody.data[0]?.articleTitle).toBe('Unassessed stale preview article')
})

test('deleting an existing judgments job succeeds when prompts and token usage reference the job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `delete-project-${Date.now()}`
  const modelId = `delete-model-${Date.now()}`
  const connectionId = `delete-connection-${Date.now()}`
  const jobId = `delete-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)
  await insertQueuedPromptFixture({
    articleId: `delete-article-${Date.now()}`,
    jobId,
    promptId: `delete-prompt-${Date.now()}`,
  })
  await runDatabase(`
    INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
    VALUES ('delete-token-${Date.now()}', '${jobId}', 1, 10, 5, 15)
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {method: 'DELETE'}))
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain(jobId)
})
