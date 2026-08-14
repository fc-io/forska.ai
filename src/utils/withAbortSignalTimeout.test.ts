import {afterEach, expect, mock, test} from 'bun:test'

import {withAbortSignalTimeout} from './withAbortSignalTimeout.ts'

const originalTimeout = AbortSignal.timeout.bind(AbortSignal)

afterEach(() => {
  Object.defineProperty(AbortSignal, 'timeout', {configurable: true, value: originalTimeout})
})

const installNeverAbortingNativeTimeout = () => {
  const timeout = mock(() => {
    return new AbortController().signal
  })

  Object.defineProperty(AbortSignal, 'timeout', {configurable: true, value: timeout})
  return timeout
}

test.serial('aborts through the fallback timer when the native timeout signal does not fire', async () => {
  const timeout = installNeverAbortingNativeTimeout()
  const error = await withAbortSignalTimeout(10, async (signal) => {
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason)
        },
        {once: true},
      )
    })
  }).catch((caughtError: unknown) => {
    return caughtError
  })

  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('TimeoutError')
  expect(timeout).toHaveBeenCalledWith(10)
})

test.serial('forwards the native timeout reason', async () => {
  const nativeTimeoutController = new AbortController()
  const timeoutReason = new DOMException('native timeout', 'TimeoutError')
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: mock(() => {
      return nativeTimeoutController.signal
    }),
  })
  const result = withAbortSignalTimeout(1_000, async (signal) => {
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason)
        },
        {once: true},
      )
    })
  })

  nativeTimeoutController.abort(timeoutReason)

  expect(
    await result.catch((error: unknown) => {
      return error
    }),
  ).toBe(timeoutReason)
})

test.serial('clears the fallback timer after the operation settles', async () => {
  installNeverAbortingNativeTimeout()
  const state: {operationSignal?: AbortSignal} = {}

  await withAbortSignalTimeout(10, async (signal) => {
    state.operationSignal = signal
    return undefined
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 25)
  })

  expect(state.operationSignal?.aborted).toBe(false)
})
