type WriterWarningKind = 'unresponsive-writer' | 'write-failure' | 'writer-disabled'
type WriterWarningSeverity = 'warning' | 'error'

type WriterWarningsState = {currentWriteFailure: WriterWarning | null; recentWarnings: WriterWarning[]}

export type WriterWarning = {at: string; kind: WriterWarningKind; message: string; severity: WriterWarningSeverity}

declare global {
  var __forskaWriterWarningsState: WriterWarningsState | undefined
}

const writerWarningRetentionMs = 15 * 60_000

const getWriterWarningsState = () => {
  globalThis.__forskaWriterWarningsState ??= {currentWriteFailure: null, recentWarnings: []}

  return globalThis.__forskaWriterWarningsState
}

const writerWarningsState = getWriterWarningsState()

const getWriterWarningMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : String(error)
}

const getNextWriterWarning = (params: {kind: WriterWarningKind; message: string; severity: WriterWarningSeverity}) => {
  return {
    at: new Date().toISOString(),
    kind: params.kind,
    message: params.message,
    severity: params.severity,
  } satisfies WriterWarning
}

const pruneWriterWarnings = (nowMs: number) => {
  writerWarningsState.recentWarnings = writerWarningsState.recentWarnings.filter((warning) => {
    return nowMs - new Date(warning.at).getTime() <= writerWarningRetentionMs
  })
}

const upsertRecentWriterWarning = (nextWarning: WriterWarning) => {
  const previousWarning = writerWarningsState.recentWarnings[0]
  const isDuplicate =
    previousWarning?.kind === nextWarning.kind
    && previousWarning.message === nextWarning.message
    && Date.now() - new Date(previousWarning.at).getTime() < 5_000

  writerWarningsState.recentWarnings = isDuplicate
    ? writerWarningsState.recentWarnings
    : [nextWarning, ...writerWarningsState.recentWarnings]
}

export const recordUnresponsiveWriterWarning = (params: {message: string}) => {
  const nowMs = Date.now()

  pruneWriterWarnings(nowMs)
  upsertRecentWriterWarning(
    getNextWriterWarning({kind: 'unresponsive-writer', message: params.message, severity: 'warning'}),
  )
}

export const recordWriterWriteFailure = (params: {action: string; error: unknown}) => {
  writerWarningsState.currentWriteFailure = getNextWriterWarning({
    kind: 'write-failure',
    message: `${params.action} failed: ${getWriterWarningMessage(params.error)}`,
    severity: 'error',
  })
}

export const clearWriterWriteFailure = () => {
  writerWarningsState.currentWriteFailure = null
}

export const clearUnresponsiveWriterWarnings = () => {
  writerWarningsState.recentWarnings = writerWarningsState.recentWarnings.filter((warning) => {
    return warning.kind !== 'unresponsive-writer'
  })
}

export const getWriterWarnings = () => {
  const nowMs = Date.now()

  pruneWriterWarnings(nowMs)

  return writerWarningsState.currentWriteFailure === null
    ? writerWarningsState.recentWarnings
    : [writerWarningsState.currentWriteFailure, ...writerWarningsState.recentWarnings]
}
