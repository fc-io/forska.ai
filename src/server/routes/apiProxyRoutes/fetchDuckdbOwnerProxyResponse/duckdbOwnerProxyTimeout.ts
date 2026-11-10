import type {DuckdbOwnerProxyClientConnection} from '../duckdbOwnerProxyRequestTemplate.ts'

export const getDuckdbOwnerProxyTimeoutResponse = (timeoutMs: number) => {
  return Response.json({data: null, error: `DuckDB owner proxy target timed out after ${timeoutMs} ms`}, {status: 504})
}

export const getDuckdbOwnerProxyBodyIdleTimeoutMessage = (idleTimeoutMs: number) => {
  return `DuckDB owner proxy response stalled: no body data for ${idleTimeoutMs} ms`
}

export const createDuckdbOwnerProxyTimeout = (timeoutMs: number) => {
  const nativeTimeoutSignal = AbortSignal.timeout(timeoutMs)
  const controller = new AbortController()
  const abortFromNativeSignal = () => {
    controller.abort(nativeTimeoutSignal.reason)
  }
  const fallbackTimeout = setTimeout(() => {
    controller.abort(new Error(`DuckDB owner proxy target timed out after ${timeoutMs} ms`))
  }, timeoutMs)

  nativeTimeoutSignal.addEventListener('abort', abortFromNativeSignal, {once: true})

  return {
    /** Aborts the owner request now, whether or not the timer has been disposed. */
    abort: (reason: Error) => {
      controller.abort(reason)
    },
    dispose: () => {
      clearTimeout(fallbackTimeout)
      nativeTimeoutSignal.removeEventListener('abort', abortFromNativeSignal)
    },
    signal: controller.signal,
  }
}

export type DuckdbOwnerProxyTimeout = ReturnType<typeof createDuckdbOwnerProxyTimeout>

/** Default routes: the headers timer keeps running and aborts the body if the whole response is not done in time. */
export const keepDuckdbOwnerProxyTimeoutUntilBodySettles = (
  response: Response,
  timeout: DuckdbOwnerProxyTimeout,
  onBodyTimeout: () => void = () => {},
) => {
  const sourceBody = response.body

  if (sourceBody === null) {
    timeout.dispose()
    return response
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let settled = false
  const getReader = () => {
    reader ??= sourceBody.getReader()
    return reader
  }
  const settle = () => {
    if (settled) {
      return
    }

    settled = true
    timeout.dispose()
    reader?.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        try {
          await (reader === null ? sourceBody.cancel(reason) : reader.cancel(reason))
        } finally {
          settle()
        }
      },
      async pull(controller) {
        try {
          const result = await getReader().read()

          if (result.done) {
            settle()
            controller.close()
            return
          }

          controller.enqueue(result.value)
        } catch (error) {
          if (timeout.signal.aborted) {
            onBodyTimeout()
          }

          settle()
          controller.error(error)
        }
      },
    },
    {highWaterMark: 0},
  )

  return new Response(body, {headers: response.headers, status: response.status, statusText: response.statusText})
}

/**
 * Long-download routes: headers have arrived, so the headers budget no longer applies. The body is aborted only when
 * the owner sends nothing for `idleTimeoutMs` while the proxy is waiting on it. The idle clock runs only during a
 * pending read from the owner, so a slow client does not count as an owner stall.
 *
 * When the body fails (stall or owner error) and the client connection is known, the client socket is dropped without
 * a clean end, because Bun would otherwise end the chunked response normally and a truncated file would look complete.
 */
export const keepDuckdbOwnerProxyBodyWhileChunksArrive = (
  response: Response,
  timeout: DuckdbOwnerProxyTimeout,
  {
    clientConnection,
    idleTimeoutMs,
    onBodyIdleTimeout = () => {},
  }: {clientConnection?: DuckdbOwnerProxyClientConnection; idleTimeoutMs: number; onBodyIdleTimeout?: () => void},
) => {
  timeout.dispose()

  const sourceBody = response.body

  if (sourceBody === null) {
    return response
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let settled = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleError: Error | null = null
  const getReader = () => {
    reader ??= sourceBody.getReader()
    return reader
  }
  const clearIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdleTimer = () => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = null
      idleError = new Error(getDuckdbOwnerProxyBodyIdleTimeoutMessage(idleTimeoutMs))
      onBodyIdleTimeout()
      timeout.abort(idleError)
      // A cancelled reader resolves the pending read as done. pull() checks idleError so that truncation is reported
      // as a failure and never as a clean end of the download.
      void reader?.cancel(idleError).catch(() => {})
    }, idleTimeoutMs)
  }
  const settle = () => {
    if (settled) {
      return
    }

    settled = true
    clearIdleTimer()
    reader?.releaseLock()
  }
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    settle()

    if (clientConnection === undefined) {
      controller.error(error)
      return
    }

    clientConnection.dropWithoutCleanEnd()
    // Keep the stream open until Bun drops the socket and cancels it. Closing or erroring it would end the response
    // cleanly.
    return new Promise<void>(() => {})
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        if (settled) {
          return
        }

        try {
          await (reader === null ? sourceBody.cancel(reason) : reader.cancel(reason))
        } finally {
          settle()
        }
      },
      async pull(controller) {
        armIdleTimer()

        try {
          const result = await getReader().read()

          clearIdleTimer()

          if (idleError !== null) {
            return fail(controller, idleError)
          }

          if (result.done) {
            settle()
            controller.close()
            return
          }

          controller.enqueue(result.value)
        } catch (error) {
          clearIdleTimer()
          return fail(controller, idleError ?? error)
        }
      },
    },
    {highWaterMark: 0},
  )

  return new Response(body, {headers: response.headers, status: response.status, statusText: response.statusText})
}
