import {safeSerializeConsoleArgs} from './installSafeConsoleLogging.ts'
import {getRuntimeLogProfile, isRuntimeJsonlSinkInstalled, writeRuntimeLogEvent} from './runtimeLogger.ts'

type LogLevel = 'log' | 'warn' | 'error'
export type RateLimitedLogSink = 'both' | 'file-only' | 'remove-or-dev-only' | 'terminal-only'
type RateLimitedLogSeverity = 'ERROR' | 'INFO' | 'WARN'

type LogEntry = {lastLogTime: number; suppressedCount: number}

type RateLimitedLoggerOptions = {sink?: RateLimitedLogSink; windowMs?: number; showSuppressedCount?: boolean}

type RateLimitedLogger = {
  /** Log at 'log' level with rate limiting */
  log: (key: string, message: string, ...args: unknown[]) => void
  /** Log at 'warn' level with rate limiting */
  warn: (key: string, message: string, ...args: unknown[]) => void
  /** Log at 'error' level with rate limiting */
  error: (key: string, message: string, ...args: unknown[]) => void
  /** Force a log regardless of rate limit (and reset the timer) */
  force: (key: string, message: string, level?: LogLevel, ...args: unknown[]) => void
  /** Clear rate limit state for a specific key (useful when state resets) */
  reset: (key: string) => void
  /** Clear all rate limit state */
  resetAll: () => void
}

const normalizeLogArgs = (args: unknown[]): string[] => {
  return safeSerializeConsoleArgs(args)
}

const getRuntimeLogSeverity = (level: LogLevel): RateLimitedLogSeverity => {
  const severities: Record<LogLevel, RateLimitedLogSeverity> = {error: 'ERROR', log: 'INFO', warn: 'WARN'}

  return severities[level]
}

const shouldWriteTerminalLog = ({sink}: {sink: RateLimitedLogSink}) => {
  return (
    sink === 'terminal-only'
    || sink === 'both'
    || (sink === 'remove-or-dev-only' && getRuntimeLogProfile() === 'local')
    || (sink === 'file-only' && !isRuntimeJsonlSinkInstalled())
  )
}

const writeTerminalLog = ({args, level, message}: {args: unknown[]; level: LogLevel; message: string}) => {
  console[level](message, ...normalizeLogArgs(args))
}

const writeFileLog = ({
  args,
  key,
  level,
  message,
  sink,
}: {
  args: unknown[]
  key: string
  level: LogLevel
  message: string
  sink: RateLimitedLogSink
}) => {
  return sink === 'file-only' || sink === 'both'
    ? writeRuntimeLogEvent({
        attrs: {args: normalizeLogArgs(args)},
        event: key,
        message,
        severity: getRuntimeLogSeverity(level),
      })
    : false
}

const writeRoutedLog = ({
  args,
  key,
  level,
  message,
  sink,
}: {
  args: unknown[]
  key: string
  level: LogLevel
  message: string
  sink: RateLimitedLogSink
}) => {
  writeFileLog({args, key, level, message, sink})

  if (shouldWriteTerminalLog({sink})) {
    writeTerminalLog({args, level, message})
  }
}

export const createRateLimitedLogger = (options: RateLimitedLoggerOptions = {}): RateLimitedLogger => {
  const {sink = 'terminal-only', windowMs = 600_000, showSuppressedCount = true} = options

  const entries = new Map<string, LogEntry>()

  const doLog = (level: LogLevel, key: string, message: string, ...args: unknown[]): void => {
    const now = Date.now()
    const entry = entries.get(key)

    if (entry && now - entry.lastLogTime < windowMs) {
      // Within rate limit window - suppress and count
      entry.suppressedCount += 1
      return
    }

    const finalMessage =
      showSuppressedCount && entry && entry.suppressedCount > 0
        ? `${message} (+${entry.suppressedCount} suppressed)`
        : message

    writeRoutedLog({args, key, level, message: finalMessage, sink})
    entries.set(key, {lastLogTime: now, suppressedCount: 0})
  }

  const force = (key: string, message: string, level: LogLevel = 'log', ...args: unknown[]): void => {
    writeRoutedLog({args, key, level, message, sink})
    entries.set(key, {lastLogTime: Date.now(), suppressedCount: 0})
  }

  const reset = (key: string): void => {
    entries.delete(key)
  }

  const resetAll = (): void => {
    entries.clear()
  }

  return {
    log: (key, message, ...args) => {
      return doLog('log', key, message, ...args)
    },
    warn: (key, message, ...args) => {
      return doLog('warn', key, message, ...args)
    },
    error: (key, message, ...args) => {
      return doLog('error', key, message, ...args)
    },
    force,
    reset,
    resetAll,
  }
}

export const rateLimitedLogger = createRateLimitedLogger()
