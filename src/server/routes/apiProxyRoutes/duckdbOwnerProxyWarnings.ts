import {duckdbOwnerProxyLogger} from './duckdbOwnerProxyLogger.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyErrorMessage} from './getDuckdbOwnerProxyErrorMessage.ts'
import {getPublicDuckdbOwnerProxyPathname} from './getPublicDuckdbOwnerProxyPathname.ts'
import {isRetryableDuckdbOwnerProxyMutation} from './isRetryableDuckdbOwnerProxyMutation.ts'

const getDuckdbOwnerProxyRouteDiagnosticName = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const publicPathname = getPublicDuckdbOwnerProxyPathname(requestTemplate)

  if (
    requestTemplate.method === 'POST'
    && publicPathname.match(/^\/api\/comparison-projects\/[^/]+\/conflict-resolution$/) !== null
  ) {
    return 'comparison-project-conflict-resolution-save'
  }

  if (
    requestTemplate.method === 'POST'
    && publicPathname.match(/^\/api\/comparison-projects\/[^/]+\/conflict-resolution\/reset$/) !== null
  ) {
    return 'comparison-project-conflict-resolution-reset'
  }

  return `${requestTemplate.method} ${publicPathname}`
}

const getDuckdbOwnerProxyDiagnosticContext = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  extra: Record<string, unknown> = {},
) => {
  return {
    classification: requestTemplate.classification,
    failClosedWithoutDuckdbOwner: requestTemplate.failClosedWithoutDuckdbOwner,
    method: requestTemplate.method,
    pathname: requestTemplate.pathname,
    publicPathname: getPublicDuckdbOwnerProxyPathname(requestTemplate),
    retryableMutation: isRetryableDuckdbOwnerProxyMutation(requestTemplate),
    route: getDuckdbOwnerProxyRouteDiagnosticName(requestTemplate),
    search: requestTemplate.search,
    ...extra,
  }
}

export const warnDuckdbOwnerProxyFailure = (
  key: string,
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  extra: Record<string, unknown> = {},
) => {
  duckdbOwnerProxyLogger.warn(
    key,
    '[api-proxy] DuckDB owner proxy could not forward request',
    getDuckdbOwnerProxyDiagnosticContext(requestTemplate, extra),
  )
}

/**
 * headers: no response headers within the budget (the client gets a 504).
 * body: default route, the total budget ran out while the body streamed (the client gets a truncated download).
 * body-idle: long-download route, the owner sent no body data for the idle budget.
 */
export const warnDuckdbOwnerProxyTimeout = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  extra: {elapsedMs: number; phase: 'body' | 'body-idle' | 'headers'; timeoutMs: number | null},
) => {
  duckdbOwnerProxyLogger.warn(
    `api-proxy:duckdb-owner-timeout:${extra.phase}`,
    '[api-proxy] DuckDB owner proxy target timed out',
    getDuckdbOwnerProxyDiagnosticContext(requestTemplate, extra),
  )
}

export const warnDuckdbOwnerProxyOwnerErrorResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  response: Response,
  duckdbOwnerUrl: string,
) => {
  if (response.status < 500) {
    return
  }

  const bodyPreview = await response
    .clone()
    .text()
    .then((body) => {
      return body.slice(0, 1_000)
    })
    .catch((error) => {
      return `unable to read owner error body: ${getDuckdbOwnerProxyErrorMessage(error)}`
    })

  warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-error-response', requestTemplate, {
    bodyPreview,
    duckdbOwnerUrl,
    status: response.status,
    statusText: response.statusText,
  })
}
