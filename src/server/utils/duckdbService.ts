import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {access, copyFile, mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {Effect} from 'effect'

import {env} from './env.ts'
import {ensureDuckdbPathDirectory} from './getDuckdbPath.ts'
import {readLocalAppSettings} from './localAppSettings.ts'
import {
  ensureCurrentDuckdbOwnerLease,
  registerWriterDemotionHandler,
  releaseCurrentDuckdbOwnerLease,
} from './serverRuntimeRole.ts'

type DuckdbRuntimeConfig = {binary: string; databasePath: string; memoryLimit: string; tempDirectory: string | null}
export type DuckdbSnapshot = {createdAt: string; snapshotPath: string}
type DuckdbTransactionRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type PendingDuckdbQuery = {
  reject: (error: Error) => void
  resolve: (rows: unknown[]) => void
  stderrLines: string[]
  stdoutLines: string[]
  token: string
}

type DuckdbMarkerRow = {__duckdb_done__?: string}
type DuckdbServiceState = {
  currentPendingDuckdbQuery: PendingDuckdbQuery | null
  duckdbProcess: ChildProcessWithoutNullStreams | null
  duckdbQueue: Promise<void>
  duckdbRuntimeConfig: DuckdbRuntimeConfig | null
  shutdownHooksRegistered: boolean
  stderrBuffer: string
  stdoutBuffer: string
}

declare global {
  var __forskaDuckdbServiceState: DuckdbServiceState | undefined
}

const getDuckdbServiceState = () => {
  globalThis.__forskaDuckdbServiceState ??= {
    currentPendingDuckdbQuery: null,
    duckdbProcess: null,
    duckdbQueue: Promise.resolve(),
    duckdbRuntimeConfig: null,
    shutdownHooksRegistered: false,
    stderrBuffer: '',
    stdoutBuffer: '',
  }

  return globalThis.__forskaDuckdbServiceState
}

const duckdbServiceState = getDuckdbServiceState()
const duckdbSnapshotDirectory = join(tmpdir(), 'forska-duckdb-studio')

const getDuckdbBinary = () => {
  return readLocalAppSettings().duckdbBin ?? 'duckdb'
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const getDuckdbRuntimeConfigValue = () => {
  if (duckdbServiceState.duckdbRuntimeConfig) {
    return duckdbServiceState.duckdbRuntimeConfig
  }

  duckdbServiceState.duckdbRuntimeConfig = {
    binary: getDuckdbBinary(),
    databasePath: env.DUCKDB_PATH,
    memoryLimit: env.DUCKDB_MEMORY_LIMIT,
    tempDirectory: getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY),
  }

  return duckdbServiceState.duckdbRuntimeConfig
}

const ensureDuckdbRuntimeDirectories = (runtimeConfig: DuckdbRuntimeConfig) => {
  ensureDuckdbPathDirectory(runtimeConfig.databasePath)
  return runtimeConfig.tempDirectory === null ? runtimeConfig : createDuckdbTempDirectory(runtimeConfig)
}

const createDuckdbTempDirectory = (runtimeConfig: DuckdbRuntimeConfig) => {
  mkdirSync(runtimeConfig.tempDirectory ?? '', {recursive: true})
  return runtimeConfig
}

const escapeDuckdbString = (value: string) => {
  return value.replaceAll("'", "''")
}

const getDuckdbStartupStatements = (runtimeConfig: DuckdbRuntimeConfig) => {
  const tempDirectoryStatement = runtimeConfig.tempDirectory
    ? `SET temp_directory = '${escapeDuckdbString(runtimeConfig.tempDirectory)}'`
    : null

  return [`SET memory_limit = '${escapeDuckdbString(runtimeConfig.memoryLimit)}'`, tempDirectoryStatement].filter(
    (statement): statement is string => {
      return statement !== null
    },
  )
}

const getNormalizedDuckdbStatement = (statement: string) => {
  return statement.trim().replace(/;+$/u, '')
}

const getDuckdbMarkerStatement = (token: string) => {
  return `SELECT '${token}' AS __duckdb_done__`
}

const getDuckdbCommandText = (statement: string, token: string) => {
  return `${getNormalizedDuckdbStatement(statement)};\n${getDuckdbMarkerStatement(token)};\n`
}

const getDuckdbRowsFromOutput = (output: string): unknown[] => {
  const parsed = JSON.parse(output) as unknown
  return Array.isArray(parsed) ? parsed : [parsed]
}

const getDuckdbMarkerToken = (line: string) => {
  try {
    const [firstRow] = getDuckdbRowsFromOutput(line) as DuckdbMarkerRow[]
    return typeof firstRow?.__duckdb_done__ === 'string' ? firstRow.__duckdb_done__ : null
  } catch {
    return null
  }
}

const getDuckdbResultRows = (lines: string[]) => {
  const output = lines.join('\n').trim()
  return output === '' ? [] : getDuckdbRowsFromOutput(output)
}

const rejectPendingDuckdbQuery = (error: Error) => {
  if (duckdbServiceState.currentPendingDuckdbQuery) {
    duckdbServiceState.currentPendingDuckdbQuery.reject(error)
    duckdbServiceState.currentPendingDuckdbQuery = null
  }
}

const resolvePendingDuckdbQuery = () => {
  if (duckdbServiceState.currentPendingDuckdbQuery) {
    const stderrOutput = duckdbServiceState.currentPendingDuckdbQuery.stderrLines.join('\n').trim()
    const pendingQuery = duckdbServiceState.currentPendingDuckdbQuery
    duckdbServiceState.currentPendingDuckdbQuery = null
    return stderrOutput === ''
      ? pendingQuery.resolve(getDuckdbResultRows(pendingQuery.stdoutLines))
      : pendingQuery.reject(new Error(stderrOutput))
  }
}

const appendPendingDuckdbStdoutLine = (line: string) => {
  if (duckdbServiceState.currentPendingDuckdbQuery) {
    duckdbServiceState.currentPendingDuckdbQuery.stdoutLines = [
      ...duckdbServiceState.currentPendingDuckdbQuery.stdoutLines,
      line,
    ]
  }
}

const appendPendingDuckdbStderrLine = (line: string) => {
  if (duckdbServiceState.currentPendingDuckdbQuery) {
    duckdbServiceState.currentPendingDuckdbQuery.stderrLines = [
      ...duckdbServiceState.currentPendingDuckdbQuery.stderrLines,
      line,
    ]
  }
}

const handleDuckdbStdoutLine = (line: string) => {
  const trimmedLine = line.trim()

  if (trimmedLine === '' || duckdbServiceState.currentPendingDuckdbQuery === null) {
    return
  }

  return getDuckdbMarkerToken(trimmedLine) === duckdbServiceState.currentPendingDuckdbQuery.token
    ? resolvePendingDuckdbQuery()
    : appendPendingDuckdbStdoutLine(trimmedLine)
}

const handleDuckdbStderrLine = (line: string) => {
  const trimmedLine = line.trim()

  if (trimmedLine !== '') {
    appendPendingDuckdbStderrLine(trimmedLine)
  }
}

const flushDuckdbStdout = (chunk: string) => {
  const lines = `${duckdbServiceState.stdoutBuffer}${chunk}`.split('\n')
  duckdbServiceState.stdoutBuffer = lines.pop() ?? ''
  lines.map(handleDuckdbStdoutLine)
}

const flushDuckdbStderr = (chunk: string) => {
  const lines = `${duckdbServiceState.stderrBuffer}${chunk}`.split('\n')
  duckdbServiceState.stderrBuffer = lines.pop() ?? ''
  lines.map(handleDuckdbStderrLine)
}

const resetDuckdbRuntimeState = () => {
  duckdbServiceState.duckdbProcess = null
  duckdbServiceState.stdoutBuffer = ''
  duckdbServiceState.stderrBuffer = ''
}

const safeReleaseCurrentDuckdbOwnerLease = async () => {
  try {
    await releaseCurrentDuckdbOwnerLease()
  } catch (error) {
    console.error('[duckdb] failed to release writer lease', error)
  }
}

const waitForDuckdbProcessExit = (activeProcess: ChildProcessWithoutNullStreams) => {
  return new Promise<void>((resolve) => {
    activeProcess.once('exit', () => {
      resolve()
    })
  })
}

const closeDuckdbProcessDirect = async (activeProcess: ChildProcessWithoutNullStreams) => {
  if (activeProcess.exitCode !== null || activeProcess.killed) {
    return
  }

  const processExit = waitForDuckdbProcessExit(activeProcess)
  activeProcess.stdin.end('.quit\n')
  await processExit
}

const registerDuckdbShutdownHooks = () => {
  if (duckdbServiceState.shutdownHooksRegistered) {
    return
  }

  duckdbServiceState.shutdownHooksRegistered = true
  ;(['SIGINT', 'SIGTERM'] as const).map((signal) => {
    process.once(signal, () => {
      void closeDuckdbService().then(
        () => {
          process.exit(0)
        },
        (error) => {
          console.error(`[duckdb] shutdown failed on ${signal}`, error)
          process.exit(1)
        },
      )
    })
  })
}

const getDuckdbExitError = (code: number | null, signal: string | null) => {
  const stderrOutput = duckdbServiceState.currentPendingDuckdbQuery?.stderrLines.join('\n').trim() ?? ''
  const exitReason = signal ? `signal ${signal}` : `code ${String(code ?? 'unknown')}`
  return new Error(stderrOutput === '' ? `DuckDB process exited with ${exitReason}` : stderrOutput)
}

const handleDuckdbProcessExit = (code: number | null, signal: string | null) => {
  rejectPendingDuckdbQuery(getDuckdbExitError(code, signal))
  resetDuckdbRuntimeState()
  void safeReleaseCurrentDuckdbOwnerLease()
}

const handleDuckdbProcessError = (error: Error) => {
  rejectPendingDuckdbQuery(error)
  resetDuckdbRuntimeState()
  void safeReleaseCurrentDuckdbOwnerLease()
}

const createDuckdbProcess = (runtimeConfig: DuckdbRuntimeConfig) => {
  const nextProcess = spawn(runtimeConfig.binary, ['-json', runtimeConfig.databasePath], {stdio: 'pipe'})
  nextProcess.stdout.setEncoding('utf8')
  nextProcess.stderr.setEncoding('utf8')
  nextProcess.stdout.on('data', flushDuckdbStdout)
  nextProcess.stderr.on('data', flushDuckdbStderr)
  nextProcess.on('exit', handleDuckdbProcessExit)
  nextProcess.on('error', handleDuckdbProcessError)
  nextProcess.stdin.write('.bail on\n')
  return nextProcess
}

const getDuckdbCommandError = (error: Error | null | undefined) => {
  const stderrOutput = duckdbServiceState.currentPendingDuckdbQuery?.stderrLines.join('\n').trim() ?? ''
  return error ?? new Error(stderrOutput === '' ? 'DuckDB command failed' : stderrOutput)
}

const writeDuckdbCommand = (statement: string, token: string) => {
  return new Promise<void>((resolve, reject) => {
    const activeProcess = duckdbServiceState.duckdbProcess

    if (activeProcess === null) {
      reject(new Error('DuckDB process not started'))
      return
    }

    activeProcess.stdin.write(getDuckdbCommandText(statement, token), (error) => {
      return error ? reject(getDuckdbCommandError(error)) : resolve()
    })
  })
}

const runDuckdbCommand = async <T>(statement: string): Promise<T[]> => {
  const token = randomUUID()
  return new Promise<T[]>((resolve, reject) => {
    duckdbServiceState.currentPendingDuckdbQuery = {
      token,
      stdoutLines: [],
      stderrLines: [],
      resolve: (rows) => {
        resolve(rows as T[])
      },
      reject,
    }
    void writeDuckdbCommand(statement, token).catch((error) => {
      rejectPendingDuckdbQuery(getDuckdbCommandError(error instanceof Error ? error : undefined))
    })
  })
}

const runDuckdbStartupStatements = async (statements: string[]): Promise<void> => {
  if (statements.length === 0) {
    return
  }

  const [currentStatement = ''] = statements
  await runDuckdbCommand(currentStatement)
  return runDuckdbStartupStatements(statements.slice(1))
}

const cleanupFailedDuckdbStart = (activeProcess: ChildProcessWithoutNullStreams) => {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => {
      return closeDuckdbProcessDirect(activeProcess)
    }).pipe(
      Effect.catchAll(() => {
        return Effect.void
      }),
    )

    yield* Effect.tryPromise(() => {
      return safeReleaseCurrentDuckdbOwnerLease()
    }).pipe(
      Effect.catchAll(() => {
        return Effect.void
      }),
    )

    yield* Effect.sync(() => {
      if (duckdbServiceState.duckdbProcess === activeProcess) {
        resetDuckdbRuntimeState()
      }
    })
  })
}

const ensureStartedDuckdbProcessEffect = () => {
  return Effect.gen(function* () {
    if (duckdbServiceState.duckdbProcess) {
      return duckdbServiceState.duckdbProcess
    }

    const runtimeConfig = yield* Effect.sync(() => {
      return ensureDuckdbRuntimeDirectories(getDuckdbRuntimeConfigValue())
    })
    yield* Effect.tryPromise(() => {
      return ensureCurrentDuckdbOwnerLease()
    })
    const nextProcess = yield* Effect.sync(() => {
      return createDuckdbProcess(runtimeConfig)
    })

    yield* Effect.sync(() => {
      duckdbServiceState.duckdbProcess = nextProcess
    })

    yield* Effect.tryPromise(() => {
      return runDuckdbStartupStatements(getDuckdbStartupStatements(runtimeConfig))
    }).pipe(
      Effect.catchAll((error) => {
        return Effect.zipRight(cleanupFailedDuckdbStart(nextProcess), Effect.fail(error))
      }),
    )

    yield* Effect.sync(() => {
      registerDuckdbShutdownHooks()
    })

    return nextProcess
  })
}

const ensureStartedDuckdbProcess = async () => {
  return Effect.runPromise(ensureStartedDuckdbProcessEffect())
}

const enqueueDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedWork = duckdbServiceState.duckdbQueue.then(work)
  duckdbServiceState.duckdbQueue = queuedWork.then(
    () => {
      return undefined
    },
    () => {
      return undefined
    },
  )
  return queuedWork
}

export const getDuckdbRuntimeConfig = () => {
  return {...getDuckdbRuntimeConfigValue()}
}

export const runDuckdbJsonQuery = async <T>(statement: string): Promise<T[]> => {
  return enqueueDuckdbWork(async () => {
    await ensureStartedDuckdbProcess()
    return runDuckdbCommand<T>(statement)
  })
}

export const runDuckdbStatement = async (statement: string) => {
  await enqueueDuckdbWork(async () => {
    await ensureStartedDuckdbProcess()
    await runDuckdbCommand(statement)
  })
}

export const runDuckdbTransaction = async <T>(work: (runner: DuckdbTransactionRunner) => Promise<T>): Promise<T> => {
  return enqueueDuckdbWork(async () => {
    await ensureStartedDuckdbProcess()
    await runDuckdbCommand('BEGIN TRANSACTION')

    try {
      const result = await work({
        queryJson: async <T>(statement: string) => {
          return runDuckdbCommand<T>(statement)
        },
        run: async (statement: string) => {
          await runDuckdbCommand(statement)
        },
      })
      await runDuckdbCommand('COMMIT')
      return result
    } catch (error) {
      await runDuckdbCommand('ROLLBACK')
      throw error
    }
  })
}

export const runDuckdbMaintenance = async (command: 'checkpoint' | 'force_checkpoint') => {
  const statement = command === 'checkpoint' ? 'CHECKPOINT' : 'PRAGMA force_checkpoint'
  await runDuckdbStatement(statement)
}

const hasDuckdbSnapshotWal = (snapshotWalPath: string) => {
  return Effect.tryPromise(() => {
    return access(snapshotWalPath).then(
      () => {
        return true
      },
      () => {
        return false
      },
    )
  })
}

const copyDuckdbSnapshot = (runtimeConfig: DuckdbRuntimeConfig): Effect.Effect<DuckdbSnapshot, unknown, never> => {
  return Effect.gen(function* () {
    if (runtimeConfig.databasePath === ':memory:') {
      yield* Effect.fail(new Error('DuckDB snapshots are not available for :memory: databases'))
    }

    yield* Effect.tryPromise(() => {
      return runDuckdbCommand('CHECKPOINT')
    })

    const createdAt = new Date().toISOString()
    const snapshotName = `${basename(runtimeConfig.databasePath)}.${createdAt.replaceAll(':', '-')}.${randomUUID()}.duckdb`
    const snapshotPath = join(duckdbSnapshotDirectory, snapshotName)
    const walPath = `${runtimeConfig.databasePath}.wal`
    const snapshotWalPath = `${snapshotPath}.wal`

    yield* Effect.tryPromise(() => {
      return mkdir(duckdbSnapshotDirectory, {recursive: true})
    })
    yield* Effect.tryPromise(() => {
      return copyFile(runtimeConfig.databasePath, snapshotPath)
    })

    const hasWal = yield* hasDuckdbSnapshotWal(walPath)

    if (hasWal) {
      yield* Effect.tryPromise(() => {
        return copyFile(walPath, snapshotWalPath)
      })
    }

    return {createdAt, snapshotPath} satisfies DuckdbSnapshot
  })
}

export const createDuckdbSnapshot = async (): Promise<DuckdbSnapshot> => {
  return enqueueDuckdbWork(async () => {
    await ensureStartedDuckdbProcess()
    return Effect.runPromise(copyDuckdbSnapshot(getDuckdbRuntimeConfigValue()))
  })
}

export const deleteDuckdbSnapshot = async (snapshotPath: string) => {
  const snapshotWalPath = `${snapshotPath}.wal`
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => {
        return rm(snapshotPath, {force: true})
      })
      yield* Effect.tryPromise(() => {
        return rm(snapshotWalPath, {force: true})
      })
    }),
  )
}

export const closeDuckdbService = async () => {
  await enqueueDuckdbWork(async () => {
    if (duckdbServiceState.duckdbProcess === null) {
      await releaseCurrentDuckdbOwnerLease()
      return
    }

    const activeProcess = duckdbServiceState.duckdbProcess
    await closeDuckdbProcessDirect(activeProcess)
    await releaseCurrentDuckdbOwnerLease()
  })
}

registerWriterDemotionHandler(async () => {
  if (duckdbServiceState.duckdbProcess !== null) {
    await closeDuckdbService()
  }
})
