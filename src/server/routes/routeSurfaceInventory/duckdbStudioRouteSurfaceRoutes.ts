import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentMaintenance} from './routeSurfaceRouteGroups.ts'

export const duckdbStudioRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentMaintenance('DuckdbStudioRoutes.ts', 'DuckDB snapshot creation and local database file paths.', [
    ['POST', '/api/duckdbStudioSnapshots'],
  ]),
]
