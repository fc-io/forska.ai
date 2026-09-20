import {expect, test} from 'bun:test'

import {createReviewsWarningsPayloadMemo} from './reviewsWarningsPayloadMemo.ts'

const createClock = (startMs: number) => {
  let nowMs = startMs

  return {
    advance: (deltaMs: number) => {
      nowMs += deltaMs
    },
    now: () => {
      return nowMs
    },
  }
}

const createCountingCompute = () => {
  let computeCount = 0

  return {
    compute: async () => {
      computeCount += 1

      return {computeCount}
    },
    getComputeCount: () => {
      return computeCount
    },
  }
}

test('memo mode shares one computation per key until the TTL expires', async () => {
  const clock = createClock(1_000)
  const memo = createReviewsWarningsPayloadMemo<{computeCount: number}>({now: clock.now, ttlMs: 10_000})
  const counting = createCountingCompute()

  const [first, second] = await Promise.all([
    memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'}),
    memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'}),
  ])
  clock.advance(9_999)
  const third = await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})

  expect(first).toEqual({computeCount: 1})
  expect(second).toBe(first)
  expect(third).toBe(first)
  expect(counting.getComputeCount()).toBe(1)

  clock.advance(1)
  const fourth = await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})

  expect(fourth).toEqual({computeCount: 2})
  expect(counting.getComputeCount()).toBe(2)
})

test('memo entries are keyed so different projects never share a payload', async () => {
  const clock = createClock(1_000)
  const memo = createReviewsWarningsPayloadMemo<{computeCount: number}>({now: clock.now, ttlMs: 10_000})
  const counting = createCountingCompute()

  await memo.read({compute: counting.compute, key: 'project-1:hash-a', mode: 'memo'})
  await memo.read({compute: counting.compute, key: 'project-1:hash-b', mode: 'memo'})
  await memo.read({compute: counting.compute, key: 'project-2:hash-a', mode: 'memo'})

  expect(counting.getComputeCount()).toBe(3)
  expect(memo.size()).toBe(3)
})

test('refresh mode recomputes and replaces the memo entry for later memo reads', async () => {
  const clock = createClock(1_000)
  const memo = createReviewsWarningsPayloadMemo<{computeCount: number}>({now: clock.now, ttlMs: 10_000})
  const counting = createCountingCompute()

  await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})
  const refreshed = await memo.read({compute: counting.compute, key: 'project-1', mode: 'refresh'})
  const reused = await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})

  expect(refreshed).toEqual({computeCount: 2})
  expect(reused).toBe(refreshed)
  expect(counting.getComputeCount()).toBe(2)
})

test('bypass mode computes without touching the memo', async () => {
  const clock = createClock(1_000)
  const memo = createReviewsWarningsPayloadMemo<{computeCount: number}>({now: clock.now, ttlMs: 10_000})
  const counting = createCountingCompute()

  const memoized = await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})
  const bypassed = await memo.read({compute: counting.compute, key: 'project-1', mode: 'bypass'})
  const reused = await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})

  expect(bypassed).toEqual({computeCount: 2})
  expect(reused).toBe(memoized)
  expect(memo.size()).toBe(1)
})

test('rejected computations are not retained and expired entries are pruned on store', async () => {
  const clock = createClock(1_000)
  const memo = createReviewsWarningsPayloadMemo<{computeCount: number}>({now: clock.now, ttlMs: 10_000})
  const counting = createCountingCompute()
  const failing = async () => {
    throw new Error('diagnostics unavailable')
  }

  const rejection = await memo.read({compute: failing, key: 'project-1', mode: 'memo'}).then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )

  expect(rejection).toBeInstanceOf(Error)
  expect(memo.size()).toBe(0)

  await memo.read({compute: counting.compute, key: 'project-1', mode: 'memo'})
  clock.advance(10_000)
  await memo.read({compute: counting.compute, key: 'project-2', mode: 'memo'})

  expect(memo.size()).toBe(1)
  expect(counting.getComputeCount()).toBe(2)

  memo.clear()

  expect(memo.size()).toBe(0)
})
