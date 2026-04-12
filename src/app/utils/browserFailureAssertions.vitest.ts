import {describe, expect, test} from 'vitest'

import {createBrowserFailureAssertions} from './browserFailureAssertions'

type MockBrowserConsoleMessage = {text: () => string; type: () => string}

type MockBrowserPage = {
  emitConsole: (message: MockBrowserConsoleMessage) => void
  emitPageError: (error: Error) => void
  off: (
    event: 'console' | 'pageerror',
    handler: ((message: MockBrowserConsoleMessage) => void) | ((error: Error) => void),
  ) => void
  on: (
    event: 'console' | 'pageerror',
    handler: ((message: MockBrowserConsoleMessage) => void) | ((error: Error) => void),
  ) => void
}

const createMockBrowserPage = (): MockBrowserPage => {
  const consoleHandlers = new Set<(message: MockBrowserConsoleMessage) => void>()
  const pageErrorHandlers = new Set<(error: Error) => void>()

  return {
    emitConsole: (message) => {
      consoleHandlers.forEach((handler) => {
        handler(message)
      })
    },
    emitPageError: (error) => {
      pageErrorHandlers.forEach((handler) => {
        handler(error)
      })
    },
    off: (event, handler) => {
      if (event === 'console') {
        consoleHandlers.delete(handler as (message: MockBrowserConsoleMessage) => void)
        return
      }

      pageErrorHandlers.delete(handler as (error: Error) => void)
    },
    on: (event, handler) => {
      if (event === 'console') {
        consoleHandlers.add(handler as (message: MockBrowserConsoleMessage) => void)
        return
      }

      pageErrorHandlers.add(handler as (error: Error) => void)
    },
  }
}

describe('createBrowserFailureAssertions', () => {
  test('fails for pageerror, console.error, and defaultQueryOptions console text', () => {
    const page = createMockBrowserPage()
    const browserFailures = createBrowserFailureAssertions(page)

    page.emitPageError(new Error('Route exploded'))
    page.emitConsole({
      text: () => {
        return 'visible console error'
      },
      type: () => {
        return 'error'
      },
    })
    page.emitConsole({
      text: () => {
        return 'Cannot read properties of undefined (reading defaultQueryOptions)'
      },
      type: () => {
        return 'warning'
      },
    })

    expect(() => {
      browserFailures.assertNoFailures()
    }).toThrowError(/pageerror|console\.error|defaultQueryOptions/)

    browserFailures.dispose()
  })
})
