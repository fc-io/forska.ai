import {EventEmitter} from 'node:events'

import {expect, mock, test} from 'bun:test'

type FakeDuckdbStream = EventEmitter & {setEncoding: (_encoding: string) => void}
type FakeDuckdbProcess = EventEmitter & {
  exitCode: number | null
  killed: boolean
  stderr: FakeDuckdbStream
  stdin: {end: (chunk?: string) => void; write: (chunk: string, callback?: (error: Error | null) => void) => boolean}
  stdout: FakeDuckdbStream
}

const getEnvSnapshot = () => {
  return {
    API_SERVER_PORT: process.env.API_SERVER_PORT,
    DUCKDB_MEMORY_LIMIT: process.env.DUCKDB_MEMORY_LIMIT,
    DUCKDB_PATH: process.env.DUCKDB_PATH,
    DUCKDB_TEMP_DIRECTORY: process.env.DUCKDB_TEMP_DIRECTORY,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: process.env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON,
    RUN_SERVER_FULL_TEXT_FETCHING: process.env.RUN_SERVER_FULL_TEXT_FETCHING,
    SERVER_ROLE: process.env.SERVER_ROLE,
    SERVER_WRITER_URL: process.env.SERVER_WRITER_URL,
    VITE_PORT: process.env.VITE_PORT,
  }
}

const restoreEnvSnapshot = (snapshot: ReturnType<typeof getEnvSnapshot>) => {
  process.env.API_SERVER_PORT = snapshot.API_SERVER_PORT
  process.env.DUCKDB_MEMORY_LIMIT = snapshot.DUCKDB_MEMORY_LIMIT
  process.env.DUCKDB_PATH = snapshot.DUCKDB_PATH
  process.env.DUCKDB_TEMP_DIRECTORY = snapshot.DUCKDB_TEMP_DIRECTORY
  process.env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON = snapshot.RUN_SERVER_FULL_TEXT_CONVERSION_CRON
  process.env.RUN_SERVER_FULL_TEXT_FETCHING = snapshot.RUN_SERVER_FULL_TEXT_FETCHING
  process.env.SERVER_ROLE = snapshot.SERVER_ROLE
  process.env.SERVER_WRITER_URL = snapshot.SERVER_WRITER_URL
  process.env.VITE_PORT = snapshot.VITE_PORT
}

const createFakeDuckdbStream = (): FakeDuckdbStream => {
  const stream = new EventEmitter() as FakeDuckdbStream

  stream.setEncoding = (_encoding: string) => {
    return undefined
  }

  return stream
}

const getDuckdbMarkerToken = (chunk: string) => {
  return chunk.match(/SELECT '([^']+)' AS __duckdb_done__/u)?.[1] ?? null
}

const createFakeDuckdbProcess = (): FakeDuckdbProcess => {
  const stdout = createFakeDuckdbStream()
  const stderr = createFakeDuckdbStream()
  const duckdbProcess = new EventEmitter() as FakeDuckdbProcess

  duckdbProcess.exitCode = null
  duckdbProcess.killed = false
  duckdbProcess.stdout = stdout
  duckdbProcess.stderr = stderr
  duckdbProcess.stdin = {
    end: (_chunk?: string) => {
      duckdbProcess.exitCode = 0
      duckdbProcess.killed = true
      duckdbProcess.emit('exit', 0, null)
    },
    write: (chunk: string, callback?: (error: Error | null) => void) => {
      const token = getDuckdbMarkerToken(chunk)

      if (token) {
        queueMicrotask(() => {
          stdout.emit('data', `[{"__duckdb_done__":"${token}"}]\n`)
        })
      }

      callback?.(null)
      return true
    },
  }

  return duckdbProcess
}

test('duckdb transaction keeps the original error when rollback fails', async () => {
  const envSnapshot = getEnvSnapshot()
  let duckdbProcess: FakeDuckdbProcess | null = null

  process.env.API_SERVER_PORT = '3999'
  process.env.DUCKDB_MEMORY_LIMIT = '20GB'
  process.env.DUCKDB_PATH = '/tmp/f1-duckdb-transaction-rollback-test.duckdb'
  process.env.DUCKDB_TEMP_DIRECTORY = '/tmp/f1-duckdb-transaction-rollback-test-temp'
  process.env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON = 'false'
  process.env.RUN_SERVER_FULL_TEXT_FETCHING = 'false'
  process.env.SERVER_ROLE = 'writer'
  process.env.SERVER_WRITER_URL = ''
  process.env.VITE_PORT = '3000'
  ;(globalThis as Record<string, unknown>).__forskaDuckdbServiceState = undefined

  void mock.module('node:child_process', () => {
    return {
      spawn: () => {
        duckdbProcess = createFakeDuckdbProcess()
        return duckdbProcess
      },
    }
  })
  void mock.module('./localAppSettings.ts', () => {
    return {
      readLocalAppSettings: () => {
        return {duckdbBin: 'duckdb'}
      },
    }
  })
  void mock.module('./serverRuntimeRole.ts', () => {
    return {
      ensureCurrentDuckdbOwnerLease: async () => {
        return {leaseId: 'test-lease'}
      },
      registerWriterDemotionHandler: (_handler: (reason: string) => Promise<void> | void) => {
        return undefined
      },
      releaseCurrentDuckdbOwnerLease: async () => {
        return undefined
      },
    }
  })

  try {
    const duckdbServiceModule = (await import(
      `./duckdbService.ts?transaction-rollback-test=${Date.now()}`
    )) as typeof import('./duckdbService.ts')
    let errorMessage = ''

    try {
      await duckdbServiceModule.runDuckdbTransaction(async () => {
        if (duckdbProcess === null) {
          throw new Error('DuckDB process missing in rollback test')
        }

        duckdbProcess.exitCode = 1
        duckdbProcess.killed = true
        duckdbProcess.emit('exit', 1, null)
        throw new Error('original failure')
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toBe('original failure -- rollback failed: DuckDB process not started')
  } finally {
    restoreEnvSnapshot(envSnapshot)
    ;(globalThis as Record<string, unknown>).__forskaDuckdbServiceState = undefined
  }
})
