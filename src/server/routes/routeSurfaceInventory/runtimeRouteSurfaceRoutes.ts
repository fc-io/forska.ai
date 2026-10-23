import {runtimePrivateApiPrefix} from '../../utils/runtimePrivateApi.ts'
import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {
  internalDecision,
  ownerlessDiagnostics,
  ownerlessSettingsDiagnostics,
  routeGroup,
} from './routeSurfaceRouteGroups.ts'

export const runtimeRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...routeGroup(
    {
      category: 'supported-local-api',
      proxyClassification: 'local-bootstrap',
      releaseDecision: 'Keep local-only as readiness/bootstrap API.',
      routeModule: 'runtimeReadyRoutes.ts',
      sensitivity: null,
    },
    [['GET', '/api/runtime/ready']],
  ),
  ...ownerlessSettingsDiagnostics(
    'runtimeReadyRoutes.ts',
    'Process id, server role, runtime version, and Bun HTTP cap.',
    [['GET', '/api/runtime/state']],
  ),
  ...ownerlessSettingsDiagnostics(
    'reviewServingStatusRoutes.ts',
    'Review-serving pause, owner proxy, queue, and snapshot status.',
    [['GET', '/api/review-serving/status']],
  ),
  ...ownerlessSettingsDiagnostics(
    'DuckdbOwnerConnectionsRoutes.ts',
    'DuckDB owner, follower, host, process, and mart throughput metadata.',
    [['GET', '/api/duckdb_owner_connections']],
  ),
  ...routeGroup(
    {
      category: 'internal-runtime-api',
      proxyClassification: 'duckdb-owner-diagnostics',
      releaseDecision: internalDecision,
      routeModule: 'DuckdbOwnerConnectionsRoutes.ts',
      sensitivity: 'DuckDB owner heartbeat and process metadata.',
    },
    [['POST', '/api/duckdb_owner_connections/heartbeat']],
  ),
  ...ownerlessDiagnostics(
    'JudgmentDispatchTelemetryRoutes.ts',
    'Local judgment dispatch and provider capacity telemetry.',
    [
      ['GET', '/api/admin/judgment-dispatch-runtime/:jobId'],
      ['GET', `${runtimePrivateApiPrefix}/api/admin/judgment-dispatch-runtime/:jobId`],
    ],
  ),
]
