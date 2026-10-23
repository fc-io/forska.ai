import {getDuckdbOwnerConnectionProxyHeaders} from '../../utils/duckdbOwnerConnections.ts'
import {
  type ApiRouteClassification,
  classifyApiRoute,
  getDuckdbOwnerProxyPathname,
  isProjectTransferStreamingUploadPath,
  shouldApiRouteFailClosedWithoutDuckdbOwner,
  shouldApiRouteProxyToDuckdbOwner,
} from '../apiRouteClassification.ts'

export type DuckdbOwnerProxyRequestTemplate = {
  body: ArrayBuffer | null
  classification: ApiRouteClassification
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

export const getDuckdbOwnerProxyRequestTemplate = async (
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
