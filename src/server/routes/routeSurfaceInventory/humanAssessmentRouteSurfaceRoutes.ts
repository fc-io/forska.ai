import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentProduct} from './routeSurfaceRouteGroups.ts'

export const humanAssessmentRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('HumanAssessmentRoutes.ts', [
    ['GET', '/api/humanassessment/overview'],
    ['GET', '/api/humanassessment/overview-both-projects'],
  ]),
  ...ownerDependentProduct('HumanAssessmentRoutes.ts', [
    ['POST', '/api/humanassessment/init'],
    ['POST', '/api/humanassessment/submit'],
  ]),
]
