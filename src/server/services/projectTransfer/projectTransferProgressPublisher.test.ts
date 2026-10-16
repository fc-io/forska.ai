import {expect, test} from 'bun:test'

import {
  createProjectTransferOverallProgressTracker,
  createProjectTransferProgressPublisher,
  createProjectTransferProgressScheduler,
} from './projectTransferProgressPublisher.ts'

const wait = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const getClock = (startMs = 1_000) => {
  const clock = {nowMs: startMs}

  return {
    advance: (ms: number) => {
      clock.nowMs += ms
    },
    getNowMs: () => {
      return clock.nowMs
    },
  }
}

test('overall tracker clamps to the highest percent within an operation and completes at 100', () => {
  const tracker = createProjectTransferOverallProgressTracker('commit')

  expect(tracker.getCurrent()).toBeNull()
  expect(tracker.update({step: 'revalidation', stepFraction: 0.5}).percent).toBe(18)
  expect(tracker.update({step: 'waitForDuckdb', stepFraction: null})).toMatchObject({
    percent: 18,
    step: {key: 'waitForDuckdb'},
    stepFraction: null,
  })
  expect(tracker.update({step: 'revalidation', stepFraction: 0.25}).percent).toBe(18)
  expect(tracker.update({step: 'writeTables', stepFraction: 0.5}).percent).toBe(68.5)
  expect(tracker.getCurrent()?.percent).toBe(68.5)
  expect(tracker.complete().percent).toBe(100)
})

test('scheduler publishes step boundaries immediately and throttles sub-step updates to one per interval', async () => {
  const clock = getClock()
  const scheduler = createProjectTransferProgressScheduler({getNowMs: clock.getNowMs, throttleMs: 1_000})
  const published: string[] = []
  const publish = (value: string) => {
    return () => {
      published.push(value)
    }
  }

  await scheduler.publishNow(publish('start'))
  await scheduler.publishThrottled(publish('dropped'))
  clock.advance(400)
  await scheduler.publishThrottled(publish('pending'))
  clock.advance(600)
  await scheduler.publishThrottled(publish('due'))
  clock.advance(10)
  await scheduler.publishThrottled(publish('cancelled'))
  await scheduler.publishNow(publish('end'))
  await scheduler.close()

  expect(published).toEqual(['start', 'due', 'end'])
})

test('scheduler flushes the latest throttled update after the interval', async () => {
  const scheduler = createProjectTransferProgressScheduler({throttleMs: 30})
  const published: string[] = []

  await scheduler.publishNow(() => {
    published.push('start')
  })
  await scheduler.publishThrottled(() => {
    published.push('older')
  })
  await scheduler.publishThrottled(() => {
    published.push('latest')
  })
  await wait(80)
  await scheduler.close()

  expect(published).toEqual(['start', 'latest'])
})

test('scheduler runs publishes and heartbeats one at a time in call order', async () => {
  const scheduler = createProjectTransferProgressScheduler({throttleMs: 0})
  const events: string[] = []
  const slowPublish = scheduler.publishNow(async () => {
    events.push('slow:start')
    await wait(20)
    events.push('slow:end')
  })
  const heartbeat = scheduler.enqueue(() => {
    events.push('heartbeat')
  })
  const nextPublish = scheduler.publishNow(() => {
    events.push('next')
  })

  await Promise.all([slowPublish, heartbeat, nextPublish])

  expect(events).toEqual(['slow:start', 'slow:end', 'heartbeat', 'next'])
})

test('scheduler surfaces a failed trailing publish at the next boundary and close drops pending work', async () => {
  const scheduler = createProjectTransferProgressScheduler({throttleMs: 20})
  const published: string[] = []

  await scheduler.publishNow(() => {
    published.push('start')
  })
  await scheduler.publishThrottled(() => {
    throw new Error('ownership lost')
  })
  await wait(60)

  const boundaryError = await scheduler
    .publishNow(() => {
      published.push('never')
    })
    .then(
      () => {
        return null
      },
      (error: unknown) => {
        return error
      },
    )

  expect(boundaryError).toBeInstanceOf(Error)
  expect((boundaryError as Error).message).toBe('ownership lost')

  const closing = createProjectTransferProgressScheduler({throttleMs: 1_000})

  await closing.publishNow(() => {
    published.push('closing-start')
  })
  await closing.publishThrottled(() => {
    published.push('closing-pending')
  })
  await closing.close()
  await wait(20)

  expect(published).toEqual(['start', 'closing-start'])
})

const getDeferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

const getProgress = (percent: number) => {
  const tracker = createProjectTransferOverallProgressTracker('analyze')
  return {overall: {...tracker.complete(), percent}, phase: 'analyze' as const, status: 'running' as const}
}

test('publisher heartbeats restamp the last written payload and clamp at persistence time', async () => {
  const gate = getDeferred()
  const written: number[] = []
  const publisher = createProjectTransferProgressPublisher({
    writeArtifact: async (progress) => {
      if (progress.overall?.percent === 10) await gate.promise
      written.push(progress.overall?.percent ?? -1)
    },
  })
  await publisher.publish(getProgress(0))
  const slow = publisher.publish(getProgress(10))
  const heartbeat = publisher.heartbeat()
  const next = publisher.publish(getProgress(30))
  const older = publisher.publish(getProgress(20))
  gate.resolve()
  await Promise.all([slow, heartbeat, next, older])
  await publisher.close()
  expect(written).toEqual([0, 10, 10, 30, 30])
})

test('ordinary writes coalesce behind slow artifacts and throttle when executed', async () => {
  const gate = getDeferred()
  const writes: {at: number; percent: number}[] = []
  const publisher = createProjectTransferProgressPublisher({
    throttleMs: 40,
    writeArtifact: async (progress) => {
      writes.push({at: Date.now(), percent: progress.overall?.percent ?? -1})
      if (progress.overall?.percent === 0) await gate.promise
    },
  })
  const slow = publisher.publish(getProgress(0))
  await publisher.publish(getProgress(10), {throttled: true})
  await wait(60)
  await publisher.publish(getProgress(20), {throttled: true})
  await publisher.publish(getProgress(30), {throttled: true})
  gate.resolve()
  await slow
  await wait(5)
  await publisher.publish(getProgress(40), {throttled: true})
  await publisher.flush()
  expect(
    writes.map((write) => {
      return write.percent
    }),
  ).toEqual([0, 30, 40])
  expect((writes[2]?.at ?? 0) - (writes[1]?.at ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(40)
  await publisher.close()
})

test('session writes are independent, single flight, latest wins, and flush waits for them', async () => {
  const gate = getDeferred()
  const written: number[] = []
  const publisher = createProjectTransferProgressPublisher({
    writeArtifact: () => {},
    writeSession: async (progress) => {
      written.push(progress.overall?.percent ?? -1)
      if (progress.overall?.percent === 0) await gate.promise
    },
  })
  await publisher.publish(getProgress(0))
  await publisher.publish(getProgress(10))
  await publisher.publish(getProgress(20))
  let flushed = false
  const flushing = publisher.flush().then(() => {
    flushed = true
  })
  await wait(10)
  expect(flushed).toBe(false)
  expect(written).toEqual([0])
  gate.resolve()
  await flushing
  expect(written).toEqual([0, 20])
  await publisher.close()
})

test('session failure is rethrown by the next publish and flush', async () => {
  const publisher = createProjectTransferProgressPublisher({
    writeArtifact: () => {},
    writeSession: () => {
      throw new Error('ownership lost')
    },
  })
  await publisher.publish(getProgress(0))
  await wait(0)
  expect(publisher.publish(getProgress(10))).rejects.toThrow('ownership lost')
  expect(publisher.flush()).rejects.toThrow('ownership lost')
  expect(publisher.close()).rejects.toThrow('ownership lost')
})

test('flush persists pending ordinary progress while close cancels it', async () => {
  const written: number[] = []
  const publisher = createProjectTransferProgressPublisher({
    throttleMs: 20,
    writeArtifact: (progress) => {
      written.push(progress.overall?.percent ?? -1)
    },
  })
  await publisher.publish(getProgress(0))
  await publisher.publish(getProgress(10), {throttled: true})
  await publisher.flush()
  await publisher.publish(getProgress(20), {throttled: true})
  await publisher.close()
  expect(written).toEqual([0, 10])
})

test('flush waits for an ordinary artifact scheduled as an in-flight write completes', async () => {
  const first = getDeferred()
  const second = getDeferred()
  const started = getDeferred()
  const publisher = createProjectTransferProgressPublisher({
    throttleMs: 0,
    writeArtifact: async (progress) => {
      if (progress.overall?.percent === 0) await first.promise
      else {
        started.resolve()
        await second.promise
      }
    },
  })
  const publishing = publisher.publish(getProgress(0))
  await publisher.publish(getProgress(10), {throttled: true})
  let flushed = false
  const flushing = publisher.flush().then(() => {
    flushed = true
  })
  first.resolve()
  await publishing
  await started.promise
  await wait(5)
  expect(flushed).toBe(false)
  second.resolve()
  await flushing
  expect(publisher.getLastWritten()?.overall?.percent).toBe(10)
  await publisher.close()
})
