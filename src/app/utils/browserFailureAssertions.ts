type BrowserFailure = {message: string; source: string}

type BrowserConsoleMessage = {text: () => string; type: () => string}

type BrowserPage = {
  off?: {
    (event: 'console', handler: (message: BrowserConsoleMessage) => void): void
    (event: 'pageerror', handler: (error: Error) => void): void
  }
  on: {
    (event: 'console', handler: (message: BrowserConsoleMessage) => void): void
    (event: 'pageerror', handler: (error: Error) => void): void
  }
}

type BrowserFailureAssertions = {assertNoFailures: () => void; dispose: () => void}

const browserConsoleMethods = ['debug', 'error', 'info', 'log', 'warn'] as const

const normalizeBrowserFailurePart = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? value.message
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (typeof value === 'symbol') {
    return value.toString()
  }

  return 'undefined'
}

const normalizeBrowserFailureMessage = (value: unknown): string => {
  return normalizeBrowserFailurePart(value).trim()
}

const normalizeBrowserConsoleText = (values: unknown[]): string => {
  return values.map(normalizeBrowserFailurePart).join(' ').trim()
}

const isDefaultQueryOptionsFailure = (text: string): boolean => {
  return text.includes('defaultQueryOptions')
}

const buildBrowserFailureMessage = (failures: BrowserFailure[]): string => {
  return failures
    .map((failure, index) => {
      return `${String(index + 1)}. [${failure.source}] ${failure.message}`
    })
    .join('\n')
}

const recordBrowserFailure = (failures: BrowserFailure[], source: string, message: string) => {
  failures.push({message, source})
}

const createWindowBrowserFailureAssertions = (targetWindow: Window): BrowserFailureAssertions => {
  const failures: BrowserFailure[] = []
  const consoleObject = globalThis.console
  const originalConsoleMethods = browserConsoleMethods.reduce<Record<string, (...args: unknown[]) => void>>(
    (acc, method) => {
      acc[method] = consoleObject[method].bind(consoleObject)
      return acc
    },
    {},
  )

  const onError = (event: ErrorEvent) => {
    const message = normalizeBrowserFailureMessage(event.error ?? event.message)
    recordBrowserFailure(failures, 'pageerror', message)
  }

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const message = normalizeBrowserFailureMessage(event.reason)
    recordBrowserFailure(failures, 'pageerror', message)
  }

  browserConsoleMethods.forEach((method) => {
    const originalMethod = originalConsoleMethods[method]

    consoleObject[method] = ((...args: unknown[]) => {
      const text = normalizeBrowserConsoleText(args)

      if (method === 'error') {
        recordBrowserFailure(failures, 'console.error', text)
      }

      if (isDefaultQueryOptionsFailure(text)) {
        recordBrowserFailure(failures, `console.${method}`, text)
      }

      originalMethod(...args)
    }) as Console[typeof method]
  })

  targetWindow.addEventListener('error', onError)
  targetWindow.addEventListener('unhandledrejection', onUnhandledRejection)

  return {
    assertNoFailures: () => {
      if (failures.length === 0) {
        return
      }

      throw new Error(buildBrowserFailureMessage(failures))
    },
    dispose: () => {
      targetWindow.removeEventListener('error', onError)
      targetWindow.removeEventListener('unhandledrejection', onUnhandledRejection)
      browserConsoleMethods.forEach((method) => {
        consoleObject[method] = originalConsoleMethods[method] as Console[typeof method]
      })
    },
  }
}

const createPageBrowserFailureAssertions = (page: BrowserPage): BrowserFailureAssertions => {
  const failures: BrowserFailure[] = []

  const onPageError = (error: Error) => {
    const message = normalizeBrowserFailureMessage(error)
    recordBrowserFailure(failures, 'pageerror', message)
  }

  const onConsole = (message: BrowserConsoleMessage) => {
    const text = normalizeBrowserFailureMessage(message.text())

    if (message.type() === 'error') {
      recordBrowserFailure(failures, 'console.error', text)
    }

    if (isDefaultQueryOptionsFailure(text)) {
      recordBrowserFailure(failures, `console.${message.type()}`, text)
    }
  }

  page.on('pageerror', onPageError)
  page.on('console', onConsole)

  return {
    assertNoFailures: () => {
      if (failures.length === 0) {
        return
      }

      throw new Error(buildBrowserFailureMessage(failures))
    },
    dispose: () => {
      page.off?.('pageerror', onPageError)
      page.off?.('console', onConsole)
    },
  }
}

const isBrowserPage = (target: BrowserPage | Window): target is BrowserPage => {
  return !('document' in target)
}

export const createBrowserFailureAssertions = (target: BrowserPage | Window): BrowserFailureAssertions => {
  return isBrowserPage(target)
    ? createPageBrowserFailureAssertions(target)
    : createWindowBrowserFailureAssertions(target)
}
