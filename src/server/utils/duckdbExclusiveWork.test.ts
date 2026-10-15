import {afterEach, expect, test} from 'bun:test'

import {
  type DuckdbExclusiveWorkReadinessSnapshot,
  getActiveDuckdbExclusiveWorkSnapshot,
  getDuckdbExclusiveWorkAdmissionError,
  hasActiveDuckdbExclusiveWork,
  isDuckdbExclusiveWorkAdmissionError,
  isDuckdbExclusiveWorkLeaseContext,
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

test('exclusive-work admission errors remain recognizable after statement context is added', () => {
  const error = getDuckdbExclusiveWorkAdmissionError({
    operation: 'backgroundQuery',
    phase: 'commit',
    routeOrJobKey: 'review.bulk.worker',
  })

  expect(isDuckdbExclusiveWorkAdmissionError(error)).toBe(true)
  expect(isDuckdbExclusiveWorkAdmissionError(new Error(`${error.message} -- duckdb background query: SELECT 1`))).toBe(
    true,
  )
  expect(isDuckdbExclusiveWorkAdmissionError(new Error('unrelated DuckDB failure'))).toBe(false)
})

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

test('prepareDuckdbExclusiveWork admits after recycle when allocator RSS remains high but queues are drained', async () => {
  let recycleCount = 0
  const highRssReadiness = {
    activeMaintenance: [],
    appendQueueDepth: 0,
    backgroundQueueDepth: 0,
    foregroundQueueDepth: 0,
    recycleRecommended: true,
    rssBytes: 95,
    rssReady: false,
  } satisfies DuckdbExclusiveWorkReadinessSnapshot

  await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return highRssReadiness
      },
      recycleDuckdbRuntime: async () => {
        recycleCount += 1
      },
      sleep: async () => {},
    },
    pollIntervalMs: 1,
    timeoutMs: 1,
  })

  expect(recycleCount).toBe(1)
  expect(getActiveDuckdbExclusiveWorkSnapshot()).toMatchObject({admissionState: 'ready', blockedBy: {rssReady: false}})
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
  expect(error?.message).toContain(
    'blocked by 1 queued or running foreground DuckDB work item(s); in-flight reviewServing.projector.worker',
  )
  expect(operationStarted).toBe(false)
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('lease run marks only its own async work as the exclusive-work lease context', async () => {
  let releaseOperation = () => {}
  const operationGate = new Promise<void>((resolve) => {
    releaseOperation = resolve
  })
  const leaseContexts: boolean[] = []
  const lease = await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return readyReadiness
      },
      sleep: async () => {},
    },
  })
  const running = lease.run(async () => {
    leaseContexts.push(isDuckdbExclusiveWorkLeaseContext())
    await operationGate
    leaseContexts.push(isDuckdbExclusiveWorkLeaseContext())
  })
  const outsideWhileRunning = isDuckdbExclusiveWorkLeaseContext()

  releaseOperation()
  await running

  expect(leaseContexts).toEqual([true, true])
  expect(outsideWhileRunning).toBe(false)
  expect(isDuckdbExclusiveWorkLeaseContext()).toBe(false)
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('lease reclaimMemory collects garbage and keeps the runtime when RSS is back under the cap', async () => {
  const events: string[] = []
  const lease = await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      forceGarbageCollection: () => {
        events.push('gc')
      },
      getReadinessSnapshot: () => {
        events.push('readiness')
        return {...readyReadiness, maxRssBytes: 100, rssBytes: 40}
      },
      recycleDuckdbRuntime: () => {
        events.push('recycle')
      },
      sleep: async () => {},
    },
  })
  events.length = 0

  const reclaim = await lease.run(() => {
    return lease.reclaimMemory()
  })

  expect(events).toEqual(['gc', 'readiness', 'gc'])
  expect(reclaim).toMatchObject({readiness: {rssBytes: 40, rssReady: true}, recycled: false})
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('lease reclaimMemory recycles DuckDB once when RSS stays at the cap after garbage collection', async () => {
  const events: string[] = []
  let rssAtCap = false
  const lease = await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      forceGarbageCollection: () => {
        events.push('gc')
      },
      getReadinessSnapshot: () => {
        events.push('readiness')
        return rssAtCap
          ? {...readyReadiness, maxRssBytes: 100, recycleRecommended: true, rssBytes: 95, rssReady: false}
          : readyReadiness
      },
      recycleDuckdbRuntime: () => {
        rssAtCap = false
        events.push(`recycle:${getActiveDuckdbExclusiveWorkSnapshot()?.admissionState ?? 'missing'}`)
      },
      sleep: async () => {},
    },
  })
  rssAtCap = true
  events.length = 0

  const result = await lease.run(async () => {
    const reclaim = await lease.reclaimMemory()

    return {reclaim, snapshot: lease.snapshot()}
  })

  expect(events).toEqual(['gc', 'readiness', 'recycle:recycling', 'gc', 'gc'])
  expect(result.reclaim).toMatchObject({readiness: {rssBytes: 95, rssReady: false}, recycled: true})
  expect(result.snapshot).toMatchObject({admissionState: 'running', message: 'DuckDB exclusive work is running'})
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

const busyHighRssReadiness: DuckdbExclusiveWorkReadinessSnapshot = {
  activeMaintenance: ['background backgroundQuery reviewServing.projector.worker for 5 ms'],
  appendQueueDepth: 0,
  backgroundQueueDepth: 1,
  foregroundQueueDepth: 1,
  maxRssBytes: 100,
  recycleRecommended: true,
  rssBytes: 95,
  rssReady: false,
}

const drainedHighRssReadiness: DuckdbExclusiveWorkReadinessSnapshot = {
  ...readyReadiness,
  maxRssBytes: 100,
  recycleRecommended: true,
  rssBytes: 95,
  rssReady: false,
}

const getHighRssReadiness = (busy: boolean) => {
  return busy ? busyHighRssReadiness : drainedHighRssReadiness
}

test('lease reclaimMemory waits for in-flight DuckDB work to drain before recycling', async () => {
  const events: string[] = []
  const messagesWhileWaiting: string[] = []
  let reclaiming = false
  let busyReads = 2
  const lease = await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      forceGarbageCollection: () => {
        events.push('gc')
      },
      getReadinessSnapshot: () => {
        const busy = reclaiming && busyReads > 0

        busyReads = busy ? busyReads - 1 : busyReads
        events.push(busy ? 'readiness:busy' : 'readiness:drained')
        return reclaiming ? getHighRssReadiness(busy) : readyReadiness
      },
      recycleDuckdbRuntime: () => {
        events.push('recycle')
      },
      sleep: async () => {
        messagesWhileWaiting.push(getActiveDuckdbExclusiveWorkSnapshot()?.message ?? 'missing')
        events.push('sleep')
      },
    },
    pollIntervalMs: 1,
  })
  reclaiming = true
  events.length = 0

  const result = await lease.run(async () => {
    const reclaim = await lease.reclaimMemory()

    return {reclaim, snapshot: lease.snapshot()}
  })

  expect(events).toEqual([
    'gc',
    'readiness:busy',
    'sleep',
    'readiness:busy',
    'sleep',
    'readiness:drained',
    'recycle',
    'gc',
    'gc',
  ])
  expect(messagesWhileWaiting).toEqual([
    'Waiting for in-flight DuckDB work to finish before recycling the runtime',
    'Waiting for in-flight DuckDB work to finish before recycling the runtime',
  ])
  expect(result.reclaim).toMatchObject({readiness: {activeMaintenance: [], foregroundQueueDepth: 0}, recycled: true})
  expect(result.snapshot).toMatchObject({admissionState: 'running', message: 'DuckDB exclusive work is running'})
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})

test('lease reclaimMemory skips the recycle when in-flight DuckDB work does not drain in time', async () => {
  let clockMs = 0
  let reclaiming = false
  let recycleCount = 0
  let sleepCount = 0
  const lease = await prepareDuckdbExclusiveWork(getInput(), {
    dependencies: {
      getReadinessSnapshot: () => {
        return reclaiming ? busyHighRssReadiness : readyReadiness
      },
      now: () => {
        return new Date(clockMs)
      },
      recycleDuckdbRuntime: () => {
        recycleCount += 1
      },
      sleep: async (delayMs) => {
        sleepCount += 1
        clockMs += delayMs
      },
    },
    pollIntervalMs: 250,
    reclaimDrainTimeoutMs: 1000,
  })
  reclaiming = true

  const result = await lease.run(async () => {
    const reclaim = await lease.reclaimMemory()

    return {reclaim, snapshot: lease.snapshot()}
  })

  expect(result.reclaim).toMatchObject({
    readiness: {activeMaintenance: busyHighRssReadiness.activeMaintenance, rssReady: false},
    recycleSkippedReason: 'drainTimeout',
    recycled: false,
  })
  expect(recycleCount).toBe(0)
  expect(sleepCount).toBe(4)
  expect(result.snapshot).toMatchObject({admissionState: 'running', message: 'DuckDB exclusive work is running'})
  expect(hasActiveDuckdbExclusiveWork()).toBe(false)
})
