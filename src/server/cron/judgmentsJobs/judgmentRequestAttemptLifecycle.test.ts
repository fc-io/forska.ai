import {afterEach, expect, mock, test} from 'bun:test'

import {getDerivedJudgmentPromptLifecycleState} from './judgmentLifecycleTelemetry.ts'
import {
  getRequestAttemptLifecycleState,
  JudgmentRequestAttemptInvariantError,
  type JudgmentRequestAttemptJsonEntry,
  mutateRequestAttemptManifestEntries,
  withDurableCloseoutRef,
} from './judgmentRequestAttemptManifest.ts'
import * as realProviderAdmissionLeaseModule from './providerAdmissionLease.ts'

type JudgmentsRequestRuntimeModule = typeof import('./judgmentsRequestRuntime.ts')
type ProviderAdmissionLeaseAcquireInput = Parameters<
  typeof realProviderAdmissionLeaseModule.acquireProviderAdmissionLeasePersisted
>[0]
type ProviderAdmissionLeaseReleaseInput = Parameters<
  typeof realProviderAdmissionLeaseModule.releaseProviderAdmissionLeaseWithResultThroughOwner
>[0]

const providerAdmissionLeaseModulePath = new URL('./providerAdmissionLease.ts', import.meta.url).pathname

const acquireProviderAdmissionLeasePersisted = async (input: ProviderAdmissionLeaseAcquireInput) => {
  return realProviderAdmissionLeaseModule.acquireProviderAdmissionLease(input)
}

const releaseProviderAdmissionLeaseWithResultThroughOwner = async (input: ProviderAdmissionLeaseReleaseInput) => {
  const released = realProviderAdmissionLeaseModule.releaseProviderAdmissionLease(input)
  return released ? ({released: true} as const) : ({reason: 'missing', released: false} as const)
}

const loadRuntime = (): Promise<JudgmentsRequestRuntimeModule> => {
  void mock.module(providerAdmissionLeaseModulePath, () => {
    return {
      ...realProviderAdmissionLeaseModule,
      acquireProviderAdmissionLeasePersisted,
      releaseProviderAdmissionLeaseWithResultThroughOwner,
    }
  })

  return import(
    `./judgmentsRequestRuntime.ts?test=${Date.now()}-${Math.random()}`
  ) as Promise<JudgmentsRequestRuntimeModule>
}

afterEach(async () => {
  const {resetJudgmentRequestRuntimeForTests} = await loadRuntime()
  resetJudgmentRequestRuntimeForTests()
  mock.restore()
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
  const {
    getJudgmentRequestLifecycleRecords,
    getJudgmentRequestStats,
    markJudgmentRequestAttemptsPersisted,
    withJudgmentRequest,
  } = await loadRuntime()
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
      expect(getJudgmentRequestStats(jobId)).toEqual({
        inFlight: 1,
        pendingPersistedAttempts: 1,
        requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 0, worker: 0},
        requestWorkBacklog: 1,
        waitingForRequestSlot: 0,
      })
      expect(getJudgmentRequestLifecycleRecords(jobId)).toMatchObject([
        {lifecycleState: 'liveRequest', requestAttemptId: requestAttempt.requestAttemptId},
      ])
      return requestBaseURL
    },
  )

  expect(baseURL).toBe('codex://app-server')
  expect(seenAttempts).toHaveLength(1)
  expect(seenAttempts[0]).toMatch(/[0-9a-f-]{36}/)
  expect(getJudgmentRequestStats(jobId)).toEqual({
    inFlight: 0,
    pendingPersistedAttempts: 1,
    requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 0, worker: 0},
    requestWorkBacklog: 1,
    waitingForRequestSlot: 0,
  })
  expect(getJudgmentRequestLifecycleRecords(jobId)).toMatchObject([
    {lifecycleState: 'persistingCompletion', requestAttemptId: seenAttempts[0]},
  ])

  markJudgmentRequestAttemptsPersisted(jobId, seenAttempts)

  expect(getJudgmentRequestStats(jobId)).toEqual({
    inFlight: 0,
    pendingPersistedAttempts: 0,
    requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 0, worker: 0},
    requestWorkBacklog: 0,
    waitingForRequestSlot: 0,
  })
  expect(getJudgmentRequestLifecycleRecords(jobId)).toEqual([])
})

test('persistence-stage attempts stay persisting even after request failure', () => {
  const persistingFailure = mutateRequestAttemptManifestEntries({
    currentEntries: [baseManifestAttempt],
    mutation: {
      mergeEntries: [
        {
          ...baseManifestAttempt,
          closeoutKind: 'persistence',
          error: 'duckdb down',
          finishedAt: '2026-05-03T12:00:02.000Z',
          outcome: 'failure',
          persistenceSubreason: 'token_use',
        },
      ],
    },
  })
  const [entry] = persistingFailure

  expect(entry?.lifecycleState).toBe('persistingCompletion')
  expect(entry?.persistenceSubreason).toBe('token_use')
  expect(entry?.error).toBe('duckdb down')
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

test('compatible terminal closeout surfaces merge without treating token use as conflicting', () => {
  const legacyCompletionAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'completion_outbox',
    completionTokens: 5,
    finishedAt: '2026-05-03T12:00:02.000Z',
    lifecycleState: 'completedRequest',
    outcome: 'success',
    promptTokens: 10,
    totalTokens: 15,
  } satisfies JudgmentRequestAttemptJsonEntry
  const pendingTokenUseAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'pending_token_use',
      ref: {claimId: 'claim-a', id: 'attempt-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [legacyCompletionAttempt],
    }),
  )
  const mergedManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [legacyCompletionAttempt],
    mutation: {mergeEntries: [pendingTokenUseAttempt]},
  })
  const mergedEntry = getFirstManifestEntry(mergedManifest)

  expect(getRequestAttemptLifecycleState(mergedEntry)).toBe('completedRequest')
  expect(mergedEntry.closeoutKind).toBe('pending_token_use')
  expect(mergedEntry.durableCloseoutRef?.kind).toBe('pending_token_use')
})

test('durable timeout token use closes a non-durable live request failure', () => {
  const liveTimeoutAttempt = {
    ...baseManifestAttempt,
    baseURL: 'http://provider.test/v1',
    closeoutKind: 'live_request',
    error: 'The operation timed out.',
    finishedAt: '2026-05-03T12:00:35.000Z',
    lifecycleState: 'liveRequest',
    outcome: 'failure',
    startedAt: '2026-05-03T12:00:05.000Z',
    stateStartedAt: '2026-05-03T12:00:05.000Z',
    updatedAt: '2026-05-03T12:00:35.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const pendingTokenUseAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'pending_token_use',
      ref: {claimId: 'claim-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [
        {
          ...liveTimeoutAttempt,
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:36.000Z',
          lifecycleState: 'persistingCompletion',
        },
      ],
    }),
  )
  const mergedManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [liveTimeoutAttempt],
    mutation: {mergeEntries: [pendingTokenUseAttempt]},
  })
  const mergedEntry = getFirstManifestEntry(mergedManifest)

  expect(getRequestAttemptLifecycleState(mergedEntry)).toBe('closedRequest')
  expect(mergedEntry.closeoutKind).toBe('pending_token_use')
  expect(mergedEntry.durableCloseoutRef?.kind).toBe('pending_token_use')
  expect(mergedEntry.error).toBe('The operation timed out.')
})

test('late durable failure evidence after no-durable worker closeout is quarantined', () => {
  const workerLostClosedAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'manifest_repair',
    closeoutReason: 'workerLostNoDurableResult',
    finishedAt: '2026-05-03T12:00:35.000Z',
    lifecycleState: 'closedRequest',
    outcome: 'failure',
    stateStartedAt: '2026-05-03T12:00:35.000Z',
    updatedAt: '2026-05-03T12:00:35.000Z',
  } satisfies JudgmentRequestAttemptJsonEntry
  const tokenUseAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'token_use',
      ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [
        {
          ...workerLostClosedAttempt,
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:36.000Z',
          lifecycleState: 'persistingCompletion',
        },
      ],
    }),
  )
  const mergedManifest = mutateRequestAttemptManifestEntries({
    currentEntries: [workerLostClosedAttempt],
    mutation: {mergeEntries: [tokenUseAttempt]},
  })
  const mergedEntry = getFirstManifestEntry(mergedManifest)

  expect(getRequestAttemptLifecycleState(mergedEntry)).toBe('closedRequest')
  expect(mergedEntry.closeoutKind).toBe('manifest_repair')
  expect(mergedEntry.lateEvidenceConflict?.closeoutKind).toBe('token_use')
})

test('compaction accepts token-use closeout after completion closeout for the same attempt', () => {
  const completionAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'judgment_outbox',
      ref: {id: 'judgment-a', jobId: 'job-a', queueRecordId: 'queue-a'},
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
  const tokenUseAttempt = withDurableCloseoutRef({
    closeoutKind: 'token_use',
    ref: {id: 'token-use-a', jobId: 'job-a'},
    requestAttempts: [
      {
        ...baseManifestAttempt,
        closeoutKind: 'persistence',
        completionTokens: 5,
        finishedAt: '2026-05-03T12:00:02.000Z',
        lifecycleState: 'persistingCompletion',
        outcome: 'success',
        promptTokens: 10,
        totalTokens: 15,
      },
    ],
  })

  const compacted = mutateRequestAttemptManifestEntries({
    currentEntries: [completionAttempt],
    mutation: {compactRequestAttemptIds: [completionAttempt.requestAttemptId], mergeEntries: tokenUseAttempt},
  })

  expect(compacted).toEqual([])
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

test('derived prompt lifecycle precedence separates attempt closeout from prompt terminal state', () => {
  const retryClosedAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'manifest_repair',
    closeoutReason: 'workerLostRequeued',
    finishedAt: '2026-05-03T12:00:03.000Z',
    lifecycleState: 'closedRequest',
    outcome: 'failure',
    requestAttemptId: 'attempt-retry',
  } satisfies JudgmentRequestAttemptJsonEntry
  const completedAttempt = getFirstManifestEntry(
    withDurableCloseoutRef({
      closeoutKind: 'token_use',
      ref: {id: 'token-use-a', jobId: 'job-a', queueRecordId: 'queue-a'},
      requestAttempts: [
        {
          ...baseManifestAttempt,
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:06.000Z',
          lifecycleState: 'persistingCompletion',
          outcome: 'success',
          requestAttemptId: 'attempt-success',
        },
      ],
    }),
  )

  expect(getDerivedJudgmentPromptLifecycleState({requestAttempts: [retryClosedAttempt], status: 'ready'})).toBeNull()
  expect(
    getDerivedJudgmentPromptLifecycleState({requestAttempts: [retryClosedAttempt, completedAttempt], status: 'judged'}),
  ).toBe('completed')
  expect(
    getDerivedJudgmentPromptLifecycleState({
      requestAttempts: [{...baseManifestAttempt, lifecycleState: 'liveRequest'}],
      status: 'judged',
    }),
  ).toBe('hasLiveRequest')
})

test('zero-request prompt terminals require explicit no-request success or closeout reasons', () => {
  const closedAttempt = {
    ...baseManifestAttempt,
    closeoutKind: 'manifest_repair',
    closeoutReason: 'workerLostNoDurableResult',
    finishedAt: '2026-05-03T12:00:03.000Z',
    lifecycleState: 'closedRequest',
    outcome: 'failure',
  } satisfies JudgmentRequestAttemptJsonEntry

  expect(getDerivedJudgmentPromptLifecycleState({requestAttempts: [], status: 'judged'})).toBeNull()
  expect(
    getDerivedJudgmentPromptLifecycleState({
      noRequestSuccessReason: 'alreadyJudged',
      requestAttempts: [],
      status: 'judged',
    }),
  ).toBe('completed')
  expect(
    getDerivedJudgmentPromptLifecycleState({
      promptCloseoutReason: 'articleMissing',
      requestAttempts: [],
      status: 'judged',
    }),
  ).toBe('closed')
  expect(getDerivedJudgmentPromptLifecycleState({requestAttempts: [closedAttempt], status: 'judged'})).toBe('closed')
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
  expect(() => {
    mutateRequestAttemptManifestEntries({
      currentEntries: [completedAttempt],
      mutation: {
        mergeEntries: [
          {
            ...completedAttempt,
            durableCloseoutRef: {...completedAttempt.durableCloseoutRef, id: 'token-use-b', kind: 'token_use'},
          },
        ],
      },
    })
  }).toThrow(JudgmentRequestAttemptInvariantError)
})
