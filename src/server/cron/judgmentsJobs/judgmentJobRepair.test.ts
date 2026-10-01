import {rmSync, writeFileSync} from 'node:fs'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-job-repair')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let repairModule: typeof import('./judgmentJobRepair.ts') | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    currentRepairModule,
    sqliteModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobRepair.ts'),
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
  repairModule = currentRepairModule
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

const insertProjectFixture = async ({
  connectionId,
  modelId,
  projectId,
  systemPromptVariant = null,
  useMetadata = false,
}: {
  connectionId: string
  modelId: string
  projectId: string
  systemPromptVariant?: string | null
  useMetadata?: boolean
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata,
      system_prompt_variant
    )
    VALUES (
      '${projectId}', 'Judgment job repair test', '${modelId}', TRUE, TRUE, FALSE, FALSE, ${useMetadata ? 'TRUE' : 'FALSE'},
      ${systemPromptVariant === null ? 'NULL' : `'${systemPromptVariant}'`}
    )
  `)
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
  if (!runDatabase || !sqliteService) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Repair test article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Repair test prompt', '${promptId}-hash')
  `)

  const service = sqliteService()

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for repair test')
  }

  await service.markPromptAsJudged(jobId, claimedPrompt.recordId)
}

const insertJobFixture = async ({
  jobId,
  projectId,
  status,
  storageState,
}: {
  jobId: string
  projectId: string
  status: string
  storageState: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', '${status}', '${storageState}')
  `)
}

test('startup automatic repair requeues orphaned rows for running active SQLite jobs only', async () => {
  if (!queryDatabase || !repairModule || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const now = Date.now()
  const connectionId = `startup-repair-connection-${now}`
  const modelId = `startup-repair-model-${now}`
  const projectId = `startup-repair-project-${now}`
  const runningJobId = `startup-repair-running-job-${now}`
  const secondRunningJobId = `startup-repair-second-running-job-${now}`
  const pausedJobId = `startup-repair-paused-job-${now}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertJobFixture({jobId: runningJobId, projectId, status: 'running', storageState: 'active'})
  await insertJobFixture({jobId: secondRunningJobId, projectId, status: 'running', storageState: 'active'})
  await insertJobFixture({jobId: pausedJobId, projectId, status: 'paused', storageState: 'active'})
  await insertOrphanedJudgedQueueFixture({
    articleId: `startup-repair-running-article-${now}`,
    jobId: runningJobId,
    promptId: `startup-repair-running-prompt-${now}`,
  })
  await insertOrphanedJudgedQueueFixture({
    articleId: `startup-repair-second-running-article-${now}`,
    jobId: secondRunningJobId,
    promptId: `startup-repair-second-running-prompt-${now}`,
  })
  await insertOrphanedJudgedQueueFixture({
    articleId: `startup-repair-paused-article-${now}`,
    jobId: pausedJobId,
    promptId: `startup-repair-paused-prompt-${now}`,
  })

  const summary = await repairModule.runStartupAutomaticOrphanedQueueRepair({maxBatches: 1})
  const service = sqliteService()

  expect(summary).toMatchObject({deletedRows: 0, incompleteJobCount: 0, jobCount: 1, requeuedRows: 1})
  expect(
    await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${runningJobId}'
  `),
  ).toEqual([{status: 'running', storageState: 'active'}])
  expect(await service.getHealthSnapshot(runningJobId)).toMatchObject({
    orphanedJudgedRowCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 1, running: 0, skipped: 0},
  })
  expect(await service.getHealthSnapshot(secondRunningJobId)).toMatchObject({
    orphanedJudgedRowCount: 1,
    promptCounts: {claimed: 0, judged: 1, ready: 0, running: 0, skipped: 0},
  })
  expect(await service.getHealthSnapshot(pausedJobId)).toMatchObject({
    orphanedJudgedRowCount: 1,
    promptCounts: {claimed: 0, judged: 1, ready: 0, running: 0, skipped: 0},
  })
})

test('orphan repair only counts a stored judgment of the job system prompt variant as already judged', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const now = Date.now()
  const connectionId = `variant-repair-connection-${now}`
  const modelId = `variant-repair-model-${now}`
  const projectId = `variant-repair-project-${now}`
  const otherVariantJobId = `variant-repair-other-job-${now}`
  const sameVariantJobId = `variant-repair-same-job-${now}`
  const insertStoredJudgment = (input: {articleId: string; promptId: string; systemPromptVariant: string}) => {
    return runDatabase?.(`
      INSERT INTO app.judgment (
        id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
        system_prompt_variant, is_answered, answered_original
      )
      VALUES (
        '${input.articleId}-judgment', '${input.articleId}', '${input.promptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE,
        '${input.systemPromptVariant}', TRUE, 'yes'
      )
    `)
  }

  await insertProjectFixture({connectionId, modelId, projectId, systemPromptVariant: 'screening_v1'})
  await insertJobFixture({jobId: otherVariantJobId, projectId, status: 'running', storageState: 'active'})
  await insertJobFixture({jobId: sameVariantJobId, projectId, status: 'running', storageState: 'active'})
  await insertOrphanedJudgedQueueFixture({
    articleId: `variant-repair-other-article-${now}`,
    jobId: otherVariantJobId,
    promptId: `variant-repair-other-prompt-${now}`,
  })
  await insertOrphanedJudgedQueueFixture({
    articleId: `variant-repair-same-article-${now}`,
    jobId: sameVariantJobId,
    promptId: `variant-repair-same-prompt-${now}`,
  })
  await insertStoredJudgment({
    articleId: `variant-repair-other-article-${now}`,
    promptId: `variant-repair-other-prompt-${now}`,
    systemPromptVariant: 'legacy',
  })
  await insertStoredJudgment({
    articleId: `variant-repair-same-article-${now}`,
    promptId: `variant-repair-same-prompt-${now}`,
    systemPromptVariant: 'screening_v1',
  })

  const service = sqliteService()

  expect(await service.repairOrphanedJudgedQueueRows({jobId: otherVariantJobId, maxRows: 10})).toMatchObject({
    deletedRows: 0,
    requeuedRows: 1,
  })
  expect(await service.repairOrphanedJudgedQueueRows({jobId: sameVariantJobId, maxRows: 10})).toMatchObject({
    deletedRows: 1,
    requeuedRows: 0,
  })
})

test('orphan repair only counts a stored judgment with the job use_metadata flag as already judged', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const now = Date.now()
  const connectionId = `metadata-repair-connection-${now}`
  const modelId = `metadata-repair-model-${now}`
  const projectId = `metadata-repair-project-${now}`
  const otherFlagJobId = `metadata-repair-other-job-${now}`
  const sameFlagJobId = `metadata-repair-same-job-${now}`
  const insertStoredJudgment = (input: {articleId: string; promptId: string; useMetadata: boolean}) => {
    return runDatabase?.(`
      INSERT INTO app.judgment (
        id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
        use_metadata, is_answered, answered_original
      )
      VALUES (
        '${input.articleId}-judgment', '${input.articleId}', '${input.promptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE,
        ${input.useMetadata ? 'TRUE' : 'FALSE'}, TRUE, 'yes'
      )
    `)
  }

  await insertProjectFixture({connectionId, modelId, projectId, useMetadata: true})
  await insertJobFixture({jobId: otherFlagJobId, projectId, status: 'running', storageState: 'active'})
  await insertJobFixture({jobId: sameFlagJobId, projectId, status: 'running', storageState: 'active'})
  await insertOrphanedJudgedQueueFixture({
    articleId: `metadata-repair-other-article-${now}`,
    jobId: otherFlagJobId,
    promptId: `metadata-repair-other-prompt-${now}`,
  })
  await insertOrphanedJudgedQueueFixture({
    articleId: `metadata-repair-same-article-${now}`,
    jobId: sameFlagJobId,
    promptId: `metadata-repair-same-prompt-${now}`,
  })
  await insertStoredJudgment({
    articleId: `metadata-repair-other-article-${now}`,
    promptId: `metadata-repair-other-prompt-${now}`,
    useMetadata: false,
  })
  await insertStoredJudgment({
    articleId: `metadata-repair-same-article-${now}`,
    promptId: `metadata-repair-same-prompt-${now}`,
    useMetadata: true,
  })

  const service = sqliteService()

  expect(await service.repairOrphanedJudgedQueueRows({jobId: otherFlagJobId, maxRows: 10})).toMatchObject({
    deletedRows: 0,
    requeuedRows: 1,
  })
  expect(await service.repairOrphanedJudgedQueueRows({jobId: sameFlagJobId, maxRows: 10})).toMatchObject({
    deletedRows: 1,
    requeuedRows: 0,
  })
})

test('startup automatic repair preflights running jobs before live health reads', async () => {
  if (!repairModule) {
    throw new Error('Test database not initialized')
  }

  const now = Date.now()
  const connectionId = `startup-preflight-repair-connection-${now}`
  const modelId = `startup-preflight-repair-model-${now}`
  const projectId = `startup-preflight-repair-project-${now}`
  const jobId = `startup-preflight-repair-job-${now}`
  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertJobFixture({jobId, projectId, status: 'running', storageState: 'active'})
  writeFileSync(sqlitePath, 'not a sqlite database')

  try {
    const summary = await repairModule.runStartupAutomaticOrphanedQueueRepair({maxBatches: 100})
    const result = summary.results.find((entry) => {
      return entry.jobId === jobId
    })

    expect(summary.incompleteJobCount).toBeGreaterThanOrEqual(1)
    expect(result).toMatchObject({jobId, processedBatches: 0, stoppedReason: 'repair_failed'})
  } finally {
    rmSync(sqlitePath, {force: true})
  }
})

test('automatic repair stops without looping when the time bound is exhausted', async () => {
  if (!repairModule || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const now = Date.now()
  const connectionId = `bounded-repair-connection-${now}`
  const modelId = `bounded-repair-model-${now}`
  const projectId = `bounded-repair-project-${now}`
  const jobId = `bounded-repair-job-${now}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertJobFixture({jobId, projectId, status: 'running', storageState: 'active'})
  await insertOrphanedJudgedQueueFixture({
    articleId: `bounded-repair-article-${now}`,
    jobId,
    promptId: `bounded-repair-prompt-${now}`,
  })

  const result = await repairModule.runAutomaticOrphanedQueueRepairForJob({jobId, maxDurationMs: 0})
  const health = await sqliteService().getHealthSnapshot(jobId)

  expect(result).toMatchObject({
    deletedRows: 0,
    jobId,
    processedBatches: 0,
    remainingOrphanedJudgedRows: 1,
    requeuedRows: 0,
    stoppedReason: 'time_limit',
  })
  expect(health.orphanedJudgedRowCount).toBe(1)
  expect(health.promptCounts.judged).toBe(1)
})
