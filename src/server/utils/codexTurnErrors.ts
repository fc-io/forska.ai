export type CodexTurnErrorEvent = {
  additionalDetails: string | null
  codexErrorInfo: string | null
  httpStatusCode: number | null
  message: string
  willRetry: boolean | null
}

type CodexTurnErrorCarrier = Error & {codexTurnErrorEvents?: unknown}

const codexTurnErrorEventLimit = 8

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const getString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getCodexErrorInfoName = (value: unknown): string | null => {
  return typeof value === 'string' ? getString(value) : isRecord(value) ? (Object.keys(value)[0] ?? null) : null
}

const getCodexErrorInfoHttpStatusCode = (value: unknown): number | null => {
  const name = getCodexErrorInfoName(value)
  const variant = isRecord(value) && name !== null ? value[name] : null

  return isRecord(variant) ? getNumber(variant.httpStatusCode) : null
}

export const getCodexTurnErrorEvent = ({
  error,
  willRetry,
}: {
  error: unknown
  willRetry: boolean | null
}): CodexTurnErrorEvent | null => {
  const message = isRecord(error) ? getString(error.message) : null

  return isRecord(error) && message !== null
    ? {
        additionalDetails: getString(error.additionalDetails),
        codexErrorInfo: getCodexErrorInfoName(error.codexErrorInfo),
        httpStatusCode: getCodexErrorInfoHttpStatusCode(error.codexErrorInfo),
        message,
        willRetry,
      }
    : null
}

export const appendCodexTurnErrorEvent = (
  events: CodexTurnErrorEvent[],
  event: CodexTurnErrorEvent | null,
): CodexTurnErrorEvent[] => {
  return event ? [...events, event].slice(-codexTurnErrorEventLimit) : events
}

export const attachCodexTurnErrorEvents = (error: Error, events: CodexTurnErrorEvent[]): Error => {
  return Object.assign(error, {codexTurnErrorEvents: events})
}

export const getCodexTurnErrorEvents = (error: unknown): CodexTurnErrorEvent[] => {
  const events = error instanceof Error ? (error as CodexTurnErrorCarrier).codexTurnErrorEvents : null

  return Array.isArray(events) ? (events as CodexTurnErrorEvent[]) : []
}
