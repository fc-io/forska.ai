import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterEach, expect, test} from 'bun:test'

import {
  attachTokenUseToPendingJudgeWorkerCompletion,
  enqueueJudgeWorkerCompletion,
  hasUnackedJudgeWorkerCompletion,
  type JudgeWorkerCompletionPayload,
  replayJudgeWorkerCompletionOutbox,
  resetJudgeWorkerCompletionJournalForTests,
} from './judgeWorkerCompletionJournal.ts'

const originalEnv = {
  API_SERVER_PORT: process.env.API_SERVER_PORT,
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

const setupJournalTest = (handler: OwnerFetchHandler) => {
  const testDirectory = mkdtempSync(join(tmpdir(), 'f1-judge-worker-journal-'))
  const journalPath = join(testDirectory, 'journal.sqlite')

  testDirectories.push(testDirectory)
  globalThis.fetch = async (input, init) => {
    return handler(new Request(input, init))
  }
  process.env.API_SERVER_PORT = '3001'
  process.env.JUDGE_WORKER_JOURNAL_PATH = journalPath
  process.env.SERVER_DUCKDB_OWNER_URL = 'http://owner.test'
  process.env.SERVER_ROLE = 'judge-worker'

  return {journalPath}
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

afterEach(async () => {
  resetJudgeWorkerCompletionJournalForTests()
  globalThis.fetch = originalFetch
  testDirectories.splice(0, testDirectories.length).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
  process.env.API_SERVER_PORT = originalEnv.API_SERVER_PORT
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
