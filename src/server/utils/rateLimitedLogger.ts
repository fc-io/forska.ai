/**
 * Rate-limited logger utility.
 *
 * Prevents log spam by ensuring the same message key is only logged
 * once per time window. Tracks suppressed log counts and optionally
 * includes them in the next log.
 *
 * Usage:
 *   const logger = createRateLimitedLogger({ windowMs: 30_000 })
 *   logger.log('my-key', 'Something happened') // logs immediately
 *   logger.log('my-key', 'Something happened') // suppressed for 30s
 *   // After 30s...
 *   logger.log('my-key', 'Something happened') // logs with "(+5 suppressed)"
 */

type LogLevel = 'log' | 'warn' | 'error'

type LogEntry = {lastLogTime: number; suppressedCount: number}

type RateLimitedLoggerOptions = {
  /** Time window in milliseconds. Same key won't log more than once per window. Default: 30000 (30s) */
  windowMs?: number
  /** Whether to include suppressed count in the log message. Default: true */
  showSuppressedCount?: boolean
}

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

export const createRateLimitedLogger = (options: RateLimitedLoggerOptions = {}): RateLimitedLogger => {
  const {windowMs = 600_000, showSuppressedCount = true} = options

  const entries = new Map<string, LogEntry>()

  const doLog = (level: LogLevel, key: string, message: string, ...args: unknown[]): void => {
    const now = Date.now()
    const entry = entries.get(key)

    if (entry && now - entry.lastLogTime < windowMs) {
      // Within rate limit window - suppress and count
      entry.suppressedCount += 1
      return
    }

    // Build the log message
    let finalMessage = message
    if (showSuppressedCount && entry && entry.suppressedCount > 0) {
      finalMessage = `${message} (+${entry.suppressedCount} suppressed)`
    }

    // Log it
    console[level](finalMessage, ...args)

    // Update or create entry
    entries.set(key, {lastLogTime: now, suppressedCount: 0})
  }

  const force = (key: string, message: string, level: LogLevel = 'log', ...args: unknown[]): void => {
    console[level](message, ...args)
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

/**
 * Default shared logger instance for common use cases.
 * 10 minute window, shows suppressed counts.
 */
export const rateLimitedLogger = createRateLimitedLogger()
