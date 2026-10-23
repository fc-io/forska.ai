import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentSensitive} from './routeSurfaceRouteGroups.ts'

export const usersRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentSensitive(
    'UsersRoutes.ts',
    'Single-user settings can include local paths and contact email configuration.',
    [
      ['GET', '/api/users'],
      ['GET', '/api/users/full-text-model-status'],
      ['PATCH', '/api/users'],
    ],
  ),
]
