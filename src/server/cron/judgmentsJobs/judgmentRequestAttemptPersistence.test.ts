import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterEach, expect, test} from 'bun:test'

import {
  attachTokenUseToPendingJudgeWorkerCompletion,
  enqueueJudgeWorkerCompletion,
  type JudgeWorkerCompletionPayload,
  type JudgeWorkerTokenUseSummary,
  mutateAcceptedClaimRequestAttemptManifest,
  recordAcceptedJudgeWorkerClaims,
  resetJudgeWorkerCompletionJournalForTests,
} from './judgeWorkerCompletionJournal.ts'
import {type JudgmentRequestAttemptJsonEntry, withDurableCloseoutRef} from './judgmentRequestAttemptManifest.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

const originalEnv = {
  API_SERVER_PORT: process.env.API_SERVER_PORT,
  JUDGE_WORKER_JOURNAL_PATH: process.env.JUDGE_WORKER_JOURNAL_PATH,
  SERVER_DUCKDB_OWNER_URL: process.env.SERVER_DUCKDB_OWNER_URL,
  SERVER_ROLE: process.env.SERVER_ROLE,
}
const testDirectories: string[] = []

const requestAttempt: JudgmentRequestAttemptJsonEntry = {
  articleId: 'article-a',
  baseURL: 'http://provider.test/v1',
  claimId: 'claim-a',
  closeoutKind: 'pending_token_use',
  completionTokens: 3,
  error: null,
  errorCode: null,
  finishedAt: '2026-05-03T12:00:01.000Z',
  jobId: 'job-a',
  outcome: 'success',
  promptId: 'prompt-a',
  promptIds: ['prompt-a'],
  promptTokens: 7,
  providerKey: 'provider:openai:default',
  queueRecordId: 'queue-a',
  requestAttemptId: 'attempt-a',
  startedAt: '2026-05-03T12:00:00.000Z',
  totalTokens: 10,
}

const tokenUse: JudgeWorkerTokenUseSummary = {
  failedRequests: 0,
  failedRequestsDetails: [],
  hasFailedRequests: false,
  modelName: 'model-a',
  requestAttempts: [requestAttempt],
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

const completionPayload: JudgeWorkerCompletionPayload = {
  articleId: 'article-a',
  claimId: 'claim-a',
  executionSnapshotHash: 'snapshot-hash-a',
  executionSnapshotId: 'snapshot-a',
  jobId: 'job-a',
  modelId: 'model-a',
  projectId: 'project-a',
  promptId: 'prompt-a',
  queueRecordId: 'queue-a',
  requestAttempts: [requestAttempt],
  status: 'judged',
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}

const acceptedClaim: PromptToProcess = {
  articleId: 'article-a',
  claimId: 'claim-a',
  executionSnapshotHash: 'snapshot-hash-a',
  executionSnapshotId: 'snapshot-a',
  jobId: 'job-a',
  maxInflightRequests: null,
  modelBaseUrl: 'http://provider.test/v1',
  modelId: 'model-a',
  modelMetadataJson: null,
  modelName: 'model-a',
  modelProvider: 'openai',
  modelSecretRef: null,
  modelVersion: null,
  modelWorkerUrls: [],
  projectId: 'project-a',
  promptId: 'prompt-a',
  providerConnectionId: null,
  providerKey: 'provider:openai:default',
  providerMaxInflightRequests: null,
  providerUsesFamilyDefault: true,
  recordId: 'queue-a',
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}

const parseRequestAttempts = (value: string | null | undefined) => {
  return JSON.parse(value ?? '[]') as Array<Record<string, unknown>>
}

const setupJournalPath = () => {
  const testDirectory = mkdtempSync(join(tmpdir(), 'f1-request-attempt-persistence-'))
  const journalPath = join(testDirectory, 'journal.sqlite')

  testDirectories.push(testDirectory)
  process.env.API_SERVER_PORT = '3001'
  process.env.JUDGE_WORKER_JOURNAL_PATH = journalPath
  process.env.SERVER_DUCKDB_OWNER_URL = 'http://127.0.0.1:1'
  process.env.SERVER_ROLE = 'judge-worker'

  return journalPath
}

afterEach(() => {
  resetJudgeWorkerCompletionJournalForTests()
  testDirectories.splice(0, testDirectories.length).forEach((directory) => {
    rmSync(directory, {force: true, recursive: true})
  })
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }

    process.env[key] = value
  })
})

test('pending token use and completion outbox retain exact request attempt evidence', async () => {
  const journalPath = setupJournalPath()

  await attachTokenUseToPendingJudgeWorkerCompletion({
    articleId: 'article-a',
    jobId: 'job-a',
    promptIds: ['prompt-a'],
    requestAttempts: [requestAttempt],
    tokenUse,
  })

  const pendingDatabase = new Database(journalPath, {readonly: true})
  const pendingRow = pendingDatabase
    .query(
      `
        SELECT
          claim_id AS claimId,
          queue_record_id AS queueRecordId,
          request_attempt_id AS requestAttemptId,
          request_attempts_json AS requestAttemptsJson
        FROM pending_token_use
        LIMIT 1
      `,
    )
    .get() as {
    claimId: string
    queueRecordId: string
    requestAttemptId: string
    requestAttemptsJson: string | null
  } | null
  pendingDatabase.close(false)

  const pendingRequestAttempts = parseRequestAttempts(pendingRow?.requestAttemptsJson)

  expect(pendingRow?.claimId).toBe('claim-a')
  expect(pendingRow?.queueRecordId).toBe('queue-a')
  expect(pendingRow?.requestAttemptId).toBe('attempt-a')
  expect(pendingRequestAttempts[0]?.providerKey).toBe('provider:openai:default')
  expect(pendingRequestAttempts[0]?.requestAttemptId).toBe('attempt-a')

  await enqueueJudgeWorkerCompletion(completionPayload)

  const completionDatabase = new Database(journalPath, {readonly: true})
  const completionRow = completionDatabase
    .query(
      `
        SELECT
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson
        FROM completion_outbox
        WHERE claim_id = 'claim-a'
        LIMIT 1
      `,
    )
    .get() as {requestAttemptsJson: string | null; tokenUseJson: string | null} | null
  const pendingCount = completionDatabase.query(`SELECT COUNT(*) AS count FROM pending_token_use`).get() as {
    count: number
  } | null
  completionDatabase.close(false)

  expect(Number(pendingCount?.count ?? 0)).toBe(0)
  expect(completionRow?.tokenUseJson).not.toBeNull()
  const completionRequestAttempts = parseRequestAttempts(completionRow?.requestAttemptsJson)

  expect(completionRequestAttempts[0]?.closeoutKind).toBe('pending_token_use')
  expect(completionRequestAttempts[0]?.queueRecordId).toBe('queue-a')
  expect(completionRequestAttempts[0]?.requestAttemptId).toBe('attempt-a')
})

test('accepted claim manifest CAS writes preserve siblings and compact after durable closeout', async () => {
  const journalPath = setupJournalPath()
  const siblingAttempt = {
    ...requestAttempt,
    requestAttemptId: 'attempt-b',
    startedAt: '2026-05-03T12:00:02.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry

  await recordAcceptedJudgeWorkerClaims([acceptedClaim])
  await mutateAcceptedClaimRequestAttemptManifest({
    mutation: {mergeEntries: [{...requestAttempt, closeoutKind: 'slot_wait', durableCloseoutRef: null}]},
    owner: {
      articleId: 'article-a',
      claimId: 'claim-a',
      jobId: 'job-a',
      kind: 'accepted_claim',
      promptId: 'prompt-a',
      promptIds: ['prompt-a'],
      queueRecordId: 'queue-a',
    },
  })
  await mutateAcceptedClaimRequestAttemptManifest({
    mutation: {mergeEntries: [{...siblingAttempt, closeoutKind: 'slot_wait', durableCloseoutRef: null}]},
    owner: {
      articleId: 'article-a',
      claimId: 'claim-a',
      jobId: 'job-a',
      kind: 'accepted_claim',
      promptId: 'prompt-a',
      promptIds: ['prompt-a'],
      queueRecordId: 'queue-a',
    },
  })

  const durableAttempt = withDurableCloseoutRef({
    closeoutKind: 'completion_outbox',
    ref: {claimId: 'claim-a', jobId: 'job-a', queueRecordId: 'queue-a'},
    requestAttempts: [requestAttempt],
  })
  await enqueueJudgeWorkerCompletion({...completionPayload, requestAttempts: durableAttempt})

  const database = new Database(journalPath, {readonly: true})
  const row = database
    .query(
      `
        SELECT
          request_attempt_manifest_json AS requestAttemptManifestJson,
          request_attempt_manifest_version AS requestAttemptManifestVersion
        FROM accepted_claim
        WHERE claim_id = 'claim-a'
        LIMIT 1
      `,
    )
    .get() as {requestAttemptManifestJson: string; requestAttemptManifestVersion: number} | null
  database.close(false)

  const manifestEntries = parseRequestAttempts(row?.requestAttemptManifestJson)

  expect(row?.requestAttemptManifestVersion).toBe(3)
  expect(
    manifestEntries.map((entry) => {
      return entry.requestAttemptId
    }),
  ).toEqual(['attempt-b'])
})
