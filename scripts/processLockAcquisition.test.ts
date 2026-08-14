import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  type ProcessLockState,
  readJsonProcessLockState,
  readProcessLockForAcquisition,
} from './processLockAcquisition.ts'

type TestLock = {pid: number}

const isTestLock = (value: unknown): value is TestLock => {
  return (
    typeof value === 'object'
    && value !== null
    && 'pid' in value
    && typeof value.pid === 'number'
    && Number.isInteger(value.pid)
    && value.pid > 0
  )
}

const getNextState = (states: ProcessLockState<TestLock>[]) => {
  const [state, ...remainingStates] = states

  if (state === undefined) {
    throw new Error('Unexpected process lock read')
  }

  states.splice(0, states.length, ...remainingStates)
  return Promise.resolve(state)
}

test('fresh partial process lock is retried until valid', async () => {
  let nowMs = 10_000
  const states: ProcessLockState<TestLock>[] = [
    {kind: 'malformed', modifiedAtMs: nowMs},
    {kind: 'valid', metadata: {pid: 42}},
  ]

  const lock = await readProcessLockForAcquisition({
    lockPath: 'test.lock.json',
    now: () => {
      return nowMs
    },
    readState: () => {
      return getNextState(states)
    },
    retryIntervalMs: 25,
    staleAfterMs: 2_000,
    wait: (ms) => {
      nowMs += ms
      return Promise.resolve()
    },
  })

  expect(lock).toEqual({pid: 42})
  expect(states).toEqual([])
})

test('persistent old malformed process lock fails closed after confirmation', async () => {
  const nowMs = 10_000
  let readCount = 0
  const oldMalformedState: ProcessLockState<TestLock> = {kind: 'malformed', modifiedAtMs: 1_000}

  expect(
    readProcessLockForAcquisition({
      lockPath: 'C:\\runtime\\test.lock.json',
      now: () => {
        return nowMs
      },
      readState: () => {
        readCount += 1
        return Promise.resolve(oldMalformedState)
      },
      retryIntervalMs: 25,
      staleAfterMs: 2_000,
      wait: () => {
        throw new Error('Old malformed lock should not wait')
      },
    }),
  ).rejects.toThrow(
    'Process lock at C:\\runtime\\test.lock.json stayed malformed for 2000ms. Inspect it and remove it only after confirming no server stack or dev watcher process is alive.',
  )
  expect(readCount).toBe(2)
})

test('parseable JSON with invalid process lock metadata is malformed', async () => {
  const testDirectory = await mkdtemp(join(tmpdir(), 'forska-process-lock-test-'))
  const lockPath = join(testDirectory, 'process.lock.json')

  try {
    for (const invalidMetadata of [null, false, {}, {pid: 0}, {pid: '42'}]) {
      await writeFile(lockPath, JSON.stringify(invalidMetadata), 'utf8')

      const state = await readJsonProcessLockState(lockPath, isTestLock)

      expect(state.kind).toBe('malformed')
    }
  } finally {
    await rm(testDirectory, {force: true, recursive: true})
  }
})
