import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {
  internalRuntime,
  ownerDependentMaintenance,
  ownerDependentProduct,
  ownerlessDiagnostics,
  routeGroup,
  sensitiveProductDecision,
} from './routeSurfaceRouteGroups.ts'

export const judgmentsJobsRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('JudgmentsJobsRoutes.ts', [
    ['POST', '/api/judgmentsjobs'],
    ['GET', '/api/judgmentsjobs'],
    ['GET', '/api/judgmentsjobs/:id'],
    ['GET', '/api/judgmentsjobs/:id/stop-condition-defaults'],
    ['GET', '/api/judgmentsjobs-total-token-usage'],
    ['PATCH', '/api/judgmentsjobs/:id'],
    ['DELETE', '/api/judgmentsjobs/:id'],
  ]),
  ...ownerDependentProduct('JudgmentsJobsRoutes.ts', [
    ['GET', '/api/judgmentsjobs-unassessed-count'],
    ['GET', '/api/judgmentsjobs-unassessed-articles'],
  ]),
  ...ownerlessDiagnostics(
    'JudgmentsJobsRoutes.ts',
    'Judgment job status, health, and provider telemetry diagnostics.',
    [
      ['GET', '/api/judgmentsjobs/:id/health'],
      ['GET', '/api/judgmentsjobs-health'],
    ],
  ),
  ...routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: sensitiveProductDecision,
      routeModule: 'JudgmentsJobsRoutes.ts',
      sensitivity: 'Judgment job provider telemetry history and runtime utilization metadata.',
    },
    [['GET', '/api/judgmentsjobs-provider-telemetry-history']],
  ),
  ...internalRuntime('JudgmentsJobsRoutes.ts', [
    ['POST', '/api/judgmentsjobs/:id/claims'],
    ['POST', '/api/judgmentsjobs/:id/claim'],
    ['POST', '/api/judgmentsjobs/:id/completions'],
    ['POST', '/api/judgmentsjobs/:id/complete'],
    ['POST', '/api/judgmentsjobs-worker-heartbeats'],
    ['GET', '/api/judgmentsjobs-running'],
    ['GET', '/api/judgmentsjobs/:id/runtime'],
    ['GET', '/api/judgmentsjobs/execution-snapshots/:executionSnapshotId'],
    ['GET', '/api/judgmentsjobs-execution-snapshots/:executionSnapshotId'],
  ]),
  ...ownerDependentMaintenance(
    'JudgmentsJobsRoutes.ts',
    'Judgment job repair, drain, quarantine, and cleanup controls.',
    [
      ['POST', '/api/judgmentsjobs/:id/start-clean'],
      ['POST', '/api/judgmentsjobs/:id/preflight'],
      ['POST', '/api/judgmentsjobs/:id/drain'],
      ['POST', '/api/judgmentsjobs/:id/checkpoint'],
      ['POST', '/api/judgmentsjobs/:id/quarantine'],
      ['POST', '/api/judgmentsjobs/:id/unquarantine'],
      ['POST', '/api/judgmentsjobs/:id/repair'],
      ['POST', '/api/judgmentsjobs/:id/repair-orphaned-queue'],
    ],
  ),
]
