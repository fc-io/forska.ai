import {afterEach, expect, test} from 'bun:test'

import {
  type JudgmentRequestAttemptJsonEntry,
  mutateRequestAttemptManifestEntries,
  withDurableCloseoutRef,
} from './judgmentRequestAttemptManifest.ts'
import {
  getJudgmentRequestStats,
  markJudgmentRequestsPersisted,
  resetJudgmentRequestRuntimeForTests,
  withJudgmentRequest,
} from './judgmentsRequestRuntime.ts'

afterEach(() => {
  resetJudgmentRequestRuntimeForTests()
})

test('withJudgmentRequest exposes exact request attempt context', async () => {
  const jobId = 'request-attempt-lifecycle-job'
  const seenAttempts: string[] = []

  const baseURL = await withJudgmentRequest(
    {
      fallbackBaseURL: 'codex://app-server',
      judgmentsJobId: jobId,
      modelId: 'model-a',
      provider: 'codex',
      providerConnectionId: null,
      providerMaxInflightRequests: null,
      providerUsesFamilyDefault: true,
      workerUrls: [],
    },
    async (requestBaseURL, requestAttempt) => {
      seenAttempts.push(requestAttempt.requestAttemptId)
      expect(requestAttempt.providerKey).toBe('codex:default')
      expect(requestAttempt.baseURL).toBe('codex://app-server')
      expect(requestAttempt.startedAt).toContain('T')
      expect(getJudgmentRequestStats(jobId)).toEqual({inFlight: 1, pendingPersistedAttempts: 1})
      return requestBaseURL
    },
  )

  expect(baseURL).toBe('codex://app-server')
  expect(seenAttempts).toHaveLength(1)
  expect(seenAttempts[0]).toMatch(/[0-9a-f-]{36}/)
  expect(getJudgmentRequestStats(jobId)).toEqual({inFlight: 0, pendingPersistedAttempts: 1})

  markJudgmentRequestsPersisted(jobId, 1)

  expect(getJudgmentRequestStats(jobId)).toEqual({inFlight: 0, pendingPersistedAttempts: 0})
})

test('manifest merge preserves sibling attempts and compacts only durable closeout entries', () => {
  const slotWaitAttempt = {
    articleId: 'article-a',
    closeoutKind: 'slot_wait',
    jobId: 'job-a',
    outcome: 'unknown',
    promptId: 'prompt-a',
    providerKey: 'provider:openai:default',
    queueRecordId: 'queue-a',
    requestAttemptId: 'attempt-a',
    startedAt: '2026-05-03T12:00:00.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const siblingAttempt = {
    ...slotWaitAttempt,
    requestAttemptId: 'attempt-b',
    startedAt: '2026-05-03T12:00:01.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const withSiblings = mutateRequestAttemptManifestEntries({
    currentEntries: [slotWaitAttempt],
    mutation: {mergeEntries: [siblingAttempt]},
  })
  const durableAttempt = withDurableCloseoutRef({
    closeoutKind: 'token_use',
    ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
    requestAttempts: [{...slotWaitAttempt, closeoutKind: 'persistence'}],
  })
  const compacted = mutateRequestAttemptManifestEntries({
    currentEntries: withSiblings,
    mutation: {compactRequestAttemptIds: ['attempt-a'], mergeEntries: durableAttempt},
  })

  expect(
    withSiblings.map((entry) => {
      return entry.requestAttemptId
    }),
  ).toEqual(['attempt-a', 'attempt-b'])
  expect(
    compacted.map((entry) => {
      return entry.requestAttemptId
    }),
  ).toEqual(['attempt-b'])
})
