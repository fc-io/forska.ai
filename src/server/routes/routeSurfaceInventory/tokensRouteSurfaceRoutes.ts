import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentDiagnostics, ownerDependentSensitive} from './routeSurfaceRouteGroups.ts'

export const tokensRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentDiagnostics('TokensRoutes.ts', 'Token usage ingestion includes provider request metadata.', [
    ['POST', '/api/tokens/usage'],
  ]),
  ...ownerDependentSensitive('TokensRoutes.ts', 'Token usage aggregates and provider request metadata.', [
    ['GET', '/api/tokens/largest-per-request'],
    ['GET', '/api/tokens/largest-completion-per-request'],
    ['GET', '/api/tokens'],
    ['POST', '/api/tokens/timeline'],
    ['POST', '/api/tokens/timelineAllJobs'],
    ['POST', '/api/tokens/timelineStats'],
    ['POST', '/api/tokens/timelineAllJobsStats'],
  ]),
  ...ownerDependentSensitive(
    'TokensRoutes.ts',
    'Failed request details can include prompts, article text, provider metadata, and errors.',
    [
      ['POST', '/api/tokens/failed-requests'],
      ['GET', '/api/tokens/failed-requests/:id'],
    ],
  ),
]
