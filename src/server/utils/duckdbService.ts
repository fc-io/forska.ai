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

let currentPendingDuckdbQuery: PendingDuckdbQuery | null = null
let duckdbProcess: ChildProcessWithoutNullStreams | null = null
let duckdbQueue = Promise.resolve()
let duckdbRuntimeConfig: DuckdbRuntimeConfig | null = null
let stderrBuffer = ''
let stdoutBuffer = ''

const getDuckdbBinary = () => {
  const configuredBinary = String(process.env['DUCKDB_BIN'] ?? '').trim()
  return configuredBinary === '' ? 'duckdb' : configuredBinary
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const getDuckdbRuntimeConfigValue = () => {
  if (duckdbRuntimeConfig) {
    return duckdbRuntimeConfig
  }

  duckdbRuntimeConfig = {
    binary: getDuckdbBinary(),
    databasePath: env.DUCKDB_PATH,
    memoryLimit: env.DUCKDB_MEMORY_LIMIT,
    tempDirectory: getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY),
  }

  return duckdbRuntimeConfig
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
  if (currentPendingDuckdbQuery) {
    currentPendingDuckdbQuery.reject(error)
    currentPendingDuckdbQuery = null
  }
}

const resolvePendingDuckdbQuery = () => {
  if (currentPendingDuckdbQuery) {
    const stderrOutput = currentPendingDuckdbQuery.stderrLines.join('\n').trim()
    const pendingQuery = currentPendingDuckdbQuery
    currentPendingDuckdbQuery = null
    return stderrOutput === ''
      ? pendingQuery.resolve(getDuckdbResultRows(pendingQuery.stdoutLines))
      : pendingQuery.reject(new Error(stderrOutput))
  }
}

const appendPendingDuckdbStdoutLine = (line: string) => {
  if (currentPendingDuckdbQuery) {
    currentPendingDuckdbQuery.stdoutLines = [...currentPendingDuckdbQuery.stdoutLines, line]
  }
}

const appendPendingDuckdbStderrLine = (line: string) => {
  if (currentPendingDuckdbQuery) {
    currentPendingDuckdbQuery.stderrLines = [...currentPendingDuckdbQuery.stderrLines, line]
  }
}

const handleDuckdbStdoutLine = (line: string) => {
  const trimmedLine = line.trim()

  if (trimmedLine === '' || currentPendingDuckdbQuery === null) {
    return
  }

  return getDuckdbMarkerToken(trimmedLine) === currentPendingDuckdbQuery.token
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
  const lines = `${stdoutBuffer}${chunk}`.split('\n')
  stdoutBuffer = lines.pop() ?? ''
  lines.map(handleDuckdbStdoutLine)
}

const flushDuckdbStderr = (chunk: string) => {
  const lines = `${stderrBuffer}${chunk}`.split('\n')
  stderrBuffer = lines.pop() ?? ''
  lines.map(handleDuckdbStderrLine)
}

const resetDuckdbRuntimeState = () => {
  duckdbProcess = null
  stdoutBuffer = ''
  stderrBuffer = ''
}

const getDuckdbExitError = (code: number | null, signal: string | null) => {
  const stderrOutput = currentPendingDuckdbQuery?.stderrLines.join('\n').trim() ?? ''
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
  const stderrOutput = currentPendingDuckdbQuery?.stderrLines.join('\n').trim() ?? ''
  return error ?? new Error(stderrOutput === '' ? 'DuckDB command failed' : stderrOutput)
}

const writeDuckdbCommand = (statement: string, token: string) => {
  return new Promise<void>((resolve, reject) => {
    const activeProcess = duckdbProcess

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
    currentPendingDuckdbQuery = {
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
  if (duckdbProcess) {
    return duckdbProcess
  }

  const runtimeConfig = ensureDuckdbRuntimeDirectories(getDuckdbRuntimeConfigValue())
  duckdbProcess = createDuckdbProcess(runtimeConfig)
  await runDuckdbStartupStatements(getDuckdbStartupStatements(runtimeConfig))
  return duckdbProcess
}

const enqueueDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedWork = duckdbQueue.then(work)
  duckdbQueue = queuedWork.then(
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
    if (duckdbProcess === null) {
      return
    }

    const activeProcess = duckdbProcess
    await new Promise<void>((resolve) => {
      activeProcess.once('exit', () => {
        resolve()
      })
      activeProcess.stdin.end('.quit\n')
    })
  })
}
