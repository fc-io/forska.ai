import {Elysia} from 'elysia'

import {runtimePrivateApiPrefix} from '../utils/runtimePrivateApi.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'
import {findRouteSurfaceRoute, type RouteSurfaceCategory} from './routeSurfaceInventory.ts'

export const exposeLocalOperatorApiEnvVar = 'FORSKA_EXPOSE_LOCAL_OPERATOR_API'

export const publicRouteSurfaceGatedCategories: RouteSurfaceCategory[] = [
  'internal-runtime-api',
  'local-diagnostics-api',
  'maintenance-debug-api',
  'remove-before-release',
]

const enabledValues = ['1', 'true', 'yes', 'on']
const duckdbOwnerConnectionHeartbeatPath = '/api/duckdb_owner_connections/heartbeat'

export const isLocalOperatorApiExposed = (envValues: Record<string, string | undefined> = process.env) => {
  return enabledValues.includes(
    String(envValues[exposeLocalOperatorApiEnvVar] ?? '')
      .trim()
      .toLowerCase(),
  )
}

export const getPublicRouteSurfaceGateDecision = ({
  envValues = process.env,
  method,
  pathname,
}: {
  envValues?: Record<string, string | undefined>
  method: string
  pathname: string
}) => {
  const route = findRouteSurfaceRoute({method, pathname})
  const isDuckdbOwnerConnectionHeartbeat = route?.path === duckdbOwnerConnectionHeartbeatPath
  const shouldSkipGate =
    isLocalOperatorApiExposed(envValues)
    || isDuckdbOwnerConnectionHeartbeat
    || pathname === duckdbOwnerPrivateApiPrefix
    || pathname.startsWith(`${duckdbOwnerPrivateApiPrefix}/`)
    || pathname === runtimePrivateApiPrefix
    || pathname.startsWith(`${runtimePrivateApiPrefix}/`)
  const shouldGate = route !== null && publicRouteSurfaceGatedCategories.includes(route.category) && !shouldSkipGate

  return {route, shouldGate}
}

export const publicRouteSurfaceGate = new Elysia().onRequest(({request}) => {
  const requestUrl = new URL(request.url)
  const decision = getPublicRouteSurfaceGateDecision({method: request.method, pathname: requestUrl.pathname})

  return decision.shouldGate
    ? Response.json({data: null, error: 'Route is not available on the public local API surface'}, {status: 404})
    : undefined
})
