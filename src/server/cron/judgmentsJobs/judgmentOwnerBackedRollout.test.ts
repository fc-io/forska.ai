import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterEach, expect, test} from 'bun:test'

import {
  mutateAcceptedClaimRequestAttemptManifest,
  recordAcceptedJudgeWorkerClaims,
  recoverAbandonedJudgeWorkerAcceptedClaims,
  resetJudgeWorkerCompletionJournalForTests,
  runJudgeWorkerRolloutCleanup,
} from './judgeWorkerCompletionJournal.ts'
import type {JudgmentRequestAttemptJsonEntry} from './judgmentRequestAttemptManifest.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

const originalEnv = {
  API_SERVER_PORT: process.env.API_SERVER_PORT,
  JUDGE_WORKER_JOURNAL_PATH: process.env.JUDGE_WORKER_JOURNAL_PATH,
  SERVER_DUCKDB_OWNER_URL: process.env.SERVER_DUCKDB_OWNER_URL,
  SERVER_ROLE: process.env.SERVER_ROLE,
}
const originalFetch = globalThis.fetch
const testDirectories: string[] = []
type OwnerFetchHandler = (request: Request) => Promise<Response> | Response
type JournalRolloutState = {
  acceptedClaimCount: number
  ackedAt: string | null
  completionOutboxCount: number
  requestAttemptsJson: string | null
}

const createPrompt = (overrides: Partial<PromptToProcess> = {}): PromptToProcess => {
  return {
    articleId: 'article-rollout',
    claimId: 'claim-rollout',
    executionSnapshotHash: 'snapshot-hash-rollout',
    executionSnapshotId: 'snapshot-rollout',
    jobId: 'job-rollout',
    maxInflightRequests: null,
    modelBaseUrl: 'http://owner-runtime.test/v1',
    modelId: 'model-rollout',
    modelMetadataJson: {},
    modelName: 'model-rollout',
    modelProvider: 'sglang',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    projectId: 'project-rollout',
    promptId: 'prompt-rollout',
    providerConnectionId: null,
    providerKey: 'provider-rollout',
    providerMaxInflightRequests: null,
    providerUsesFamilyDefault: false,
    recordId: 'queue-rollout',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

const createRequestAttempt = (prompt: PromptToProcess): JudgmentRequestAttemptJsonEntry => {
  return {
    articleId: prompt.articleId,
    claimId: prompt.claimId,
    closeoutKind: 'live_request',
    jobId: prompt.jobId,
    outcome: 'unknown',
    promptId: prompt.promptId,
    providerKey: prompt.providerKey ?? 'provider-rollout',
    queueRecordId: prompt.recordId,
    requestAttemptId: 'attempt-rollout',
  }
}

const setupRolloutTest = (handler: OwnerFetchHandler) => {
  const testDirectory = mkdtempSync(join(tmpdir(), 'f1-judge-worker-rollout-'))
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

const readJournalRolloutState = (journalPath: string, claimId: string): JournalRolloutState => {
  const database = new Database(journalPath, {readonly: true})
  const acceptedClaimCount = Number(
    (database.query(`SELECT COUNT(*) AS count FROM accepted_claim WHERE claim_id = ?`).get(claimId) as {count: number})
      .count,
  )
  const row = database
    .query(
      `
        SELECT
          COUNT(*) AS completionOutboxCount,
          MAX(acked_at) AS ackedAt,
          MAX(request_attempts_json) AS requestAttemptsJson
        FROM completion_outbox
        WHERE claim_id = ?
      `,
    )
    .get(claimId) as {ackedAt: string | null; completionOutboxCount: number; requestAttemptsJson: string | null}

  database.close(false)

  return {
    acceptedClaimCount,
    ackedAt: row.ackedAt,
    completionOutboxCount: Number(row.completionOutboxCount),
    requestAttemptsJson: row.requestAttemptsJson,
  }
}

const addAcceptedClaimWithManifest = async (prompt: PromptToProcess) => {
  await recordAcceptedJudgeWorkerClaims([prompt])
  await mutateAcceptedClaimRequestAttemptManifest({
    mutation: {mergeEntries: [createRequestAttempt(prompt)]},
    owner: {
      articleId: prompt.articleId,
      claimId: prompt.claimId,
      jobId: prompt.jobId,
      kind: 'accepted_claim',
      promptId: prompt.promptId,
      promptIds: [prompt.promptId],
      queueRecordId: prompt.recordId,
    },
  })
}

afterEach(() => {
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

test('owner-backed rollout cleanup writes closeout intent before owner call and deletes accepted claim after ack', async () => {
  const ownerRequests: unknown[] = []
  const prompt = createPrompt()
  const {journalPath} = setupRolloutTest(async (request) => {
    const durableState = readJournalRolloutState(journalPath, prompt.claimId)
    const body = (await request.json()) as {claimId: string; queueRecordId: string; requestAttempts?: unknown[]}

    ownerRequests.push(body)
    expect(durableState.completionOutboxCount).toBe(1)
    expect(durableState.ackedAt).toBeNull()

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}})
  })

  await addAcceptedClaimWithManifest(prompt)

  expect(await runJudgeWorkerRolloutCleanup()).toEqual({
    acceptedClaimsDeleted: 1,
    closeoutIntentsInserted: 1,
    replay: {ackedCount: 1, discardedCount: 0, failedCount: 0},
  })
  expect(ownerRequests).toHaveLength(1)
  expect(ownerRequests[0]).toMatchObject({claimId: prompt.claimId, queueRecordId: prompt.recordId, status: 'retry'})

  const state = readJournalRolloutState(journalPath, prompt.claimId)
  const requestAttempts = JSON.parse(state.requestAttemptsJson ?? '[]') as JudgmentRequestAttemptJsonEntry[]

  expect(state.acceptedClaimCount).toBe(0)
  expect(state.completionOutboxCount).toBe(1)
  expect(state.ackedAt).not.toBeNull()
  expect(requestAttempts[0]).toMatchObject({
    closeoutKind: 'completion_outbox',
    closeoutReason: 'robustSendRolloutDiscarded',
    durableCloseoutRef: {claimId: prompt.claimId, kind: 'completion_outbox', queueRecordId: prompt.recordId},
    requestAttemptId: 'attempt-rollout',
  })

  expect(await runJudgeWorkerRolloutCleanup()).toEqual({
    acceptedClaimsDeleted: 0,
    closeoutIntentsInserted: 0,
    replay: {ackedCount: 0, discardedCount: 0, failedCount: 0},
  })
  expect(ownerRequests).toHaveLength(1)
})

test('owner-backed rollout cleanup keeps accepted claim until durable closeout is acked', async () => {
  const prompt = createPrompt({claimId: 'claim-rollout-retry', recordId: 'queue-rollout-retry'})
  const {journalPath} = setupRolloutTest(async () => {
    const durableState = readJournalRolloutState(journalPath, prompt.claimId)

    expect(durableState.completionOutboxCount).toBe(1)
    return new Response('owner unavailable', {status: 503})
  })

  await addAcceptedClaimWithManifest(prompt)

  expect(await runJudgeWorkerRolloutCleanup()).toEqual({
    acceptedClaimsDeleted: 0,
    closeoutIntentsInserted: 1,
    replay: {ackedCount: 0, discardedCount: 0, failedCount: 1},
  })
  expect(readJournalRolloutState(journalPath, prompt.claimId)).toMatchObject({
    acceptedClaimCount: 1,
    ackedAt: null,
    completionOutboxCount: 1,
  })

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = (await request.json()) as {claimId: string; queueRecordId: string}

    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}})
  }

  const database = new Database(journalPath)
  const staleAttemptAt = new Date(Date.now() - 61_000).toISOString()

  try {
    database
      .query(`UPDATE completion_outbox SET last_attempt_at = ?, updated_at = ? WHERE claim_id = ?`)
      .run(staleAttemptAt, staleAttemptAt, prompt.claimId)
  } finally {
    database.close(false)
  }

  expect(await runJudgeWorkerRolloutCleanup()).toEqual({
    acceptedClaimsDeleted: 1,
    closeoutIntentsInserted: 0,
    replay: {ackedCount: 1, discardedCount: 0, failedCount: 0},
  })
  expect(readJournalRolloutState(journalPath, prompt.claimId)).toMatchObject({
    acceptedClaimCount: 0,
    completionOutboxCount: 1,
  })
})

test('accepted claim recovery skips prompts still active in dispatch runtime', async () => {
  const ownerRequests: unknown[] = []
  const activePrompt = createPrompt({claimId: 'claim-active', recordId: 'queue-active'})
  const abandonedPrompt = createPrompt({claimId: 'claim-abandoned', recordId: 'queue-abandoned'})
  const {journalPath} = setupRolloutTest(async (request) => {
    const body = (await request.json()) as {claimId: string; queueRecordId: string}

    ownerRequests.push(body)
    return Response.json({data: {claimId: body.claimId, queueRecordId: body.queueRecordId, status: 'retry'}})
  })

  await addAcceptedClaimWithManifest(activePrompt)
  await addAcceptedClaimWithManifest(abandonedPrompt)

  expect(
    await recoverAbandonedJudgeWorkerAcceptedClaims({
      protectedPrompts: [{jobId: activePrompt.jobId, queueRecordId: activePrompt.recordId}],
    }),
  ).toEqual({
    acceptedClaimsDeleted: 1,
    closeoutIntentsInserted: 1,
    replay: {ackedCount: 1, discardedCount: 0, failedCount: 0},
  })

  expect(ownerRequests).toHaveLength(1)
  expect(ownerRequests[0]).toMatchObject({claimId: abandonedPrompt.claimId, queueRecordId: abandonedPrompt.recordId})
  expect(readJournalRolloutState(journalPath, activePrompt.claimId)).toMatchObject({
    acceptedClaimCount: 1,
    completionOutboxCount: 0,
  })
  expect(readJournalRolloutState(journalPath, abandonedPrompt.claimId)).toMatchObject({
    acceptedClaimCount: 0,
    completionOutboxCount: 1,
  })
})
