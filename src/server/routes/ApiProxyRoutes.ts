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
  type ApiRouteClassification,
  classifyApiRoute,
  duckdbOwnerPrivateApiPrefix,
  getDuckdbOwnerProxyPathname,
  isProjectTransferStreamingUploadPath,
  shouldApiRouteFailClosedWithoutDuckdbOwner,
  shouldApiRouteProxyToDuckdbOwner,
} from './apiRouteClassification.ts'

type DuckdbOwnerProxyRequestTemplate = {
  body: ArrayBuffer | null
  classification: ApiRouteClassification
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

type DuckdbOwnerStreamingProxyRequestTemplate = {
  body: ReadableStream<Uint8Array> | null
  classification: ApiRouteClassification
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

const duckdbOwnerProxyRetryDelayMs = 250
const duckdbOwnerProxyRetryTimeoutMs = 4000
const duckdbOwnerDiagnosticProxyTimeoutMs = 3000
const duckdbOwnerReadProxyTimeoutMs = 15000
const duckdbOwnerMutationProxyTimeoutMs = 60000
const duckdbOwnerStreamingProxyTimeoutMs = 10 * 60 * 1000
const duckdbOwnerProxyRetryableMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT'])
const duckdbOwnerProxyHopByHopResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const duckdbOwnerDiagnosticProxyTimeoutPathnames = new Set([
  '/api/admin/duckdb-runtime-workloads',
  `${duckdbOwnerPrivateApiPrefix}/api/llmstatus`,
  `${duckdbOwnerPrivateApiPrefix}/api/nvidiasmi`,
  '/api/duckdb_owner_connections',
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
        classification,
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
        classification,
        failClosedWithoutDuckdbOwner: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
        headers: getDuckdbOwnerProxyHeaders(request),
        method: request.method,
        pathname: getDuckdbOwnerProxyPathname({classification, pathname: requestUrl.pathname}),
        search: requestUrl.search,
      }
}

const getDuckdbOwnerProxyRequest = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
  signal?: AbortSignal,
) => {
  return new Request(`${duckdbOwnerUrl}${requestTemplate.pathname}${requestTemplate.search}`, {
    body: requestTemplate.body === null ? undefined : requestTemplate.body.slice(0),
    headers: requestTemplate.headers,
    method: requestTemplate.method,
    signal,
  })
}

const getPublicDuckdbOwnerProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return requestTemplate.pathname.startsWith(duckdbOwnerPrivateApiPrefix)
    ? requestTemplate.pathname.slice(duckdbOwnerPrivateApiPrefix.length)
    : requestTemplate.pathname
}

const isRetryableDuckdbOwnerProxyMutation = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'POST') {
    return false
  }

  return (
    getPublicDuckdbOwnerProxyPathname(requestTemplate).match(
      /^\/api\/comparison-projects\/[^/]+\/conflict-resolution(?:\/reset)?$/,
    ) !== null
  )
}

const shouldRetryDuckdbOwnerProxyRequest = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return (
    duckdbOwnerProxyRetryableMethods.has(requestTemplate.method) || isRetryableDuckdbOwnerProxyMutation(requestTemplate)
  )
}

const getDuckdbOwnerStreamingProxyRequest = (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
  duckdbOwnerUrl: string,
  signal?: AbortSignal,
) => {
  return new Request(`${duckdbOwnerUrl}${requestTemplate.pathname}${requestTemplate.search}`, {
    body: requestTemplate.body ?? undefined,
    headers: requestTemplate.headers,
    method: requestTemplate.method,
    signal,
  })
}

const getIncompatibleDuckdbOwnerTargetResponse = async (duckdbOwnerUrl: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'DuckDB owner proxy target')

  return result.status === 'incompatible' ? Response.json({data: null, error: result.message}, {status: 426}) : null
}

const getDuckdbOwnerProxyTimeoutMs = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (
    requestTemplate.method === 'GET'
    && (requestTemplate.classification === 'duckdb-owner-diagnostics'
      || duckdbOwnerDiagnosticProxyTimeoutPathnames.has(requestTemplate.pathname))
  ) {
    return duckdbOwnerDiagnosticProxyTimeoutMs
  }

  return requestTemplate.method === 'GET' || requestTemplate.method === 'HEAD' || requestTemplate.method === 'OPTIONS'
    ? duckdbOwnerReadProxyTimeoutMs
    : duckdbOwnerMutationProxyTimeoutMs
}

const getDuckdbOwnerProxyRetryTimeoutMs = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return requestTemplate.method === 'GET'
    || requestTemplate.method === 'HEAD'
    || requestTemplate.method === 'OPTIONS'
    || isRetryableDuckdbOwnerProxyMutation(requestTemplate)
    ? Math.max(duckdbOwnerProxyRetryTimeoutMs, getDuckdbOwnerProxyTimeoutMs(requestTemplate))
    : duckdbOwnerProxyRetryTimeoutMs
}

const getDuckdbOwnerProxyTimeoutResponse = (timeoutMs: number) => {
  return Response.json({data: null, error: `DuckDB owner proxy target timed out after ${timeoutMs} ms`}, {status: 504})
}

const createDuckdbOwnerProxyTimeout = (timeoutMs: number) => {
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

const keepDuckdbOwnerProxyTimeoutUntilBodySettles = (
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

const fetchDuckdbOwnerProxyRequest = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const timeoutMs = getDuckdbOwnerProxyTimeoutMs(requestTemplate)

  if (timeoutMs === null) {
    return fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl))
  }

  const timeout = createDuckdbOwnerProxyTimeout(timeoutMs)

  try {
    const response = await fetch(getDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl, timeout.signal))

    return keepDuckdbOwnerProxyTimeoutUntilBodySettles(response, timeout)
  } catch (error) {
    timeout.dispose()

    if (timeout.signal.aborted) {
      return getDuckdbOwnerProxyTimeoutResponse(timeoutMs)
    }

    throw error
  }
}

const waitForDuckdbOwnerProxyTarget = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
  deadlineMs = Date.now() + getDuckdbOwnerProxyRetryTimeoutMs(requestTemplate),
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
  return waitForDuckdbOwnerProxyTarget(requestTemplate, duckdbOwnerUrl, deadlineMs)
}

const fetchDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  if (incompatibleTargetResponse !== null) {
    return incompatibleTargetResponse
  }

  return fetchDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl)
}

const fetchNonRetryableDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const targetFailureResponse = await waitForDuckdbOwnerProxyTarget(requestTemplate, duckdbOwnerUrl)

  if (targetFailureResponse !== null) {
    return targetFailureResponse
  }

  return fetchDuckdbOwnerProxyRequest(requestTemplate, duckdbOwnerUrl)
}

const fetchRetryableDuckdbOwnerProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  if (isRetryableDuckdbOwnerProxyMutation(requestTemplate)) {
    const targetFailureResponse = await waitForDuckdbOwnerProxyTarget(requestTemplate, duckdbOwnerUrl)

    if (targetFailureResponse !== null) {
      return targetFailureResponse
    }
  }

  return fetchDuckdbOwnerProxyResponse(requestTemplate, duckdbOwnerUrl)
}

const fetchDuckdbOwnerStreamingProxyResponse = async (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
  duckdbOwnerUrl: string,
) => {
  const incompatibleTargetResponse = await getIncompatibleDuckdbOwnerTargetResponse(duckdbOwnerUrl)

  if (incompatibleTargetResponse !== null) {
    return incompatibleTargetResponse
  }

  const timeout = createDuckdbOwnerProxyTimeout(duckdbOwnerStreamingProxyTimeoutMs)

  try {
    const response = await fetch(getDuckdbOwnerStreamingProxyRequest(requestTemplate, duckdbOwnerUrl, timeout.signal))

    return keepDuckdbOwnerProxyTimeoutUntilBodySettles(response, timeout)
  } catch (error) {
    timeout.dispose()

    if (timeout.signal.aborted) {
      return getDuckdbOwnerProxyTimeoutResponse(duckdbOwnerStreamingProxyTimeoutMs)
    }

    throw error
  }
}

const getRetriedProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  currentDuckdbOwnerUrl: string,
) => {
  const deadlineMs = Date.now() + getDuckdbOwnerProxyRetryTimeoutMs(requestTemplate)

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

const getImportSessionIdFromProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'GET') {
    return null
  }

  const publicPathname = getPublicDuckdbOwnerProxyPathname(requestTemplate)
  const match = publicPathname.match(/^\/api\/projects\/import\/([^/]+)$/)

  if (match === null) {
    return null
  }

  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

const getExportSessionIdFromProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'GET') {
    return null
  }

  const publicPathname = getPublicDuckdbOwnerProxyPathname(requestTemplate)
  const match = publicPathname.match(/^\/api\/projects\/export\/([^/]+)$/)

  if (match === null) {
    return null
  }

  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

const getProjectTransferImportArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const sessionId = getImportSessionIdFromProxyPathname(requestTemplate)

  if (sessionId === null) {
    return null
  }

  const {getImportSessionArtifactResponse, shouldUseImportSessionArtifactResponse} =
    await import('./projectTransferRoutes.ts')
  const artifactResponse = await getImportSessionArtifactResponse(sessionId)

  return artifactResponse === null
    || artifactResponse.data === null
    || artifactResponse.data.state === 'failed'
    || !shouldUseImportSessionArtifactResponse(artifactResponse)
    ? null
    : Response.json(artifactResponse)
}

const getProjectTransferImportArtifactFallbackProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
) => {
  const sessionId = getImportSessionIdFromProxyPathname(requestTemplate)

  if (sessionId === null) {
    return null
  }

  const {getImportSessionArtifactResponse, shouldUseImportSessionArtifactResponse} =
    await import('./projectTransferRoutes.ts')
  const artifactResponse = await getImportSessionArtifactResponse(sessionId)

  return artifactResponse === null
    || artifactResponse.data === null
    || (artifactResponse.data.state !== 'failed' && shouldUseImportSessionArtifactResponse(artifactResponse))
    ? null
    : Response.json(artifactResponse)
}

const getProjectTransferExportArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const exportId = getExportSessionIdFromProxyPathname(requestTemplate)

  if (exportId === null) {
    return null
  }

  const {getExportSessionArtifactResponse} = await import('./projectTransferRoutes.ts')
  const routeSet: {status?: number | string} = {}
  const artifactResponse = await getExportSessionArtifactResponse(routeSet, exportId)

  return artifactResponse === null
    ? null
    : Response.json(artifactResponse, {status: typeof routeSet.status === 'number' ? routeSet.status : undefined})
}

const getProjectTransferArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return (
    (await getProjectTransferImportArtifactProxyResponse(requestTemplate))
    ?? (await getProjectTransferExportArtifactProxyResponse(requestTemplate))
  )
}

const getImportArtifactFallbackForOwnerFailure = (
  ownerResponse: Response | null,
  artifactResponse: Response | null,
) => {
  return artifactResponse !== null
    && (ownerResponse === null || ownerResponse.status === 502 || ownerResponse.status === 504)
    ? artifactResponse
    : ownerResponse
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

  const artifactResponse = await getProjectTransferArtifactProxyResponse(requestTemplate)

  if (artifactResponse !== null) {
    return artifactResponse
  }

  const importArtifactFallbackResponse = await getProjectTransferImportArtifactFallbackProxyResponse(requestTemplate)

  const target = await getDuckdbOwnerProxyTargetFailureResponse(requestTemplate)

  if ('response' in target) {
    return getImportArtifactFallbackForOwnerFailure(target.response, importArtifactFallbackResponse)
  }

  const shouldRetryProxyRequest = shouldRetryDuckdbOwnerProxyRequest(requestTemplate)

  try {
    const response = shouldRetryProxyRequest
      ? await fetchRetryableDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)
      : await fetchNonRetryableDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    const ownerResponse = getDuckdbOwnerProxyResponse(response)

    return getImportArtifactFallbackForOwnerFailure(ownerResponse, importArtifactFallbackResponse)
  } catch {
    if (!shouldRetryProxyRequest) {
      return getImportArtifactFallbackForOwnerFailure(
        getDuckdbOwnerProxyFailureResponse(requestTemplate),
        importArtifactFallbackResponse,
      )
    }

    const retriedResponse = await getRetriedProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    const ownerResponse =
      retriedResponse === null
        ? getDuckdbOwnerProxyFailureResponse(requestTemplate)
        : getDuckdbOwnerProxyResponse(retriedResponse)

    return getImportArtifactFallbackForOwnerFailure(ownerResponse, importArtifactFallbackResponse)
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
