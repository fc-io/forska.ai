import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {
  ownerDependentProduct,
  ownerDependentSensitive,
  removeBeforeReleaseDecision,
  routeGroup,
} from './routeSurfaceRouteGroups.ts'

export const dataSourcesRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('ImportRoutes.ts', [['GET', '/api/import-routes']]),
  ...ownerDependentProduct('DataSourcesRoutes.ts', [
    ['GET', '/api/datasources'],
    ['GET', '/api/datasources/archived'],
    ['GET', '/api/datasources/:id'],
    ['GET', '/api/datasources/:id/tracking/changes'],
    ['POST', '/api/datasources'],
    ['POST', '/api/datasources/:id/tracking/reconcile'],
    ['PATCH', '/api/datasources/:id'],
    ['DELETE', '/api/datasources/:id'],
  ]),
  ...ownerDependentSensitive(
    'DataSourcesImportRoutes.ts',
    'Uploaded files, parsed source data, and external literature API imports.',
    [
      ['POST', '/api/datasources/import/covidence-analyze'],
      ['POST', '/api/datasources/import/covidence-create'],
      ['POST', '/api/datasources/import/covidence'],
      ['POST', '/api/datasources/import/arxiv'],
      ['POST', '/api/datasources/import/biorxiv'],
      ['POST', '/api/datasources/import/medrxiv'],
      ['POST', '/api/datasources/import/pubmed'],
      ['POST', '/api/datasources/import/europe-pmc-ppr'],
      ['POST', '/api/datasources/import/structured-file-analyze'],
      ['POST', '/api/datasources/import/structured-file-create'],
      ['POST', '/api/datasources/import/structured-file'],
    ],
  ),
  ...routeGroup(
    {
      category: 'remove-before-release',
      proxyClassification: 'owner-dependent',
      releaseDecision: removeBeforeReleaseDecision,
      routeModule: 'DataSourcesImportRoutes.ts',
      sensitivity: 'FHIR/EHR patient records and potentially PHI-bearing local assets.',
    },
    [['POST', '/api/datasources/import/fhir-ehr-patients']],
  ),
]
