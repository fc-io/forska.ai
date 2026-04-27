import {getSqlLiteral} from '../../services/appQueryHelpers.ts'

const transientJudgmentJobSqliteLockFragments = [
  'database is locked',
  'database is busy',
  'database table is locked',
  'sqlite_busy',
  'sqlite_locked',
] as const

export const getJudgmentJobSqliteErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && 'cause' in error ? error.cause : undefined
  const causeMessage = cause === undefined ? '' : getJudgmentJobSqliteErrorMessage(cause)

  return causeMessage ? `${message}: ${causeMessage}` : message
}

export const isTransientJudgmentJobSqliteLockMessage = (message: string | null | undefined) => {
  const normalized = String(message ?? '').toLowerCase()

  return transientJudgmentJobSqliteLockFragments.some((fragment) => {
    return normalized.includes(fragment)
  })
}

export const isTransientJudgmentJobSqliteLockError = (error: unknown) => {
  return isTransientJudgmentJobSqliteLockMessage(getJudgmentJobSqliteErrorMessage(error))
}

export const getTransientJudgmentJobSqliteLockReasonSql = (expression: string) => {
  const normalizedExpression = `lower(COALESCE(${expression}, ''))`

  return transientJudgmentJobSqliteLockFragments
    .map((fragment) => {
      return `contains(${normalizedExpression}, ${getSqlLiteral(fragment)})`
    })
    .join(' OR ')
}
