import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentProduct} from './routeSurfaceRouteGroups.ts'

export const subprojectsRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('SubprojectsRoutes.ts', [
    ['GET', '/api/subprojects/sources'],
    ['POST', '/api/subprojects'],
  ]),
]
