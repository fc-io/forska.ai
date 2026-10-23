import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentProduct} from './routeSurfaceRouteGroups.ts'

export const comparisonProjectsRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('ComparisonProjectsRoutes.ts', [
    ['GET', '/api/comparison-projects'],
    ['GET', '/api/comparison-projects/archived'],
    ['GET', '/api/comparison-projects/sources'],
    ['GET', '/api/comparison-projects/conflict-resolution-import-sources'],
    ['POST', '/api/comparison-projects/conflict-resolution-import-preview'],
    ['POST', '/api/comparison-projects/from-project'],
    ['GET', '/api/comparison-projects/:id/edit'],
    ['GET', '/api/comparison-projects/:id/stats'],
    ['GET', '/api/comparison-projects/:id'],
    ['POST', '/api/comparison-projects/:id/judgments'],
    ['POST', '/api/comparison-projects/:id/judgments/count'],
    ['POST', '/api/comparison-projects/:id/conflict-resolution'],
    ['POST', '/api/comparison-projects/:id/conflict-resolution/reset'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/export'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/analyze'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/pdf/analyze'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/commit'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/pdf/commit'],
    ['POST', '/api/comparison-projects/:id/export'],
    ['POST', '/api/comparison-projects'],
    ['PATCH', '/api/comparison-projects/:id'],
    ['DELETE', '/api/comparison-projects/:id/purge'],
    ['DELETE', '/api/comparison-projects/:id'],
    ['POST', '/api/comparison-projects/:id/unarchive'],
  ]),
]
