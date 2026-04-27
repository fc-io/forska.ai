import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterEach, expect, test} from 'bun:test'

import {
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
const testDirectories: string[] = []
const testServers: Array<ReturnType<typeof globalThis.Bun.serve>> = []

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

const setupJournalTest = (handler: Parameters<typeof globalThis.Bun.serve>[0]['fetch']) => {
  const testDirectory = mkdtempSync(join(tmpdir(), 'f1-judge-worker-journal-'))
  const journalPath = join(testDirectory, 'journal.sqlite')
  const server = globalThis.Bun.serve({fetch: handler, port: 0})

  testDirectories.push(testDirectory)
  testServers.push(server)
  process.env.API_SERVER_PORT = '3001'
  process.env.JUDGE_WORKER_JOURNAL_PATH = journalPath
  process.env.SERVER_DUCKDB_OWNER_URL = `http://127.0.0.1:${server.port}`
  process.env.SERVER_ROLE = 'judge-worker'

  return {journalPath, server}
}

const getCompletionOutboxRow = (journalPath: string, claimId: string) => {
  const database = new Database(journalPath, {readonly: true})
  const row = database
    .query(
      `
        SELECT acked_at AS ackedAt, last_error AS lastError, status
        FROM completion_outbox
        WHERE claim_id = ?
        LIMIT 1
      `,
    )
    .get(claimId) as {ackedAt: string | null; lastError: string | null; status: string} | null

  database.close(false)
  return row
}

afterEach(async () => {
  resetJudgeWorkerCompletionJournalForTests()
  await Promise.all(
    testServers.splice(0, testServers.length).map((server) => {
      return server.stop(true)
    }),
  )
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
  const payload = createCompletionPayload()

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
  const payload = createCompletionPayload({claimId: 'claim-stale'})

  await enqueueJudgeWorkerCompletion(payload)

  const result = await replayJudgeWorkerCompletionOutbox()
  const row = getCompletionOutboxRow(journalPath, payload.claimId)

  expect(result).toEqual({ackedCount: 0, discardedCount: 1, failedCount: 0})
  expect(await hasUnackedJudgeWorkerCompletion(payload.claimId)).toBe(false)
  expect(row?.ackedAt).not.toBeNull()
  expect(row?.status).toBe('discarded_stale')
  expect(row?.lastError).toContain('owner-backed judgment request failed (409): missing claimed prompt identity')
})
