import {existsSync} from 'node:fs'
import {join} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-component-lifecycle')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'true'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let providerServer: ReturnType<typeof globalThis.Bun.serve> | null = null

const requestJson = async <T>(path: string, init?: RequestInit): Promise<{body: T; status: number}> => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {...(init?.body ? {'content-type': 'application/json'} : {}), ...init?.headers},
    }),
  )

  return {body: (await response.json()) as T, status: response.status}
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {judgmentsJobsRoutes},
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('../../routes/JudgmentsJobsRoutes.ts'),
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
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await providerServer?.stop(true)
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('component lifecycle crosses route, dispatch, SQLite, DuckDB, projection, drain, and cleanup boundaries', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const suffix = `${Date.now()}`
  const connectionId = `component-connection-${suffix}`
  const modelId = `component-model-${suffix}`
  const projectId = `component-project-${suffix}`
  const articleId = `component-article-${suffix}`
  const promptId = `component-prompt-${suffix}`
  const serverJobId = `component-server-${suffix}`
  const providerRequests: Array<{messages?: Array<{content?: string; role?: string}>}> = []
  providerServer = globalThis.Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)

      if (url.pathname === '/v1/models') {
        return Response.json({data: [{id: 'component-stub'}], object: 'list'})
      }

      if (url.pathname === '/v1/chat/completions') {
        providerRequests.push((await request.json()) as (typeof providerRequests)[number])
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: {
                content: JSON.stringify({
                  answer: 'yes',
                  explanation: 'deterministic component response',
                  quotes: ['Deterministic abstract'],
                }),
                role: 'assistant',
              },
            },
          ],
          created: Math.floor(Date.now() / 1000),
          id: `component-response-${suffix}`,
          model: 'component-stub',
          object: 'chat.completion',
          usage: {completion_tokens: 10, prompt_tokens: 20, total_tokens: 30},
        })
      }

      return new Response('Not found', {status: 404})
    },
  })
  const providerBaseUrl = `http://127.0.0.1:${providerServer.port}/v1`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'Component SGLang stub', TRUE, 'none', '${providerBaseUrl}')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'component-stub', 'component-stub', 'Component stub', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    ) VALUES ('${projectId}', 'Component lifecycle', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at, article_updated_at)
    VALUES (
      '${articleId}', 'external-${articleId}', 'Deterministic title', 'Deterministic abstract',
      current_timestamp, current_timestamp
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Does the article satisfy the criterion?', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${projectId}-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${projectId}-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)
  const {requestReviewServingV4Rebuild} = await import('../../reviewServing/reviewServingV4RebuildRequestService.ts')
  const {runReviewServingProjectorWorkerOnce} = await import('../../workers/reviewServingProjectorWorker.ts')
  await requestReviewServingV4Rebuild({projectId, reason: 'missingReviewServingSnapshot'})
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await runReviewServingProjectorWorkerOnce({workerId: `component-bootstrap-projector-${suffix}`})
    const [completedRebuild] = await queryDatabase<{count: number}>(`
      SELECT COUNT(*) AS count FROM app.review_rebuild_request
      WHERE project_id = '${projectId}' AND status = 'completed'
    `)
    if (Number(completedRebuild?.count ?? 0) > 0) {
      break
    }
  }

  const created = await requestJson<{data: {jobId: string; status: string; storageState: string}; error: null}>(
    '/api/judgmentsjobs',
    {body: JSON.stringify({projectId}), method: 'POST'},
  )

  expect(created.status).toBe(200)
  expect(created.body.error).toBeNull()
  expect(created.body.data).toMatchObject({status: 'running', storageState: 'active'})

  const jobId = created.body.data.jobId
  const {judgmentsJobsAddToQueue} = await import('./judgmentsJobsAddToQueue.ts')
  const {getAndUpdateReadyPrompts} = await import('./judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts')
  const {createJudgmentDispatchRuntime} = await import('./judgmentDispatchRuntime.ts')
  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const {importJudgmentJobSqliteOutboxBatch} = await import('./judgmentJobSqliteOutboxImport.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  expect(sqlitePath).toBe(join(tempRuntimeRoot.judgmentJobsDirectory, `${jobId}.sqlite`))

  await judgmentsJobsAddToQueue(serverJobId)
  expect((await sqliteService.getHealthSnapshot(jobId)).promptCounts.ready).toBe(1)

  const queuedDetail = await requestJson<{
    promptStats: {claimed: number; ready: number; running: number}
    status: string
    storageHealth: {outboxRowCount: number; promptCounts: {ready: number}}
    storageState: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`/api/judgmentsjobs/${jobId}`)
  expect(queuedDetail.body).toMatchObject({
    promptStats: {claimed: 0, ready: 1, running: 0},
    status: 'running',
    storageHealth: {outboxRowCount: 0, promptCounts: {ready: 1}},
    storageState: 'active',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  const queuedHealth = await requestJson<{
    importMetadata: {importFailureCount: number; lastImportError: string | null}
    importWork: {outboxRowCount: number; pendingCompletionAckCount: number}
    liveSqlite: {lastAckSeq: number | null; promptCounts: {ready: number}}
    quarantine: {quarantineReason: string | null; quarantinedAt: string | null}
    runningWork: {claimedPromptCount: number; readyPromptCount: number; runningPromptCount: number}
    storageState: string
  }>(`/api/judgmentsjobs/${jobId}/health`)
  expect(queuedHealth.body).toMatchObject({
    importMetadata: {importFailureCount: 0, lastImportError: null},
    importWork: {outboxRowCount: 0, pendingCompletionAckCount: 0},
    liveSqlite: {lastAckSeq: null, promptCounts: {ready: 1}},
    quarantine: {quarantineReason: null, quarantinedAt: null},
    runningWork: {claimedPromptCount: 0, readyPromptCount: 1, runningPromptCount: 0},
    storageState: 'active',
  })
  const queuedList = await requestJson<{
    data: Array<{health: {badges: string[]; isHealthy: boolean}; id: string; status: string; storageState: string}>
  }>('/api/judgmentsjobs')
  expect(
    queuedList.body.data.find((job) => {
      return job.id === jobId
    }),
  ).toMatchObject({health: {badges: ['Healthy'], isHealthy: true}, status: 'running', storageState: 'active'})
  const queuedGlobalHealth = await requestJson<{
    data: {
      healthy: number
      jobs: Array<{action: string; jobId: string; progressState: string; runningWork: {readyPromptCount: number}}>
      progressStates: {queued: number}
    }
  }>('/api/judgmentsjobs-health')
  expect(
    queuedGlobalHealth.body.data.jobs.find((job) => {
      return job.jobId === jobId
    }),
  ).toMatchObject({action: 'none', progressState: 'queued', runningWork: {readyPromptCount: 1}})
  expect(queuedGlobalHealth.body.data).toMatchObject({healthy: 1, progressStates: {queued: 1}})

  const prompts = await getAndUpdateReadyPrompts(serverJobId, jobId, 1, {
    providerConnectionId: connectionId,
    providerMaxInflightRequests: 1,
    providerUsesFamilyDefault: false,
  })

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({
    articleId,
    jobId,
    modelId,
    projectId,
    promptId,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  const dispatch = createJudgmentDispatchRuntime()

  await dispatch.enqueueClaimedPrompts({label: 'component lifecycle', prompts})

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await sqliteService.getUnexportedOutboxCount(jobId)) === 1) {
      break
    }
    await globalThis.Bun.sleep(10)
  }
  await dispatch.shutdown('component lifecycle complete')

  expect(providerRequests).toHaveLength(1)
  const renderedProviderRequest = JSON.stringify(providerRequests[0])
  expect(renderedProviderRequest).toContain('Deterministic title')
  expect(renderedProviderRequest).toContain('Deterministic abstract')
  expect(await sqliteService.getUnexportedOutboxCount(jobId)).toBe(1)
  const [beforeImport] = await queryDatabase<{
    canonicalRows: number
    deltaRows: number
    dirtyWorkRows: number
    markerRows: number
  }>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment
       WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}'
         AND use_title = TRUE AND use_abstract = TRUE
         AND use_fulltext = FALSE AND use_fulltext_no_images = FALSE) AS canonicalRows,
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS markerRows,
      (SELECT COUNT(*) FROM app.review_change_delta WHERE project_id = '${projectId}') AS deltaRows,
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${projectId}') AS dirtyWorkRows
  `)
  expect(Object.values(beforeImport).map(Number)).toEqual([0, 0, 0, 0])

  expect(await importJudgmentJobSqliteOutboxBatch()).toBe(1)
  expect(await sqliteService.getUnexportedOutboxCount(jobId)).toBe(0)

  const canonicalRows = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment
    WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}'
      AND use_title = TRUE AND use_abstract = TRUE
      AND use_fulltext = FALSE AND use_fulltext_no_images = FALSE
  `)

  expect(Number(canonicalRows[0]?.count ?? 0)).toBe(1)

  const [importCommit] = await queryDatabase<{
    deltaRows: number
    dirtyWorkRows: number
    markerRows: number
    outboxSeq: number
  }>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS markerRows,
      (SELECT MAX(outbox_seq) FROM app.judgment_job_sqlite_outbox_import WHERE job_id = '${jobId}') AS outboxSeq,
      (SELECT COUNT(*) FROM app.review_change_delta WHERE project_id = '${projectId}') AS deltaRows,
      (SELECT COUNT(*) FROM app.review_serving_dirty_work WHERE project_id = '${projectId}') AS dirtyWorkRows
  `)
  expect({
    deltaRows: Number(importCommit.deltaRows),
    dirtyWorkRows: Number(importCommit.dirtyWorkRows),
    markerRows: Number(importCommit.markerRows),
    outboxSeq: Number(importCommit.outboxSeq),
  }).toEqual({deltaRows: 1, dirtyWorkRows: 5, markerRows: 1, outboxSeq: 1})
  const importedHealth = await requestJson<{
    importWork: {claimedOutboxCount: number; outboxRowCount: number}
    liveSqlite: {lastAckSeq: number | null; outboxRowCount: number}
    runningWork: {judgedPromptCount: number}
  }>(`/api/judgmentsjobs/${jobId}/health`)
  expect(importedHealth.body).toMatchObject({
    importWork: {claimedOutboxCount: 0, outboxRowCount: 1},
    liveSqlite: {lastAckSeq: null, outboxRowCount: 1},
    runningWork: {judgedPromptCount: 1},
  })
  const importedList = await requestJson<{data: Array<{health: {badges: string[]; isHealthy: boolean}; id: string}>}>(
    '/api/judgmentsjobs',
  )
  expect(
    importedList.body.data.find((job) => {
      return job.id === jobId
    })?.health,
  ).toEqual({badges: ['Retained Outbox'], isHealthy: false})
  const importedGlobalHealth = await requestJson<{
    data: {
      completionAckBacklog: number
      jobs: Array<{action: string; blockedReason: string | null; jobId: string; progressState: string}>
      retainedOutbox: number
    }
  }>('/api/judgmentsjobs-health')
  expect(
    importedGlobalHealth.body.data.jobs.find((job) => {
      return job.jobId === jobId
    }),
  ).toMatchObject({
    action: 'resume_outbox_import',
    blockedReason: 'waiting_for_owner_ack',
    progressState: 'waiting_for_owner_ack',
  })
  expect(importedGlobalHealth.body.data).toMatchObject({completionAckBacklog: 1, retainedOutbox: 1})

  const incompatibleFlags = Array.from({length: 16}, (_, value) => {
    return {
      useAbstract: Boolean(value & 2),
      useFulltext: Boolean(value & 4),
      useFulltextNoImages: Boolean(value & 8),
      useTitle: Boolean(value & 1),
    }
  }).filter((flags) => {
    return !(flags.useTitle && flags.useAbstract && !flags.useFulltext && !flags.useFulltextNoImages)
  })
  for (const flags of incompatibleFlags) {
    const [miss] = await queryDatabase<{count: number}>(`
      SELECT COUNT(*) AS count FROM app.judgment
      WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}'
        AND use_title = ${flags.useTitle} AND use_abstract = ${flags.useAbstract}
        AND use_fulltext = ${flags.useFulltext}
        AND use_fulltext_no_images = ${flags.useFulltextNoImages}
    `)
    expect(Number(miss?.count ?? 0)).toBe(0)
  }
  const [wrongModelMiss] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count FROM app.judgment
    WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = 'wrong-model'
  `)
  expect(Number(wrongModelMiss?.count ?? 0)).toBe(0)

  const dirtyBeforeProjection = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}'
  `)
  expect(Number(dirtyBeforeProjection[0]?.count ?? 0)).toBeGreaterThan(0)
  const [servingBeforeProjection] = await queryDatabase<{llmHasJudgment: boolean}>(`
    SELECT state.llm_has_judgment AS llmHasJudgment
    FROM mart.review_article_serving_list_mode_state_v4 state
    INNER JOIN app.review_serving_snapshot_manifest manifest
      ON manifest.project_id = state.project_id
      AND manifest.review_config_hash = state.review_config_hash
      AND manifest.snapshot_id = state.snapshot_id
      AND manifest.snapshot_status = 'active'
    WHERE state.project_id = '${projectId}' AND state.article_id = '${articleId}'
  `)
  expect(servingBeforeProjection?.llmHasJudgment).toBe(false)

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await runReviewServingProjectorWorkerOnce({workerId: `component-projector-${suffix}`})
    const [remaining] = await queryDatabase<{count: number}>(`
      SELECT COUNT(*) AS count FROM app.review_serving_dirty_work_ack
      WHERE dirty_work_id IN (
        SELECT dirty_work_id FROM app.review_serving_dirty_work WHERE project_id = '${projectId}'
      )
    `)
    if (Number(remaining?.count ?? 0) > 0) {
      break
    }
  }

  const projectionAcks = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count FROM app.review_serving_dirty_work_ack
    WHERE dirty_work_id IN (
      SELECT dirty_work_id FROM app.review_serving_dirty_work WHERE project_id = '${projectId}'
    )
  `)
  expect(Number(projectionAcks[0]?.count ?? 0)).toBeGreaterThan(0)
  const [servingAfterProjection] = await queryDatabase<{llmHasJudgment: boolean}>(`
    SELECT state.llm_has_judgment AS llmHasJudgment
    FROM mart.review_article_serving_list_mode_state_v4 state
    INNER JOIN app.review_serving_snapshot_manifest manifest
      ON manifest.project_id = state.project_id
      AND manifest.review_config_hash = state.review_config_hash
      AND manifest.snapshot_id = state.snapshot_id
      AND manifest.snapshot_status = 'active'
    WHERE state.project_id = '${projectId}' AND state.article_id = '${articleId}'
  `)
  expect(servingAfterProjection?.llmHasJudgment).toBe(true)
  await sqliteService.reconcileProjectRefreshAcks({projectId})
  expect((await sqliteService.getHealthSnapshot(jobId)).lastAckSeq).toBe(0)
  const visibleHealth = await requestJson<{liveSqlite: {lastAckSeq: number | null}}>(
    `/api/judgmentsjobs/${jobId}/health`,
  )
  expect(visibleHealth.body.liveSqlite.lastAckSeq).toBe(0)
  const visibleFreshness = await requestJson<{
    freshness: {
      failedMaterializationCount: number
      isFresh: boolean
      unresolvedQuarantineBarrierCount: number
      unreconciledMaterializationCount: number
    }
    freshnessStatus: string
  }>(`/api/judgmentsjobs-unassessed-count?jobId=${jobId}`)
  expect(visibleFreshness.body).toMatchObject({
    freshness: {
      failedMaterializationCount: 0,
      isFresh: true,
      unresolvedQuarantineBarrierCount: 0,
      unreconciledMaterializationCount: 0,
    },
    freshnessStatus: 'fresh',
  })

  const paused = await requestJson<{data: {status: string; storageState: string}}>(`/api/judgmentsjobs/${jobId}`, {
    body: JSON.stringify({status: 'paused'}),
    method: 'PATCH',
  })
  expect(paused.body.data).toMatchObject({status: 'paused', storageState: 'draining'})
  expect(existsSync(sqlitePath)).toBe(true)

  const drainRequest = () => {
    return requestJson<{data: {job: {status: string; storageState: string}}}>(`/api/judgmentsjobs/${jobId}/drain`, {
      body: JSON.stringify({claimedBy: serverJobId}),
      method: 'POST',
    })
  }
  const firstDrain = await drainRequest()
  expect(firstDrain.body.data.job.status).toBe('paused')

  const drainStates = [firstDrain.body.data.job.storageState]
  for (let attempt = 0; attempt < 5 && drainStates.at(-1) !== 'drained'; attempt += 1) {
    const nextDrain = await drainRequest()
    drainStates.push(nextDrain.body.data.job.storageState)
  }
  if (drainStates.at(-1) !== 'drained') {
    const refresh = await queryDatabase<unknown>(`
      SELECT * FROM app.project_mart_refresh_state WHERE project_id = '${projectId}'
    `)
    const dirty = await queryDatabase<unknown>(`
      SELECT dirty_work_id, projection_component, latest_source_high_water_mark FROM app.review_serving_dirty_work
      WHERE project_id = '${projectId}'
    `)
    const acks = await queryDatabase<unknown>(`
      SELECT dirty_work_id, projection_component, completed_source_high_water_mark, status
      FROM app.review_serving_dirty_work_ack
      WHERE dirty_work_id IN (
        SELECT dirty_work_id FROM app.review_serving_dirty_work WHERE project_id = '${projectId}'
      )
    `)
    throw new Error(JSON.stringify({acks, dirty, health: await sqliteService.getHealthSnapshot(jobId), refresh}))
  }
  expect(drainStates.at(-1)).toBe('drained')

  const drainedApiHealth = await requestJson<{
    importWork: {outboxRowCount: number; pendingCompletionAckCount: number}
    liveSqlite: {outboxRowCount: number; retainedRowCount: number}
    storageState: string
  }>(`/api/judgmentsjobs/${jobId}/health`)
  expect(drainedApiHealth.body).toMatchObject({
    importWork: {outboxRowCount: 0, pendingCompletionAckCount: 0},
    liveSqlite: {outboxRowCount: 0, retainedRowCount: 0},
    storageState: 'drained',
  })
  const drainedGlobalHealth = await requestJson<{
    data: {healthy: number; jobs: Array<{action: string; jobId: string; progressState: string}>}
  }>('/api/judgmentsjobs-health')
  expect(
    drainedGlobalHealth.body.data.jobs.find((job) => {
      return job.jobId === jobId
    }),
  ).toMatchObject({action: 'none', progressState: 'idle'})
  expect(drainedGlobalHealth.body.data.healthy).toBe(0)

  const drainedHealth = await sqliteService.getHealthSnapshot(jobId)
  expect(drainedHealth.outboxRowCount).toBe(0)
  expect(drainedHealth.pendingCompletionAckCount).toBe(0)
  expect(drainedHealth.promptCounts).toMatchObject({claimed: 0, ready: 0, running: 0})
  expect(drainedHealth.retainedRowCount).toBe(0)
  expect(await sqliteService.getUnexportedOutboxCount(jobId)).toBe(0)
  expect(sqliteService.hasOwnedLease(jobId)).toBe(false)

  await sqliteService.deleteDrainedJobs({jobId, serverJobId})
  expect(existsSync(sqlitePath)).toBe(false)
  expect(existsSync(`${sqlitePath}-wal`)).toBe(false)
  expect(existsSync(`${sqlitePath}-shm`)).toBe(false)
  const {getJudgmentJobLeasePath} = await import('./judgmentJobPaths.ts')
  expect(existsSync(getJudgmentJobLeasePath(jobId))).toBe(false)
})
