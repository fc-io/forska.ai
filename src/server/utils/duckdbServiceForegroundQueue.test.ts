import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, beforeAll, expect, spyOn, test} from 'bun:test'

type DuckdbService = typeof import('./duckdbService.ts')

const root = mkdtempSync(join(tmpdir(), 'forska-foreground-idle-'))
const testEnv = {
  DUCKDB_MEMORY_LIMIT: '256MiB',
  DUCKDB_PATH: join(root, 'test.duckdb'),
  DUCKDB_TEMP_DIRECTORY: join(root, 'spill'),
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
}
const previousEnv = Object.fromEntries(
  Object.keys(testEnv).map((key) => {
    return [key, process.env[key]]
  }),
)
const workloadContext = {routeOrJobKey: 'test.foregroundIdle', workloadClass: 'test'} as const
let service: DuckdbService

beforeAll(async () => {
  Object.assign(process.env, testEnv)
  service = await import('./duckdbService.ts')
  await service.runDuckdbJsonQuery('SELECT 1 AS value', workloadContext)
})

afterAll(async () => {
  try {
    await service.closeDuckdbService()
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(root, {force: true, recursive: true})
  }
})

const holdForegroundTransaction = async ({reject = false} = {}) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const work = service.runDuckdbTransaction(async (runner) => {
    await runner.queryJson('SELECT 1 AS value')
    entered.resolve(undefined)
    await release.promise
    if (reject) {
      throw new Error('held foreground rejected')
    }
    return 'completed'
  }, workloadContext)
  // Install the rejection handler before release; a rejected query still drains.
  const outcome = work.then(
    (result) => {
      return result
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
    },
  )
  await entered.promise
  return {
    outcome,
    release: () => {
      release.resolve(undefined)
    },
  }
}

const expectNoWaiters = () => {
  expect(globalThis.__forskaDuckdbServiceState?.duckdbForegroundIdleWaiters.size).toBe(0)
}

test('idle foreground resolves immediately but a pre-aborted caller stays cancelled', async () => {
  expect(await service.waitForDuckdbForegroundQueue({timeoutMs: 0})).toBe(true)
  const controller = new AbortController()
  controller.abort()
  expect(await service.waitForDuckdbForegroundQueue({signal: controller.signal, timeoutMs: 1000})).toBe(false)
  expectNoWaiters()
})

test('a short foreground burst wakes all observers only after the whole real queue drains', async () => {
  const connection = globalThis.__forskaDuckdbServiceState?.controlConnection
  if (connection === null || connection === undefined) {
    throw new Error('Native test connection is not started')
  }
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const nativeRead = connection.runAndReadAll.bind(connection)
  const read = spyOn(connection, 'runAndReadAll').mockImplementation(async (...args) => {
    if (args[0] === 'SELECT 1 AS burst') {
      entered.resolve(undefined)
      await release.promise
    }
    return nativeRead(...args)
  })
  const first = service.runDuckdbJsonQuery('SELECT 1 AS burst', workloadContext)
  await entered.promise
  const trailing = service.runDuckdbJsonQuery('SELECT 2 AS burst', workloadContext)
  // The exported query crosses one asynchronous append-barrier check before enqueue.
  await Promise.resolve()
  await Promise.resolve()
  const firstWait = service.waitForDuckdbForegroundQueue({timeoutMs: 1000})
  const secondWait = service.waitForDuckdbForegroundQueue({timeoutMs: 1000})
  let resolved = false
  void firstWait.then(() => {
    resolved = true
  })
  try {
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(service.getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth).toBe(2)
    expect(globalThis.__forskaDuckdbServiceState?.duckdbForegroundIdleWaiters.size).toBe(2)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([first, trailing])
    read.mockRestore()
  }
  expect(await first).toEqual([{burst: 1}])
  expect(await trailing).toEqual([{burst: 2}])
  expect(await Promise.all([firstWait, secondWait])).toEqual([true, true])
  expect(service.getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth).toBe(0)
  expectNoWaiters()
})

test('sustained foreground work times out without interrupting or dropping the query', async () => {
  const held = await holdForegroundTransaction()
  try {
    expect(await service.waitForDuckdbForegroundQueue({timeoutMs: 15})).toBe(false)
    expect(service.getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth).toBe(1)
    expectNoWaiters()
    expect(await service.waitForDuckdbForegroundQueue({timeoutMs: 0})).toBe(false)
    expect(await service.waitForDuckdbForegroundQueue({timeoutMs: Number.NaN})).toBe(false)
  } finally {
    held.release()
  }
  expect(await held.outcome).toBe('completed')
})

test('aborting one foreground-idle observer leaves another subscribed and the query intact', async () => {
  const held = await holdForegroundTransaction()
  const controller = new AbortController()
  const cancelled = service.waitForDuckdbForegroundQueue({signal: controller.signal, timeoutMs: 1000})
  const remaining = service.waitForDuckdbForegroundQueue({timeoutMs: 1000})
  try {
    controller.abort()
    expect(await cancelled).toBe(false)
    expect(globalThis.__forskaDuckdbServiceState?.duckdbForegroundIdleWaiters.size).toBe(1)
    expect(service.getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth).toBe(1)
  } finally {
    held.release()
  }
  expect(await held.outcome).toBe('completed')
  expect(await remaining).toBe(true)
  expectNoWaiters()
})

test('rejected foreground work wakes observers after native rollback and permits the next read', async () => {
  const held = await holdForegroundTransaction({reject: true})
  const idle = service.waitForDuckdbForegroundQueue({timeoutMs: 1000})
  held.release()
  expect(await held.outcome).toBe('held foreground rejected')
  expect(await idle).toBe(true)
  expectNoWaiters()
  expect(await service.runDuckdbJsonQuery('SELECT 3 AS value', workloadContext)).toEqual([{value: 3}])
})

test('runtime reset cancels pending observers instead of leaving callbacks attached to the old connection', async () => {
  const held = await holdForegroundTransaction()
  const idle = service.waitForDuckdbForegroundQueue({timeoutMs: 1000})
  service.resetDuckdbServiceForTests()
  expect(await idle).toBe(false)
  expectNoWaiters()
  held.release()
  expect(await held.outcome).toContain('DuckDB connection not started')
  expect(await service.runDuckdbJsonQuery('SELECT 4 AS value', workloadContext)).toEqual([{value: 4}])
})
