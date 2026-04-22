import {hostname} from 'node:os'

import {Elysia} from 'elysia'

import {
  getDuckdbOwnerConnectionProxyHeaders,
  getDuckdbOwnerConnectionRuntimeVersionError,
} from '../utils/duckdbOwnerConnections.ts'
import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {probeDuckdbOwnerCutoverCompatibility} from '../utils/runtimeCutover.ts'
import {getCurrentServerDuckdbOwnerUrl, shouldCurrentServerProxyApiToOwner} from '../utils/serverRuntimeRole.ts'
import {
  classifyApiRoute,
  getDuckdbOwnerProxyPathname,
  shouldApiRouteFailClosedWithoutDuckdbOwner,
  shouldApiRouteProxyToDuckdbOwner,
} from './apiRouteClassification.ts'

type DuckdbOwnerProxyRequestTemplate = {
  body: ArrayBuffer | null
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

const duckdbOwnerProxyRetryDelayMs = 250
const duckdbOwnerProxyRetryTimeoutMs = 4000
const duckdbOwnerProxyRetryableMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])

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

const isCurrentServerDuckdbOwnerUrl = (duckdbOwnerUrl: string) => {
  const parsedDuckdbOwnerUrl = new URL(duckdbOwnerUrl)
  const isSamePort = parsedDuckdbOwnerUrl.port === String(env.API_SERVER_PORT)
  const normalizedHostname = parsedDuckdbOwnerUrl.hostname.trim().toLowerCase()

  return isSamePort && currentServerHostAliases.has(normalizedHostname)
}

const waitForDuckdbOwnerProxyRetry = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, duckdbOwnerProxyRetryDelayMs)
  })
}

const getDuckdbOwnerProxyRequestTemplate = async (
  request: Request,
): Promise<DuckdbOwnerProxyRequestTemplate | null> => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname)
  const requestHeaders = new Headers({
    ...Object.fromEntries(request.headers.entries()),
    ...getDuckdbOwnerConnectionProxyHeaders(),
  })
  const hasRequestBody = request.method !== 'GET' && request.method !== 'HEAD'

  return !shouldApiRouteProxyToDuckdbOwner(classification)
    ? null
    : {
        body: hasRequestBody ? await request.clone().arrayBuffer() : null,
        failClosedWithoutDuckdbOwner: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
        headers: requestHeaders,
        method: request.method,
        pathname: getDuckdbOwnerProxyPathname({classification, pathname: requestUrl.pathname}),
        search: requestUrl.search,
      }
}

const getDuckdbOwnerProxyRequest = (requestTemplate: DuckdbOwnerProxyRequestTemplate, duckdbOwnerUrl: string) => {
  return new Request(`${duckdbOwnerUrl}${requestTemplate.pathname}${requestTemplate.search}`, {
    body: requestTemplate.body === null ? undefined : requestTemplate.body.slice(0),
    headers: requestTemplate.headers,
    method: requestTemplate.method,
  })
}

const getIncompatibleDuckdbOwnerTargetResponse = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  return result.status === 'incompatible' ? Response.json({data: null, error: result.message}, {status: 426}) : null
}

const fetchDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  return incompatibleTargetResponse ?? fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl))
}

const getRetriedProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  currentDuckdbOwnerUrl: string,
) => {
  const deadlineMs = Date.now() + duckdbOwnerProxyRetryTimeoutMs

  while (Date.now() < deadlineMs) {
    await waitForDuckdbOwnerProxyRetry()

    try {
      const nextDuckdbOwnerUrl = (await getCurrentServerDuckdbOwnerUrl()) ?? currentDuckdbOwnerUrl
      return await fetchDuckdbOwnerProxyResponse(requestTemplate, nextDuckdbOwnerUrl)
    } catch {
      continue
    }
  }

  return null
}

const getDuckdbOwnerProxyUnavailableResponse = () => {
  return Response.json({data: null, error: 'DuckDB owner proxy target unavailable'}, {status: 502})
}

const getDuckdbOwnerProxyFailureResponse = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return requestTemplate.failClosedWithoutDuckdbOwner ? getDuckdbOwnerProxyUnavailableResponse() : null
}

const getIncompatibleDuckdbOwnerPeerResponse = (request: Request) => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname)
  const error = shouldApiRouteProxyToDuckdbOwner(classification)
    ? getDuckdbOwnerConnectionRuntimeVersionError(request.headers)
    : null

  return error === null ? null : Response.json({data: null, error: error.message}, {status: 426})
}

const forwardApiRequestToDuckdbOwner = async (request: Request): Promise<Response | null> => {
  if (!shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  const requestTemplate = await getDuckdbOwnerProxyRequestTemplate(request)

  if (requestTemplate === null) {
    return null
  }

  const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()
  if (duckdbOwnerUrl === null) {
    return requestTemplate.failClosedWithoutDuckdbOwner ? getDuckdbOwnerProxyUnavailableResponse() : null
  }

  if (isCurrentServerDuckdbOwnerUrl(duckdbOwnerUrl)) {
    return Response.json(
      {data: null, error: `DuckDB owner proxy target must not point to this same API server (${duckdbOwnerUrl})`},
      {status: 500},
    )
  }

  const shouldRetryProxyRequest = duckdbOwnerProxyRetryableMethods.has(requestTemplate.method)

  try {
    return await fetchDuckdbOwnerProxyResponse(requestTemplate, duckdbOwnerUrl)
  } catch {
    if (!shouldRetryProxyRequest) {
      return getDuckdbOwnerProxyFailureResponse(requestTemplate)
    }

    return (
      (await getRetriedProxyResponse(requestTemplate, duckdbOwnerUrl))
      ?? getDuckdbOwnerProxyFailureResponse(requestTemplate)
    )
  }
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  const incompatiblePeerResponse = getIncompatibleDuckdbOwnerPeerResponse(request)

  if (incompatiblePeerResponse !== null) {
    return incompatiblePeerResponse
  }

  return forwardApiRequestToDuckdbOwner(request)
})
