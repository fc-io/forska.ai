import {hostname} from 'node:os'

import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {getCurrentServerWriterUrl, shouldCurrentServerProxyApiToWriter} from '../utils/serverRuntimeRole.ts'
import {getWriterConnectionProxyHeaders} from '../utils/writerConnections.ts'

const getCurrentServerHostAliases = () => {
  const aliases = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::1'])
  const currentHostname = hostname().trim().toLowerCase()

  if (currentHostname !== '') {
    aliases.add(currentHostname)

    if (currentHostname.endsWith('.local')) {
      aliases.add(currentHostname.slice(0, -'.local'.length))
    } else {
      aliases.add(`${currentHostname}.local`)
    }
  }

  return aliases
}

const currentServerHostAliases = getCurrentServerHostAliases()

const isCurrentServerWriterUrl = (writerUrl: string) => {
  const parsedWriterUrl = new URL(writerUrl)
  const isSamePort = parsedWriterUrl.port === String(env.API_SERVER_PORT)
  const normalizedHostname = parsedWriterUrl.hostname.trim().toLowerCase()

  return isSamePort && currentServerHostAliases.has(normalizedHostname)
}

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

const getWriterProxyUnavailableResponse = () => {
  return Response.json({data: null, error: 'Writer proxy target unavailable'}, {status: 502})
}

const forwardApiRequestToWriter = async (request: Request): Promise<Response | null> => {
  if (!shouldCurrentServerProxyApiToWriter()) {
    return null
  }

  const writerUrl = await getCurrentServerWriterUrl()

  if (writerUrl === null) {
    return null
  }

  if (isCurrentServerWriterUrl(writerUrl)) {
    return Response.json(
      {data: null, error: `Writer proxy target must not point to this same API server (${writerUrl})`},
      {status: 500},
    )
  }

  const proxiedRequest = getWriterProxyRequest(request, writerUrl)
  const shouldRetryProxyRequest = request.method === 'GET' || request.method === 'HEAD'

  if (proxiedRequest === null) {
    return null
  }

  try {
    return await fetch(proxiedRequest)
  } catch {
    if (!shouldRetryProxyRequest) {
      return getWriterProxyUnavailableResponse()
    }

    return (await getRetriedProxyResponse(request, writerUrl)) ?? getWriterProxyUnavailableResponse()
  }
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  return forwardApiRequestToWriter(request)
})
