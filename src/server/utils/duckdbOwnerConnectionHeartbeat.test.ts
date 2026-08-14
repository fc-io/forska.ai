import {expect, test} from 'bun:test'

const getLastJsonLine = (value: string) => {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${value}`)
  }

  return lastLine
}

const runHeartbeatScript = <Result>(script: string) => {
  const runScript = globalThis.Bun.spawnSync(['bun', '-e', script], {cwd: process.cwd(), env: {...process.env}})

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString()
        || runScript.stdout.toString()
        || 'DuckDB owner connection heartbeat test script failed',
    )
  }

  return JSON.parse(getLastJsonLine(runScript.stdout.toString())) as Result
}

test('DuckDB owner connection heartbeat keeps one remote request in flight and consumes responses', () => {
  const result = runHeartbeatScript<{
    bodyReadCount: number
    fetchCountAfterCompletion: number
    fetchCountWhilePending: number
    intervalMs: number
    timeoutMs: Array<number>
  }>(`
    const {mock} = await import('bun:test')
    const {resolve} = await import('node:path')
    const {pathToFileURL} = await import('node:url')

    const getModulePath = (relativePath) => {
      return pathToFileURL(resolve(relativePath)).href
    }

    const heartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
    const ownerConnectionsModulePath = getModulePath('./src/server/utils/duckdbOwnerConnections.ts')
    const rateLimitedLoggerModulePath = getModulePath('./src/server/utils/rateLimitedLogger.ts')
    const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
    const intervalCallbacks = []
    const pendingResponses = []
    const timeoutMs = []
    let bodyReadCount = 0
    let fetchCount = 0

    void mock.module(ownerConnectionsModulePath, () => {
      return {
        getDuckdbOwnerConnectionHeartbeatPayload: async () => ({serverId: 'judge'}),
        getDuckdbOwnerConnectionProxyHeaders: () => ({}),
        upsertDuckdbOwnerConnectionHeartbeat: async () => {},
      }
    })
    void mock.module(rateLimitedLoggerModulePath, () => {
      return {
        createRateLimitedLogger: () => ({warn: () => {}}),
      }
    })
    void mock.module(runtimeRoleModulePath, () => {
      return {
        canCurrentServerOwnDuckdb: () => false,
        getCurrentServerWorkerRegistryOwnerUrl: async () => 'http://127.0.0.1:3001',
      }
    })

    globalThis.setInterval = (callback, intervalMs) => {
      intervalCallbacks.push({callback, intervalMs})
      return {unref: () => {}}
    }
    globalThis.clearInterval = () => {}
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: (durationMs) => {
        timeoutMs.push(durationMs)
        return new AbortController().signal
      },
    })
    globalThis.fetch = () => {
      fetchCount += 1
      return new Promise((resolveResponse) => {
        pendingResponses.push(resolveResponse)
      })
    }

    const settle = async () => {
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
    }
    const createResponse = () => {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          bodyReadCount += 1
          return new ArrayBuffer(0)
        },
      }
    }

    const {startDuckdbOwnerConnectionHeartbeat} = await import(heartbeatModulePath)
    startDuckdbOwnerConnectionHeartbeat()
    await settle()

    const [{callback: runInterval, intervalMs}] = intervalCallbacks
    runInterval()
    runInterval()
    await settle()
    const fetchCountWhilePending = fetchCount

    pendingResponses[0](createResponse())
    await settle()
    runInterval()
    await settle()
    const fetchCountAfterCompletion = fetchCount

    pendingResponses[1](createResponse())
    await settle()

    console.log(JSON.stringify({
      bodyReadCount,
      fetchCountAfterCompletion,
      fetchCountWhilePending,
      intervalMs,
      timeoutMs,
    }))
  `)

  expect(result.fetchCountWhilePending).toBe(1)
  expect(result.fetchCountAfterCompletion).toBe(2)
  expect(result.bodyReadCount).toBe(2)
  expect(result.intervalMs).toBe(15_000)
  expect(result.timeoutMs).toEqual([10_000, 10_000])
})

test('DuckDB owner connection heartbeat releases its in-flight slot after timeout and non-OK responses', () => {
  const result = runHeartbeatScript<{
    bodyReadCount: number
    fetchCount: number
    fetchCountWhilePending: number
    localUpsertCount: number
    warningCount: number
  }>(`
    const {mock} = await import('bun:test')
    const {resolve} = await import('node:path')
    const {pathToFileURL} = await import('node:url')

    const getModulePath = (relativePath) => {
      return pathToFileURL(resolve(relativePath)).href
    }

    const heartbeatModulePath = getModulePath('./src/server/utils/duckdbOwnerConnectionHeartbeat.ts')
    const ownerConnectionsModulePath = getModulePath('./src/server/utils/duckdbOwnerConnections.ts')
    const rateLimitedLoggerModulePath = getModulePath('./src/server/utils/rateLimitedLogger.ts')
    const runtimeRoleModulePath = getModulePath('./src/server/utils/serverRuntimeRole.ts')
    const controllers = []
    const intervalCallbacks = []
    let bodyReadCount = 0
    let fetchCount = 0
    let localUpsertCount = 0
    let warningCount = 0

    void mock.module(ownerConnectionsModulePath, () => {
      return {
        getDuckdbOwnerConnectionHeartbeatPayload: async () => ({serverId: 'judge'}),
        getDuckdbOwnerConnectionProxyHeaders: () => ({}),
        upsertDuckdbOwnerConnectionHeartbeat: async () => {
          localUpsertCount += 1
        },
      }
    })
    void mock.module(rateLimitedLoggerModulePath, () => {
      return {
        createRateLimitedLogger: () => ({
          warn: () => {
            warningCount += 1
          },
        }),
      }
    })
    void mock.module(runtimeRoleModulePath, () => {
      return {
        canCurrentServerOwnDuckdb: () => false,
        getCurrentServerWorkerRegistryOwnerUrl: async () => 'http://127.0.0.1:3001',
      }
    })

    globalThis.setInterval = (callback) => {
      intervalCallbacks.push(callback)
      return {unref: () => {}}
    }
    globalThis.clearInterval = () => {}
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => {
        const controller = new AbortController()
        controllers.push(controller)
        return controller.signal
      },
    })
    globalThis.fetch = (_url, options) => {
      fetchCount += 1

      if (fetchCount === 1) {
        return new Promise((_resolveResponse, rejectResponse) => {
          options.signal.addEventListener('abort', () => {
            rejectResponse(new Error('request timed out'))
          }, {once: true})
        })
      }

      return Promise.resolve({
        ok: false,
        status: 503,
        arrayBuffer: async () => {
          bodyReadCount += 1
          return new ArrayBuffer(0)
        },
      })
    }

    const settle = async () => {
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
    }

    const {startDuckdbOwnerConnectionHeartbeat} = await import(heartbeatModulePath)
    startDuckdbOwnerConnectionHeartbeat()
    await settle()

    const [runInterval] = intervalCallbacks
    runInterval()
    await settle()
    const fetchCountWhilePending = fetchCount

    controllers[0].abort()
    await settle()
    runInterval()
    await settle()

    console.log(JSON.stringify({
      bodyReadCount,
      fetchCount,
      fetchCountWhilePending,
      localUpsertCount,
      warningCount,
    }))
  `)

  expect(result.fetchCountWhilePending).toBe(1)
  expect(result.fetchCount).toBe(2)
  expect(result.bodyReadCount).toBe(1)
  expect(result.localUpsertCount).toBe(2)
  expect(result.warningCount).toBe(2)
})
