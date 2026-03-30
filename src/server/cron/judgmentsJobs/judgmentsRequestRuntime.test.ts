import {afterEach, expect, test} from 'bun:test'

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
})

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
