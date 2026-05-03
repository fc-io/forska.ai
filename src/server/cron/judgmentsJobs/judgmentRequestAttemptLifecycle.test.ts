import {afterEach, expect, test} from 'bun:test'

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
