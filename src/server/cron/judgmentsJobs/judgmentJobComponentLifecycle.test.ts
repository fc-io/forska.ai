import {existsSync} from 'node:fs'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'
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

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'codex', 'Component Codex stub', TRUE, 'codex-cli', 'codex://app-server')
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
  const {storeSinglePromptJudgment} = await import('../../../agent/judge/storeSinglePromptJudgment.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  await judgmentsJobsAddToQueue(serverJobId)
  expect((await sqliteService.getHealthSnapshot(jobId)).promptCounts.ready).toBe(1)

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

  const dispatch = createJudgmentDispatchRuntime({
    processPrompt: async ({prompt}) => {
      await storeSinglePromptJudgment({
        article: {id: prompt.articleId} as ArticleRecord,
        chunkingStrategy: null,
        judgment: {answer: 'yes', explanation: 'deterministic component response', quotes: ['fixture quote']},
        judgmentsJobId: prompt.jobId,
        modelId: prompt.modelId,
        projectId: prompt.projectId,
        promptId: prompt.promptId,
        queueRecordId: prompt.recordId,
      })
    },
  })

  await dispatch.enqueueClaimedPrompts({label: 'component lifecycle', prompts})

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await sqliteService.getUnexportedOutboxCount(jobId)) === 1) {
      break
    }
    await globalThis.Bun.sleep(10)
  }
  await dispatch.shutdown('component lifecycle complete')

  expect(await sqliteService.getUnexportedOutboxCount(jobId)).toBe(1)
  const [canonicalBeforeImport] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count FROM app.judgment
    WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}'
  `)
  expect(Number(canonicalBeforeImport?.count ?? 0)).toBe(0)

  expect(await importJudgmentJobSqliteOutboxBatch()).toBe(1)
  expect(await sqliteService.getUnexportedOutboxCount(jobId)).toBe(0)

  const canonicalRows = await queryDatabase<{
    count: number
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT COUNT(*) AS count,
           BOOL_AND(use_abstract) AS useAbstract,
           BOOL_OR(use_fulltext) AS useFulltext,
           BOOL_OR(use_fulltext_no_images) AS useFulltextNoImages,
           BOOL_AND(use_title) AS useTitle
    FROM app.judgment
    WHERE article_id = '${articleId}' AND prompt_id = '${promptId}' AND model_id = '${modelId}'
  `)

  expect(canonicalRows[0]).toMatchObject({
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  expect(Number(canonicalRows[0]?.count ?? 0)).toBe(1)

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

  await sqliteService.deleteDrainedJobs({jobId, serverJobId})
  expect(existsSync(sqlitePath)).toBe(false)
})
