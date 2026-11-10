import {duckdbOwnerPrivateApiPrefix, getApiRouteProxyTimeoutProfile} from '../apiRouteClassification.ts'
import type {RouteSurfaceProxyTimeoutProfile} from '../routeSurfaceInventory.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getPublicDuckdbOwnerProxyPathname} from './getPublicDuckdbOwnerProxyPathname.ts'
import {isRetryableDuckdbOwnerProxyMutation} from './isRetryableDuckdbOwnerProxyMutation.ts'

const duckdbOwnerProxyRetryTimeoutMs = 4000
const duckdbOwnerRetryableMutationReadinessTimeoutMs = 180000
const duckdbOwnerReadProxyRetryTimeoutMs = 15000
export const duckdbOwnerStreamingProxyTimeoutMs = 10 * 60 * 1000

export type DuckdbOwnerProxyTimeoutBudgets = {
  diagnosticTimeoutMs: number
  /** Long-download body: abort only when the owner sends no chunk for this long while the proxy waits on it. */
  longDownloadBodyIdleTimeoutMs: number
  /** Long-download headers: how long the owner may take before the response headers arrive. */
  longDownloadTimeoutMs: number
  mutationTimeoutMs: number
  readTimeoutMs: number
}

export const duckdbOwnerProxyTimeoutBudgets: DuckdbOwnerProxyTimeoutBudgets = {
  diagnosticTimeoutMs: 3000,
  longDownloadBodyIdleTimeoutMs: 60000,
  longDownloadTimeoutMs: duckdbOwnerStreamingProxyTimeoutMs,
  mutationTimeoutMs: 60000,
  readTimeoutMs: 60000,
}

const duckdbOwnerDiagnosticProxyTimeoutPathnames = new Set([
  '/api/admin/duckdb-runtime-workloads',
  '/api/admin/process-activity',
  `${duckdbOwnerPrivateApiPrefix}/api/llmstatus`,
  `${duckdbOwnerPrivateApiPrefix}/api/nvidiasmi`,
  '/api/duckdb_owner_connections',
])

export const getDuckdbOwnerProxyTimeoutProfile = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
): RouteSurfaceProxyTimeoutProfile => {
  return getApiRouteProxyTimeoutProfile(getPublicDuckdbOwnerProxyPathname(requestTemplate), requestTemplate.method)
}

const isDuckdbOwnerProxyReadMethod = (method: string) => {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/** Budget until the owner's response headers arrive. For default routes the same timer also covers the body. */
export const getDuckdbOwnerProxyTimeoutMs = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  budgets: DuckdbOwnerProxyTimeoutBudgets = duckdbOwnerProxyTimeoutBudgets,
) => {
  if (
    requestTemplate.method === 'GET'
    && (requestTemplate.classification === 'duckdb-owner-diagnostics'
      || duckdbOwnerDiagnosticProxyTimeoutPathnames.has(requestTemplate.pathname))
  ) {
    return budgets.diagnosticTimeoutMs
  }

  if (getDuckdbOwnerProxyTimeoutProfile(requestTemplate) === 'long-download') {
    return budgets.longDownloadTimeoutMs
  }

  return isDuckdbOwnerProxyReadMethod(requestTemplate.method) ? budgets.readTimeoutMs : budgets.mutationTimeoutMs
}

/**
 * Idle budget for the body once headers have arrived, or null for default routes, where the headers timer keeps
 * running until the body settles.
 */
export const getDuckdbOwnerProxyBodyIdleTimeoutMs = (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
  budgets: DuckdbOwnerProxyTimeoutBudgets = duckdbOwnerProxyTimeoutBudgets,
) => {
  return getDuckdbOwnerProxyTimeoutProfile(requestTemplate) === 'long-download'
    ? budgets.longDownloadBodyIdleTimeoutMs
    : null
}

export const getDuckdbOwnerProxyRetryTimeoutMs = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (isRetryableDuckdbOwnerProxyMutation(requestTemplate)) {
    return Math.max(duckdbOwnerRetryableMutationReadinessTimeoutMs, getDuckdbOwnerProxyTimeoutMs(requestTemplate))
  }

  return isDuckdbOwnerProxyReadMethod(requestTemplate.method)
    ? duckdbOwnerReadProxyRetryTimeoutMs
    : duckdbOwnerProxyRetryTimeoutMs
}
