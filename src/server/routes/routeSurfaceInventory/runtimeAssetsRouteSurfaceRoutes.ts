import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentSensitive} from './routeSurfaceRouteGroups.ts'

export const runtimeAssetsRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentSensitive(
    'RuntimeAssetsRoutes.ts',
    'Local persisted runtime asset files under the reviewed asset scope.',
    [['GET', '/api/runtime-asset']],
  ),
]
