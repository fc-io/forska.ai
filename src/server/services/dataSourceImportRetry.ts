import {sleep} from '../../utils/sleep.ts'
import {isDuckdbExclusiveWorkAdmissionError} from '../utils/duckdbExclusiveWork.ts'
import {writeRuntimeOperatorLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError} from '../utils/serverRuntimeRole.ts'

export const dataSourceImportPageRetryDelaysMs = [10_000, 30_000, 60_000, 120_000] as const

const permanentDataSourceImportErrorFragments = [
  'data source import lease was lost',
  'data source not found',
  'data source is archived',
  'validation failed',
]

const transientDataSourceImportErrorFragments = [
  'duckdb workload budget exceeded',
  'current transaction is aborted',
  'database has been invalidated because of a previous fatal error',
  'must be restarted prior to being used again',
  'failed to rollback transaction',
  'duckdb connection not started',
  'duckdb background connection not started',
  'duckdb instance not started',
  'conflicting lock is held',
  'write-write conflict',
  'conflict on update',
  'timed out',
  'timeout',
  'econnreset',
  'econnrefused',
  'etimedout',
  'epipe',
  'unable to connect',
  'fetch failed',
  'socket connection was closed',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
]

const transientHttpStatusPattern = /\bhttp (429|5\d\d)\b/

export const getDataSourceImportErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const hasFragment = (message: string, fragments: readonly string[]) => {
  return fragments.some((fragment) => {
    return message.includes(fragment)
  })
}

export const isTransientDataSourceImportError = (error: unknown) => {
  const message = getDataSourceImportErrorMessage(error).toLowerCase()

  return (
    !hasFragment(message, permanentDataSourceImportErrorFragments)
    && (isExpectedDuckdbOwnerRoleLossError(error)
      || isDuckdbExclusiveWorkAdmissionError(error)
      || hasFragment(message, transientDataSourceImportErrorFragments)
      || transientHttpStatusPattern.test(message))
  )
}

const logDataSourceImportPageRetry = (input: {
  attempt: number
  delayMs: number
  error: unknown
  label: string
  maxRetries: number
}) => {
  writeRuntimeOperatorLogEvent({
    attrs: {
      attempt: input.attempt,
      delayMs: input.delayMs,
      error: getDataSourceImportErrorMessage(input.error),
      label: input.label,
      maxRetries: input.maxRetries,
    },
    event: 'data-source-import.page-retry',
    message: `[dataSourceImport] ${input.label} failed with a transient error; retrying the same page in ${input.delayMs / 1000}s (retry ${input.attempt}/${input.maxRetries})`,
    severity: 'WARN',
  })
}

export const withDataSourceImportPageRetry = async <T>(
  label: string,
  operation: () => Promise<T>,
  delaysMs: readonly number[] = dataSourceImportPageRetryDelaysMs,
): Promise<T> => {
  const runAttempt = async (attemptIndex: number): Promise<T> => {
    return await operation().catch(async (error: unknown) => {
      const delayMs = delaysMs[attemptIndex]

      if (delayMs === undefined || !isTransientDataSourceImportError(error)) {
        throw error
      }

      logDataSourceImportPageRetry({attempt: attemptIndex + 1, delayMs, error, label, maxRetries: delaysMs.length})
      await sleep(delayMs)

      return await runAttempt(attemptIndex + 1)
    })
  }

  return await runAttempt(0)
}
