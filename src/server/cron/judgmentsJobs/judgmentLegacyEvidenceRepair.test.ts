import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import type {JudgeWorkerTokenUseSummary} from './judgeWorkerCompletionJournal.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgment-legacy-evidence-repair')
const tempDbPath = tempRuntimeRoot.duckdbPath
const tempJobDir = tempRuntimeRoot.judgmentJobsDirectory

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let importOutboxBatch:
  | (typeof import('./judgmentJobSqliteOutboxImport.ts'))['importJudgmentJobSqliteOutboxBatch']
  | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let repairLegacyTokenUseEvidenceForJob:
  | (typeof import('./judgmentLegacyEvidenceRepair.ts'))['repairLegacyTokenUseEvidenceForJob']
  | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let runStartupJudgmentRolloutCleanup:
  | (typeof import('./judgmentStartupRolloutCleanup.ts'))['runStartupJudgmentRolloutCleanup']
  | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let getJudgmentJobSqlitePath: (typeof import('./judgmentJobPaths.ts'))['getJudgmentJobSqlitePath'] | null = null
let legacyCompletionEvidenceQuarantinedReason: string | null = null
let legacyRolloutImportedCloseoutReason: string | null = null
let journalModule: typeof import('./judgeWorkerCompletionJournal.ts') | null = null

const originalEnv = {
  JUDGE_WORKER_JOURNAL_PATH: process.env.JUDGE_WORKER_JOURNAL_PATH,
  SERVER_DUCKDB_OWNER_URL: process.env.SERVER_DUCKDB_OWNER_URL,
  SERVER_ROLE: process.env.SERVER_ROLE,
}
const journalDirectories: string[] = []

const parseJsonValue = (value: unknown): unknown => {
  return typeof value === 'string' ? parseJsonValue(JSON.parse(value) as unknown) : value
}

const restoreEnvValue = (key: keyof typeof originalEnv) => {
  const value = originalEnv[key]

  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

const setupGraph = async (suffix: string) => {
  if (!runDatabase) {
    throw new Error('Test database not initialized')
  }

  const connectionId = `legacy-connection-${suffix}`
  const modelId = `legacy-model-${suffix}`
  const projectId = `legacy-project-${suffix}`
  const jobId = `legacy-job-${suffix}`
  const promptId = `legacy-prompt-${suffix}`
  const articleId = `legacy-article-${suffix}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'legacy-model', 'legacy-model', 'Legacy Model', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Legacy Repair Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
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

  return {articleId, jobId, modelId, projectId, promptId}
}

const getOutboxRequestAttempts = (jobId: string) => {
  if (!getJudgmentJobSqlitePath) {
    throw new Error('SQLite path helper not initialized')
  }

  const database = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})
  const row = database
    .query(
      `
        SELECT request_attempts_json AS requestAttemptsJson
        FROM judgment_outbox
        LIMIT 1
      `,
    )
    .get() as {requestAttemptsJson: string | null} | null
  database.close(false)

  return JSON.parse(row?.requestAttemptsJson ?? '[]') as Array<Record<string, unknown>>
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    importModule,
    rolloutModule,
    legacyRepairModule,
    pathsModule,
    currentJournalModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentJobSqliteOutboxImport.ts'),
    import('./judgmentStartupRolloutCleanup.ts'),
    import('./judgmentLegacyEvidenceRepair.ts'),
    import('./judgmentJobPaths.ts'),
    import('./judgeWorkerCompletionJournal.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
  importOutboxBatch = importModule.importJudgmentJobSqliteOutboxBatch
  runStartupJudgmentRolloutCleanup = rolloutModule.runStartupJudgmentRolloutCleanup
  repairLegacyTokenUseEvidenceForJob = legacyRepairModule.repairLegacyTokenUseEvidenceForJob
  legacyCompletionEvidenceQuarantinedReason = legacyRepairModule.legacyCompletionEvidenceQuarantinedReason
  legacyRolloutImportedCloseoutReason = legacyRepairModule.legacyRolloutImportedCloseoutReason
  getJudgmentJobSqlitePath = pathsModule.getJudgmentJobSqlitePath
  journalModule = currentJournalModule
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

afterEach(async () => {
  await sqliteService?.().closeAll()
  journalModule?.resetJudgeWorkerCompletionJournalForTests()
  rmSync(tempJobDir, {force: true, recursive: true})
  journalDirectories.splice(0, journalDirectories.length).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
  restoreEnvValue('JUDGE_WORKER_JOURNAL_PATH')
  restoreEnvValue('SERVER_DUCKDB_OWNER_URL')
  restoreEnvValue('SERVER_ROLE')
})

test('safe legacy SQLite outbox import writes deterministic legacy request attempt evidence', async () => {
  if (!importOutboxBatch || !sqliteService) {
    throw new Error('Test modules not initialized')
  }

  const suffix = `outbox-${Date.now()}`
  const {articleId, jobId, modelId, projectId, promptId} = await setupGraph(suffix)
  const service = sqliteService()

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite prompt')
  }

  await service.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date('2026-05-03T12:00:00.000Z'),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `legacy-judgment-${suffix}`,
    modelId,
    projectId,
    promptId,
    queuePromptId: claimed.recordId,
    quotes: [],
    rawResponseJson: {answer: 'yes'},
    requestAttemptsJson: null,
    snapshotProjectId: projectId,
    snapshotProjectModelName: null,
    updatedAt: new Date('2026-05-03T12:00:01.000Z'),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(await importOutboxBatch({claimedBy: 'server-a', jobId})).toBe(1)

  const requestAttempts = getOutboxRequestAttempts(jobId)

  expect(requestAttempts[0]?.requestAttemptId).toStartWith('legacyRequestAttemptId:judgment_outbox:')
  expect(requestAttempts[0]?.legacyRequestAttemptId).toBe(requestAttempts[0]?.requestAttemptId)
  expect(requestAttempts[0]?.closeoutReason).toBe(legacyRolloutImportedCloseoutReason)
  expect(requestAttempts[0]?.durableCloseoutRef).toMatchObject({
    id: `legacy-judgment-${suffix}`,
    kind: 'judgment_outbox',
    queueRecordId: claimed.recordId,
  })
  expect(requestAttempts[0]?.legacyDurableRowRef).toMatchObject({outboxSeq: 1, surface: 'judgment_outbox'})
})

test('legacy completion ack with invalid request attempts keeps rollout job draining for repair', async () => {
  if (!queryDatabase || !runStartupJudgmentRolloutCleanup || !sqliteService) {
    throw new Error('Test modules not initialized')
  }

  const suffix = `ack-${Date.now()}`
  const {articleId, jobId, promptId} = await setupGraph(suffix)
  const service = sqliteService()

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite prompt')
  }

  await service.markPromptAsRetry(jobId, claimed.recordId, null, {
    claimId: claimed.claimId,
    queuePromptId: claimed.recordId,
    requestAttemptsJson: JSON.stringify({bad: true}),
    status: 'retry',
    tokenUseId: null,
  })

  expect(await runStartupJudgmentRolloutCleanup({claimedBy: 'server-a'})).toMatchObject({
    drainingJobCount: 1,
    failedJobCount: 0,
  })

  const [job] = await queryDatabase<{lastImportError: string | null; status: string; storageState: string}>(`
    SELECT
      last_import_error AS lastImportError,
      status,
      storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
    LIMIT 1
  `)

  expect(job).toEqual({
    lastImportError: legacyCompletionEvidenceQuarantinedReason,
    status: 'paused',
    storageState: 'draining',
  })
})

test('legacy token-use and pending-token-use rows are converted with durable row references', async () => {
  if (!queryDatabase || !repairLegacyTokenUseEvidenceForJob || !runDatabase || !journalModule) {
    throw new Error('Test modules not initialized')
  }

  const suffix = `token-${Date.now()}`
  const {jobId} = await setupGraph(suffix)

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
      created_at,
      started_at,
      finished_at
    ) VALUES (
      'legacy-token-use-${suffix}',
      '${jobId}',
      1,
      10,
      5,
      15,
      1,
      0,
      TIMESTAMPTZ '2026-05-03T12:00:00.000Z',
      TIMESTAMPTZ '2026-05-03T12:00:01.000Z',
      TIMESTAMPTZ '2026-05-03T12:00:02.000Z'
    )
  `)

  expect(await repairLegacyTokenUseEvidenceForJob(jobId)).toMatchObject({convertedCount: 1, quarantinedCount: 0})

  const [tokenUseRow] = await queryDatabase<{requestAttemptsJson: unknown}>(`
    SELECT request_attempts_json AS requestAttemptsJson
    FROM app.token_use
    WHERE id = 'legacy-token-use-${suffix}'
    LIMIT 1
  `)
  const parsedTokenUseAttempts = parseJsonValue(tokenUseRow?.requestAttemptsJson)
  const tokenUseAttempts = Array.isArray(parsedTokenUseAttempts)
    ? (parsedTokenUseAttempts as Array<Record<string, unknown>>)
    : []
  const tokenUseAttempt = tokenUseAttempts[0]
  const tokenUseAttemptRequestAttemptId =
    typeof tokenUseAttempt?.requestAttemptId === 'string' ? tokenUseAttempt.requestAttemptId : ''
  const tokenUseAttemptProviderKey = typeof tokenUseAttempt?.providerKey === 'string' ? tokenUseAttempt.providerKey : ''
  const tokenUseAttemptCloseoutKind =
    typeof tokenUseAttempt?.closeoutKind === 'string' ? tokenUseAttempt.closeoutKind : ''

  expect(tokenUseAttemptRequestAttemptId).toStartWith('legacyRequestAttemptId:token_use:')
  expect(tokenUseAttempt?.closeoutReason).toBe(legacyRolloutImportedCloseoutReason)
  expect(tokenUseAttempt?.legacyDurableRowRef).toMatchObject({id: `legacy-token-use-${suffix}`, surface: 'token_use'})

  const [projectionRow] = await queryDatabase<{
    closedAtMs: number | string
    closeoutKind: string
    durableCloseoutId: string | null
    durableCloseoutRefJson: unknown
    providerKey: string
    requestAttemptId: string
    tokenUseCreatedAtMs: number | string
    tokenUseId: string
  }>(`
    SELECT
      token_use_id AS tokenUseId,
      epoch_ms(token_use_created_at) AS tokenUseCreatedAtMs,
      request_attempt_id AS requestAttemptId,
      provider_key AS providerKey,
      closeout_kind AS closeoutKind,
      durable_closeout_id AS durableCloseoutId,
      TO_JSON(durable_closeout_ref_json) AS durableCloseoutRefJson,
      epoch_ms(closed_at) AS closedAtMs
    FROM app.request_attempt_closeout
    WHERE token_use_id = 'legacy-token-use-${suffix}'
    LIMIT 1
  `)

  expect(projectionRow?.tokenUseId).toBe(`legacy-token-use-${suffix}`)
  expect(Number(projectionRow?.tokenUseCreatedAtMs)).toBe(new Date('2026-05-03T12:00:00.000Z').getTime())
  expect(projectionRow?.requestAttemptId).toBe(tokenUseAttemptRequestAttemptId)
  expect(projectionRow?.providerKey).toBe(tokenUseAttemptProviderKey)
  expect(projectionRow?.closeoutKind).toBe(tokenUseAttemptCloseoutKind)
  expect(projectionRow?.durableCloseoutId).toBe(`legacy-token-use-${suffix}`)
  expect(parseJsonValue(projectionRow?.durableCloseoutRefJson)).toEqual(tokenUseAttempt?.durableCloseoutRef)
  expect(Number(projectionRow?.closedAtMs)).toBe(new Date('2026-05-03T12:00:02.000Z').getTime())

  const journalDirectory = mkdtempSync(join(tmpdir(), 'f1-legacy-pending-token-use-'))
  const journalPath = join(journalDirectory, 'journal.sqlite')
  const tokenUse: JudgeWorkerTokenUseSummary = {
    failedRequests: 0,
    failedRequestsDetails: [],
    hasFailedRequests: false,
    modelName: 'legacy-model',
    successfulRequests: 1,
    totalCompletionTokens: 5,
    totalFailedCompletionTokens: 0,
    totalFailedPromptTokens: 0,
    totalFailedTokens: 0,
    totalPromptTokens: 10,
    totalRequests: 1,
    totalSuccessCompletionTokens: 5,
    totalSuccessPromptTokens: 10,
    totalSuccessTokens: 15,
    totalTokens: 15,
  }

  journalDirectories.push(journalDirectory)
  process.env.JUDGE_WORKER_JOURNAL_PATH = journalPath
  process.env.SERVER_DUCKDB_OWNER_URL = 'http://127.0.0.1:1'
  process.env.SERVER_ROLE = 'judge-worker'

  await journalModule.attachTokenUseToPendingJudgeWorkerCompletion({
    articleId: 'journal-article',
    jobId: 'journal-job',
    promptIds: ['journal-prompt'],
    requestAttempts: [],
    tokenUse,
  })
  journalModule.resetJudgeWorkerCompletionJournalForTests()
  await journalModule.replayJudgeWorkerCompletionOutbox()

  const journalDatabase = new Database(journalPath, {readonly: true})
  const pendingRow = journalDatabase
    .query(
      `
        SELECT
          request_attempt_id AS requestAttemptId,
          request_attempts_json AS requestAttemptsJson
        FROM pending_token_use
        LIMIT 1
      `,
    )
    .get() as {requestAttemptId: string; requestAttemptsJson: string | null} | null
  journalDatabase.close(false)

  const pendingAttempts = JSON.parse(pendingRow?.requestAttemptsJson ?? '[]') as Array<Record<string, unknown>>

  expect(pendingRow?.requestAttemptId).toStartWith('legacyRequestAttemptId:pending_token_use:')
  expect(pendingAttempts[0]?.requestAttemptId).toBe(pendingRow?.requestAttemptId)
  expect(pendingAttempts[0]?.closeoutReason).toBe(legacyRolloutImportedCloseoutReason)
  expect(pendingAttempts[0]?.legacyDurableRowRef).toMatchObject({surface: 'pending_token_use'})
})
