import {expect, test} from 'bun:test'

import {
  getLiveStopChildProcessDependencies,
  stopChildProcess,
  type StopChildProcessDependencies,
  type StopChildProcessSignal,
  type StoppableChildProcess,
} from './stopChildProcess.ts'

const createChildProcess = (input: {exitCode?: number | null; pid?: number} = {}) => {
  const exit = Promise.withResolvers<number>()
  const kills: Array<StopChildProcessSignal | undefined> = []
  const childProcess: StoppableChildProcess = {
    exitCode: input.exitCode ?? null,
    exited: exit.promise,
    kill: (signal) => {
      kills.push(signal)
      childProcess.exitCode = 1
      exit.resolve(1)
    },
    pid: input.pid ?? 4242,
  }

  if (input.exitCode !== undefined && input.exitCode !== null) {
    exit.resolve(input.exitCode)
  }

  return {
    childProcess,
    exitGracefully: () => {
      childProcess.exitCode = 0
      exit.resolve(0)
    },
    kills,
  }
}

const createDependencies = (platform: string) => {
  const timeout = Promise.withResolvers<undefined>()
  const calls: string[] = []
  const dependencies: StopChildProcessDependencies = {
    clearStopRequest: (pid) => {
      calls.push(`clear:${pid}`)
    },
    log: (message) => {
      calls.push(`log:${message}`)
    },
    platform,
    requestStop: (pid, reason) => {
      calls.push(`request:${pid}:${reason}`)
    },
    wait: async (ms) => {
      calls.push(`wait:${ms}`)
      await timeout.promise
    },
  }

  return {
    calls,
    dependencies,
    fireTimeout: () => {
      return timeout.resolve(undefined)
    },
  }
}

const stopOptions = {childName: 'stacked-server child', signal: 'SIGINT' as const, timeoutMs: 335_000}

test('outside Windows the wrapper forwards the signal to its child exactly as before', async () => {
  const child = createChildProcess()
  const harness = createDependencies('darwin')

  const result = await stopChildProcess(harness.dependencies, child.childProcess, stopOptions)

  expect(result).toBe('signalled')
  expect(child.kills).toEqual(['SIGINT'])
  expect(harness.calls).toEqual([])
})

test('on Windows the wrapper asks its child to stop and waits for it instead of terminating it', async () => {
  const child = createChildProcess()
  const harness = createDependencies('win32')

  const stopping = stopChildProcess(harness.dependencies, child.childProcess, stopOptions)
  await globalThis.Bun.sleep(1)

  expect(child.kills).toEqual([])
  expect(harness.calls).toEqual(['request:4242:SIGINT to stacked-server child', 'wait:335000'])

  child.exitGracefully()

  expect(await stopping).toBe('exited')
  expect(child.kills).toEqual([])
  expect(harness.calls.at(-1)).toBe('clear:4242')
})

test('on Windows the wrapper terminates a child that is still running at the timeout', async () => {
  const child = createChildProcess()
  const harness = createDependencies('win32')

  const stopping = stopChildProcess(harness.dependencies, child.childProcess, stopOptions)
  await globalThis.Bun.sleep(1)
  harness.fireTimeout()

  expect(await stopping).toBe('killed')
  expect(child.kills).toEqual(['SIGKILL'])
  expect(harness.calls).toContain('log:stacked-server child pid=4242 did not exit within 335000ms; terminating it')
  expect(harness.calls.at(-1)).toBe('clear:4242')
})

test('on Windows a failed stop request still waits for the child that already got the console Ctrl+C', async () => {
  const child = createChildProcess()
  const harness = createDependencies('win32')
  harness.dependencies.requestStop = () => {
    throw new Error('ENOSPC')
  }

  const stopping = stopChildProcess(harness.dependencies, child.childProcess, stopOptions)
  await globalThis.Bun.sleep(1)
  child.exitGracefully()

  expect(await stopping).toBe('exited')
  expect(child.kills).toEqual([])
  expect(harness.calls[0]).toBe('log:stacked-server child pid=4242 could not receive a stop request: ENOSPC')
})

test('a child that already exited is neither signalled nor asked to stop', async () => {
  const child = createChildProcess({exitCode: 0})
  const harness = createDependencies('win32')

  expect(await stopChildProcess(harness.dependencies, child.childProcess, stopOptions)).toBe('already-exited')
  expect(child.kills).toEqual([])
  expect(harness.calls).toEqual([])
})

const readRemainingText = async (reader: ReadableStreamDefaultReader<Uint8Array>, text = ''): Promise<string> => {
  const chunk = await reader.read()

  return chunk.done ? text : readRemainingText(reader, text + new TextDecoder().decode(chunk.value))
}

test('a real child process watching for stop requests exits cleanly when the Windows path asks it to stop', async () => {
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {startProcessStopRequestWatcher} = await import('./src/server/utils/processStopRequest.ts')
        startProcessStopRequestWatcher({
          onStopRequest: (request) => {
            console.log('graceful stop: ' + request.reason)
            process.exit(0)
          },
          pollIntervalMs: 20,
        })
        console.log('watching')
        setInterval(() => {}, 1_000)
      `,
    ],
    {cwd: process.cwd(), stderr: 'pipe', stdout: 'pipe'},
  )
  const reader = childProcess.stdout.getReader()
  const firstChunk = await reader.read()
  const logs: string[] = []

  expect(new TextDecoder().decode(firstChunk.value)).toContain('watching')

  const result = await stopChildProcess(
    {
      ...getLiveStopChildProcessDependencies((message) => {
        logs.push(message)
      }),
      platform: 'win32',
    },
    childProcess,
    {childName: 'watcher child', signal: 'SIGINT', timeoutMs: 10_000},
  )
  const rest = await readRemainingText(reader)

  expect(result).toBe('exited')
  expect(childProcess.exitCode).toBe(0)
  expect(childProcess.signalCode).toBeNull()
  expect(rest).toContain('graceful stop: SIGINT to watcher child')
  expect(logs).toEqual([])
})
