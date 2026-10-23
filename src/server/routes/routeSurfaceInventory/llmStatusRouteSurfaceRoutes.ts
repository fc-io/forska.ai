import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentProduct} from './routeSurfaceRouteGroups.ts'

export const llmStatusRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('LlmStatusRoutes.ts', [['GET', '/api/llmstatus']]),
]
