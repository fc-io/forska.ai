import {duckdbOwnerPrivateApiPrefix} from '../apiRouteClassification.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {isRetryableDuckdbOwnerProxyMutation} from './isRetryableDuckdbOwnerProxyMutation.ts'

const duckdbOwnerProxyRetryTimeoutMs = 4000
const duckdbOwnerRetryableMutationReadinessTimeoutMs = 180000
const duckdbOwnerDiagnosticProxyTimeoutMs = 3000
const duckdbOwnerReadProxyTimeoutMs = 60000
const duckdbOwnerReadProxyRetryTimeoutMs = 15000
const duckdbOwnerMutationProxyTimeoutMs = 60000
const duckdbOwnerDiagnosticProxyTimeoutPathnames = new Set([
  '/api/admin/duckdb-runtime-workloads',
  '/api/admin/process-activity',
  `${duckdbOwnerPrivateApiPrefix}/api/llmstatus`,
  `${duckdbOwnerPrivateApiPrefix}/api/nvidiasmi`,
  '/api/duckdb_owner_connections',
])

export const getDuckdbOwnerProxyTimeoutMs = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
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

export const getDuckdbOwnerProxyRetryTimeoutMs = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (isRetryableDuckdbOwnerProxyMutation(requestTemplate)) {
    return Math.max(duckdbOwnerRetryableMutationReadinessTimeoutMs, getDuckdbOwnerProxyTimeoutMs(requestTemplate))
  }

  return requestTemplate.method === 'GET' || requestTemplate.method === 'HEAD' || requestTemplate.method === 'OPTIONS'
    ? duckdbOwnerReadProxyRetryTimeoutMs
    : duckdbOwnerProxyRetryTimeoutMs
}
