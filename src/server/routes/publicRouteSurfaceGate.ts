import {Elysia} from 'elysia'

import {runtimePrivateApiPrefix} from '../utils/runtimePrivateApi.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'
import {findRouteSurfaceRoute, type RouteSurfaceCategory} from './routeSurfaceInventory.ts'

export const publicRouteSurfaceGatedCategories: RouteSurfaceCategory[] = [
  'internal-runtime-api',
  'remove-before-release',
]

const duckdbOwnerConnectionHeartbeatPath = '/api/duckdb_owner_connections/heartbeat'

export const getPublicRouteSurfaceGateDecision = ({method, pathname}: {method: string; pathname: string}) => {
  const route = findRouteSurfaceRoute({method, pathname})
  const isDuckdbOwnerConnectionHeartbeat = route?.path === duckdbOwnerConnectionHeartbeatPath
  const shouldSkipGate =
    isDuckdbOwnerConnectionHeartbeat
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
