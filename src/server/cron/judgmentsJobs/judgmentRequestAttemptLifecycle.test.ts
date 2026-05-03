import {afterEach, expect, test} from 'bun:test'

import {
  getRequestAttemptLifecycleState,
  JudgmentRequestAttemptInvariantError,
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

const baseManifestAttempt = {
  articleId: 'article-a',
  closeoutKind: 'slot_wait',
  createdAt: '2026-05-03T12:00:00.000Z',
  jobId: 'job-a',
  lifecycleState: 'waitingForRequestSlot',
  outcome: 'unknown',
  promptId: 'prompt-a',
  providerKey: 'provider:openai:default',
  queueRecordId: 'queue-a',
  requestAttemptId: 'attempt-a',
  startedAt: '2026-05-03T12:00:00.000Z',
  stateStartedAt: '2026-05-03T12:00:00.000Z',
  updatedAt: '2026-05-03T12:00:00.000Z',
} satisfies JudgmentRequestAttemptJsonEntry

const getFirstManifestEntry = (entries: JudgmentRequestAttemptJsonEntry[]): JudgmentRequestAttemptJsonEntry => {
  const [entry] = entries
  expect(entry).toBeDefined()

  if (!entry) {
    throw new Error('expected manifest entry')
  }

  return entry
}

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

test('request attempt state machine accepts monotonic forward transitions and ignores stale backward writes', () => {
  const liveAttempt = {
    ...baseManifestAttempt,
    baseURL: 'http://provider.test/v1',
    closeoutKind: 'live_request',
    lifecycleState: 'liveRequest',
    startedAt: '2026-05-03T12:00:01.000Z',
    stateStartedAt: '2026-05-03T12:00:01.000Z',
    updatedAt: '2026-05-03T12:00:01.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const persistingAttempt = {
    ...liveAttempt,
    closeoutKind: 'persistence',
    finishedAt: '2026-05-03T12:00:02.000Z',
    lifecycleState: 'persistingCompletion',
    stateStartedAt: '2026-05-03T12:00:02.000Z',
    updatedAt: '2026-05-03T12:00:02.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const durableAttempt = withDurableCloseoutRef({
    closeoutKind: 'token_use',
    ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
    requestAttempts: [{...persistingAttempt, outcome: 'success'}],
  })
  const liveManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [baseManifestAttempt],
    mutation: {mergeEntries: [liveAttempt]},
  })
  const staleManifest = mutateRequestAttemptManifestEntries({
    currentEntries: liveManifest,
    mutation: {mergeEntries: [baseManifestAttempt]},
  })
  const completedManifest = mutateRequestAttemptManifestEntries({
    currentEntries: staleManifest,
    mutation: {mergeEntries: [persistingAttempt, ...durableAttempt]},
  })

  const staleEntry = getFirstManifestEntry(staleManifest)
  const completedEntry = getFirstManifestEntry(completedManifest)

  expect(getRequestAttemptLifecycleState(staleEntry)).toBe('liveRequest')
  expect(staleEntry.closeoutKind).toBe('live_request')
  expect(getRequestAttemptLifecycleState(completedEntry)).toBe('completedRequest')
  expect(completedEntry.closeoutKind).toBe('token_use')
})

test('terminal request attempts are sinks except same-state metadata enrichment', () => {
  const completedAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'token_use',
      ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [
        {
          ...baseManifestAttempt,
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:02.000Z',
          lifecycleState: 'persistingCompletion',
          outcome: 'success',
        },
      ],
    }),
  )
  const enrichedAttempt = {
    ...completedAttempt,
    error: 'late duplicate metadata',
    lifecycleState: 'completedRequest',
  } satisfies JudgmentRequestAttemptJsonEntry
  const staleLiveAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'live_request',
    lifecycleState: 'liveRequest',
  } satisfies JudgmentRequestAttemptJsonEntry
  const enrichedManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [completedAttempt],
    mutation: {mergeEntries: [enrichedAttempt]},
  })
  const terminalManifest = mutateRequestAttemptManifestEntries({
    currentEntries: enrichedManifest,
    mutation: {mergeEntries: [staleLiveAttempt]},
  })

  const terminalEntry = getFirstManifestEntry(terminalManifest)

  expect(getRequestAttemptLifecycleState(terminalEntry)).toBe('completedRequest')
  expect(terminalEntry.closeoutKind).toBe('token_use')
  expect(terminalEntry.error).toBe('late duplicate metadata')
})

test('durable evidence supersedes unavailable diagnostics and late evidence after worker-loss closeout is quarantined', () => {
  const unavailableAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'live_request',
    lifecycleState: 'workerUnavailable',
    updatedAt: '2026-05-03T12:00:05.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const durableAttempt = withDurableCloseoutRef({
    closeoutKind: 'token_use',
    ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
    requestAttempts: [
      {
        ...baseManifestAttempt,
        closeoutKind: 'persistence',
        finishedAt: '2026-05-03T12:00:06.000Z',
        lifecycleState: 'persistingCompletion',
        outcome: 'success',
      },
    ],
  })
  const supersededManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [unavailableAttempt],
    mutation: {mergeEntries: durableAttempt},
  })
  const workerLostClosedAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'manifest_repair',
    closeoutReason: 'workerLostNoDurableResult',
    finishedAt: '2026-05-03T12:00:04.000Z',
    lifecycleState: 'closedRequest',
    stateStartedAt: '2026-05-03T12:00:04.000Z',
    updatedAt: '2026-05-03T12:00:04.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const conflictManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [workerLostClosedAttempt],
    mutation: {mergeEntries: durableAttempt},
  })

  const supersededEntry = getFirstManifestEntry(supersededManifest)
  const conflictEntry = getFirstManifestEntry(conflictManifest)

  expect(getRequestAttemptLifecycleState(supersededEntry)).toBe('completedRequest')
  expect(getRequestAttemptLifecycleState(conflictEntry)).toBe('closedRequest')
  expect(conflictEntry.lateEvidenceConflict?.reason).toBe('lateEvidenceAfterWorkerLostNoDurableResult')
})

test('duplicate request attempt ids with conflicting durable fields fail invariants', () => {
  const completedAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'token_use',
      ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [
        {
          ...baseManifestAttempt,
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:02.000Z',
          lifecycleState: 'persistingCompletion',
          outcome: 'success',
          totalTokens: 10,
        },
      ],
    }),
  )
  const conflictingAttempt = {
    ...completedAttempt,
    finishedAt: '2026-05-03T12:00:03.000Z',
    totalTokens: 11,
  } satisfies JudgmentRequestAttemptJsonEntry

  expect(() => {
    mutateRequestAttemptManifestEntries({
      currentEntries: [completedAttempt],
      mutation: {mergeEntries: [{...completedAttempt, providerKey: 'provider:anthropic:default'}]},
    })
  }).toThrow(JudgmentRequestAttemptInvariantError)
  expect(() => {
    mutateRequestAttemptManifestEntries({
      currentEntries: [completedAttempt],
      mutation: {mergeEntries: [conflictingAttempt]},
    })
  }).toThrow(JudgmentRequestAttemptInvariantError)
})
