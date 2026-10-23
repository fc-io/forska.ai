import type {RoutePair, RouteSurfaceRoute, RouteSurfaceRouteDefaults} from './routeSurfaceInventoryTypes.ts'

const supportedProductDecision = 'Keep as supported local product API on loopback.'
export const sensitiveProductDecision = 'Keep local-only after public-release sensitivity review.'
const diagnosticsDecision = 'Keep local diagnostics available on the loopback API without operator mode.'
export const internalDecision =
  'Gated on the public API by default. Keep internal/local-only and omit from public docs.'
const maintenanceDecision = 'Keep local maintenance controls available on the loopback API without operator mode.'
export const removeBeforeReleaseDecision =
  'Gated on the public API by default. Remove before release unless explicitly justified.'
const settingsDiagnosticsDecision = 'Keep as read-only Settings diagnostics on the local loopback API.'

export const routeGroup = (defaults: RouteSurfaceRouteDefaults, routes: readonly RoutePair[]): RouteSurfaceRoute[] => {
  return routes.map(([method, path]) => {
    return {...defaults, method, path}
  })
}

export const ownerDependentProduct = (routeModule: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'supported-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: supportedProductDecision,
      routeModule,
      sensitivity: null,
    },
    routes,
  )
}

export const ownerDependentSensitive = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: sensitiveProductDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const ownerDependentMaintenance = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'maintenance-debug-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: maintenanceDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const ownerDependentDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'local-diagnostics-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: diagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const ownerDependentSettingsDiagnostics = (
  routeModule: string,
  sensitivity: string,
  routes: readonly RoutePair[],
) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: settingsDiagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const ownerlessDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'local-diagnostics-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: diagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const ownerlessSettingsDiagnostics = (
  routeModule: string,
  sensitivity: string,
  routes: readonly RoutePair[],
) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: settingsDiagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

export const internalRuntime = (routeModule: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'internal-runtime-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: internalDecision,
      routeModule,
      sensitivity: 'Runtime coordination and worker state.',
    },
    routes,
  )
}
