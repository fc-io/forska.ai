import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {
  ownerDependentMaintenance,
  ownerDependentSensitive,
  ownerDependentSettingsDiagnostics,
  ownerlessSettingsDiagnostics,
} from './routeSurfaceRouteGroups.ts'

export const adminRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentMaintenance('AdminInvestigateRoutes.ts', 'Admin diagnostics and prompt/judgment cleanup.', [
    ['GET', '/api/admin/duckdb-append-metrics'],
    ['GET', '/api/admin/list-prompts-with-types'],
    ['POST', '/api/admin/delete-unexpected-answers'],
    ['POST', '/api/admin/auto-sync-all-unexpected-answers'],
    ['GET', '/api/admin/auto-sync-all-progress'],
    ['GET', '/api/admin/investigate-unexpected-answers'],
  ]),
  ...ownerDependentSensitive('AdminInvestigateRoutes.ts', 'Destructive local database reset for the settings page.', [
    ['POST', '/api/admin/clear-databases'],
  ]),
  ...ownerDependentSettingsDiagnostics(
    'AdminInvestigateRoutes.ts',
    'DuckDB owner active workload, queue, and in-memory process activity diagnostics.',
    [
      ['GET', '/api/admin/duckdb-runtime-workloads'],
      ['GET', '/api/admin/process-activity'],
    ],
  ),
  ...ownerDependentSettingsDiagnostics(
    'AdminInvestigateRoutes.ts',
    'DuckDB path, process memory, and maintenance runtime state.',
    [['GET', '/api/admin/maintenance-runtime-diagnostics']],
  ),
  ...ownerlessSettingsDiagnostics('AdminInvestigateRoutes.ts', 'Local worker runtime diagnostics.', [
    ['GET', '/api/admin/worker-runtime-diagnostics'],
  ]),
]
