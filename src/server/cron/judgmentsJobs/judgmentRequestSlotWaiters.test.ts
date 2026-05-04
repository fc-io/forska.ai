import {afterEach, expect, mock, test} from 'bun:test'

import * as realProviderAdmissionLeaseModule from './providerAdmissionLease.ts'

type JudgmentsRequestRuntimeModule = typeof import('./judgmentsRequestRuntime.ts')
type ProviderAdmissionLeaseAcquireInput = Parameters<
  typeof realProviderAdmissionLeaseModule.acquireProviderAdmissionLeasePersisted
>[0]
type ProviderAdmissionLeaseReleaseInput = Parameters<
  typeof realProviderAdmissionLeaseModule.releaseProviderAdmissionLeaseWithResultThroughOwner
>[0]
type JudgmentRequestInput = Parameters<JudgmentsRequestRuntimeModule['withJudgmentRequest']>[0]

const codexMaxInflightModulePath = new URL('./getCodexMaxInflight.ts', import.meta.url).pathname
const judgmentsCapacityModulePath = new URL('./getJudgmentsCapacity.ts', import.meta.url).pathname
const providerAdmissionLeaseModulePath = new URL('./providerAdmissionLease.ts', import.meta.url).pathname
const requestAttemptManifestStoreModulePath = new URL('./judgmentRequestAttemptManifestStore.ts', import.meta.url)
  .pathname

const getCodexMaxInflightMock = mock(() => {
  return 1
})
const getJudgmentsCapacityMock = mock((_runningJobCount: number) => {
  return {
    addToQueueMaxBatchSize: 10,
    maxBurst: 1,
    maxInflight: 1,
    perWorkerMaxBurstRequests: 1,
    perWorkerMaxInflightRequests: 1,
    perWorkerMaxRunningRequests: 1,
    readyTargetPerJob: 1,
    readyTargetTotal: 1,
    workerCount: 1,
  }
})
const acquireProviderAdmissionLeasePersisted = mock(async (input: ProviderAdmissionLeaseAcquireInput) => {
  return realProviderAdmissionLeaseModule.acquireProviderAdmissionLease(input)
})
const releaseProviderAdmissionLeaseWithResultThroughOwner = mock(async (input: ProviderAdmissionLeaseReleaseInput) => {
  const released = realProviderAdmissionLeaseModule.releaseProviderAdmissionLease(input)
  return released ? ({released: true} as const) : ({reason: 'missing', released: false} as const)
})
const recordRequestAttemptManifestStage = mock(async (_input: unknown) => {
  return undefined
})

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const createSignal = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve: () => void = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

const getPromiseError = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      return null
    },
    (error) => {
      return error as unknown
    },
  )
}

const registerMocks = (): void => {
  void mock.module(codexMaxInflightModulePath, () => {
    return {getCodexMaxInflight: getCodexMaxInflightMock}
  })
  void mock.module(judgmentsCapacityModulePath, () => {
    return {getJudgmentsCapacity: getJudgmentsCapacityMock}
  })
  void mock.module(providerAdmissionLeaseModulePath, () => {
    return {
      ...realProviderAdmissionLeaseModule,
      acquireProviderAdmissionLeasePersisted,
      releaseProviderAdmissionLeaseWithResultThroughOwner,
    }
  })
  void mock.module(requestAttemptManifestStoreModulePath, () => {
    return {
      compactClosedOutRequestAttemptManifestEntries: async () => {
        return undefined
      },
      getRequestAttemptManifestOwner: (input: unknown) => {
        return input
      },
      recordRequestAttemptManifestStage,
      recordRequestAttemptsEnteringPersistence: async () => {
        return undefined
      },
      recordRequestAttemptsPersistenceFailure: async () => {
        return undefined
      },
    }
  })
}

const loadRuntime = (): Promise<JudgmentsRequestRuntimeModule> => {
  registerMocks()

  return import(
    `./judgmentsRequestRuntime.ts?test=${Date.now()}-${Math.random()}`
  ) as Promise<JudgmentsRequestRuntimeModule>
}

const createProviderSnapshotFields = (provider: 'codex' | 'openai') => {
  const providerKey = provider === 'codex' ? 'codex:default' : 'provider:openai:default'

  return {
    providerFamily: provider,
    providerId: providerKey,
    providerKey,
    providerLimit: 10,
    providerLimitVersion: `${provider}:limit:v1`,
    providerName: provider,
    providerUsesFamilyDefault: true,
    resolvedDefaultCapacity: 10,
  }
}

const startHeldRequest = async (runtime: JudgmentsRequestRuntimeModule, input: JudgmentRequestInput) => {
  const release = createSignal()
  let started = false
  const request = runtime.withJudgmentRequest(input, async () => {
    started = true
    await release.promise
  })

  await flush()
  expect(started).toBe(true)

  return {release, request}
}

afterEach(async () => {
  const runtime = await loadRuntime()
  runtime.resetJudgmentRequestRuntimeForTests()
  getCodexMaxInflightMock.mockClear()
  getJudgmentsCapacityMock.mockClear()
  acquireProviderAdmissionLeasePersisted.mockClear()
  releaseProviderAdmissionLeaseWithResultThroughOwner.mockClear()
  recordRequestAttemptManifestStage.mockClear()
  mock.restore()
})

test('codex waiters are rejected when their request attempt is closed', async () => {
  const runtime = await loadRuntime()
  const first = await startHeldRequest(runtime, {
    ...createProviderSnapshotFields('codex'),
    fallbackBaseURL: 'codex://app-server',
    judgmentsJobId: 'job-codex-first',
    provider: 'codex',
    providerConnectionId: null,
    providerMaxInflightRequests: null,
    workerUrls: [],
  })
  const secondRequest = runtime.withJudgmentRequest(
    {
      ...createProviderSnapshotFields('codex'),
      fallbackBaseURL: 'codex://app-server',
      judgmentsJobId: 'job-codex-second',
      provider: 'codex',
      providerConnectionId: null,
      providerMaxInflightRequests: null,
      requestAttemptManifestOwner: {
        jobId: 'job-codex-second',
        kind: 'queue_prompt',
        queueRecordId: 'record-codex-second',
      },
      workerUrls: [],
    },
    async () => {
      throw new Error('closed waiter should not start')
    },
  )

  await flush()
  const [waitingAttempt] = runtime.getJudgmentRequestLifecycleRecords('job-codex-second')
  expect(waitingAttempt?.lifecycleState).toBe('waitingForRequestSlot')

  const secondRejected = getPromiseError(secondRequest)
  runtime.markJudgmentRequestAttemptsClosed('job-codex-second', [waitingAttempt?.requestAttemptId ?? 'missing'])
  const secondError = await secondRejected
  expect(secondError).toBeInstanceOf(Error)
  expect(String(secondError)).toContain('request-attempt-closed')

  first.release.resolve()
  await first.request
})

test('in-flight provider admission acquisition is reported as provider admission wait', async () => {
  const runtime = await loadRuntime()
  const admissionRelease = createSignal()
  let started = false

  acquireProviderAdmissionLeasePersisted.mockImplementationOnce(async (input: ProviderAdmissionLeaseAcquireInput) => {
    await admissionRelease.promise
    return realProviderAdmissionLeaseModule.acquireProviderAdmissionLease(input)
  })

  const request = runtime.withJudgmentRequest(
    {
      ...createProviderSnapshotFields('openai'),
      fallbackBaseURL: 'http://provider-admission-wait.test/v1',
      judgmentsJobId: 'job-provider-admission-wait',
      provider: 'openai',
      providerConnectionId: null,
      providerMaxInflightRequests: 10,
      requestAttemptManifestOwner: {
        jobId: 'job-provider-admission-wait',
        kind: 'queue_prompt',
        queueRecordId: 'record-provider-admission-wait',
      },
      workerUrls: [],
    },
    async () => {
      started = true
    },
  )

  await flush()

  expect(started).toBe(false)
  expect(runtime.getJudgmentRequestStats('job-provider-admission-wait')).toMatchObject({
    inFlight: 0,
    requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 1, worker: 0},
    waitingForRequestSlot: 1,
  })

  admissionRelease.resolve()
  await request

  expect(started).toBe(true)
  expect(runtime.getJudgmentRequestStats('job-provider-admission-wait').requestSlotWaiters.providerAdmission).toBe(0)
})

test('fallback and worker waiters are rejected by prompt-scoped recovery', async () => {
  const runtime = await loadRuntime()
  const fallbackFirst = await startHeldRequest(runtime, {
    ...createProviderSnapshotFields('openai'),
    fallbackBaseURL: 'http://fallback-waiter.test/v1',
    judgmentsJobId: 'job-fallback-first',
    provider: 'openai',
    providerConnectionId: null,
    providerMaxInflightRequests: 10,
    workerUrls: [],
  })
  const fallbackSecond = runtime.withJudgmentRequest(
    {
      ...createProviderSnapshotFields('openai'),
      fallbackBaseURL: 'http://fallback-waiter.test/v1',
      judgmentsJobId: 'job-fallback-second',
      provider: 'openai',
      providerConnectionId: null,
      providerMaxInflightRequests: 10,
      requestAttemptManifestOwner: {
        jobId: 'job-fallback-second',
        kind: 'queue_prompt',
        queueRecordId: 'record-fallback-second',
      },
      workerUrls: [],
    },
    async () => {
      throw new Error('fallback waiter should not start')
    },
  )
  const workerFirst = await startHeldRequest(runtime, {
    ...createProviderSnapshotFields('openai'),
    fallbackBaseURL: 'http://unused-worker-waiter.test/v1',
    judgmentsJobId: 'job-worker-first',
    provider: 'openai',
    providerConnectionId: null,
    providerMaxInflightRequests: 10,
    workerUrls: ['http://worker-waiter.test'],
  })
  const workerSecond = runtime.withJudgmentRequest(
    {
      ...createProviderSnapshotFields('openai'),
      fallbackBaseURL: 'http://unused-worker-waiter.test/v1',
      judgmentsJobId: 'job-worker-second',
      provider: 'openai',
      providerConnectionId: null,
      providerMaxInflightRequests: 10,
      requestAttemptManifestOwner: {
        jobId: 'job-worker-second',
        kind: 'queue_prompt',
        queueRecordId: 'record-worker-second',
      },
      workerUrls: ['http://worker-waiter.test'],
    },
    async () => {
      throw new Error('worker waiter should not start')
    },
  )

  await flush()
  expect(runtime.getJudgmentRequestStats('job-fallback-second').waitingForRequestSlot).toBe(1)
  expect(runtime.getJudgmentRequestStats('job-worker-second').waitingForRequestSlot).toBe(1)

  const fallbackRejected = getPromiseError(fallbackSecond)
  const workerRejected = getPromiseError(workerSecond)

  runtime.rejectJudgmentRequestWaitersForPrompts({
    prompts: [
      {jobId: 'job-fallback-second', recordId: 'record-fallback-second'},
      {jobId: 'job-worker-second', recordId: 'record-worker-second'},
    ],
    reason: 'prompt-recovered',
  })

  expect(String(await fallbackRejected)).toContain('prompt-recovered')
  expect(String(await workerRejected)).toContain('prompt-recovered')

  fallbackFirst.release.resolve()
  workerFirst.release.resolve()
  await fallbackFirst.request
  await workerFirst.request
})
