import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'

import {env} from './env.ts'
import {ensureDuckdbPathDirectory} from './getDuckdbPath.ts'

type DuckdbRuntimeConfig = {binary: string; databasePath: string; memoryLimit: string; tempDirectory: string | null}
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
    stderrBuffer: '',
    stdoutBuffer: '',
  }

  return globalThis.__forskaDuckdbServiceState
}

const duckdbServiceState = getDuckdbServiceState()

const getDuckdbBinary = () => {
  const configuredBinary = String(process.env['DUCKDB_BIN'] ?? '').trim()
  return configuredBinary === '' ? 'duckdb' : configuredBinary
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

const getDuckdbExitError = (code: number | null, signal: string | null) => {
  const stderrOutput = duckdbServiceState.currentPendingDuckdbQuery?.stderrLines.join('\n').trim() ?? ''
  const exitReason = signal ? `signal ${signal}` : `code ${String(code ?? 'unknown')}`
  return new Error(stderrOutput === '' ? `DuckDB process exited with ${exitReason}` : stderrOutput)
}

const handleDuckdbProcessExit = (code: number | null, signal: string | null) => {
  rejectPendingDuckdbQuery(getDuckdbExitError(code, signal))
  resetDuckdbRuntimeState()
}

const handleDuckdbProcessError = (error: Error) => {
  rejectPendingDuckdbQuery(error)
  resetDuckdbRuntimeState()
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

const ensureStartedDuckdbProcess = async () => {
  if (duckdbServiceState.duckdbProcess) {
    return duckdbServiceState.duckdbProcess
  }

  const runtimeConfig = ensureDuckdbRuntimeDirectories(getDuckdbRuntimeConfigValue())
  duckdbServiceState.duckdbProcess = createDuckdbProcess(runtimeConfig)
  await runDuckdbStartupStatements(getDuckdbStartupStatements(runtimeConfig))
  return duckdbServiceState.duckdbProcess
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

export const closeDuckdbService = async () => {
  await enqueueDuckdbWork(async () => {
    if (duckdbServiceState.duckdbProcess === null) {
      return
    }

    const activeProcess = duckdbServiceState.duckdbProcess
    await new Promise<void>((resolve) => {
      activeProcess.once('exit', () => {
        resolve()
      })
      activeProcess.stdin.end('.quit\n')
    })
  })
}
