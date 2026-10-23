import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentDiagnostics} from './routeSurfaceRouteGroups.ts'

export const nvidiaSmiRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentDiagnostics('NvidiaSmiRoutes.ts', 'Local GPU telemetry.', [['GET', '/api/nvidiasmi']]),
]
