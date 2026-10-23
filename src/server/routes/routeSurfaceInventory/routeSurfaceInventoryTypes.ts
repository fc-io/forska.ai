export type RouteSurfaceCategory =
  | 'internal-runtime-api'
  | 'local-diagnostics-api'
  | 'maintenance-debug-api'
  | 'remove-before-release'
  | 'sensitive-local-api'
  | 'supported-local-api'

export type RouteSurfaceProxyClassification =
  | 'duckdb-owner-diagnostics'
  | 'local-bootstrap'
  | 'owner-dependent'
  | 'ownerless-readable-diagnostics'

export type RouteSurfaceRoute = {
  category: RouteSurfaceCategory
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  path: string
  proxyClassification: RouteSurfaceProxyClassification
  releaseDecision: string
  routeModule: string
  sensitivity: string | null
}

export type RouteSurfaceEntrypoint = {
  category: RouteSurfaceCategory
  defaultBind: 'loopback' | 'process-local'
  releaseDecision: string
  source: string
  surface: string
}

export type RouteSurfaceRouteDefaults = Omit<RouteSurfaceRoute, 'method' | 'path'>
export type RoutePair = readonly [RouteSurfaceRoute['method'], string]
