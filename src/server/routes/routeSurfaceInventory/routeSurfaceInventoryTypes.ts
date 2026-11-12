export type RouteSurfaceCategory =
  | 'internal-runtime-api'
  | 'local-diagnostics-api'
  | 'maintenance-debug-api'
  | 'remove-before-release'
  | 'sensitive-local-api'
  | 'supported-local-api'

export type RouteSurfaceProxyClassification =
  'duckdb-owner-diagnostics' | 'local-bootstrap' | 'owner-dependent' | 'ownerless-readable-diagnostics'

/**
 * How long the API process waits on the DuckDB owner when it proxies this route.
 * - default: 60 s for the whole response, headers and body together (3 s for diagnostics).
 * - long-download: file downloads that are slow to start and long to stream. They get a 10-minute budget for the
 *   headers. Once headers arrive, the body is cut only when the owner sends nothing for the idle budget (60 s).
 */
export type RouteSurfaceProxyTimeoutProfile = 'default' | 'long-download'

export type RouteSurfaceRoute = {
  category: RouteSurfaceCategory
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  path: string
  proxyClassification: RouteSurfaceProxyClassification
  /** Omitted means 'default'. Set through `longDownload(...)` in routeSurfaceRouteGroups.ts. */
  proxyTimeoutProfile?: RouteSurfaceProxyTimeoutProfile
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
