import {mkdirSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterEach, expect, test} from 'bun:test'

import {
  applyJudgeWorkerCompletionOutboxLocally,
  attachTokenUseToPendingJudgeWorkerCompletion,
  enqueueJudgeWorkerCompletion,
  flushJudgeWorkerCompletionOutboxForClaim,
  hasUnackedJudgeWorkerCompletion,
  type JudgeWorkerCompletionPayload,
  recordAcceptedJudgeWorkerClaims,
  replayJudgeWorkerCompletionOutbox,
  resetJudgeWorkerCompletionJournalForTests,
} from './judgeWorkerCompletionJournal.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

const originalEnv = {
  API_SERVER_PORT: process.env.API_SERVER_PORT,
  DUCKDB_PATH: process.env.DUCKDB_PATH,
  JUDGE_WORKER_JOURNAL_PATH: process.env.JUDGE_WORKER_JOURNAL_PATH,
  SERVER_DUCKDB_OWNER_URL: process.env.SERVER_DUCKDB_OWNER_URL,
  SERVER_ROLE: process.env.SERVER_ROLE,
}
const originalFetch = globalThis.fetch
const testDirectories: string[] = []
type OwnerFetchHandler = (request: Request) => Promise<Response> | Response
type CompletionOutboxTestRow = {
  ackedAt: string | null
  lastError: string | null
  status: string
  tokenUseJson: string | null
}
const successCompletionTokenUseReplayGraceMs = 30_000

const createCompletionPayload = (
  overrides: Partial<JudgeWorkerCompletionPayload> = {},
): JudgeWorkerCompletionPayload => {
  return {
    articleId: 'article-a',
    claimId: 'claim-a',
    executionSnapshotHash: 'snapshot-hash-a',
    executionSnapshotId: 'snapshot-a',
    jobId: 'job-a',
    modelId: 'model-a',
    projectId: 'project-a',
    promptId: 'prompt-a',
    queueRecordId: 'queue-a',
    status: 'judged',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

const createTokenUse = () => {
  return {
    failedRequests: 0,
    failedRequestsDetails: [],
    hasFailedRequests: false,
    modelName: 'model-a',
    successfulRequests: 1,
    totalCompletionTokens: 3,
    totalFailedCompletionTokens: 0,
    totalFailedPromptTokens: 0,
    totalFailedTokens: 0,
    totalPromptTokens: 7,
    totalRequests: 1,
    totalSuccessCompletionTokens: 3,
    totalSuccessPromptTokens: 7,
    totalSuccessTokens: 10,
    totalTokens: 10,
  }
}

const createAcceptedClaimPrompt = (payload: JudgeWorkerCompletionPayload): PromptToProcess => {
  return {
    articleId: payload.articleId,
    claimId: payload.claimId,
    executionSnapshotHash: payload.executionSnapshotHash,
    executionSnapshotId: payload.executionSnapshotId,
    jobId: payload.jobId,
    modelBaseUrl: 'http://runtime.test/v1',
    modelId: payload.modelId,
    modelMetadataJson: null,
    modelName: 'Model A',
    modelProvider: 'openai',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    projectId: payload.projectId,
    promptId: payload.promptId,
    providerConnectionId: 'connection-a',
    providerMaxInflightRequests: 10,
    providerUsesFamilyDefault: false,
    recordId: payload.queueRecordId,
    useAbstract: payload.useAbstract,
    useFulltext: payload.useFulltext,
    useFulltextNoImages: payload.useFulltextNoImages,
    useTitle: payload.useTitle,
  }
}

const setupJournalTest = (handler: OwnerFetchHandler) => {
  const testDirectory = mkdtempSync(join(tmpdir(), 'f1-judge-worker-journal-'))
  const journalPath = join(testDirectory, 'journal.sqlite')

  testDirectories.push(testDirectory)
  globalThis.fetch = async (input, init) => {
    return handler(new Request(input, init))
  }
  process.env.API_SERVER_PORT = '3001'
  process.env.DUCKDB_PATH = join(testDirectory, 'forska.duckdb')
  process.env.JUDGE_WORKER_JOURNAL_PATH = journalPath
  process.env.SERVER_DUCKDB_OWNER_URL = 'http://owner.test'
  process.env.SERVER_ROLE = 'judge-worker'

  return {journalPath, testDirectory}
}

const createLocalJobPrompt = ({
  claimId,
  payload,
  testDirectory,
}: {
  claimId: string | null
  payload: JudgeWorkerCompletionPayload
  testDirectory: string
}): void => {
  const jobsRoot = join(testDirectory, 'judgment-jobs')
  mkdirSync(jobsRoot, {recursive: true})
  const database = new Database(join(jobsRoot, `${payload.jobId}.sqlite`), {create: true})

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE job_info (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_version TEXT,
      model_base_url TEXT,
      model_secret_ref TEXT,
      model_metadata_json TEXT,
      provider_config_json TEXT,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE queue_prompt (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_kind TEXT,
      skip_reason TEXT,
      server_id TEXT,
      claim_id TEXT,
      execution_snapshot_id TEXT,
      execution_snapshot_hash TEXT,
      sent_at TEXT,
      judged_at TEXT,
      extra_retry_count INTEGER NOT NULL DEFAULT 0,
      last_recoverable_error_code TEXT,
      retry_after_at TEXT,
      request_attempt_manifest_json TEXT NOT NULL DEFAULT '[]',
      request_attempt_manifest_version INTEGER NOT NULL DEFAULT 0,
      request_attempt_manifest_repair_json TEXT,
      ready_insert_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, article_id, prompt_id)
    );
    CREATE TABLE completion_ack (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      token_use_id TEXT,
      request_attempts_json TEXT,
      completed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  database
    .query(
      `
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      payload.jobId,
      payload.projectId,
      payload.modelId,
      'Model A',
      'openai',
      Number(payload.useTitle),
      Number(payload.useAbstract),
      Number(payload.useFulltext),
      Number(payload.useFulltextNoImages),
      new Date().toISOString(),
    )
  database
    .query(
      `
        INSERT INTO queue_prompt (
          id,
          job_id,
          article_id,
          prompt_id,
          status,
          claim_id,
          execution_snapshot_id,
          execution_snapshot_hash,
          ready_insert_seq,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      payload.queueRecordId,
      payload.jobId,
      payload.articleId,
      payload.promptId,
      'claimed',
      claimId,
      payload.executionSnapshotId,
      payload.executionSnapshotHash,
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    )
  database.close(false)
}

const getCompletionOutboxRow = (journalPath: string, claimId: string) => {
  const database = new Database(journalPath, {readonly: true})
  const row = database
    .query(
      `
        SELECT acked_at AS ackedAt, last_error AS lastError, status, token_use_json AS tokenUseJson
        FROM completion_outbox
        WHERE claim_id = ?
        LIMIT 1
      `,
    )
    .get(claimId) as CompletionOutboxTestRow | null

  database.close(false)
  return row
}

const getAcceptedClaimCount = (journalPath: string, claimId: string): number => {
  const database = new Database(journalPath, {readonly: true})
  const row = database
    .query(
      `
        SELECT COUNT(*) AS count
        FROM accepted_claim
        WHERE claim_id = ?
      `,
    )
    .get(claimId) as {count: number} | null

  database.close(false)
  return row?.count ?? 0
}

const getQueuePromptState = (testDirectory: string, payload: JudgeWorkerCompletionPayload) => {
  const database = new Database(join(testDirectory, 'judgment-jobs', `${payload.jobId}.sqlite`), {readonly: true})
  const row = database
    .query(
      `
        SELECT claim_id AS claimId, status
        FROM queue_prompt
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(payload.queueRecordId) as {claimId: string | null; status: string} | null

  database.close(false)
  return row
}

afterEach(async () => {
  resetJudgeWorkerCompletionJournalForTests()
  globalThis.fetch = originalFetch
  testDirectories.splice(0, testDirectories.length).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
  process.env.API_SERVER_PORT = originalEnv.API_SERVER_PORT
  process.env.DUCKDB_PATH = originalEnv.DUCKDB_PATH
  process.env.JUDGE_WORKER_JOURNAL_PATH = originalEnv.JUDGE_WORKER_JOURNAL_PATH
  process.env.SERVER_DUCKDB_OWNER_URL = originalEnv.SERVER_DUCKDB_OWNER_URL
  process.env.SERVER_ROLE = originalEnv.SERVER_ROLE
})

test('completion replay logs plain owner errors without JSON parse masking', async () => {
  const {journalPath} = setupJournalTest(async () => {
    return new Response('missing owner completion endpoint', {status: 503})
  })
  const payload = createCompletionPayload({status: 'retry'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 0, failedCount: 1})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(true)
  expect(row?.ackedAt).toBeNull()
  expect(row?.lastError).toContain('owner-backed judgment request failed (503): missing owner completion endpoint')
  expect(row?.lastError).not.toContain('JSON Parse error')
})

test('completion flushes are globally bounded so owner ack cannot stampede', async () => {
  let activeRequests = 0
  let maxActiveRequests = 0
  const {journalPath} = setupJournalTest(async (request) => {
    activeRequests += 1
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    activeRequests -= 1
    const body = (await request.json()) as JudgeWorkerCompletionPayload

    return Response.json({
      data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: body.status ?? 'judged'},
      error: null,
    })
  })
  const payloads = Array.from({length: 16}, (_value, index) => {
    return createCompletionPayload({
      articleId: `article-${index}`,
      claimId: `claim-${index}`,
      queueRecordId: `queue-${index}`,
      status: 'retry',
    })
  })

  await Promise.all(
    payloads.map((payload) => {
      return enqueueJudgeWorkerCompletion(payload)
    }),
  )
  const replays = await Promise.all(
    payloads.map((payload) => {
      return flushJudgeWorkerCompletionOutboxForClaim(payload.claimId)
    }),
  )

  expect(maxActiveRequests).toBeLessThanOrEqual(8)
  expect(
    replays.reduce((total, replay) => {
      return total + replay.ackedCount
    }, 0),
  ).toBe(16)
  expect(getCompletionOutboxRow(journalPath, 'claim-0')?.ackedAt).not.toBeNull()
})

test('completion replay discards stale missing-claim responses', async () => {
  const {journalPath} = setupJournalTest(async () => {
    return new Response('missing claimed prompt identity', {status: 409})
  })
  const payload = createCompletionPayload({claimId: 'claim-stale', status: 'retry'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('owner-backed judgment request failed (409): missing claimed prompt identity')
})

test('completion replay discards locally stale claims without calling the owner', async () => {
  let ownerCalls = 0
  const {journalPath, testDirectory} = setupJournalTest(async () => {
    ownerCalls += 1
    return Response.json({data: {claimId: 'unexpected', queueRecordId: 'unexpected', status: 'retry'}})
  })
  const payload = createCompletionPayload({claimId: 'claim-local-stale', status: 'retry'})

  createLocalJobPrompt({claimId: 'claim-current', payload, testDirectory})
  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(ownerCalls).toBe(0)
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('snapshot claim identity mismatch for claimId')
})

test('local completion apply releases retry rows without owner calls', async () => {
  let ownerCalls = 0
  const {journalPath, testDirectory} = setupJournalTest(() => {
    ownerCalls += 1
    return new Response('owner should not be called', {status: 500})
  })
  const payload = createCompletionPayload({
    claimId: 'claim-local-retry',
    jobId: 'job-local-retry',
    queueRecordId: 'queue-local-retry',
    status: 'retry',
  })

  createLocalJobPrompt({claimId: payload.claimId, payload, testDirectory})
  await recordAcceptedJudgeWorkerClaims([createAcceptedClaimPrompt(payload)])
  await enqueueJudgeWorkerCompletion(payload)

  const result = await applyJudgeWorkerCompletionOutboxLocally({limit: 1})
  const queuePrompt = getQueuePromptState(testDirectory, payload)
  const database = new Database(journalPath, {readonly: true})
  const outbox = database
    .query(
      `
        SELECT acked_at AS ackedAt, local_applied_at AS localAppliedAt
        FROM completion_outbox
        WHERE claim_id = ?
        LIMIT 1
      `,
    )
    .get(payload.claimId) as {ackedAt: string | null; localAppliedAt: string | null} | null
  database.close(false)

  expect(ownerCalls).toBe(0)
  expect(result.appliedCount).toBe(1)
  expect(queuePrompt).toEqual({claimId: null, status: 'ready'})
  expect(outbox?.ackedAt).toBeNull()
  expect(outbox?.localAppliedAt).toBeTruthy()
})

test('completion replay discards stale missing SQLite job database responses', async () => {
  const {journalPath} = setupJournalTest(async () => {
    return new Response('missing SQLite job database', {status: 409})
  })
  const payload = createCompletionPayload({claimId: 'claim-missing-sqlite', status: 'retry'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('owner-backed judgment request failed (409): missing SQLite job database')
})

test('completion replay discards stale snapshot identity mismatch responses', async () => {
  const {journalPath} = setupJournalTest(async () => {
    return new Response('snapshot identity mismatch for judgment completion', {status: 409})
  })
  const payload = createCompletionPayload({claimId: 'claim-snapshot-mismatch', status: 'retry'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('owner-backed judgment request failed (409): snapshot identity mismatch')
})

test('completion replay discards stale snapshot claim identity mismatch responses', async () => {
  const {journalPath} = setupJournalTest(async () => {
    return new Response('snapshot claim identity mismatch for claimId', {status: 409})
  })
  const payload = createCompletionPayload({claimId: 'claim-snapshot-claim-mismatch', status: 'retry'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('owner-backed judgment request failed (409): snapshot claim identity mismatch')
})

test('completion replay limit skips rows still waiting for token use', async () => {
  const receivedClaimIds: string[] = []
  setupJournalTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string}
    receivedClaimIds.push(body.claimId)

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}})
  })
  const waitingPayload = createCompletionPayload({claimId: 'claim-limit-waiting', queueRecordId: 'queue-limit-waiting'})
  const retryPayload = createCompletionPayload({
    claimId: 'claim-limit-retry',
    queueRecordId: 'queue-limit-retry',
    status: 'retry',
  })

  await enqueueJudgeWorkerCompletion(waitingPayload)
  await enqueueJudgeWorkerCompletion(retryPayload)

  const result = await replayJudgeWorkerCompletionOutbox({limit: 1})

  expect(result).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(receivedClaimIds).toEqual(['claim-limit-retry'])
  expect(await hasUnackedJudgeWorkerCompletion(waitingPayload.claimId)).toBe(true)
  expect(await hasUnackedJudgeWorkerCompletion(retryPayload.claimId)).toBe(false)
})

test('completion replay deletes accepted claim rows after owner ack', async () => {
  const {journalPath} = setupJournalTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string}

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}})
  })
  const payload = createCompletionPayload({claimId: 'claim-accepted-cleanup'})

  await recordAcceptedJudgeWorkerClaims([createAcceptedClaimPrompt(payload)])
  await enqueueJudgeWorkerCompletion(payload)

  expect(getAcceptedClaimCount(journalPath, payload.claimId)).toBe(1)
  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 0, discardedCount: 0, failedCount: 0})

  await attachTokenUseToPendingJudgeWorkerCompletion({
    articleId: payload.articleId,
    jobId: payload.jobId,
    promptIds: [payload.promptId],
    tokenUse: createTokenUse(),
  })

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(getAcceptedClaimCount(journalPath, payload.claimId)).toBe(0)
})

test('judged completion replay waits for token use', async () => {
  let requestCount = 0
  let receivedTokenUse: unknown = null
  const {journalPath} = setupJournalTest(async (request) => {
    requestCount += 1
    const body = (await request.json()) as {claimId: string; queueRecordId: string; tokenUse?: unknown}
    receivedTokenUse = body.tokenUse ?? null

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}})
  })
  const payload = createCompletionPayload()

  await enqueueJudgeWorkerCompletion(payload)

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 0, discardedCount: 0, failedCount: 0})
  expect(requestCount).toBe(0)
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(true)

  await attachTokenUseToPendingJudgeWorkerCompletion({
    articleId: payload.articleId,
    jobId: payload.jobId,
    promptIds: [payload.promptId],
    tokenUse: createTokenUse(),
  })

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(requestCount).toBe(1)
  expect(receivedTokenUse).toMatchObject({totalRequests: 1, totalTokens: 10})
  expect(getCompletionOutboxRow(journalPath, payload.claimId)?.ackedAt).not.toBeNull()
})

test('judged completion replay eventually proceeds without token use after grace period', async () => {
  let receivedTokenUse: unknown = 'unset'
  const {journalPath} = setupJournalTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string; tokenUse?: unknown}
    receivedTokenUse = body.tokenUse ?? null

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}})
  })
  const payload = createCompletionPayload()

  await enqueueJudgeWorkerCompletion(payload)
  const staleUpdatedAt = new Date(Date.now() - successCompletionTokenUseReplayGraceMs - 1_000).toISOString()
  const database = new Database(journalPath)
  database.query(`UPDATE completion_outbox SET updated_at = ? WHERE claim_id = ?`).run(staleUpdatedAt, payload.claimId)
  database.close(false)

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(receivedTokenUse).toBeNull()
  expect(getCompletionOutboxRow(journalPath, payload.claimId)?.ackedAt).not.toBeNull()
})

test('late token use replays an already acked judged completion', async () => {
  let receivedTokenUse: unknown = null
  const {journalPath} = setupJournalTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string; tokenUse?: unknown}
    receivedTokenUse = body.tokenUse ?? null

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}})
  })
  const payload = createCompletionPayload()

  await enqueueJudgeWorkerCompletion(payload)
  const database = new Database(journalPath)
  database
    .query(`UPDATE completion_outbox SET acked_at = ?, updated_at = ? WHERE claim_id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), payload.claimId)
  database.close(false)

  await attachTokenUseToPendingJudgeWorkerCompletion({
    articleId: payload.articleId,
    jobId: payload.jobId,
    promptIds: [payload.promptId],
    tokenUse: createTokenUse(),
  })

  const reactivatedRow = getCompletionOutboxRow(journalPath, payload.claimId)
  expect(reactivatedRow?.ackedAt).toBeNull()
  expect(reactivatedRow?.tokenUseJson).not.toBeNull()

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(receivedTokenUse).toMatchObject({totalRequests: 1, totalTokens: 10})
})

test('pending token use reactivates acked judged completion during replay', async () => {
  let receivedTokenUse: unknown = null
  const {journalPath} = setupJournalTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string; tokenUse?: unknown}
    receivedTokenUse = body.tokenUse ?? null

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'judged'}})
  })
  const payload = createCompletionPayload()
  const now = new Date().toISOString()

  await enqueueJudgeWorkerCompletion(payload)
  const database = new Database(journalPath)
  database.transaction(() => {
    database
      .query(`UPDATE completion_outbox SET acked_at = ?, updated_at = ? WHERE claim_id = ?`)
      .run(now, now, payload.claimId)
    database
      .query(
        `
          INSERT INTO pending_token_use (
            job_id,
            claim_id,
            queue_record_id,
            article_id,
            prompt_id,
            request_attempt_id,
            token_use_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        payload.jobId,
        payload.claimId,
        payload.queueRecordId,
        payload.articleId,
        payload.promptId,
        'request-attempt-a',
        JSON.stringify(createTokenUse()),
        now,
        now,
      )
  })()
  database.close(false)

  expect(await replayJudgeWorkerCompletionOutbox()).toEqual({ackedCount: 1, discardedCount: 0, failedCount: 0})
  expect(receivedTokenUse).toMatchObject({totalRequests: 1, totalTokens: 10})
  expect(getCompletionOutboxRow(journalPath, payload.claimId)?.ackedAt).not.toBeNull()
})
