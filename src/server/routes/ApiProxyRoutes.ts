import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {getCurrentServerWriterUrl, shouldCurrentServerProxyApiToWriter} from '../utils/serverRuntimeRole.ts'
import {getWriterConnectionProxyHeaders} from '../utils/writerConnections.ts'

const localWriterOrigins = new Set([
  `http://127.0.0.1:${env.API_SERVER_PORT}`,
  `http://localhost:${env.API_SERVER_PORT}`,
])

const getWriterProxyRequest = (request: Request, writerUrl: string) => {
  const requestUrl = new URL(request.url)
  const requestHeaders = new Headers({
    ...Object.fromEntries(request.headers.entries()),
    ...getWriterConnectionProxyHeaders(),
  })
  const hasRequestBody = request.method !== 'GET' && request.method !== 'HEAD'

  return requestUrl.pathname.startsWith('/api/')
    ? new Request(`${writerUrl}${requestUrl.pathname}${requestUrl.search}`, {
        body: hasRequestBody ? request.body : undefined,
        headers: requestHeaders,
        method: request.method,
      })
    : null
}

const getRetriedProxyResponse = async (request: Request, currentWriterUrl: string) => {
  const nextWriterUrl = await getCurrentServerWriterUrl()

  if (nextWriterUrl === null) {
    return null
  }

  if (nextWriterUrl === currentWriterUrl) {
    throw new Error('Writer proxy target unavailable after retry')
  }

  const retriedRequest = getWriterProxyRequest(request, nextWriterUrl)
  return retriedRequest === null ? null : fetch(retriedRequest)
}

const forwardApiRequestToWriter = async (request: Request): Promise<Response | null> => {
  if (!shouldCurrentServerProxyApiToWriter()) {
    return null
  }

  const writerUrl = await getCurrentServerWriterUrl()

  if (writerUrl === null) {
    return null
  }

  if (localWriterOrigins.has(new URL(writerUrl).origin)) {
    throw new Error(`Writer proxy target must not point to this same API server (${writerUrl})`)
  }

  const proxiedRequest = getWriterProxyRequest(request, writerUrl)
  const retryRequest = request.method === 'GET' || request.method === 'HEAD' ? request : request.clone()

  if (proxiedRequest === null) {
    return null
  }

  try {
    return await fetch(proxiedRequest)
  } catch {
    return getRetriedProxyResponse(retryRequest, writerUrl)
  }
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  return forwardApiRequestToWriter(request)
})
