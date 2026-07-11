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
  isProjectTransferStreamingUploadPath,
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

type DuckdbOwnerStreamingProxyRequestTemplate = {
  body: ReadableStream<Uint8Array> | null
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

const duckdbOwnerProxyRetryDelayMs = 250
const duckdbOwnerProxyRetryTimeoutMs = 4000
const duckdbOwnerProxyRetryableMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])
const duckdbOwnerProxyHopByHopResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

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

const getDuckdbOwnerProxyHeaders = (request: Request) => {
  return new Headers({...Object.fromEntries(request.headers.entries()), ...getDuckdbOwnerConnectionProxyHeaders()})
}

const getDuckdbOwnerProxyRequestTemplate = async (
  request: Request,
): Promise<DuckdbOwnerProxyRequestTemplate | null> => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname, request.method)
  const hasRequestBody = request.method !== 'GET' && request.method !== 'HEAD'

  return !shouldApiRouteProxyToDuckdbOwner(classification)
    ? null
    : {
        body: hasRequestBody ? await request.clone().arrayBuffer() : null,
        failClosedWithoutDuckdbOwner: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
        headers: getDuckdbOwnerProxyHeaders(request),
        method: request.method,
        pathname: getDuckdbOwnerProxyPathname({classification, pathname: requestUrl.pathname}),
        search: requestUrl.search,
      }
}

const getDuckdbOwnerStreamingProxyRequestTemplate = (
  request: Request,
): DuckdbOwnerStreamingProxyRequestTemplate | null => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname, request.method)
  const shouldStreamUpload = isProjectTransferStreamingUploadPath(requestUrl.pathname, request.method)

  return !shouldStreamUpload || !shouldApiRouteProxyToDuckdbOwner(classification)
    ? null
    : {
        body: request.body,
        failClosedWithoutDuckdbOwner: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
        headers: getDuckdbOwnerProxyHeaders(request),
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

const getDuckdbOwnerStreamingProxyRequest = (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  return new Request(`${duckdbOwnerUrl}${requestTemplate.pathname}${requestTemplate.search}`, {
    body: requestTemplate.body ?? undefined,
    headers: requestTemplate.headers,
    method: requestTemplate.method,
  })
}

const getIncompatibleDuckdbOwnerTargetResponse = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  return result.status === 'incompatible' ? Response.json({data: null, error: result.message}, {status: 426}) : null
}

const waitForDuckdbOwnerProxyTarget = async (
  duckdbOwnerUrl: string,
  deadlineMs = Date.now() + duckdbOwnerProxyRetryTimeoutMs,
): Promise<Response | null> => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  if (result.status === 'incompatible') {
    return Response.json({data: null, error: result.message}, {status: 426})
  }

  if (result.status === 'compatible') {
    return null
  }

  if (Date.now() >= deadlineMs) {
    return getDuckdbOwnerProxyUnavailableResponse()
  }

  await waitForDuckdbOwnerProxyRetry()
  return waitForDuckdbOwnerProxyTarget(duckdbOwnerUrl, deadlineMs)
}

const fetchDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  return incompatibleTargetResponse ?? fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl))
}

const fetchNonRetryableDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const targetFailureResponse = await waitForDuckdbOwnerProxyTarget(duckdbOwnerUrl)

  return targetFailureResponse ?? fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl))
}

const fetchDuckdbOwnerStreamingProxyResponse = async (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  return incompatibleTargetResponse ?? fetch(getDuckdbOwnerStreamingProxyRequest(requestTemplate, duckdbOwnerUrl))
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

const getDuckdbOwnerProxyFailureResponse = (requestTemplate: {failClosedWithoutDuckdbOwner: boolean}) => {
  return requestTemplate.failClosedWithoutDuckdbOwner ? getDuckdbOwnerProxyUnavailableResponse() : null
}

const getDuckdbOwnerProxyResponseHeaders = (response: Response) => {
  return Array.from(response.headers.entries()).reduce<Headers>((headers, [key, value]) => {
    if (!duckdbOwnerProxyHopByHopResponseHeaders.has(key.toLowerCase())) {
      headers.set(key, value)
    }

    return headers
  }, new Headers())
}

const getDuckdbOwnerProxyResponse = (response: Response) => {
  return new Response(response.body, {
    headers: getDuckdbOwnerProxyResponseHeaders(response),
    status: response.status,
    statusText: response.statusText,
  })
}

const getIncompatibleDuckdbOwnerPeerResponse = (request: Request) => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname, request.method)
  const error = shouldApiRouteProxyToDuckdbOwner(classification)
    ? getDuckdbOwnerConnectionRuntimeVersionError(request.headers)
    : null

  return error === null ? null : Response.json({data: null, error: error.message}, {status: 426})
}

const getDuckdbOwnerProxyTargetFailureResponse = async (requestTemplate: {
  failClosedWithoutDuckdbOwner: boolean
}): Promise<{duckdbOwnerUrl: string} | {response: Response | null}> => {
  const duckdbOwnerUrl = await getCurrentServerDuckdbOwnerUrl()
  if (duckdbOwnerUrl === null) {
    return {response: getDuckdbOwnerProxyFailureResponse(requestTemplate)}
  }

  if (isCurrentServerDuckdbOwnerUrl(duckdbOwnerUrl)) {
    return {
      response: Response.json(
        {data: null, error: `DuckDB owner proxy target must not point to this same API server (${duckdbOwnerUrl})`},
        {status: 500},
      ),
    }
  }

  return {duckdbOwnerUrl}
}

const forwardStreamingApiRequestToDuckdbOwner = async (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
): Promise<Response | null> => {
  const target = await getDuckdbOwnerProxyTargetFailureResponse(requestTemplate)

  if ('response' in target) {
    return target.response
  }

  try {
    return getDuckdbOwnerProxyResponse(
      await fetchDuckdbOwnerStreamingProxyResponse(requestTemplate, target.duckdbOwnerUrl),
    )
  } catch {
    return getDuckdbOwnerProxyFailureResponse(requestTemplate)
  }
}

const forwardBufferedApiRequestToDuckdbOwner = async (request: Request): Promise<Response | null> => {
  const requestTemplate = await getDuckdbOwnerProxyRequestTemplate(request)

  if (requestTemplate === null) {
    return null
  }

  const target = await getDuckdbOwnerProxyTargetFailureResponse(requestTemplate)

  if ('response' in target) {
    return target.response
  }

  const shouldRetryProxyRequest = duckdbOwnerProxyRetryableMethods.has(requestTemplate.method)

  try {
    const response = shouldRetryProxyRequest
      ? await fetchDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)
      : await fetchNonRetryableDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    return getDuckdbOwnerProxyResponse(response)
  } catch {
    if (!shouldRetryProxyRequest) {
      return getDuckdbOwnerProxyFailureResponse(requestTemplate)
    }

    const retriedResponse = await getRetriedProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    return retriedResponse === null
      ? getDuckdbOwnerProxyFailureResponse(requestTemplate)
      : getDuckdbOwnerProxyResponse(retriedResponse)
  }
}

const forwardApiRequestToDuckdbOwner = async (request: Request): Promise<Response | null> => {
  if (!shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  const streamingRequestTemplate = getDuckdbOwnerStreamingProxyRequestTemplate(request)

  return streamingRequestTemplate === null
    ? forwardBufferedApiRequestToDuckdbOwner(request)
    : forwardStreamingApiRequestToDuckdbOwner(streamingRequestTemplate)
}

export const apiProxyRoutes = new Elysia().use(withErrorHandler()).onRequest(async ({request}) => {
  const incompatiblePeerResponse = getIncompatibleDuckdbOwnerPeerResponse(request)

  if (incompatiblePeerResponse !== null) {
    return incompatiblePeerResponse
  }

  return forwardApiRequestToDuckdbOwner(request)
})
