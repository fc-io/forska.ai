import {afterEach, expect, test} from 'bun:test'

import {
  classifyConnectionFailure,
  ConnectionError,
  recordConnectionFailure,
  recordConnectionSuccess,
} from './connectionHealth.ts'
import {resetJudgmentRequestRuntimeForTests, withJudgmentRequest} from './judgmentsRequestRuntime.ts'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const createSignal = () => {
  let resolve: () => void = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

afterEach(() => {
  resetJudgmentRequestRuntimeForTests()
  Date.now = realDateNow
})

const realDateNow = Date.now

test('fallback requests enforce provider caps and release after failure', async () => {
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-1',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
      throw new Error('expected fallback failure')
    },
  ).catch((error) => {
    expect(error).toBeInstanceOf(Error)
  })

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-fallback-2',
      provider: 'openai',
      fallbackBaseURL: 'http://fallback-runtime.test/v1',
      providerConnectionId: 'connection-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest

  expect(secondStarted).toBe(true)
})

test('worker requests enforce provider caps and release after success', async () => {
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-1',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test'],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-2',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-a.test'],
    },
    async () => {
      secondStarted = true
    },
  )

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-worker-3',
      provider: 'sglang',
      fallbackBaseURL: 'http://unused-runtime.test/v1',
      providerConnectionId: 'connection-worker-other',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: ['http://worker-runtime-b.test'],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)
  expect(thirdStarted).toBe(true)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest
  await thirdRequest

  expect(secondStarted).toBe(true)
})

test('codex requests enforce saved provider caps per connection', async () => {
  const firstRelease = createSignal()
  let firstStarted = false
  let secondStarted = false
  let thirdStarted = false

  const firstRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-1',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      firstStarted = true
      await firstRelease.promise
    },
  )

  await flush()
  expect(firstStarted).toBe(true)

  const secondRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-2',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-shared',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      secondStarted = true
    },
  )

  const thirdRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-codex-3',
      provider: 'codex',
      fallbackBaseURL: 'codex://app-server',
      providerConnectionId: 'connection-codex-other',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
    },
  )

  await flush()
  expect(secondStarted).toBe(false)
  expect(thirdStarted).toBe(true)

  firstRelease.resolve()
  await firstRequest
  await flush()
  await secondRequest
  await thirdRequest

  expect(secondStarted).toBe(true)
})

test('fallback endpoint availability blocks during cooldown, allows one probe, and resumes after probe success', async () => {
  let now = 1_000
  Date.now = () => {
    return now
  }

  const providerConnectionId = 'connection-gated'
  const fallbackBaseURL = 'http://fallback-runtime-gated.test/v1'
  const failure = classifyConnectionFailure({
    context: {effectiveBaseURL: fallbackBaseURL, endpointPath: '/v1/chat/completions', providerKind: 'openai'},
    error: {status: 404},
  })

  recordConnectionFailure({effectiveBaseURL: fallbackBaseURL, failure, providerConnectionId})

  let blockedError: unknown = null

  try {
    await withJudgmentRequest(
      {
        judgmentsJobId: 'job-gated-blocked',
        provider: 'openai',
        fallbackBaseURL,
        providerConnectionId,
        providerMaxInflightRequests: 2,
        providerUsesFamilyDefault: false,
        workerUrls: [],
      },
      async () => {
        throw new Error('should not run while cooldown is active')
      },
    )
  } catch (error) {
    blockedError = error
  }

  expect(blockedError).toBeInstanceOf(ConnectionError)

  now += 30_001

  const probeRelease = createSignal()
  let probeStarted = false
  let secondStarted = false
  let thirdStarted = false

  const probeRequest = withJudgmentRequest(
    {
      judgmentsJobId: 'job-gated-probe-1',
      provider: 'openai',
      fallbackBaseURL,
      providerConnectionId,
      providerMaxInflightRequests: 2,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async (baseURL) => {
      probeStarted = true
      await probeRelease.promise
      recordConnectionSuccess({effectiveBaseURL: baseURL, providerConnectionId})
    },
  )

  await flush()
  expect(probeStarted).toBe(true)

  let probingBlockedError: unknown = null

  try {
    await withJudgmentRequest(
      {
        judgmentsJobId: 'job-gated-probe-2',
        provider: 'openai',
        fallbackBaseURL,
        providerConnectionId,
        providerMaxInflightRequests: 2,
        providerUsesFamilyDefault: false,
        workerUrls: [],
      },
      async () => {
        secondStarted = true
      },
    )
  } catch (error) {
    probingBlockedError = error
  }

  expect(probingBlockedError).toBeInstanceOf(ConnectionError)

  expect(secondStarted).toBe(false)

  probeRelease.resolve()
  await probeRequest

  await withJudgmentRequest(
    {
      judgmentsJobId: 'job-gated-probe-3',
      provider: 'openai',
      fallbackBaseURL,
      providerConnectionId,
      providerMaxInflightRequests: 2,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    async () => {
      thirdStarted = true
    },
  )

  expect(thirdStarted).toBe(true)
})
