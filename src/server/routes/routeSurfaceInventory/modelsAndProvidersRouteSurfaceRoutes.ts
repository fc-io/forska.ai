import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {
  internalRuntime,
  ownerDependentDiagnostics,
  ownerDependentProduct,
  ownerDependentSensitive,
} from './routeSurfaceRouteGroups.ts'

export const modelsAndProvidersRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('ModelsRoutes.ts', [
    ['GET', '/api/models'],
    ['GET', '/api/models/stored'],
    ['POST', '/api/models/ensure'],
  ]),
  ...ownerDependentSensitive('ModelsRoutes.ts', 'Codex authentication state and login flow.', [
    ['GET', '/api/models/codex/status'],
    ['POST', '/api/models/codex/login'],
    ['GET', '/api/models/codex/login/:jobId'],
  ]),
  ...ownerDependentDiagnostics('ModelsRoutes.ts', 'Local GPU/runtime capacity details.', [
    ['GET', '/api/models/gpu-info'],
  ]),
  ...ownerDependentSensitive(
    'ProviderConnectionsRoutes.ts',
    'Provider credentials, secret references, auth flow, and model discovery metadata.',
    [
      ['POST', '/api/provider-auth/:providerKind/begin'],
      ['POST', '/api/provider-auth/:providerKind/finish'],
      ['GET', '/api/provider-connections'],
      ['POST', '/api/provider-connections'],
      ['PATCH', '/api/provider-connections/:id'],
      ['DELETE', '/api/provider-connections/:id'],
      ['POST', '/api/provider-connections/:id/test'],
      ['GET', '/api/provider-connections/:id/discovered-models'],
    ],
  ),
  ...ownerDependentProduct('ProviderModelsRoutes.ts', [
    ['POST', '/api/provider-connections/:id/sync-models'],
    ['POST', '/api/provider-connections/:id/models'],
    ['PATCH', '/api/models/:id'],
    ['PATCH', '/api/models/:id/capability-overrides'],
  ]),
  ...internalRuntime('providerAdmissionLeaseRoutes.ts', [
    ['POST', '/api/provideradmissionleases/acquire'],
    ['POST', '/api/provideradmissionleases/heartbeat'],
    ['POST', '/api/provideradmissionleases/release'],
    ['POST', '/api/provideradmissionleases/release-result'],
    ['POST', '/api/provideradmissionleases/expire'],
    ['POST', '/api/provideradmissionleases/reconcile'],
    ['POST', '/api/provider-admission-leases/acquire'],
    ['POST', '/api/provider-admission-leases/heartbeat'],
    ['POST', '/api/provider-admission-leases/release'],
    ['POST', '/api/provider-admission-leases/release-result'],
    ['POST', '/api/provider-admission-leases/expire'],
    ['POST', '/api/provider-admission-leases/reconcile'],
  ]),
]
