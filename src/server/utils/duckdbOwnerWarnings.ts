type DuckdbOwnerWarningKind = 'unresponsive-owner' | 'write-failure' | 'owner-proxy-disabled'
type DuckdbOwnerWarningSeverity = 'warning' | 'error'

type DuckdbOwnerWarningsState = {currentWriteFailure: DuckdbOwnerWarning | null; recentWarnings: DuckdbOwnerWarning[]}

export type DuckdbOwnerWarning = {
  at: string
  kind: DuckdbOwnerWarningKind
  message: string
  severity: DuckdbOwnerWarningSeverity
}

declare global {
  var __forskaDuckdbOwnerWarningsState: DuckdbOwnerWarningsState | undefined
}

const duckdbOwnerWarningRetentionMs = 15 * 60_000

const getDuckdbOwnerWarningsState = () => {
  globalThis.__forskaDuckdbOwnerWarningsState ??= {currentWriteFailure: null, recentWarnings: []}

  return globalThis.__forskaDuckdbOwnerWarningsState
}

const duckdbOwnerWarningsState = getDuckdbOwnerWarningsState()

const getDuckdbOwnerWarningMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : String(error)
}

const getNextDuckdbOwnerWarning = (params: {
  kind: DuckdbOwnerWarningKind
  message: string
  severity: DuckdbOwnerWarningSeverity
}) => {
  return {
    at: new Date().toISOString(),
    kind: params.kind,
    message: params.message,
    severity: params.severity,
  } satisfies DuckdbOwnerWarning
}

const pruneDuckdbOwnerWarnings = (nowMs: number) => {
  duckdbOwnerWarningsState.recentWarnings = duckdbOwnerWarningsState.recentWarnings.filter((warning) => {
    return nowMs - new Date(warning.at).getTime() <= duckdbOwnerWarningRetentionMs
  })
}

const upsertRecentDuckdbOwnerWarning = (nextWarning: DuckdbOwnerWarning) => {
  const previousWarning = duckdbOwnerWarningsState.recentWarnings[0]
  const isDuplicate =
    previousWarning?.kind === nextWarning.kind
    && previousWarning.message === nextWarning.message
    && Date.now() - new Date(previousWarning.at).getTime() < 5_000

  duckdbOwnerWarningsState.recentWarnings = isDuplicate
    ? duckdbOwnerWarningsState.recentWarnings
    : [nextWarning, ...duckdbOwnerWarningsState.recentWarnings]
}

export const recordUnresponsiveDuckdbOwnerWarning = (params: {message: string}) => {
  const nowMs = Date.now()

  pruneDuckdbOwnerWarnings(nowMs)
  upsertRecentDuckdbOwnerWarning(
    getNextDuckdbOwnerWarning({kind: 'unresponsive-owner', message: params.message, severity: 'warning'}),
  )
}

export const recordDuckdbOwnerWriteFailure = (params: {action: string; error: unknown}) => {
  duckdbOwnerWarningsState.currentWriteFailure = getNextDuckdbOwnerWarning({
    kind: 'write-failure',
    message: `${params.action} failed: ${getDuckdbOwnerWarningMessage(params.error)}`,
    severity: 'error',
  })
}

export const clearDuckdbOwnerWriteFailure = () => {
  duckdbOwnerWarningsState.currentWriteFailure = null
}

export const clearUnresponsiveDuckdbOwnerWarnings = () => {
  duckdbOwnerWarningsState.recentWarnings = duckdbOwnerWarningsState.recentWarnings.filter((warning) => {
    return warning.kind !== 'unresponsive-owner'
  })
}

export const getDuckdbOwnerWarnings = () => {
  const nowMs = Date.now()

  pruneDuckdbOwnerWarnings(nowMs)

  return duckdbOwnerWarningsState.currentWriteFailure === null
    ? duckdbOwnerWarningsState.recentWarnings
    : [duckdbOwnerWarningsState.currentWriteFailure, ...duckdbOwnerWarningsState.recentWarnings]
}
