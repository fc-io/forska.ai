const SAFE_CONSOLE_LOGGING_INSTALLED = Symbol.for('forska.safeConsoleLoggingInstalled')

type ConsoleMethodName = 'debug' | 'error' | 'info' | 'log' | 'warn'

const safeSerializeConsoleArg = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }

  try {
    return JSON.stringify(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({error: `failed to serialize console argument: ${message}`})
  }
}

export const installSafeConsoleLogging = (): void => {
  const globalState = globalThis as typeof globalThis & {[SAFE_CONSOLE_LOGGING_INSTALLED]?: boolean}
  if (globalState[SAFE_CONSOLE_LOGGING_INSTALLED]) {
    return
  }

  ;(['debug', 'error', 'info', 'log', 'warn'] as const).forEach((methodName: ConsoleMethodName) => {
    const originalMethod = console[methodName].bind(console)
    console[methodName] = ((...args: unknown[]) => {
      originalMethod(
        ...args.map((arg) => {
          return safeSerializeConsoleArg(arg)
        }),
      )
    }) as Console[ConsoleMethodName]
  })

  globalState[SAFE_CONSOLE_LOGGING_INSTALLED] = true
}
