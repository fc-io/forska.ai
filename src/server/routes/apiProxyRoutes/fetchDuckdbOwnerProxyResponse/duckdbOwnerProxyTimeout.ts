export const getDuckdbOwnerProxyTimeoutResponse = (timeoutMs: number) => {
  return Response.json({data: null, error: `DuckDB owner proxy target timed out after ${timeoutMs} ms`}, {status: 504})
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
    dispose: () => {
      clearTimeout(fallbackTimeout)
      nativeTimeoutSignal.removeEventListener('abort', abortFromNativeSignal)
    },
    signal: controller.signal,
  }
}

export const keepDuckdbOwnerProxyTimeoutUntilBodySettles = (
  response: Response,
  timeout: ReturnType<typeof createDuckdbOwnerProxyTimeout>,
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
          settle()
          controller.error(error)
        }
      },
    },
    {highWaterMark: 0},
  )

  return new Response(body, {headers: response.headers, status: response.status, statusText: response.statusText})
}
