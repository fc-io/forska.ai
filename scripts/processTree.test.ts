import {expect, test} from 'bun:test'

import {type ProcessTreeDependencies, type ProcessTreeSignal, stopProcessTree} from './processTree.ts'

type FakeProcess = {children: number[]; exitAfterSigtermMs: number | null; ignoresStopRequest?: boolean}

const createProcessTreeHarness = (processes: Record<number, FakeProcess>, platform = 'darwin') => {
  const clock = {nowMs: 0}
  const alive = new Set(Object.keys(processes).map(Number))
  const exitAtMs = new Map<number, number>()
  const signals: Array<{atMs: number; pids: number[]; signal: ProcessTreeSignal}> = []
  const stopRequests: Array<{atMs: number; pids: number[]}> = []
  const clearedStopRequests: number[][] = []
  const logs: string[] = []
  const settleExits = () => {
    ;[...exitAtMs.entries()].map(([pid, atMs]) => {
      return atMs <= clock.nowMs ? alive.delete(pid) : false
    })
  }
  const scheduleGracefulExit = (pids: number[]) => {
    pids
      .filter((pid) => {
        return !exitAtMs.has(pid) && processes[pid]?.ignoresStopRequest !== true
      })
      .map((pid) => {
        const exitDelayMs = processes[pid]?.exitAfterSigtermMs ?? null

        return exitDelayMs === null ? null : exitAtMs.set(pid, clock.nowMs + exitDelayMs)
      })
  }
  const dependencies: ProcessTreeDependencies = {
    clearStopRequests: (pids) => {
      clearedStopRequests.push(pids)
    },
    platform,
    requestStop: (pids) => {
      stopRequests.push({atMs: clock.nowMs, pids})
      scheduleGracefulExit(pids)
    },
    getDescendantProcessIds: (pid) => {
      const children = alive.has(pid) ? (processes[pid]?.children ?? []) : []

      return children.flatMap((childPid) => {
        return alive.has(childPid) ? [childPid, ...dependencies.getDescendantProcessIds(childPid)] : []
      })
    },
    isProcessAlive: (pid) => {
      settleExits()
      return alive.has(pid)
    },
    killProcessIds: (pids, signal) => {
      signals.push({atMs: clock.nowMs, pids, signal})
      pids
        .filter((pid) => {
          return signal === 'SIGKILL' || !exitAtMs.has(pid)
        })
        .map((pid) => {
          const exitDelayMs = signal === 'SIGKILL' ? 0 : (processes[pid]?.exitAfterSigtermMs ?? null)

          return exitDelayMs === null ? null : exitAtMs.set(pid, clock.nowMs + exitDelayMs)
        })
    },
    log: (message) => {
      logs.push(message)
    },
    now: () => {
      return clock.nowMs
    },
    wait: async (ms) => {
      clock.nowMs += ms
    },
  }

  return {alive, clearedStopRequests, clock, dependencies, logs, signals, stopRequests}
}

const stopOptions = {
  forcedKillTimeoutMs: 5_000,
  pid: 100,
  pollIntervalMs: 250,
  processName: 'server stack',
  shutdownTimeoutMs: 300_000,
}

test('a process tree that stops its children and exits within the deadline is never SIGKILLed', async () => {
  const harness = createProcessTreeHarness({
    100: {children: [200], exitAfterSigtermMs: 180_000},
    200: {children: [], exitAfterSigtermMs: 170_000},
  })
  harness.dependencies.killProcessIds([200], 'SIGTERM')
  harness.signals.length = 0

  const result = await stopProcessTree(harness.dependencies, stopOptions)

  expect(result).toBe('exited')
  expect(harness.signals).toEqual([{atMs: 0, pids: [100], signal: 'SIGTERM'}])
  expect(harness.stopRequests).toEqual([])
  expect(harness.clearedStopRequests).toEqual([])
  expect(harness.clock.nowMs).toBe(180_000)
})

test('descendants left running after the parent exits get SIGTERM, then SIGKILL at the shared deadline', async () => {
  const harness = createProcessTreeHarness({
    100: {children: [200], exitAfterSigtermMs: 1_000},
    200: {children: [300], exitAfterSigtermMs: null},
    300: {children: [], exitAfterSigtermMs: null},
  })

  const result = await stopProcessTree(harness.dependencies, {...stopOptions, shutdownTimeoutMs: 20_000})

  expect(result).toBe('killed')
  expect(harness.signals).toEqual([
    {atMs: 0, pids: [100], signal: 'SIGTERM'},
    {atMs: 1_000, pids: [200, 300], signal: 'SIGTERM'},
    {atMs: 20_000, pids: [100, 200, 300], signal: 'SIGKILL'},
  ])
  expect(harness.alive.size).toBe(0)
})

test('a hung parent is escalated to SIGKILL of the whole tree, never just the parent', async () => {
  const harness = createProcessTreeHarness({
    100: {children: [200, 210], exitAfterSigtermMs: null},
    200: {children: [300], exitAfterSigtermMs: null},
    210: {children: [], exitAfterSigtermMs: null},
    300: {children: [], exitAfterSigtermMs: null},
  })

  const result = await stopProcessTree(harness.dependencies, stopOptions)

  expect(result).toBe('killed')
  expect(harness.signals).toEqual([
    {atMs: 0, pids: [100], signal: 'SIGTERM'},
    {atMs: 300_000, pids: [100, 200, 300, 210], signal: 'SIGKILL'},
  ])
  expect(harness.logs.at(-1)).toContain('sending SIGKILL to the process tree')
  expect(harness.alive.size).toBe(0)
})

test('a still-busy DuckDB owner keeps its whole shutdown budget before any SIGKILL', async () => {
  const harness = createProcessTreeHarness({100: {children: [], exitAfterSigtermMs: 239_750}})

  const result = await stopProcessTree(harness.dependencies, {...stopOptions, shutdownTimeoutMs: 240_000})

  expect(result).toBe('exited')
  expect(
    harness.signals.filter((entry) => {
      return entry.signal === 'SIGKILL'
    }),
  ).toEqual([])
})

test('processes that survive SIGKILL fail loudly after the forced-kill timeout', async () => {
  const harness = createProcessTreeHarness({100: {children: [], exitAfterSigtermMs: null}})
  harness.dependencies.killProcessIds = (pids, signal) => {
    harness.signals.push({atMs: harness.clock.nowMs, pids, signal})
  }

  const error = await stopProcessTree(harness.dependencies, {...stopOptions, shutdownTimeoutMs: 1_000}).catch(
    (caughtError: unknown) => {
      return caughtError
    },
  )

  expect(error).toEqual(new Error('Timed out waiting for server stack pids=100 to exit'))
  expect(harness.clock.nowMs).toBe(6_000)
})

test('on Windows the tree root gets a stop request instead of SIGTERM and is never force-killed when it exits in time', async () => {
  const harness = createProcessTreeHarness(
    {100: {children: [200], exitAfterSigtermMs: 180_000}, 200: {children: [], exitAfterSigtermMs: 170_000}},
    'win32',
  )
  harness.dependencies.requestStop([200], 'stop api')
  harness.stopRequests.length = 0

  const result = await stopProcessTree(harness.dependencies, stopOptions)

  expect(result).toBe('exited')
  expect(harness.signals).toEqual([])
  expect(harness.stopRequests).toEqual([{atMs: 0, pids: [100]}])
  expect(harness.clearedStopRequests).toEqual([[100, 200]])
  expect(harness.clock.nowMs).toBe(180_000)
})

test('on Windows orphaned descendants get stop requests, then the tree is force-killed at the shared deadline', async () => {
  const harness = createProcessTreeHarness(
    {
      100: {children: [200], exitAfterSigtermMs: 1_000},
      200: {children: [300], exitAfterSigtermMs: null},
      300: {children: [], exitAfterSigtermMs: null},
    },
    'win32',
  )

  const result = await stopProcessTree(harness.dependencies, {...stopOptions, shutdownTimeoutMs: 20_000})

  expect(result).toBe('killed')
  expect(harness.stopRequests).toEqual([
    {atMs: 0, pids: [100]},
    {atMs: 1_000, pids: [200, 300]},
  ])
  expect(harness.signals).toEqual([{atMs: 20_000, pids: [100, 200, 300], signal: 'SIGKILL'}])
  expect(harness.logs.at(-1)).toContain('after a stop request; sending SIGKILL to the process tree')
  expect(harness.alive.size).toBe(0)
})

test('on Windows a DuckDB owner that ignores the stop request keeps its whole budget before TerminateProcess', async () => {
  const harness = createProcessTreeHarness(
    {100: {children: [], exitAfterSigtermMs: 1_000, ignoresStopRequest: true}},
    'win32',
  )

  const result = await stopProcessTree(harness.dependencies, {...stopOptions, shutdownTimeoutMs: 240_000})

  expect(result).toBe('killed')
  expect(harness.signals).toEqual([{atMs: 240_000, pids: [100], signal: 'SIGKILL'}])
  expect(harness.clearedStopRequests).toEqual([[100]])
})

test('on Windows an unwritable stop request falls back to SIGTERM instead of waiting for nothing', async () => {
  const harness = createProcessTreeHarness({100: {children: [], exitAfterSigtermMs: 0}}, 'win32')
  harness.dependencies.requestStop = () => {
    throw new Error('EACCES: permission denied')
  }

  const result = await stopProcessTree(harness.dependencies, stopOptions)

  expect(result).toBe('exited')
  expect(harness.signals).toEqual([{atMs: 0, pids: [100], signal: 'SIGTERM'}])
  expect(harness.logs[0]).toContain('could not receive a stop request (EACCES: permission denied); sending SIGTERM')
})
