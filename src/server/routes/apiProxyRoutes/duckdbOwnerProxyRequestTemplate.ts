import {getDuckdbOwnerConnectionProxyHeaders} from '../../utils/duckdbOwnerConnections.ts'
import {
  type ApiRouteClassification,
  classifyApiRoute,
  getDuckdbOwnerProxyPathname,
  isProjectTransferStreamingUploadPath,
  shouldApiRouteFailClosedWithoutDuckdbOwner,
  shouldApiRouteProxyToDuckdbOwner,
} from '../apiRouteClassification.ts'

export type DuckdbOwnerProxyClientServer = {timeout: (request: Request, seconds: number) => void}

export type DuckdbOwnerProxyClientConnection = {
  /**
   * When a proxied body fails after headers were sent, Bun ends the chunked response cleanly whether the stream
   * errors or throws, so the client cannot tell a cut download from a complete one. This sets a 1 s idle timeout
   * instead. The caller then leaves the stream open, Bun drops the socket without the terminating chunk, and the
   * client sees an interrupted download.
   */
  dropWithoutCleanEnd: () => void
}

export type DuckdbOwnerProxyRequestTemplate = {
  body: ArrayBuffer | null
  classification: ApiRouteClassification
  /** The client socket of the API request, when the proxy runs inside Bun.serve. */
  clientConnection?: DuckdbOwnerProxyClientConnection
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

export type DuckdbOwnerStreamingProxyRequestTemplate = {
  body: ReadableStream<Uint8Array> | null
  classification: ApiRouteClassification
  failClosedWithoutDuckdbOwner: boolean
  headers: Headers
  method: string
  pathname: string
  search: string
}

const getDuckdbOwnerProxyHeaders = (request: Request) => {
  return new Headers({...Object.fromEntries(request.headers.entries()), ...getDuckdbOwnerConnectionProxyHeaders()})
}

const getDuckdbOwnerProxyClientConnection = (
  request: Request,
  server: DuckdbOwnerProxyClientServer | null,
): DuckdbOwnerProxyClientConnection | undefined => {
  return server === null
    ? undefined
    : {
        dropWithoutCleanEnd: () => {
          server.timeout(request, 1)
        },
      }
}

export const getDuckdbOwnerProxyRequestTemplate = async (
  request: Request,
  server: DuckdbOwnerProxyClientServer | null = null,
): Promise<DuckdbOwnerProxyRequestTemplate | null> => {
  const requestUrl = new URL(request.url)
  const classification = classifyApiRoute(requestUrl.pathname, request.method)
  const hasRequestBody = request.method !== 'GET' && request.method !== 'HEAD'
  const clientConnection = getDuckdbOwnerProxyClientConnection(request, server)

  return !shouldApiRouteProxyToDuckdbOwner(classification)
    ? null
    : {
        body: hasRequestBody ? await request.clone().arrayBuffer() : null,
        classification,
        ...(clientConnection === undefined ? {} : {clientConnection}),
        failClosedWithoutDuckdbOwner: shouldApiRouteFailClosedWithoutDuckdbOwner(classification),
        headers: getDuckdbOwnerProxyHeaders(request),
        method: request.method,
        pathname: getDuckdbOwnerProxyPathname({classification, pathname: requestUrl.pathname}),
        search: requestUrl.search,
      }
}

export const getDuckdbOwnerStreamingProxyRequestTemplate = (
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

export const getDuckdbOwnerProxyRequest = (
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

export const getDuckdbOwnerStreamingProxyRequest = (
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

export const isBufferedDuckdbOwnerProxyRequestTemplate = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate | DuckdbOwnerStreamingProxyRequestTemplate,
): requestTemplate is DuckdbOwnerProxyRequestTemplate => {
  return requestTemplate.body === null || requestTemplate.body instanceof ArrayBuffer
}
