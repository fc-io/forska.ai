import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getImportSessionIdFromProxyPathname} from './projectTransferArtifactProxyResponse.ts'

const duckdbOwnerProxyHopByHopResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const duckdbExclusiveWorkBusyCode = 'DUCKDB_EXCLUSIVE_WORK'

export const getDuckdbOwnerProxyUnavailableResponse = (requestTemplate?: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate !== undefined && getImportSessionIdFromProxyPathname(requestTemplate) !== null) {
    return Response.json(
      {
        code: duckdbExclusiveWorkBusyCode,
        data: null,
        error: 'The database is busy with a project import. Status will update when it finishes.',
      },
      {headers: {'Retry-After': '5'}, status: 503},
    )
  }

  return Response.json({data: null, error: 'DuckDB owner proxy target unavailable'}, {status: 502})
}

export const getDuckdbOwnerProxyFailureResponse = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return requestTemplate.failClosedWithoutDuckdbOwner ? getDuckdbOwnerProxyUnavailableResponse(requestTemplate) : null
}

const getDuckdbOwnerProxyResponseHeaders = (response: Response) => {
  return Array.from(response.headers.entries()).reduce<Headers>((headers, [key, value]) => {
    if (!duckdbOwnerProxyHopByHopResponseHeaders.has(key.toLowerCase())) {
      headers.set(key, value)
    }

    return headers
  }, new Headers())
}

export const getDuckdbOwnerProxyResponse = (response: Response) => {
  return new Response(response.body, {
    headers: getDuckdbOwnerProxyResponseHeaders(response),
    status: response.status,
    statusText: response.statusText,
  })
}
