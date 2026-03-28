import {hostname} from 'node:os'

import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {getCurrentServerWriterUrl, shouldCurrentServerProxyApiToWriter} from '../utils/serverRuntimeRole.ts'
import {getWriterConnectionProxyHeaders} from '../utils/writerConnections.ts'

type WriterProxyRequestTemplate = {
  body: ArrayBuffer | null
  headers: Headers
  method: string
  pathname: string
  search: string
}

const writerProxyRetryDelayMs = 250
const writerProxyRetryTimeoutMs = 4000
const writerProxyRetryableMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])

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

const waitForWriterProxyRetry = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, writerProxyRetryDelayMs)
  })
}

const getWriterProxyRequestTemplate = async (request: Request): Promise<WriterProxyRequestTemplate | null> => {
  const requestUrl = new URL(request.url)
  const requestHeaders = new Headers({
    ...Object.fromEntries(request.headers.entries()),
    ...getWriterConnectionProxyHeaders(),
  })
  const hasRequestBody = request.method !== 'GET' && request.method !== 'HEAD'

  return !requestUrl.pathname.startsWith('/api/')
    ? null
    : {
        body: hasRequestBody ? await request.clone().arrayBuffer() : null,
        headers: requestHeaders,
        method: request.method,
        pathname: requestUrl.pathname,
        search: requestUrl.search,
      }
}

const getWriterProxyRequest = (requestTemplate: WriterProxyRequestTemplate, writerUrl: string) => {
  return new Request(`${writerUrl}${requestTemplate.pathname}${requestTemplate.search}`, {
    body: requestTemplate.body === null ? undefined : requestTemplate.body.slice(0),
    headers: requestTemplate.headers,
    method: requestTemplate.method,
  })
}

const fetchWriterProxyResponse = async (requestTemplate: WriterProxyRequestTemplate, writerUrl: string) => {
  return fetch(getWriterProxyRequest(requestTemplate, writerUrl))
}

const getRetriedProxyResponse = async (requestTemplate: WriterProxyRequestTemplate, currentWriterUrl: string) => {
  const deadlineMs = Date.now() + writerProxyRetryTimeoutMs

  while (Date.now() < deadlineMs) {
    await waitForWriterProxyRetry()

    try {
      const nextWriterUrl = (await getCurrentServerWriterUrl()) ?? currentWriterUrl
      return await fetchWriterProxyResponse(requestTemplate, nextWriterUrl)
    } catch {
      continue
    }
  }

  return null
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

  const requestTemplate = await getWriterProxyRequestTemplate(request)

  if (isCurrentServerWriterUrl(writerUrl)) {
    return Response.json(
      {data: null, error: `Writer proxy target must not point to this same API server (${writerUrl})`},
      {status: 500},
    )
  }

  if (requestTemplate === null) {
    return null
  }

  const shouldRetryProxyRequest = writerProxyRetryableMethods.has(requestTemplate.method)

  try {
    return await fetchWriterProxyResponse(requestTemplate, writerUrl)
  } catch {
    if (!shouldRetryProxyRequest) {
      return getWriterProxyUnavailableResponse()
    }

    return (await getRetriedProxyResponse(requestTemplate, writerUrl)) ?? getWriterProxyUnavailableResponse()
  }
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  return forwardApiRequestToWriter(request)
})
