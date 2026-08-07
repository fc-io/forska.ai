import {afterEach, expect, test} from 'bun:test'

import {
  type DuckdbExclusiveWorkReadinessSnapshot,
  getActiveDuckdbExclusiveWorkSnapshot,
  hasActiveDuckdbExclusiveWork,
  prepareDuckdbExclusiveWork,
  resetDuckdbExclusiveWorkForTests,
  runWithDuckdbExclusiveWork,
  updateActiveDuckdbExclusiveWorkProgress,
} from './duckdbExclusiveWork.ts'

const readyReadiness: DuckdbExclusiveWorkReadinessSnapshot = {
  activeMaintenance: [],
  appendQueueDepth: 0,
  backgroundQueueDepth: 0,
  foregroundQueueDepth: 0,
  rssReady: true,
}

const getInput = () => {
  return {
    kind: 'project_transfer_import' as const,
    ownerToken: 'owner-1',
    phase: 'commit' as const,
    sessionId: 'session-1',
  }
}

afterEach(() => {
  resetDuckdbExclusiveWorkForTests()
})

const getRejectedError = async (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error : new Error(String(error))
    },
  )
}

test('runWithDuckdbExclusiveWork publishes running snapshot and releases after success', async () => {
  let snapshotDuringOperation = null as ReturnType<typeof getActiveDuckdbExclusiveWorkSnapshot>

  const result = await runWithDuckdbExclusiveWork(
    getInput(),
    () => {
      snapshotDuringOperation = getActiveDuckdbExclusiveWorkSnapshot()
      return 'done'
    },
    {
      dependencies: {
        getReadinessSnapshot: () => {
          return readyReadiness
        },
        sleep: async () => {},
      },
    },
  )

  expect(result).toBe('done')
  expect(snapshotDuringOperation).toMatchObject({
    admissionState: 'running',
    kind: 'project_transfer_import',
    phase: 'commit',
    sessionId: 'session-1',
  })
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('runWithDuckdbExclusiveWork releases after operation failure', async () => {
  const error = await getRejectedError(
    runWithDuckdbExclusiveWork(
      getInput(),
      () => {
        throw new Error('commit failed')
      },
      {
        dependencies: {
          getReadinessSnapshot: () => {
            return readyReadiness
          },
          sleep: async () => {},
        },
      },
    ),
  )

  expect(error?.message).toBe('commit failed')
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('prepareDuckdbExclusiveWork waits until queues and maintenance drain before ready', async () => {
  const readinessValues: DuckdbExclusiveWorkReadinessSnapshot[] = [
    {
      activeMaintenance: ['reviewServing.projector.worker'],
      appendQueueDepth: 1,
      backgroundQueueDepth: 1,
      foregroundQueueDepth: 1,
      rssReady: true,
    },
    readyReadiness,
  ]
  const snapshots: Array<ReturnType<typeof getActiveDuckdbExclusiveWorkSnapshot>> = []

  await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return readinessValues.shift() ?? readyReadiness
      },
      sleep: async () => {
        snapshots.push(getActiveDuckdbExclusiveWorkSnapshot())
      },
    },
    pollIntervalMs: 1,
  })

  expect(snapshots[0]).toMatchObject({
    admissionState: 'draining',
    blockedBy: {
      activeMaintenance: ['reviewServing.projector.worker'],
      appendQueueDepth: 1,
      backgroundQueueDepth: 1,
      foregroundQueueDepth: 1,
    },
    message: 'Waiting for DuckDB maintenance work to pause',
  })
  expect(getActiveDuckdbExclusiveWorkSnapshot()).toMatchObject({admissionState: 'ready'})
})

test('prepareDuckdbExclusiveWork recycles before ready when queues are drained but RSS is high', async () => {
  let recycled = false
  const readinessValues: DuckdbExclusiveWorkReadinessSnapshot[] = [
    {
      activeMaintenance: [],
      appendQueueDepth: 0,
      backgroundQueueDepth: 0,
      foregroundQueueDepth: 0,
      recycleRecommended: true,
      rssBytes: 95,
      rssReady: false,
    },
    readyReadiness,
  ]

  await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return readinessValues.shift() ?? readyReadiness
      },
      recycleDuckdbRuntime: async () => {
        recycled = true
      },
      sleep: async () => {},
    },
    pollIntervalMs: 1,
  })

  expect(recycled).toBe(true)
  expect(getActiveDuckdbExclusiveWorkSnapshot()).toMatchObject({admissionState: 'ready'})
})

test('prepareDuckdbExclusiveWork exposes requested, recycling, and releasing states', async () => {
  const states: string[] = []
  const readinessValues: DuckdbExclusiveWorkReadinessSnapshot[] = [
    {
      activeMaintenance: [],
      appendQueueDepth: 0,
      backgroundQueueDepth: 0,
      foregroundQueueDepth: 0,
      recycleRecommended: true,
      rssBytes: 95,
      rssReady: false,
    },
    readyReadiness,
  ]

  const preparePromise = prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      forceGarbageCollection: async () => {
        const snapshot = getActiveDuckdbExclusiveWorkSnapshot()

        if (snapshot !== null) {
          states.push(snapshot.admissionState)
        }
      },
      getReadinessSnapshot: () => {
        return readinessValues.shift() ?? readyReadiness
      },
      recycleDuckdbRuntime: async () => {
        states.push(getActiveDuckdbExclusiveWorkSnapshot()?.admissionState ?? 'missing')
      },
      sleep: async () => {},
    },
  })

  states.push(getActiveDuckdbExclusiveWorkSnapshot()?.admissionState ?? 'missing')

  const handle = await preparePromise
  states.push(handle.snapshot().admissionState)
  await handle.release()

  expect(states[0]).toBe('requested')
  expect(states).toContain('recycling')
  expect(states.slice(-2)).toEqual(['ready', 'releasing'])
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('updateActiveDuckdbExclusiveWorkProgress updates progress snapshot fields', async () => {
  await prepareDuckdbExclusiveWork(
    {...getInput(), estimatedRows: 100},
    {
      dependencies: {
        getReadinessSnapshot: () => {
          return readyReadiness
        },
        sleep: async () => {},
      },
    },
  )

  const snapshot = updateActiveDuckdbExclusiveWorkProgress({
    completedRows: 25,
    message: 'Copied operation tables',
    percent: 25,
    totalRows: 100,
  })

  expect(snapshot).toMatchObject({
    admissionState: 'ready',
    completedRows: 25,
    estimatedRows: 100,
    message: 'Copied operation tables',
    percent: 25,
    totalRows: 100,
  })
})

test('prepareDuckdbExclusiveWork times out before heavy work can start', async () => {
  let operationStarted = false

  const error = await getRejectedError(
    runWithDuckdbExclusiveWork(
      getInput(),
      () => {
        operationStarted = true
      },
      {
        dependencies: {
          getReadinessSnapshot: () => {
            return {
              activeMaintenance: ['reviewServing.projector.worker'],
              appendQueueDepth: 0,
              backgroundQueueDepth: 0,
              foregroundQueueDepth: 1,
              rssReady: true,
            }
          },
          sleep: async () => {},
        },
        pollIntervalMs: 1,
        timeoutMs: 0,
      },
    ),
  )

  expect(error?.message).toContain(
    'Timed out after 0ms waiting for DuckDB exclusive project_transfer_import commit work',
  )
  expect(operationStarted).toBe(false)
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('prepareDuckdbExclusiveWork rejects concurrent exclusive work', async () => {
  await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return readyReadiness
      },
      sleep: async () => {},
    },
  })

  const error = await getRejectedError(
    prepareDuckdbExclusiveWork(
      {...getInput(), sessionId: 'session-2'},
      {
        dependencies: {
          getReadinessSnapshot: () => {
            return readyReadiness
          },
          sleep: async () => {},
        },
      },
    ),
  )

  expect(error?.message).toContain('DuckDB exclusive work is already active')
})
