const getFallbackTimeoutReason = (timeoutMs: number) => {
  return new DOMException(`The operation timed out after ${timeoutMs} ms`, 'TimeoutError')
}

export const withAbortSignalTimeout = async <T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const nativeTimeoutSignal = AbortSignal.timeout(timeoutMs)
  const controller = new AbortController()
  const abortFromNativeTimeout = () => {
    controller.abort(nativeTimeoutSignal.reason)
  }
  const fallbackTimeout = setTimeout(() => {
    controller.abort(getFallbackTimeoutReason(timeoutMs))
  }, timeoutMs)

  nativeTimeoutSignal.addEventListener('abort', abortFromNativeTimeout, {once: true})

  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(fallbackTimeout)
    nativeTimeoutSignal.removeEventListener('abort', abortFromNativeTimeout)
  }
}
